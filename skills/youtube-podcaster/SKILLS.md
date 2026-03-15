---
name: youtube-podcaster
description: Converts a YouTube video into a multi-voice AI podcast using a local API.
metadata:
  openclaw:
    requires:
      bins:
        - curl
---

# YouTube Podcaster

This skill allows you (the AI agent) to convert YouTube videos into podcasts.

## Requirements
- Ensure the local Podcast API is running at `http://localhost:7860`.

## How to use
Make a GET request to the local API using `curl`. 

### Required Parameters
- `url`: The YouTube URL requested by the user.
- `apiKey`: The user's Gemini API key (ask the user for this if not provided in the prompt/environment).
- `host1` & `host2`: Optional names for the hosts.

### Example Usage
```bash
curl "http://localhost:7860/api/generate-podcast?url=YOUTUBE_URL&apiKey=YOUR_API_KEY&host1=Alex&host2=Sam"
