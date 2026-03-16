// --- LOAD ENVIRONMENT VARIABLES FIRST ---
require('dotenv').config();

const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { fetchTranscript } = require('youtube-transcript-plus');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 7860;

// Trust the first proxy in front of Express so rate-limiting maps to the actual user IP
app.set('trust proxy', 1); 

// --- MIDDLEWARE ---
app.use(express.static('public'));
app.use('/downloads', express.static(path.join(__dirname, 'downloads'))); // Expose downloads for previews
app.use(express.json({ limit: '50mb' }));

// --- SECURITY: RATE LIMITING ---
const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 50,
    message: { error: "Too many requests, please slow down." }
});

const synthesizeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, 
    max: 5, 
    message: { error: "Too many podcasts generated from this IP, please try again after an hour." },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', globalApiLimiter);

// --- FILE SYSTEM SETUP ---
const downloadsDir = path.join(__dirname, 'downloads');

// Safe startup: Do NOT wipe the directory to protect active cloud volumes
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
    console.log("✨ Created downloads directory.");
} else {
    console.log("📂 Downloads directory found. Relying on Hourly Garbage Collector for cleanup.");
}

// --- IN-MEMORY JOB TRACKER & QUEUE ---
const jobs = {};
const jobQueue = [];
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = 2; // Limit this to your server's CPU core count

function processNextJob() {
    if (activeJobs >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) return;
    
    const queuedItem = jobQueue.shift(); 
    
    // Check if user closed the tab or deleted the job while waiting
    if (!jobs[queuedItem.id] || jobs[queuedItem.id].status === 'cancelled') {
        console.log(`[Queue] 🛑 Skipping cancelled job: ${queuedItem.id}`);
        return processNextJob(); 
    }
    
    activeJobs++;
    
    queuedItem.task().finally(() => {
        activeJobs--;
        processNextJob(); 
    });
}

// Hourly Garbage Collector
setInterval(() => {
    console.log("🧹 Running routine cleanup of stale data...");
    const now = Date.now();

    // 1. Sweep In-Memory Jobs
    for (const id in jobs) {
        if (now - jobs[id].timestamp > 60 * 60 * 1000) {
            if (jobs[id].process) jobs[id].process.kill('SIGKILL');
            delete jobs[id];
            console.log(`🗑️ Auto-deleted stale memory job: ${id}`);
        }
    }

    // 2. Sweep Hard Drive
    if (!fs.existsSync(downloadsDir)) return;
    const folders = fs.readdirSync(downloadsDir);

    folders.forEach(folder => {
        const folderPath = path.join(downloadsDir, folder);
        try {
            const stats = fs.statSync(folderPath);
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                fs.rmSync(folderPath, { recursive: true, force: true });
                console.log(`🗑️ Auto-deleted stale session folder: ${folder}`);
            }
        } catch (err) {
            console.error(`❌ Failed to check/delete ${folder}:`, err.message);
        }
    });
}, 60 * 60 * 1000);

// --- HELPERS ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sanitizeId(id) {
    if (!id || typeof id !== 'string') return 'default_video';
    return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

