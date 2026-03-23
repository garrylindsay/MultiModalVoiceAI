# Garry Demo AI Assistant

## Prerequisites

You need an `OPENAI_API_KEY` and a `GOOGLE_API_KEY` to run this code. Store them in a `.env` file in the root directory of the project, or set them as environment variables.

## Setup

### Apple Silicon Users

If you are running the code on Apple Silicon, run the following command:

```sh
brew install portaudio
```

You can check if Python 3 is available on your system by running the following command in your terminal:

```
$ python3 --version
```

This command will display the installed version of Python 3 if it is available. If Python 3 is not installed, you will need to install it from the official Python website. https://www.python.org/downloads/

Create a virtual environment, update pip, and install the required packages:

```
$ pythonv3 -m venv .venv
$ source .venv/bin/activate or .venv/scripts/activate.ps1 for windows powershell
$ pip install -U pip
$ pip install -r requirements.txt
```

Run the MultiModalVoiceAIApp:

```
$ python multimodalvoiceaiapp_v1.py
```





