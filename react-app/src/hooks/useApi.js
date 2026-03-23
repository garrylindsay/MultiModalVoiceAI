import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Secure API hook - All API calls go through the backend server
 * API keys are NEVER exposed to the browser - they stay on the server
 */
export function useApi() {
  const [serverStatus, setServerStatus] = useState('connecting');
  const [ttsProvider, setTtsProvider] = useState('openai');
  const [modelInfo, setModelInfo] = useState(null);
  const [available, setAvailable] = useState(null);
  const [providerNames, setProviderNames] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const audioElementRef = useRef(null);
  const audioUnlockedRef = useRef(false);

  // Pre-create and "unlock" a reusable Audio element on first user interaction.
  // iOS/iPad requires audio playback to be initiated from a user gesture.
  // By playing a silent clip on the first tap, subsequent programmatic plays work.
  useEffect(() => {
    const audio = new Audio();
    audio.setAttribute('playsinline', '');
    audioElementRef.current = audio;

    const unlock = () => {
      if (audioUnlockedRef.current) return;
      // Play a tiny silent WAV to unlock the audio element
      audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
      audio.play().then(() => {
        audioUnlockedRef.current = true;
        audio.pause();
        audio.currentTime = 0;
      }).catch(() => { /* ignore — will retry on next interaction */ });
    };

    document.addEventListener('click', unlock, { once: false });
    document.addEventListener('touchstart', unlock, { once: false });

    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
    };
  }, []);

  // Check server health
  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      if (response.ok) {
        const data = await response.json();
        setServerStatus('connected');
        if (data.ttsProvider) setTtsProvider(data.ttsProvider);
        if (data.models) setModelInfo(data.models);
        if (data.available) setAvailable(data.available);
        if (data.providerNames) setProviderNames(data.providerNames);
        if (data.defaults) setDefaults(data.defaults);
        return data;
      }
      setServerStatus('error');
      return false;
    } catch (error) {
      console.error('Health check failed:', error);
      setServerStatus('error');
      return false;
    }
  }, []);

  // Send chat message to secure backend
  // The backend handles the API call with the server-side API key
  // llmProvider: 'lmstudio' | 'gemini' (optional override)
  const sendChat = useCallback(async (prompt, imageBase64 = null, chatHistory = [], llmProvider = null) => {
    const body = {
      prompt,
      imageBase64,
      chatHistory: chatHistory.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10),
    };
    if (llmProvider) body.llmProvider = llmProvider;

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `Server error: ${response.status}`);
    }

    const data = await response.json();
    return { text: data.response, llmSeconds: data.llmSeconds || 0, model: data.model || '' };
  }, []);

  // Play TTS audio - API call handled securely on server
  // Uses the pre-unlocked audio element so iOS/iPad allows playback
  // Returns { ttsSeconds } with the time taken
  // ttsOverride: 'local' | 'cloud' — if provided, overrides the server default
  const playTTS = useCallback(async (text, ttsOverride = null) => {
    if (!text) return { ttsSeconds: 0 };
    const ttsStart = Date.now();

    const effectiveTTS = ttsOverride === 'local' ? 'browser' : ttsOverride === 'cloud' ? 'openai' : ttsProvider;

    // --- Browser-native TTS (free, no API key) ---
    if (effectiveTTS === 'browser') {
      return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.onend = () => {
          resolve({ ttsSeconds: parseFloat(((Date.now() - ttsStart) / 1000).toFixed(1)) });
        };
        utterance.onerror = (e) => {
          console.error('Browser TTS error:', e);
          resolve({ ttsSeconds: parseFloat(((Date.now() - ttsStart) / 1000).toFixed(1)) });
        };
        window.speechSynthesis.cancel(); // cancel any queued speech
        window.speechSynthesis.speak(utterance);
        // Safari workaround: force playback to start by canceling after a short delay
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
          setTimeout(() => {
            window.speechSynthesis.cancel();
          }, 500);
        }
      });
    }

    // --- OpenAI TTS (server-side, paid) ---
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        console.error('TTS failed:', response.status);
        return;
      }

      const audioBlob = await response.blob();
      const ttsNetworkSeconds = parseFloat(((Date.now() - ttsStart) / 1000).toFixed(1));
      const audioUrl = URL.createObjectURL(audioBlob);
      
      // Reuse the pre-unlocked audio element (critical for iOS/iPad)
      const audio = audioElementRef.current || new Audio();
      audio.src = audioUrl;
      
      return new Promise((resolve, reject) => {
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          resolve({ ttsSeconds: ttsNetworkSeconds });
        };
        audio.onerror = (e) => {
          URL.revokeObjectURL(audioUrl);
          reject(e);
        };
        audio.play().catch((err) => {
          console.warn('Audio play blocked, trying fallback...', err);
          // Fallback: create new Audio (works on desktop browsers)
          const fallback = new Audio(audioUrl);
          fallback.onended = () => {
            URL.revokeObjectURL(audioUrl);
            resolve({ ttsSeconds: ttsNetworkSeconds });
          };
          fallback.play().catch(reject);
        });
      });
    } catch (error) {
      console.error('TTS error:', error);
      return { ttsSeconds: parseFloat(((Date.now() - ttsStart) / 1000).toFixed(1)) };
    }
  }, [ttsProvider]);

  // Speech-to-text via server (alternative to browser API)
  const transcribeAudio = useCallback(async (audioBlob) => {
    const reader = new FileReader();
    
    return new Promise((resolve, reject) => {
      reader.onload = async () => {
        try {
          const base64 = reader.result.split(',')[1];
          
          const response = await fetch('/api/stt', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ audioBase64: base64 }),
          });

          if (!response.ok) {
            throw new Error('Transcription failed');
          }

          const data = await response.json();
          resolve(data.text);
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(audioBlob);
    });
  }, []);

  return {
    serverStatus,
    ttsProvider,
    modelInfo,
    available,
    providerNames,
    defaults,
    checkHealth,
    sendChat,
    playTTS,
    transcribeAudio,
  };
}
