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

This skill allows you to convert YouTube videos into "NotebookLM style" podcasts. It enables to automate the creation of Podcast.

Before that you need to say `Run the npm install command for the youtube-podcaster skill`. This step you need to do only once. You can provide the Gemini API Key in the .env file in the folder `youtube-podcaster` under the `skills` folder. Then just say `create podcast for the video https://www.youtube.com/watch?v=<video id> using youtube-podcaster skill`

The skill will call the following 3 APIs 
1. POST /api/transcribe with the YouTube URL and a unique session id.
2. POST /api/draft-script with that same id, host names, optional language, and a valid Gemini API key (x-api-key header).
3. POST /api/synthesize with the generated script, id, and the same Gemini key.

## Source Code
- The source code can be found in the Github repo - https://github.com/kaudata/youtube-podcaster

## Where to find the generated audio file?
- The filename of the audio file is `podcast.m4a` and you can find it in the `downloads` folder in the `skills/youtube-podcaster/` folder
- You can also see the text of the podcast by looking at `script.txt` file in the same folder where `podcast.m4a` file is.
- You can also see the original text of the youtube video by looking at `original.txt` file in the same folder where `podcast.m4a` file is. 
- Apart from this you can also see the closed caption text file in WebVTT format of the original video by looking at `original.vtt` file and the closed caption text of the podcast file in `podcast.vtt` file

## Cleanup
- Once you are done look at the running node processes by using the command `ps aux | grep node` and try to kill the appropriate node process or you can also issue the command `pkill -n node` which means that you are killing the newest node server process 







