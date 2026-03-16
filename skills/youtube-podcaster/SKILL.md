---
name: youtube-podcaster
description: Converts a YouTube video into a multi-voice AI podcast using a local Node.js API and FFmpeg.
metadata:
  openclaw:
    requires:
      bins:
        - curl
        - node
        - npm
        - ffmpeg
      env:
        - GEMINI_API_KEY
---

# YouTube Podcaster

This skill allows you to convert YouTube videos into "NotebookLM style" podcasts. It automates the transcription, script drafting, and high-fidelity audio synthesis of a multi-host discussion based on any public YouTube video.

## Prerequisites & Installation
This skill requires **Node.js** and **FFmpeg** to be installed on your system.

1. **Install Dependencies:** You must run the install command once before the first use. Say: 
   `Run the npm install command for the youtube-podcaster skill`.
2. **Set Credentials:** Provide your Gemini API key in a `.env` file located at `skills/youtube-podcaster/.env` using the variable name `GEMINI_API_KEY`.
3. **Start the Server:** The automation requires the local server to be active. Say:
   `Start the local server for the youtube-podcaster skill`.

## Usage
Once the server is running, you can generate a podcast by saying:
`Create a podcast for the video https://www.youtube.com/watch?v=<video_id> using the youtube-podcaster skill`

The skill orchestrates three local API calls:
1. **Transcription:** Pulls text and subtitles from YouTube.
2. **Scripting:** Uses **Gemini 2.5 Flash** to draft a conversational dialogue between two hosts.
3. **Synthesis:** Uses **Gemini 2.5 Flash TTS** and **FFmpeg** to create a gapless `.m4a` audio file.

## File Locations & Persistence
All generated artifacts are stored in a session-specific subfolder within the skill's directory:
`skills/youtube-podcaster/downloads/<session_id>/`

* **Audio:** `podcast.m4a`
* **Captions:** `podcast.vtt` (Synced subtitles for the audio)
* **Scripts:** `script.txt` (The dialogue) and `original.txt` (The source transcript)

## Security & Privacy
* **Localhost Binding:** The server binds to `localhost:7860` by default. It is not accessible from the public internet unless you explicitly configure a tunnel or firewall rule.
* **Data Persistence:** Files remain on disk until the hourly garbage collector runs or you manually delete the `downloads` folder.
* **API Usage:** This skill performs network calls to Google's Gemini API and YouTube's transcript service.

## Safe Cleanup
When you are finished using the studio, you should shut down the background Node.js process to free up system resources. 
Instruct the agent to:
`Stop the youtube-podcaster server process` 
(The agent will execute `pkill -f "node index.js"` to target the specific process safely).

## Source Code
The source code is available at: [https://github.com/kaudata/youtube-podcaster](https://github.com/kaudata/youtube-podcaster)