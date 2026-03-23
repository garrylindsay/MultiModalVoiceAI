document.getElementById('speak').addEventListener('click', () => {
    const recognition = new window.SpeechRecognition();
    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        console.log('You said: ', transcript);
        fetch('/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ transcript }),
        })
        .then(response => response.json())
        .then(data => {
            console.log('Response:', data.message);
        })
        .catch((error) => {
            console.error('Error:', error);
        });
    };
    recognition.start();
});

if (navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: true })
        .then((stream) => {
            document.getElementById('webcam').srcObject = stream;
        })
        .catch((error) => {
            console.log("Something went wrong!", error);
        });
}