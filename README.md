# 🎙️ AI Podcast Studio

A secure, multi-step web application that converts YouTube videos into NotebookLM-style multi-host AI podcasts. 

This project extracts YouTube transcripts, utilizes **Google's Gemini 2.5 Flash** model to draft conversational scripts, and leverages the **Gemini 2.5 Flash TTS** model to synthesize high-fidelity, gapless, multi-speaker audio.

## ✨ Features
* **Automated Transcription:** Instantly pulls transcripts and generates `.vtt` subtitle files from any public YouTube URL.
* **Semantic Search:** Query the video's transcript using natural language to jump to specific timestamps.
* **AI Scripting Engine:** Automatically formats dense video transcripts into engaging, multi-host dialogues in your target language.
* **High-Fidelity Audio Synthesis:** Generates natural, conversational audio with dynamic pacing and gapless speaker transitions.
* **In-Memory Job Queue:** Safely handles concurrent audio generation requests without crashing the server's CPU or RAM.
* **Secure API Key Handling:** Utilizes a Bring-Your-Own-Key (BYOK) architecture where user keys are secured in browser memory and obfuscated from the DOM.

## 🛠️ Tech Stack
* **Frontend:** HTML5, CSS3, Vanilla JavaScript
* **Backend:** Node.js, Express.js
* **AI Provider:** Google Gemini API (`@google/genai`)
* **Audio Engine:** FFmpeg (Raw PCM to M4A encoding)

---

## 💻 Local Development Setup

### 1. Prerequisites
You must have the following installed on your local machine:
* **Node.js** (v20.0.0 or higher)
* **FFmpeg** (Must be installed on your system OS and accessible via your system's PATH. *Note: `fluent-ffmpeg` is just a Node wrapper, it requires the actual FFmpeg software to function.*)

### 2. Installation
Clone the repository and install the Node dependencies:
```bash
git clone https://github.com/kaudata/youtube-podcaster.git
cd youtube-podcaster
npm install
