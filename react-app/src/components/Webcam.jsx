import { useState, useRef, useEffect, forwardRef, useImperativeHandle, memo } from 'react';

const WebcamComponent = forwardRef(({ onCameraToggle }, ref) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // Expose capture method to parent
  useImperativeHandle(ref, () => ({
    captureFrame: () => {
      if (!videoRef.current || !isConnected) return null;
      
      const canvas = canvasRef.current;
      const video = videoRef.current;
      
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      
      // Return base64 without data URI prefix
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      return dataUrl.split(',')[1];
    }
  }));

  useEffect(() => {
    let isMounted = true;

    const initCamera = async () => {
      try {
        setIsInitializing(true);
        setError(null);

        // Request camera access
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: 'user'
          },
          audio: false
        });

        if (!isMounted) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        streamRef.current = stream;
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setIsConnected(true);
          onCameraToggle?.(true);
        }
      } catch (err) {
        console.error('Camera error:', err);
        if (isMounted) {
          setError(getCameraErrorMessage(err));
          setIsConnected(false);
          onCameraToggle?.(false);
        }
      } finally {
        if (isMounted) {
          setIsInitializing(false);
        }
      }
    };

    initCamera();

    return () => {
      isMounted = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [onCameraToggle]);

  const getCameraErrorMessage = (err) => {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Camera access denied. Please allow camera permissions in your browser settings.';
      case 'NotFoundError':
        return 'No camera found. Please connect a camera and refresh.';
      case 'NotReadableError':
        return 'Camera is in use by another application.';
      case 'OverconstrainedError':
        return 'Camera does not meet requirements.';
      default:
        return `Camera error: ${err.message}`;
    }
  };

  const retryCamera = () => {
    setIsInitializing(true);
    setError(null);
    
    // Stop existing stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    
    // Trigger re-init by remounting
    window.location.reload();
  };

  return (
    <div className="video-container">
      <video 
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ 
          display: isConnected ? 'block' : 'none',
          transform: 'scaleX(-1)' // Mirror the video
        }}
      />
      
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      
      {!isConnected && (
        <div className="video-placeholder">
          <div className="icon">
            {isInitializing ? '⏳' : '📷'}
          </div>
          {isInitializing ? (
            <p>Initializing camera...</p>
          ) : error ? (
            <>
              <p>{error}</p>
              <button className="btn btn-secondary" onClick={retryCamera}>
                Retry
              </button>
            </>
          ) : (
            <p>Camera not available</p>
          )}
        </div>
      )}
      
      {isConnected && (
        <div className="camera-status connected">
          🟢 Live
        </div>
      )}
    </div>
  );
});

WebcamComponent.displayName = 'Webcam';

const Webcam = memo(WebcamComponent);
export default Webcam;
