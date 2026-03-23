const express = require('express');
const bodyParser = require('body-parser');
const tf = require('@tensorflow/tfjs-node');

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

app.post('/process', (req, res) => {
    const { transcript } = req.body;
    console.log('Received:', transcript);
    // Example: Process transcript with an AI model
    // This is where you'd interact with TensorFlow.js or any other AI model
    // For demonstration, we'll just echo the transcript
    const responseMessage = `Processed: ${transcript}`;
    res.json({ message: responseMessage });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});