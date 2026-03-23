import { useRef, useEffect, useState } from 'react';

function WaitCounter({ startTime, label }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) { setElapsed(0); return; }
    const tick = () => setElapsed(((Date.now() - startTime) / 1000).toFixed(1));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [startTime]);

  if (!startTime) return null;
  return (
    <span className="wait-counter">{label}: {elapsed}s</span>
  );
}

function Chat({ messages, isProcessing, processingStartTime, processingLabel, inputText, onInputChange, onSubmit }) {
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="icon">💬</div>
            <p>Start a conversation by speaking or typing below.</p>
            <p style={{ fontSize: '0.8rem', marginTop: '0.5rem', opacity: 0.7 }}>
              Your API keys are secure - they never leave the server.
            </p>
          </div>
        ) : (
          messages.map((message, index) => (
            <div 
              key={index} 
              className={`message ${message.role}`}
            >
              {message.role === 'assistant' && message.timing && (
                <div className="message-timing" style={{ whiteSpace: 'pre-line' }}>
                  {/* STT timing and model, color-coded and on new lines */}
                    {message.timing.stt > 0 && (
                      <>
                        <span>
                          STT: {message.timing.stt}s : 
                          <span className={`timing-badge ${message.timing.models?.stt?.location || 'local'}`}>{message.timing.models?.stt?.name || 'Web Speech API'}</span>
                          {' : '}
                          <span className={`timing-badge ${message.timing.models?.stt?.location || 'local'}`}>{message.timing.models?.stt?.location || 'local'}</span>
                        </span>
                        <br />
                      </>
                    )}
                    <span>
                      LLM: {message.timing.llm}s : 
                      <span className={`timing-badge ${message.timing.models?.llm?.location || 'local'}`}>{message.timing.llmModel || message.timing.models?.llm?.name || 'unknown'}</span>
                      {' : '}
                      <span className={`timing-badge ${message.timing.models?.llm?.location || 'local'}`}>{message.timing.models?.llm?.location || 'local'}</span>
                    </span>
                    <br />
                    {message.timing.tts > 0 && (
                      <>
                        <span>
                          TTS: {message.timing.tts}s : 
                          <span className={`timing-badge ${message.timing.models?.tts?.location || 'local'}`}>{message.timing.models?.tts?.name || 'browser'}</span>
                          {' : '}
                          <span className={`timing-badge ${message.timing.models?.tts?.location || 'local'}`}>{message.timing.models?.tts?.location || 'local'}</span>
                        </span>
                        <br />
                      </>
                    )}
                </div>
              )}
              {message.content}
            </div>
          ))
        )}
        
        {isProcessing && (
          <div className="typing-indicator">
            <div className="typing-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <WaitCounter startTime={processingStartTime} label={processingLabel} />
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>
      
      <form className="chat-input" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Type a message or use voice..."
          disabled={isProcessing}
        />
        <button 
          type="submit" 
          className="btn btn-primary"
          disabled={!inputText.trim() || isProcessing}
        >
          Send
        </button>
      </form>
    </div>
  );
}

export default Chat;
