import base64
from threading import Lock, Thread
import ssl
import urllib.request

import cv2
import openai
from cv2 import VideoCapture, imencode
from dotenv import load_dotenv
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.schema.messages import SystemMessage
from langchain_community.chat_message_histories import ChatMessageHistory
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI
from pyaudio import PyAudio, paInt16
from speech_recognition import Microphone, Recognizer, UnknownValueError

# Fix SSL certificate verification issue on macOS
try:
    _create_unverified_https_context = ssl._create_unverified_context
except AttributeError:
    pass
else:
    ssl._create_default_https_context = _create_unverified_https_context

load_dotenv()

'''
This Python script integrates several advanced features, including real-time webcam streaming, voice recognition, and text-to-speech (TTS) capabilities, to create an interactive assistant. 
It leverages libraries such as OpenCV for video capture, PyAudio for audio output, and various AI and machine learning libraries for processing and generating responses.
'''

class WebcamStream:
    '''
    The WebcamStream class manages the video stream from the webcam. 
    It initializes the video capture, starts a separate thread to continuously read frames from the webcam, and provides methods to start and stop the stream. 
    The read method allows for reading the current frame, with an option to encode the frame as a JPEG image in base64 format, which is useful for processing or transmitting the image data.
    '''
    
    def __init__(self):
        self.stream = VideoCapture(index=0)
        # Check if camera is properly initialized
        if not self.stream.isOpened():
            print("Warning: Could not open camera. Please check camera permissions in System Preferences > Security & Privacy > Camera")
            self.frame = None
        else:
            _, self.frame = self.stream.read()
            # Handle case where frame is None (camera access denied)
            if self.frame is None:
                print("Warning: Camera access denied or failed. Please allow camera access in System Preferences.")
        self.running = False
        self.lock = Lock()

    def start(self):
        if self.running:
            return self

        self.running = True

        self.thread = Thread(target=self.update, args=())
        self.thread.start()
        return self

    def update(self):
        while self.running:
            if self.stream.isOpened():
                _, frame = self.stream.read()
                if frame is not None:
                    self.lock.acquire()
                    self.frame = frame
                    self.lock.release()
                else:
                    # If frame reading fails, keep the last valid frame
                    pass
            else:
                # Camera not available, sleep briefly to avoid busy waiting
                import time
                time.sleep(0.1)

    def read(self, encode=False):
        self.lock.acquire()
        # Handle case where frame is None (camera unavailable)
        if self.frame is None:
            self.lock.release()
            # Return a black frame as fallback
            import numpy as np
            frame = np.zeros((480, 640, 3), dtype=np.uint8)
            if encode:
                _, buffer = imencode(".jpeg", frame)
                return base64.b64encode(buffer)
            return frame
        
        frame = self.frame.copy()
        self.lock.release()

        if encode:
            _, buffer = imencode(".jpeg", frame)
            return base64.b64encode(buffer)

        return frame

    def stop(self):
        self.running = False
        if self.thread.is_alive():
            self.thread.join()

    def __exit__(self, exc_type, exc_value, exc_traceback):
        self.stream.release()

class Assistant:
    """
    The Assistant class encapsulates the logic for generating responses based on prompts and images. 
    It initializes with a model that defines how to process and respond to inputs. 
    The answer method takes a text prompt and an image, invokes the processing chain to generate a response, and then uses TTS to audibly deliver the response. 
    The _create_inference_chain method sets up the processing chain, defining how inputs are transformed into responses.
    """
    def __init__(self, model):
        self.chain = self._create_inference_chain(model)

    def answer(self, prompt, image):
        if not prompt:
            return

        print("Prompt:", prompt)

        # Handle case where no image is provided (camera unavailable)
        if image is not None:
            response = self.chain.invoke(
                {"prompt": prompt, "image_base64": image.decode()},
                config={"configurable": {"session_id": "unused"}},
            ).strip()
        else:
            # For audio-only mode, create a simple text-only response
            response = f"I heard you say: {prompt}. However, I cannot see anything as the camera is not available."

        print("Response:", response)

        if response:
            self._tts(response)

    def _tts(self, response):
        player = PyAudio().open(format=paInt16, channels=1, rate=24000, output=True)

        with openai.audio.speech.with_streaming_response.create(
            model="tts-1",
            voice="fable",
            response_format="pcm",
            input=response,
        ) as stream:
            for chunk in stream.iter_bytes(chunk_size=1024):
                player.write(chunk)

    def _create_inference_chain(self, model):
        """
        Creates an inference chain for the voice assistant.

        Args:
            model: The model used for inference.

        Returns:
            A RunnableWithMessageHistory object representing the inference chain.

        """
        SYSTEM_PROMPT = """
        You are a witty assistant that will use the chat history and the image 
        provided by the user to answer its questions.

        Use few words on your answers. Go straight to the point. Do not use any
        emoticons or emojis. Do not ask the user any questions.

        Be friendly and helpful. Show some personality. Do not be too formal.
        """

        prompt_template = ChatPromptTemplate.from_messages(
            [
                SystemMessage(content=SYSTEM_PROMPT),
                MessagesPlaceholder(variable_name="chat_history"),
                (
                    "human",
                    [
                        {"type": "text", "text": "{prompt}"},
                        {
                            "type": "image_url",
                            "image_url": "data:image/jpeg;base64,{image_base64}",
                        },
                    ],
                ),
            ]
        )

        ### chain the prompt to the model then to the output
        chain = prompt_template | model | StrOutputParser()

        chat_message_history = ChatMessageHistory()
        return RunnableWithMessageHistory(
            chain,
            lambda _: chat_message_history,
            input_messages_key="prompt",
            history_messages_key="chat_history",
        )

