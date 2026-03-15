const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { fetchTranscript } = require('youtube-transcript-plus');

const app = express();
// IMPORTANT: Hugging Face uses port 7860
const port = process.env.PORT || 7860;

// Set up public static files and downloads directory
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
app.use(express.static(publicDir));

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);
app.use('/downloads', express.static(downloadsDir));

// --- AUTO CLEANUP ---
// Delete files older than 2 hours to keep the HF Space storage clean
setInterval(() => {
    fs.readdir(downloadsDir, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && now - stats.mtimeMs > 2 * 60 * 60 * 1000) {
                    fs.unlink(filePath, () => console.log(`🗑️ Auto-cleanup: ${file}`));
                }
            });
        });
    });
}, 60 * 60 * 1000);

// --- HELPERS ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatVTTTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds);
    const ms = Math.floor((seconds % 1) * 1000);
    return date.toISOString().substr(11, 8) + '.' + ms.toString().padStart(3, '0');
}

function findPhraseTimestamp(transcript, phrase, videoId) {
    const lowerPhrase = phrase.toLowerCase();
    const match = transcript.find(entry => entry.text.toLowerCase().includes(lowerPhrase));
    if (match) {
        const seconds = Math.floor(match.offset);
        return { text: match.text, timestamp: seconds, url: `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s` };
    }
    return null;
}

function generateYouTubeVTT(transcript) {
    let vtt = "WEBVTT\n\n";
    transcript.forEach((entry, i) => {
        const start = formatVTTTime(entry.offset);
        const end = formatVTTTime(entry.offset + (entry.duration || 2));
        vtt += `${i + 1}\n${start} --> ${end}\n${entry.text}\n\n`;
    });
    return vtt;
}

async function generatePodcastScript(ai, fullText, targetLanguage, host1, host2) {
    const translationInstruction = targetLanguage 
        ? `CRITICAL INSTRUCTION: You must write the entire podcast script seamlessly in ${targetLanguage}. Translate and adapt the core concepts from the original transcript naturally.` 
        : `Write the podcast script in the same language as the provided content.`;

    const prompt = `You are an expert podcast producer. Create a natural, engaging conversation between two hosts, ${host1} and ${host2}, based on the provided YouTube transcript. Focus on the key insights. 
    Format exactly like this:
    ${host1}: [Dialogue here]
    ${host2}: [Dialogue here]
    Do not include stage directions.
    ${translationInstruction}
    Content:
    ${fullText}`;
    
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: prompt,
        config: { temperature: 0.7, maxOutputTokens: 8192 }
    });
    
    let scriptText = response.text;
    if (!scriptText && response.candidates?.length > 0) {
        scriptText = response.candidates[0].content?.parts?.[0]?.text;
    }
    if (!scriptText) throw new Error("API returned an empty script.");
    return scriptText.trim();
}

