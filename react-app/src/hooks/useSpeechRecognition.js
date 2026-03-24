import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Cross-browser speech recognition hook
 * Supports two modes:
 *   - "local"  → browser Web Speech API (Chrome, Edge, Safari)
 *   - "cloud"  → MediaRecorder → send audio to /api/stt (OpenAI Whisper)
 */
// Accepts optional onError callback
export function useSpeechRecognition(onResult, sttProvider = 'local', onError) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [browserInfo, setBrowserInfo] = useState({ name: '', supported: true });
  const recognitionRef = useRef(null);
  const listenStartRef = useRef(null);
  const lastSttDurationRef = useRef(0);
  const sttProviderRef = useRef(sttProvider);

  // Stable refs for callbacks — avoids tearing down recognition when parent re-renders
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // Keep ref in sync so callbacks always see latest value
  useEffect(() => {
    sttProviderRef.current = sttProvider;
  }, [sttProvider]);

  // ---- MediaRecorder refs for cloud STT ----
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

  // ---- Silence detection refs ----
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const silenceFrameRef = useRef(0);       // consecutive silent frames
  const speechDetectedRef = useRef(false); // has the user spoken yet?
  const silenceTimerRef = useRef(null);    // RAF id

  // Detect browser support for local Web Speech API
  useEffect(() => {
    const userAgent = navigator.userAgent;
    let browserName = 'Unknown';
    let supported = true;

    if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
      browserName = 'Chrome';
    } else if (userAgent.includes('Edg')) {
      browserName = 'Edge';
    } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      browserName = 'Safari';
    } else if (userAgent.includes('Firefox')) {
      browserName = 'Firefox';
      supported = false;
    } else if (userAgent.includes('Opera') || userAgent.includes('OPR')) {
      browserName = 'Opera';
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      supported = false;
    }

    setBrowserInfo({ name: browserName, supported });
    // Cloud STT is always supported (just needs a microphone)
    setIsSupported(supported || sttProviderRef.current === 'cloud');

    if (supported && SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        listenStartRef.current = Date.now();
        setIsListening(true);
        console.log('[Local STT] Recognition started — listening for speech...');
      };

      recognition.onaudiostart = () => {
        console.log('[Local STT] Audio capture started');
      };

      recognition.onsoundstart = () => {
        console.log('[Local STT] Sound detected');
      };

      recognition.onspeechstart = () => {
        console.log('[Local STT] Speech detected');
      };

      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        const confidence = event.results[0][0].confidence;
        const sttSeconds = listenStartRef.current
          ? parseFloat(((Date.now() - listenStartRef.current) / 1000).toFixed(1))
          : 0;
        lastSttDurationRef.current = sttSeconds;
        console.log(`[Local STT] Result: "${transcript}" (confidence: ${(confidence * 100).toFixed(1)}%, ${sttSeconds}s)`);
        if (onResultRef.current && transcript) onResultRef.current(transcript, sttSeconds);
      };

      recognition.onnomatch = () => {
        console.warn('[Local STT] No match — speech was heard but not recognized');
      };

      recognition.onerror = (event) => {
        console.error(`[Local STT] Error: ${event.error} (message: ${event.message || 'none'})`);
        setIsListening(false);
        if (onErrorRef.current) {
          onErrorRef.current(event.error);
        }
      };

      recognition.onend = () => {
        console.log('[Local STT] Recognition ended');
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      console.log(`[Local STT] SpeechRecognition initialized (${browserName})`);
    } else {
      console.warn(`[Local STT] Not supported in ${browserName} — cloud STT still available`);
    }

    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch (_) { /* ignore */ }
      }
    };
  }, []); // Run once — callbacks use stable refs

  // Keep isSupported in sync when provider changes
  useEffect(() => {
    if (sttProvider === 'cloud') {
      setIsSupported(true);
    } else {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      setIsSupported(!!SpeechRecognition);
    }
  }, [sttProvider]);

  // ---- Cloud STT helpers ----

  // Silence detection constants
  const SILENCE_THRESHOLD = 15;     // RMS below this = silence (0-255 scale)
  const SPEECH_THRESHOLD = 20;      // RMS above this = speech detected
  const SILENCE_DURATION_MS = 1800; // ms of silence after speech before auto-stop
  const MIN_RECORDING_MS = 800;     // minimum recording time before silence can trigger

  const stopSilenceDetection = useCallback(() => {
    if (silenceTimerRef.current) {
      cancelAnimationFrame(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    silenceFrameRef.current = 0;
    speechDetectedRef.current = false;
  }, []);

  const startSilenceDetection = useCallback((stream) => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;
      silenceFrameRef.current = 0;
      speechDetectedRef.current = false;

      const dataArray = new Uint8Array(analyser.fftSize);
      let silenceStartTime = null;

      const checkAudio = () => {
        if (!analyserRef.current) return;

        analyser.getByteTimeDomainData(dataArray);

        // Calculate RMS volume
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / dataArray.length) * 255;

        const elapsed = Date.now() - (listenStartRef.current || Date.now());

        if (rms > SPEECH_THRESHOLD) {
          // User is speaking
          if (!speechDetectedRef.current) {
            speechDetectedRef.current = true;
            console.log(`[Cloud STT] Speech detected (RMS: ${rms.toFixed(1)})`);
          }
          silenceStartTime = null;
          silenceFrameRef.current = 0;
        } else if (rms < SILENCE_THRESHOLD && speechDetectedRef.current && elapsed > MIN_RECORDING_MS) {
          // Silence after speech
          if (!silenceStartTime) {
            silenceStartTime = Date.now();
          }
          const silenceDuration = Date.now() - silenceStartTime;
          if (silenceDuration >= SILENCE_DURATION_MS) {
            console.log(`[Cloud STT] Auto-stopping — ${(silenceDuration / 1000).toFixed(1)}s of silence after speech`);
            // Auto-stop recording
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
              mediaRecorderRef.current.stop();
            }
            stopSilenceDetection();
            return;
          }
        }

        silenceTimerRef.current = requestAnimationFrame(checkAudio);
      };

      silenceTimerRef.current = requestAnimationFrame(checkAudio);
      console.log('[Cloud STT] Silence detection started');
    } catch (err) {
      console.warn('[Cloud STT] Could not start silence detection:', err);
    }
  }, [stopSilenceDetection]);

  const startCloudRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      console.log(`[Cloud STT] Recording started — mimeType: ${mimeType}`);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop all tracks so mic indicator goes away
        stream.getTracks().forEach(t => t.stop());

        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        console.log(`[Cloud STT] Recording stopped — blob: ${blob.size} bytes, chunks: ${audioChunksRef.current.length}`);

        if (blob.size < 1000) {
          console.warn('[Cloud STT] Audio too short, skipping');
          setIsListening(false);
          return;
        }

        const sttStart = listenStartRef.current || Date.now();

        try {
          // Send as FormData (no base64 encoding — avoids data corruption)
          const ext = mimeType.includes('webm') ? 'webm' : 'ogg';
          const formData = new FormData();
          formData.append('audio', blob, `recording.${ext}`);

          const response = await fetch('/api/stt', {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Transcription failed' }));
            console.error('[Cloud STT] Server error:', err.error);
            if (onErrorRef.current) onErrorRef.current(err.error);
            setIsListening(false);
            return;
          }

          const data = await response.json();
          const transcript = data.text || '';
          const sttSeconds = parseFloat(((Date.now() - sttStart) / 1000).toFixed(1));
          lastSttDurationRef.current = sttSeconds;
          console.log(`[Cloud STT] Transcription: "${transcript}" (${sttSeconds}s)`);
          if (onResultRef.current && transcript.trim()) {
            onResultRef.current(transcript.trim(), sttSeconds);
          }
        } catch (err) {
          console.error('[Cloud STT] Network error:', err);
        } finally {
          setIsListening(false);
        }
      };

      mediaRecorderRef.current = recorder;
      listenStartRef.current = Date.now();
      // Collect data in 250ms chunks for reliability
      recorder.start(250);
      setIsListening(true);

      // Start monitoring audio levels for auto-stop
      startSilenceDetection(stream);
    } catch (err) {
      console.error('[Cloud STT] Microphone access denied:', err);
      if (onErrorRef.current) onErrorRef.current('mic-denied');
      setIsListening(false);
    }
  }, [startSilenceDetection]); // Callbacks use stable refs

  const stopCloudRecording = useCallback(() => {
    stopSilenceDetection();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    // isListening is set to false in onstop handler after transcription completes
  }, [stopSilenceDetection]);

  // ---- Public API ----
  const startListening = useCallback(() => {
    if (isListening) return;

    if (sttProviderRef.current === 'cloud') {
      startCloudRecording();
      return;
    }

    // Local Web Speech API
    if (!recognitionRef.current) {
      console.error('[Local STT] recognitionRef is null — SpeechRecognition not available');
      if (onErrorRef.current) onErrorRef.current('not-supported');
      return;
    }
    try {
      console.log('[Local STT] Calling recognition.start()...');
      recognitionRef.current.start();
    } catch (error) {
      if (onErrorRef.current) {
        onErrorRef.current(error.name || 'start-failed');
      }
      if (error.name !== 'InvalidStateError') {
        console.error('Failed to start speech recognition:', error);
      }
    }
  }, [isListening, startCloudRecording]);

  const stopListening = useCallback(() => {
    if (sttProviderRef.current === 'cloud') {
      stopCloudRecording();
      return;
    }

    if (!recognitionRef.current || !isListening) return;
    try {
      recognitionRef.current.stop();
    } catch (error) {
      console.error('Failed to stop speech recognition:', error);
    }
    setIsListening(false);
  }, [isListening, stopCloudRecording]);

  return {
    isListening,
    isSupported,
    startListening,
    stopListening,
    browserInfo,
  };
}