function timestampToSeconds(ts) {
    const p = ts.split(':').map(parseFloat);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

function formatVTTTime(totalSeconds) {
    // Convert to total ms first to eliminate floating-point carry-over bugs
    const totalMs = Math.round(totalSeconds * 1000);
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    const pad = (num, size) => num.toString().padStart(size, '0');
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

// --- ROUTES ---

// 1. Transcribe (POST)
app.post('/api/transcribe', async (req, res) => {
    const { url, id } = req.body;
    if (!url) return res.status(400).json({ error: "Missing YouTube URL" });
    const safeId = sanitizeId(id);
    const videoDir = path.join(downloadsDir, safeId);
    if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

    try {
        const transcript = await fetchTranscript(url);
        const fullText = transcript.map(t => t.text).join(' ');
        fs.writeFileSync(path.join(videoDir, 'original.txt'), fullText);

        let vtt = "WEBVTT\n\n";
        transcript.forEach((t, i) => {
            const start = new Date(t.offset * 1000).toISOString().substring(11, 19);
            vtt += `${i+1}\n${start}.000 --> ${start}.500\n${t.text}\n\n`;
        });
        fs.writeFileSync(path.join(videoDir, 'original.vtt'), vtt);
        res.json({ fullText });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Semantic VTT Search (POST)
app.post('/api/search', async (req, res) => {
    const { id, query } = req.body;
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: "API Key required" });
    if (!query) return res.status(400).json({ error: "Search query required" });

    const safeId = sanitizeId(id);
    const vttPath = path.join(downloadsDir, safeId, 'original.vtt');
    if (!fs.existsSync(vttPath)) return res.status(404).json({ error: "VTT file not found" });

    try {
        const vtt = fs.readFileSync(vttPath, 'utf8');
        const genAI = new GoogleGenAI({ apiKey: apiKey });
        
        const result = await genAI.models.generateContent({ 
            model: "gemini-2.5-flash", 
            contents: `Find segments in this VTT relating to "${query}". Return JSON array: [{"text": "...", "timestamp": "HH:MM:SS"}].\n\n${vtt.substring(0, 15000)}` 
        });
        
        const json = JSON.parse(result.text.replace(/```json|```/g, ''));
        res.json({ results: json.map(r => ({ ...r, seconds: timestampToSeconds(r.timestamp) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Draft Script (POST)
app.post('/api/draft-script', async (req, res) => {
    const { id, host1 = 'Alex', host2 = 'Sam', targetLanguage = 'English' } = req.body;
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: "API Key required" });

    const safeId = sanitizeId(id);
    const txtPath = path.join(downloadsDir, safeId, 'original.txt');
    if (!fs.existsSync(txtPath)) return res.status(404).json({ error: "Original transcript not found" });

    try {
        const text = fs.readFileSync(txtPath, 'utf8');
        const genAI = new GoogleGenAI({ apiKey: apiKey });
        
        const prompt = `Draft a podcast script between ${host1} and ${host2} based on the following text. Use strictly "${host1}: Dialogue" and "${host2}: Dialogue" formatting. The entire script MUST be written seamlessly in ${targetLanguage}.\n\nText: ${text}`;
        
        const result = await genAI.models.generateContent({ 
            model: "gemini-2.5-flash", 
            contents: prompt 
        });
        
        res.json({ script: result.text });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Synthesize Audio (POST) - Background Worker with Rate Limiting
app.post('/api/synthesize', synthesizeLimiter, (req, res) => {
    const { id, script, host1 = 'Alex', host2 = 'Sam' } = req.body;
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) return res.status(401).json({ error: "API Key required" });
    if (!script) return res.status(400).json({ error: "Script content required" });

    const safeId = sanitizeId(id);
    
    if (jobs[safeId] && jobs[safeId].status === 'processing') {
        return res.json({ success: true, jobId: safeId, message: "Job already running." });
    }

    jobs[safeId] = { 
        status: 'queued', 
        message: 'Waiting in queue for server resources...',
        timestamp: Date.now() 
    };
    res.json({ success: true, jobId: safeId }); 

    const synthesisTask = async () => {
        return new Promise(async (resolveTask) => {
            jobs[safeId].status = 'processing';
            const videoDir = path.join(downloadsDir, safeId);
            const pcmPath = path.join(videoDir, 'temp.pcm');
            const m4aPath = path.join(videoDir, 'podcast.m4a');
            const vttPath = path.join(videoDir, 'podcast.vtt');
            
            try {
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
                fs.writeFileSync(path.join(videoDir, 'script.txt'), script);

                const genAI = new GoogleGenAI({ apiKey: apiKey });
                const segments = [];
                
                const sanitizedScript = script
                    .replace(/<[^>]*>?/gm, '')               
                    .replace(/\r\n/g, '\n')                  
                    .replace(/[\u200B-\u200D\uFEFF]/g, '')   
                    .trim();

                const MAX_CHUNK_LENGTH = 1500; 
                const regex = /^([a-zA-Z0-9_ ]+)\s*:\s*([\s\S]*?)(?=^[a-zA-Z0-9_ ]+\s*:|\s*$)/gm;
                let m; 
                
                while ((m = regex.exec(sanitizedScript)) !== null) {
                    const speaker = m[1].trim();
                    const text = m[2].trim();
                    
                    if (speaker && text.length > 0) {
                        if (text.length <= MAX_CHUNK_LENGTH) {
                            segments.push({ s: speaker, t: text });
                        } else {
                            const sentences = text.match(/[^.?!]+[.?!]+(?:\s|$)|[^.?!]+$/g) || [text];
                            let currentChunk = "";
                            
                            sentences.forEach(sentence => {
                                const cleanSentence = sentence.trim();
                                if (!cleanSentence) return;
                                
                                if ((currentChunk.length + cleanSentence.length) > MAX_CHUNK_LENGTH) {
                                    if (currentChunk.trim().length > 0) {
                                        segments.push({ s: speaker, t: currentChunk.trim() });
                                    }
                                    if (cleanSentence.length > MAX_CHUNK_LENGTH) {
                                        let pointer = 0;
                                        while (pointer < cleanSentence.length) {
                                            segments.push({ s: speaker, t: cleanSentence.substring(pointer, pointer + MAX_CHUNK_LENGTH) });
                                            pointer += MAX_CHUNK_LENGTH;
                                        }
                                        currentChunk = "";
                                    } else {
                                        currentChunk = cleanSentence; 
                                    }
                                } else {
                                    currentChunk += (currentChunk ? " " : "") + cleanSentence;
                                }
                            });
                            
                            if (currentChunk.trim().length > 0) {
                                segments.push({ s: speaker, t: currentChunk.trim() });
                            }
                        }
                    }
                }

                if (segments.length === 0) {
                    jobs[safeId] = { status: 'error', message: "Could not parse any dialogue. Please ensure the script uses the 'Name: Text' format." };
                    return resolveTask(); 
                }

                const pcmBuffers = [];
                const maleHostRef = host2.toLowerCase();
                let podcastVtt = "WEBVTT\n\n";
                let currentTime = 0;

                for (let i = 0; i < segments.length; i++) {
                    const lineNum = i + 1;
                    const lineText = segments[i].t;
                    jobs[safeId].message = `Synthesizing chunk ${lineNum} of ${segments.length}...`;
                    console.log(`[Job: ${safeId}] 🎙️ Starting chunk ${lineNum}/${segments.length}...`);
                    
                    const voiceName = segments[i].s.toLowerCase().includes(maleHostRef) ? "Puck" : "Aoede";
                    
                    let audioData = null;
                    let attempt = 0;
                    const maxRetries = 3;

                    while (attempt <= maxRetries) {
                        try {
                            const timeoutPromise = new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('API_TIMEOUT: Gemini took too long to respond')), 30000)
                            );

                            const apiPromise = genAI.models.generateContent({
                                model: 'gemini-2.5-flash-preview-tts',
                                contents: lineText,
                                config: {
                                    responseModalities: ["AUDIO"],
                                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } }
                                }
                            });

                            const response = await Promise.race([apiPromise, timeoutPromise]);
                            const base64Audio = response.candidates[0].content.parts[0].inlineData.data;
                            audioData = Buffer.from(base64Audio, 'base64');
                            
                            // STRIP WAV HEADERS TO PREVENT AUDIO CLICKS
                            if (audioData.length > 44 && audioData.toString('utf8', 0, 4) === 'RIFF') {
                                audioData = audioData.subarray(44); 
                            }

                            console.log(`[Job: ${safeId}] ✅ Chunk ${lineNum} success!`);
                            break; 
                        } catch (apiError) {
                            attempt++;
                            const errorMessage = apiError.message || "";
                            console.error(`[Job: ${safeId}] ⚠️ Error on segment ${lineNum} (Attempt ${attempt}):`, errorMessage);
                            
                            const isQuotaExhausted = errorMessage.includes('Quota exceeded') || errorMessage.includes('RESOURCE_EXHAUSTED');
                            if (isQuotaExhausted) {
                                console.error(`[Job: ${safeId}] ❌ Daily API quota exhausted.`);
                                jobs[safeId] = { status: 'error', message: "API Daily Quota Exceeded (100 requests/day). Please try again tomorrow or upgrade your API tier." };
                                return resolveTask();
                            }

                            const isRateLimit = apiError.status === 429 || errorMessage.includes('429') || errorMessage.includes('Too Many Requests');
                            if (attempt > maxRetries || !isRateLimit) {
                                console.error(`[Job: ${safeId}] ❌ Segment ${lineNum} failed permanently. Skipping.`);
                                break; 
                            }
                            
                            const backoffDelay = Math.pow(2, attempt) * 1000; 
                            jobs[safeId].message = `API Rate Limit paused. Retrying segment ${lineNum} in ${backoffDelay/1000}s...`;
                            await delay(backoffDelay);
                        }
                    }

                    if (!audioData) {
                        podcastVtt += `${lineNum}\n${formatVTTTime(currentTime)} --> ${formatVTTTime(currentTime + 1)}\n<v ${segments[i].s}>[Audio generation failed for this chunk]\n\n`;
                        const oneSecondSilence = Buffer.alloc(48000, 0); 
                        pcmBuffers.push(oneSecondSilence);
                        currentTime += 1;
                        continue; 
                    }

                    const duration = audioData.length / 48000;
                    podcastVtt += `${lineNum}\n${formatVTTTime(currentTime)} --> ${formatVTTTime(currentTime + duration)}\n<v ${segments[i].s}>${lineText}\n\n`;
                    
                    pcmBuffers.push(audioData);
                    currentTime += duration;
                    
                    if (i < segments.length - 1) {
                        const nextSpeaker = segments[i + 1].s;
                        if (nextSpeaker !== segments[i].s) {
                            const pauseDuration = 0.5;
                            const dynamicSilence = Buffer.alloc(24000 * 2 * pauseDuration, 0); 
                            pcmBuffers.push(dynamicSilence);
                            currentTime += pauseDuration;
                            await delay(200); 
                        }
                    }
                }

                jobs[safeId].message = 'Compiling high-quality audio...';

                fs.writeFileSync(vttPath, podcastVtt);
                fs.writeFileSync(pcmPath, Buffer.concat(pcmBuffers));
                
                jobs[safeId].process = ffmpeg(pcmPath)
                    .inputOptions(['-f s16le', '-ar 24000', '-ac 1'])
                    .outputOptions(['-c:a aac', '-b:a 96k', '-ar 24000', '-movflags +faststart'])
                    .save(m4aPath)
                    .on('end', () => { 
                        if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath); 
                        jobs[safeId] = { status: 'done', file: 'podcast.m4a' };
                        resolveTask(); 
                    })
                    .on('error', (err) => {
                        if (!err.message.includes('SIGKILL')) {
                            jobs[safeId] = { status: 'error', message: err.message };
                        }
                        resolveTask();
                    });

            } catch (e) {
                jobs[safeId] = { status: 'error', message: e.message };
                resolveTask();
            }
        });
    };

    jobQueue.push({ id: safeId, task: synthesisTask });
    processNextJob();
});

// 5. Check Status (GET)
app.get('/api/status', (req, res) => {
    const safeId = sanitizeId(req.query.id);
    if (!jobs[safeId]) return res.json({ status: 'not_found' });
    const { process, ...safeData } = jobs[safeId];
    res.json(safeData);
});

// 6. DELETE Folder (DELETE)
app.delete('/api/delete-folder', (req, res) => {
    const rawId = req.body.id || req.query.id; 
    if (!rawId) return res.status(400).json({ error: "Missing ID" });
    const safeId = sanitizeId(rawId);
    
    if (jobs[safeId]) {
        if (jobs[safeId].process) jobs[safeId].process.kill('SIGKILL');
        jobs[safeId].status = 'cancelled';
        delete jobs[safeId];
    }

    const folder = path.join(downloadsDir, safeId);
    if (fs.existsSync(folder)) {
        try {
            fs.rmSync(folder, { recursive: true, force: true });
            res.json({ success: true, message: "Folder safely removed." });
        } catch (e) { res.status(500).json({ error: "Failed to delete: " + e.message }); }
    } else res.status(404).json({ error: "Folder not found" }); 
});

// 7. Download All (GET)
app.get('/api/download-zip', (req, res) => {
    const rawId = req.query.id;
    if (!rawId) return res.status(400).send("Missing ID");
    
    const safeId = sanitizeId(rawId);

    if (jobs[safeId] && (jobs[safeId].status === 'processing' || jobs[safeId].status === 'queued')) {
        return res.status(409).send("Wait just a little longer! Your podcast is still rendering. Please try downloading again when it says 'Production Complete'.");
    }

    const folderPath = path.join(downloadsDir, safeId);

    if (!fs.existsSync(folderPath)) {
        return res.status(404).send("Files not found. They may have been deleted.");
    }

    res.attachment(`podcast_assets_${safeId}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => { res.status(500).send({ error: err.message }); });
    archive.pipe(res);

    const filesToZip = [
        { name: 'original_transcript.txt', local: 'original.txt' },
        { name: 'podcast_script.txt', local: 'script.txt' },
        { name: 'podcast_audio.m4a', local: 'podcast.m4a' },
        { name: 'podcast_captions.vtt', local: 'podcast.vtt' }
    ];

    filesToZip.forEach(file => {
        const filePath = path.join(folderPath, file.local);
        if (fs.existsSync(filePath)) archive.file(filePath, { name: file.name });
    });

    archive.finalize();
});

const server = app.listen(port, () => console.log(`Studio running securely on port ${port}`));
server.timeout = 0;
server.keepAliveTimeout = 0; 
server.headersTimeout = 0;