import { useState, useRef, useCallback, useEffect } from 'react';
import Webcam from './components/Webcam';
import Chat from './components/Chat';
import ProviderToggle from './components/ProviderToggle';
import { useApi } from './hooks/useApi';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';

function App() {
  const [messages, setMessages] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [inputText, setInputText] = useState('');
  const [processingStartTime, setProcessingStartTime] = useState(null);
  const [processingLabel, setProcessingLabel] = useState('');
  const [speechError, setSpeechError] = useState('');
  const webcamRef = useRef(null);
  // Track if a transcript was received in the last recognition session
  const transcriptReceivedRef = useRef(false);

  // Provider preferences (local vs cloud)
  const [providers, setProviders] = useState({
    stt: 'local',
    llm: 'local',
    tts: 'local',
  });
  const providersRef = useRef(providers);
  useEffect(() => { providersRef.current = providers; }, [providers]);

  const handleProviderChange = useCallback((key, value) => {
    setProviders(prev => ({ ...prev, [key]: value }));
  }, []);
  
  const { sendChat, playTTS, serverStatus, checkHealth, modelInfo, available, providerNames, defaults } = useApi();

  // Initialise provider defaults from server health response
  const defaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (defaults && !defaultsAppliedRef.current) {
      setProviders(prev => ({
        stt: defaults.stt || prev.stt,
        llm: defaults.llm || prev.llm,
        tts: defaults.tts || prev.tts,
      }));
      defaultsAppliedRef.current = true;
    }
  }, [defaults]);
  
  const handleSpeechResult = useCallback(async (transcript, sttSeconds = 0) => {
    if (!transcript.trim()) return;
    setSpeechError(''); // Clear any previous speech error if we got a result
    transcriptReceivedRef.current = true;

    // Add user message
    const userMessage = { role: 'user', content: transcript };
    setMessages(prev => [...prev, userMessage]);
    setIsProcessing(true);
    setProcessingLabel('LLM');
    setProcessingStartTime(Date.now());

    try {
      // Capture current frame if camera is available
      let imageBase64 = null;
      if (webcamRef.current && cameraEnabled) {
        imageBase64 = webcamRef.current.captureFrame();
      }

      // Send to secure backend (API keys never leave the server)
      const llmProviderKey = providersRef.current.llm === 'cloud' ? 'gemini' : 'lmstudio';
      const chatResult = await sendChat(transcript, imageBase64, messages, llmProviderKey);
      const llmSeconds = chatResult.llmSeconds || 0;
      const responseText = chatResult.text;

      // Switch timer label to TTS phase
      setProcessingLabel('TTS');
      setProcessingStartTime(Date.now());

      // Add assistant response with LLM timing (TTS will be updated after)
      // Determine model names based on current provider selections
      const currentProviders = providersRef.current;
      const sttModelInfo = currentProviders.stt === 'cloud'
        ? { name: providerNames?.stt?.cloud || 'whisper-1', location: 'cloud' }
        : { name: providerNames?.stt?.local || 'Web Speech API', location: 'local' };
      const llmModelInfo = currentProviders.llm === 'cloud'
        ? { name: providerNames?.llm?.cloud || 'gemini', location: 'cloud' }
        : { name: providerNames?.llm?.local || 'LM Studio', location: 'local' };
      const ttsModelInfo = currentProviders.tts === 'cloud'
        ? { name: providerNames?.tts?.cloud || 'tts-1', location: 'cloud' }
        : { name: providerNames?.tts?.local || 'Browser TTS', location: 'local' };

      const timingData = {
        stt: sttSeconds,
        llm: llmSeconds,
        tts: 0,
        models: { stt: sttModelInfo, llm: llmModelInfo, tts: ttsModelInfo },
        llmModel: chatResult.model || '',
      };
      const assistantMessage = { role: 'assistant', content: responseText, timing: timingData };
      setMessages(prev => [...prev, assistantMessage]);

      // Play TTS response — errors here don't block the text response
      try {
        const ttsResult = await playTTS(responseText, currentProviders.tts);
        const ttsSeconds = ttsResult?.ttsSeconds || 0;
        // Update the timing on the last assistant message
        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.role === 'assistant') {
            updated[lastIdx] = { ...updated[lastIdx], timing: { ...updated[lastIdx].timing, tts: ttsSeconds } };
          }
          return updated;
        });
      } catch (ttsError) {
        console.error('TTS playback error:', ttsError);
        setMessages(prev => [...prev, { 
          role: 'warning', 
          content: `🔇 Voice playback failed: ${ttsError.message || 'Could not play audio response'}. You can still read the text above.`
        }]);
      }

    } catch (error) {
      console.error('Error processing message:', error);
      const errorMsg = error.message || 'An unexpected error occurred';

      // Provide user-friendly context based on the error
      let displayMsg = errorMsg;
      if (errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError')) {
        displayMsg = '⚠️ Cannot reach the server. Please check that both servers are running.';
      } else {
        displayMsg = `⚠️ ${errorMsg}`;
      }

      setMessages(prev => [...prev, { 
        role: 'error', 
        content: displayMsg
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStartTime(null);
      setProcessingLabel('');
    }
  }, [cameraEnabled, messages, sendChat, playTTS, providerNames]);
  
  // Custom error handler for speech recognition
  const handleSpeechError = useCallback((errorType) => {
    // Show the exact error type for diagnosis
    if (errorType === 'aborted' && !transcriptReceivedRef.current) {
      setSpeechError('Speech recognition was aborted. Please try again.');
    } else if (errorType === 'not-allowed') {
      setSpeechError('Microphone access denied. Please allow microphone permissions in your browser settings.');
    } else if (errorType === 'no-speech') {
      setSpeechError('No speech detected. Please try speaking more clearly or check your microphone.');
    } else if (errorType !== 'aborted') {
      setSpeechError(`Speech recognition error: ${errorType}`);
    }
    // Reset transcript flag for next session
    if (errorType !== 'aborted') {
      transcriptReceivedRef.current = false;
    }
  }, []);

  const {
    isListening,
    isSupported: speechSupported,
    startListening,
    stopListening,
    browserInfo
  } = useSpeechRecognition(handleSpeechResult, providers.stt, handleSpeechError);
  
  const handleTextSubmit = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || isProcessing) return;
    
    const text = inputText;
    setInputText('');
    await handleSpeechResult(text, 0);
  };
  
  const toggleListening = () => {
    setSpeechError(''); // Clear any previous error
    transcriptReceivedRef.current = false; // Reset transcript flag at start
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };
  
  const handleCameraToggle = useCallback((enabled) => {
    setCameraEnabled(enabled);
  }, []);
  
  const clearChat = () => {
    setMessages([]);
  };
  
  // Check server health on mount
  useEffect(() => {
    checkHealth();
  }, [checkHealth]);
  
  return (
    <div className="app">
      <header className="header">
        <h1>
          <span>Garry's MultiModal Voice AI</span>
        </h1>
        <div className="security-badge">
          Secure Connection
        </div>
      </header>
      
      <main className="main-content">
        {/* Video Panel */}
        <div className="panel">
          <div className="panel-header">
            <h2>📹 Camera Feed</h2>
            <span className={`camera-status ${cameraEnabled ? 'connected' : 'disconnected'}`}>
              {cameraEnabled ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <div className="panel-body">
            <Webcam 
              ref={webcamRef} 
              onCameraToggle={handleCameraToggle}
            />
            
            <div className="controls">
              <button
                className={`btn ${isListening ? 'btn-danger recording' : 'btn-primary'}`}
                onClick={toggleListening}
                disabled={!speechSupported || isProcessing}
              >
                {isListening ? '🔴 Stop Recording' : '🎤 Start Recording'}
              </button>
              
              <button
                className="btn btn-secondary"
                onClick={clearChat}
                disabled={messages.length === 0}
              >
                🗑️ Clear Chat
              </button>
            </div>
            
            {speechError && (
              <div className="speech-error">
                <span>⚠️ {speechError}</span>
              </div>
            )}
            
            <div className="status-bar">
              <div className={`status-dot ${isListening ? 'recording' : serverStatus === 'connected' ? '' : 'inactive'}`}></div>
              <span className="status-text">
                {isListening ? 'Listening...' : 
                 isProcessing ? 'Processing...' : 
                 serverStatus === 'connected' ? 'Ready' : 'Connecting...'}
              </span>
            </div>
            
            {!speechSupported && (
              <div className="browser-notice">
                <h4>⚠️ Browser Compatibility</h4>
                <p>
                  Speech recognition is not supported in {browserInfo.name}. 
                  Please use Chrome, Edge, or Safari for full functionality.
                  You can still use text input.
                </p>
              </div>
            )}
            
            <ProviderToggle
              providers={providers}
              onChange={handleProviderChange}
              available={available}
              providerNames={providerNames}
            />
          </div>
        </div>
        
        {/* Chat Panel */}
        <div className="panel">
          <div className="panel-header">
            <h2>💬 Conversation</h2>
            <div className="voice-activity" style={{ opacity: isListening ? 1 : 0.5 }}>
              {isListening ? '🔴 Recording' : '⚪ Idle'}
            </div>
          </div>
          <div className="panel-body" style={{ padding: 0 }}>
            <Chat 
              messages={messages}
              isProcessing={isProcessing}
              processingStartTime={processingStartTime}
              processingLabel={processingLabel}
              inputText={inputText}
              onInputChange={setInputText}
              onSubmit={handleTextSubmit}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
