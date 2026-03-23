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

  // Keep ref in sync so callbacks always see latest value
  useEffect(() => {
    sttProviderRef.current = sttProvider;
  }, [sttProvider]);

  // ---- MediaRecorder refs for cloud STT ----
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

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
      };

      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        const confidence = event.results[0][0].confidence;
        const sttSeconds = listenStartRef.current
          ? parseFloat(((Date.now() - listenStartRef.current) / 1000).toFixed(1))
          : 0;
        lastSttDurationRef.current = sttSeconds;
        console.log(`[Local STT] "${transcript}" (confidence: ${(confidence * 100).toFixed(1)}%, ${sttSeconds}s)`);
        if (onResult && transcript) onResult(transcript, sttSeconds);
      };

      recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
        if (onError) {
          onError(event.error);
        }
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          console.warn('Speech recognition error:', event.error);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch (_) { /* ignore */ }
      }
    };
  }, [onResult]);

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
  const startCloudRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });

      let silenceTimeout = null;
      let audioContext = null;
      let analyser = null;
      let source = null;
      let dataArray = null;

      // Silence detection: stop after 1s of silence
      function setupSilenceDetection() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        dataArray = new Uint8Array(analyser.fftSize);

        function checkSilence() {
          analyser.getByteTimeDomainData(dataArray);
          // Calculate RMS (root mean square) to detect silence
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const val = (dataArray[i] - 128) / 128;
            sum += val * val;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          if (rms < 0.01) {
            // If silence detected, start timeout
            if (!silenceTimeout) {
              silenceTimeout = setTimeout(() => {
                if (recorder.state === 'recording') {
                  recorder.stop();
                }
              }, 1000); // 1s of silence
            }
          } else {
            // If not silent, clear timeout
            if (silenceTimeout) {
              clearTimeout(silenceTimeout);
              silenceTimeout = null;
            }
          }
          if (recorder.state === 'recording') {
            requestAnimationFrame(checkSilence);
          }
        }
        checkSilence();
      }

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop all tracks so mic indicator goes away
        stream.getTracks().forEach(t => t.stop());
        if (audioContext) {
          audioContext.close();
        }
        if (silenceTimeout) {
          clearTimeout(silenceTimeout);
        }

        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size === 0) {
          setIsListening(false);
          return;
        }

        const sttStart = listenStartRef.current || Date.now();

        // Convert to base64 and send to server
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const base64 = reader.result.split(',')[1];
            const response = await fetch('/api/stt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audioBase64: base64 }),
            });

            if (!response.ok) {
              const err = await response.json().catch(() => ({ error: 'Transcription failed' }));
              console.error('[Cloud STT] Error:', err.error);
              setIsListening(false);
              return;
            }

            const data = await response.json();
            const transcript = data.text || '';
            const sttSeconds = parseFloat(((Date.now() - sttStart) / 1000).toFixed(1));
            lastSttDurationRef.current = sttSeconds;
            console.log(`[Cloud STT] "${transcript}" (${sttSeconds}s)`);
            if (onResult && transcript.trim()) {
              onResult(transcript.trim(), sttSeconds);
            }
          } catch (err) {
            console.error('[Cloud STT] Network error:', err);
          } finally {
            setIsListening(false);
          }
        };
        reader.onerror = () => setIsListening(false);
        reader.readAsDataURL(blob);
      };

      mediaRecorderRef.current = recorder;
      listenStartRef.current = Date.now();
      recorder.start();
      setupSilenceDetection();
      setIsListening(true);
    } catch (err) {
      console.error('[Cloud STT] Microphone access denied:', err);
      setIsListening(false);
    }
  }, [onResult]);

  const stopCloudRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    // isListening is set to false in onstop handler after transcription completes
  }, []);

  // ---- Public API ----
  const startListening = useCallback(() => {
    if (isListening) return;

    if (sttProviderRef.current === 'cloud') {
      startCloudRecording();
      return;
    }

    // Local Web Speech API
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.start();
    } catch (error) {
      if (onError) {
        onError(error.name || 'start-failed');
      }
      if (error.name !== 'InvalidStateError') {
        console.error('Failed to start speech recognition:', error);
      }
    }
  }, [isListening, startCloudRecording, onError]);

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