'''
Main start of the script
'''
print("Initializing webcam...")
webcam_stream = WebcamStream()

# Check if camera initialization was successful
if webcam_stream.stream.isOpened() and webcam_stream.frame is not None:
    webcam_stream.start()
    print("Camera initialized successfully.")
else:
    print("Camera initialization failed. The app will run in audio-only mode.")
    print("To fix camera issues on macOS:")
    print("1. Go to System Preferences > Security & Privacy > Camera")
    print("2. Make sure Python/Terminal has camera access")
    print("3. Restart the application")

model = ChatGoogleGenerativeAI(model="gemini-3.1-flash-lite-preview")

# You can use OpenAI's GPT-4o model instead of Gemini Flash
# by uncommenting the following line:
# model = ChatOpenAI(model="gpt-4o")

assistant = Assistant(model)

def audio_callback(recognizer, audio):
    try:
        prompt = recognizer.recognize_whisper(audio, model="base", language="english")
        # Only process if we have a valid frame from the camera
        if webcam_stream.frame is not None:
            assistant.answer(prompt, webcam_stream.read(encode=True))
        else:
            print("Camera not available, processing audio only")
            assistant.answer(prompt, None)

    except UnknownValueError:
        pass
    except Exception as e:
        print(f"Error in audio processing: {e}")
        # Continue running despite errors
        print("There was an error processing the audio.")

recognizer = Recognizer()
microphone = Microphone()
with microphone as source:
    recognizer.adjust_for_ambient_noise(source)

'''
The active selection is a line of Python code that utilizes a method called listen_in_background from an object referred to as recognizer. 
This method is designed to listen for audio input from a specified source, in this case, microphone, and execute a callback function, audio_callback, whenever a phrase is detected in the audio input. The method is particularly useful for applications that require continuous or hands-free voice input, such as voice-activated assistants or automated transcription services.

The listen_in_background method works by spawning a new thread that listens for audio input from the microphone source. 
This allows the main program to continue running without being blocked while audio input is being processed. 
The method returns a stopper function, which, when called, will request the background listener thread to stop. 
This is useful for gracefully shutting down the audio listening process when the application is closing or when you no longer need to listen for audio input.

The audio_callback function passed to listen_in_background is expected to accept two parameters: the recognizer_instance and an AudioData instance representing the captured audio. This callback function is where you would typically process the captured audio, for example, by performing speech recognition or audio analysis. It's important to note that this callback function will be called from the background thread created by listen_in_background, not from the main thread of the application.

In summary, the line of code assigns the stopper function returned by listen_in_background to a variable named stop_listening. 
This setup allows the application to continuously listen for and process audio input from the microphone in the background, while also providing a mechanism to stop the listening process when needed.
'''
stop_listening = recognizer.listen_in_background(microphone, audio_callback)

print("Application started. Press ESC or 'q' to quit.")
print("If camera permission is denied, the app will work in audio-only mode.")

try:
    while True:
        try:
            frame = webcam_stream.read()
            cv2.imshow("webcam", frame)
            '''
            Putting it all together, this line of code is checking if the user has pressed either the ESC key or the "q" key. 
            This is a common pattern in OpenCV applications for breaking out of a loop that displays video frames or images in a window, allowing the program to proceed to its next steps or terminate. 
            The use of 1 millisecond in cv2.waitKey(1) ensures that the program checks for key presses almost continuously, making the application responsive to user input without introducing significant delay.
            '''
            if cv2.waitKey(1) in [27, ord("q")]:
                break
        except cv2.error as e:
            print(f"OpenCV error: {e}")
            print("Camera display failed, continuing in audio-only mode...")
            # If OpenCV fails, just listen for audio without video display
            try:
                import time
                time.sleep(1)  # Prevent busy waiting
                # Check for keyboard interrupt to exit
                if cv2.waitKey(1) in [27, ord("q")]:
                    break
            except KeyboardInterrupt:
                break
except KeyboardInterrupt:
    print("\nStopping application...")

'''
In summary, the webcam_stream.stop() method call is used to stop a running webcam stream. 
It does so by setting a flag to signal the end of the stream and then waits for the thread managing the stream to finish its execution. 
This is a common pattern in multithreaded applications to ensure that resources are cleanly released and the application can safely continue or terminate.
'''
webcam_stream.stop()
cv2.destroyAllWindows()
stop_listening(wait_for_stop=False)
