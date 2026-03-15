# YouTube Podcaster

This Openclaw skill allows you to convert YouTube videos into "NotebookLM style" podcasts.

## Requirements
- You need Node.js and FFmpeg installed. If you are using Mac, then use the command
brew install node ffmpeg

- Set up the Node environment. Run these commands one by one:
mkdir ~/Desktop/youtube-podcaster
cd ~/Desktop/youtube-podcaster
npm init -y
npm install express @google/genai fluent-ffmpeg youtube-transcript-plus
mkdir public downloads

- Inside the public folder, there should be index.html

- Ensure the local Podcast API is running at `http://localhost:7860` by running the command
node index.js

## How to use
- Go to the URL http://localhost:7860/ and you will see the html file being rendered. 
- Make sure you get the Gemini API key. API key is stored in browsers localStorage. Make sure to use the "Clear Saved Key" button in red color in case you don't want to persist the API key.
- Enter the Youtube URL with a pattern https://www.youtube.com/watch?v= 
- Enter the host 1 name (Female) and host 2 name (Male)
- Target Language is Optional. 
- Search Phrase is optional too. It generates the URL string to jump to that section in the original youtube video

### Required Parameters
You can use the curl command too using the following parameters
- `url`: The YouTube URL requested by the user.
- `apiKey`: The user's Gemini API key (ask the user for this if not provided in the prompt/environment).
- `host1` & `host2`: Optional names for the hosts.

### Example Usage
```bash
curl "http://localhost:7860/api/generate-podcast?url=YOUTUBE_URL&apiKey=YOUR_API_KEY&host1=Alex&host2=Sam"