// --- API ROUTE ---
app.get('/api/generate-podcast', async (req, res) => {
    req.setTimeout(0); 
    
    const { url, apiKey, targetLanguage, searchPhrase, host1 = "Alex", host2 = "Sam" } = req.query;
    if (!url) return res.status(400).json({ error: "Missing URL." });
    if (!apiKey) return res.status(400).json({ error: "Missing Gemini API Key." });

    // Initialize BYOK instance
    const ai = new GoogleGenAI({ apiKey: apiKey });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendLog = (msg) => {
        console.log(msg);
        res.write(`data: ${msg}\n\n`);
    };

    try {
        sendLog(`\n--- New Podcast Request ---`);
        const videoId = url.split('v=')[1]?.split('&')[0] || "video";
        
        sendLog(`[1/4] Fetching Transcript...`);
        const transcript = await fetchTranscript(url);
        
        // Extract the plain text from the transcript
        const fullText = transcript.map(t => t.text).join(' ');

        // Save original YouTube VTT file
        const ytVttPath = path.join(downloadsDir, `${videoId}_original.vtt`);
        fs.writeFileSync(ytVttPath, generateYouTubeVTT(transcript));
        sendLog(`  -> Original YouTube VTT saved.`);

        // Save original YouTube TXT file
        const ytTxtPath = path.join(downloadsDir, `${videoId}_original.txt`);
        fs.writeFileSync(ytTxtPath, fullText);
        sendLog(`  -> Original YouTube TXT saved.`);

        if (searchPhrase) {
            const found = findPhraseTimestamp(transcript, searchPhrase, videoId);
            if (found) {
                sendLog(`  -> 🔍 Found phrase "${searchPhrase}" at ${found.timestamp}s: ${found.url}`);
            } else {
                sendLog(`  -> 🔍 Phrase "${searchPhrase}" not found in transcript.`);
            }
        }

        // Use the generated plain text file content to generate the script
        sendLog(`[2/4] Generating Script with hosts ${host1} & ${host2}...`);
        const script = await generatePodcastScript(ai, fullText, targetLanguage, host1, host2);

        sendLog(`[3/4] Synthesizing Audio & Podcast VTT...`);
        const segments = [];
        const regex = /([A-Za-z0-9_]+):\s*([\s\S]*?)(?=[A-Za-z0-9_]+:|$)/g;
        let match;
        while ((match = regex.exec(script)) !== null) {
            segments.push({ speaker: match[1].trim(), text: match[2].trim() });
        }
        if (segments.length === 0) segments.push({ speaker: host1, text: script });

        let podcastVtt = "WEBVTT\n\n";
        let currentTime = 0;
        const pcmBuffers = [];
        const silenceBuffer = Buffer.alloc(24000, 0); 
        const voiceMap = { [host1]: "Aoede", [host2]: "Puck" };

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const voiceName = voiceMap[seg.speaker] || "Aoede"; 
            sendLog(`  🎙️ Recording line ${i+1}/${segments.length} for ${seg.speaker}...`);

            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash-preview-tts', 
                    contents: seg.text,
                    config: {
                        responseModalities: ["AUDIO"],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
                    }
                });

                const audioData = Buffer.from(response.candidates[0].content.parts[0].inlineData.data, 'base64');
                const duration = audioData.length / 48000; 
                
                podcastVtt += `${i + 1}\n${formatVTTTime(currentTime)} --> ${formatVTTTime(currentTime + duration)}\n<v ${seg.speaker}>${seg.text}\n\n`;
                
                pcmBuffers.push(audioData);
                currentTime += duration;
                
                if (i < segments.length - 1) {
                    pcmBuffers.push(silenceBuffer);
                    currentTime += 0.5;
                    await delay(1000);
                }
            } catch (err) {
                sendLog(`  ❌ Skipped line ${i+1}: ${err.message}`);
            }
        }

        sendLog(`[4/4] Finalizing MP3 and generated VTT...`);
        const baseFileName = `podcast_${Date.now()}`;
        fs.writeFileSync(path.join(downloadsDir, `${baseFileName}.vtt`), podcastVtt);
        
        const tempPcmPath = path.join(downloadsDir, `${baseFileName}.pcm`);
        fs.writeFileSync(tempPcmPath, Buffer.concat(pcmBuffers));

        ffmpeg(tempPcmPath)
            .inputOptions(['-f s16le', '-ar 24000', '-ac 1'])
            .save(path.join(downloadsDir, `${baseFileName}.mp3`))
            .on('end', () => {
                fs.unlinkSync(tempPcmPath); 
                sendLog(`[Done] Audio generated successfully!`);
                sendLog(`FILE_READY:${baseFileName}.mp3`);
                res.end();
            })
            .on('error', (err) => {
                sendLog(`ERROR: FFmpeg failed: ${err.message}`);
                res.end();
            });

    } catch (error) {
        res.write(`data: ERROR:${error.message}\n\n`);
        res.end();
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});