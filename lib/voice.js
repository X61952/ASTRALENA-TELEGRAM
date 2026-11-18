/**
 * Astralena AI — text → voice note (FEMALE voice). Built to work even on servers WITHOUT ffmpeg.
 * Providers, in order:
 *   1. Groq Orpheus TTS  (voice "hannah")  → needs GROQ_API_KEY + ffmpeg (WAV → Opus)
 *   2. Microsoft Edge TTS, Ogg/Opus output  (en-US-AriaNeural) → no ffmpeg, no key
 *   3. Microsoft Edge TTS, MP3 output       → Telegram accepts MP3 as a voice message
 *   4. Google Translate TTS (female, MP3)   → last resort, no key
 * generate() → { buffer, ext, via } | null.   diagnose() → a status report (used by /voicetest).
 */
const groq = require('./groq');
const media = require('./media');
const cfg = require('./config');

const MAX_CHARS = 700;

/** Female voices people can switch to with /voice. id = provider:voiceName */
const VOICES = [
    { id: 'groq:hannah', label: 'Hannah', note: 'warm, natural' },
    { id: 'groq:diana', label: 'Diana', note: 'calm, mature' },
    { id: 'groq:autumn', label: 'Autumn', note: 'soft, friendly' },
    { id: 'edge:en-US-AriaNeural', label: 'Aria', note: 'US, clear' },
    { id: 'edge:en-US-JennyNeural', label: 'Jenny', note: 'US, friendly' },
    { id: 'edge:en-US-AvaNeural', label: 'Ava', note: 'US, expressive' },
    { id: 'edge:en-US-EmmaNeural', label: 'Emma', note: 'US, easygoing' },
    { id: 'edge:en-US-MichelleNeural', label: 'Michelle', note: 'US, professional' },
    { id: 'edge:en-GB-SoniaNeural', label: 'Sonia', note: 'UK' },
    { id: 'edge:en-GB-LibbyNeural', label: 'Libby', note: 'UK, youthful' },
    { id: 'edge:en-AU-NatashaNeural', label: 'Natasha', note: 'Australian' },
    { id: 'edge:en-NG-EzinneNeural', label: 'Ezinne', note: 'Nigerian' },
    { id: 'edge:en-KE-AsiliaNeural', label: 'Asilia', note: 'Kenyan' },
    { id: 'edge:en-ZA-LeahNeural', label: 'Leah', note: 'South African' },
    { id: 'edge:en-IN-NeerjaNeural', label: 'Neerja', note: 'Indian' },
];
const DEFAULT_ID = `groq:${cfg.TTS_VOICE}`;
const findVoice = (q) => {
    const t = String(q || '').trim().toLowerCase().replace(/\s*\(.*\)$/, '');
    if (!t) return null;
    return VOICES.find((v) => v.id.toLowerCase() === t || v.label.toLowerCase() === t || v.id.split(':')[1].toLowerCase() === t) || null;
};

function cleanForSpeech(text) {
    return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*_~`#>]/g, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\uFE0F]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── provider 1: Groq Orpheus ──
async function groqTts(text, voiceName) {
    if (!groq.hasKey()) return { err: 'GROQ_API_KEY not set' };
    if (text.length > 190) return { err: 'text longer than 190 chars (Orpheus limit)' };
    if (!(await media.hasFfmpeg())) return { err: 'needs ffmpeg (not found)' };
    const r = await groq.speech(text, voiceName || cfg.TTS_VOICE);
    if (!r.ok) return { err: r.error };
    const ogg = await media.toOpus(r.buffer, 'wav');
    return ogg ? { buf: ogg, ext: 'ogg' } : { err: 'ffmpeg could not encode Opus' };
}

// ── providers 2 + 3: Edge TTS ──
async function edgeTts(text, kind, voiceName) {
    let lib;
    try { lib = require('msedge-tts'); } catch { return { err: 'msedge-tts is not installed (npm install failed?)' }; }
    const { MsEdgeTTS, OUTPUT_FORMAT } = lib;
    const fmt = kind === 'ogg'
        ? (OUTPUT_FORMAT.OGG_24KHZ_16BIT_MONO_OPUS || OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS)
        : OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
    if (!fmt) return { err: 'this msedge-tts version has no such output format' };
    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voiceName || cfg.EDGE_VOICE, fmt);
        const r = tts.toStream(text);
        const stream = r?.audioStream || r;
        const chunks = [];
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out after 30s')), 30000);
            stream.on('data', (c) => chunks.push(Buffer.from(c)));
            stream.on('end', () => { clearTimeout(timer); resolve(); });
            stream.on('close', () => { clearTimeout(timer); resolve(); });
            stream.on('error', (e) => { clearTimeout(timer); reject(e); });
        });
        const buf = Buffer.concat(chunks);
        if (buf.length < 800) return { err: 'no audio came back' };
        return { buf, ext: kind === 'ogg' ? 'ogg' : 'mp3' };
    } catch (e) { return { err: e.message || String(e) }; }
}

// ── provider 4: Google Translate TTS ──
function sentences(text, max = 180) {
    const parts = text.match(/[^.!?;:]+[.!?;:]*\s*/g) || [text];
    const out = [];
    let cur = '';
    for (const p of parts) {
        if ((cur + p).length > max) { if (cur) out.push(cur.trim()); cur = ''; }
        if (p.length > max) { for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max).trim()); } else cur += p;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
}
async function googleTts(text) {
    try {
        const bufs = [];
        for (const chunk of sentences(text)) {
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(chunk)}`;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            try {
                const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' } });
                if (!res.ok) return { err: `HTTP ${res.status}` };
                bufs.push(Buffer.from(await res.arrayBuffer()));
            } finally { clearTimeout(timer); }
        }
        const buf = Buffer.concat(bufs);
        return buf.length > 800 ? { buf, ext: 'mp3' } : { err: 'no audio came back' };
    } catch (e) { return { err: e.name === 'AbortError' ? 'timed out' : e.message }; }
}

/** MP3 → Opus when ffmpeg exists (nicer voice bubble); otherwise send the MP3 as it is. */
async function polish(r, via) {
    if (r.ext === 'mp3' && (await media.hasFfmpeg())) {
        const ogg = await media.toOpus(r.buf, 'mp3');
        if (ogg) return { buffer: ogg, ext: 'ogg', via };
    }
    return { buffer: r.buf, ext: r.ext, via };
}

/** -> { buffer, ext, via } or null (too long / every provider failed). opts.voice = a VOICES id. */
async function generate(text, opts = {}) {
    const clean = cleanForSpeech(text);
    if (!clean || clean.length > MAX_CHARS) return null;

    const chosen = findVoice(opts.voice) || findVoice(DEFAULT_ID) || VOICES[0];
    const [kind, name] = chosen.id.split(':');
    const edgeName = kind === 'edge' ? name : cfg.EDGE_VOICE;
    const steps = [];
    if (kind === 'groq') steps.push(['groq-orpheus', () => groqTts(clean, name)]);
    steps.push(['edge-opus', () => edgeTts(clean, 'ogg', edgeName)]);
    steps.push(['edge-mp3', () => edgeTts(clean, 'mp3', edgeName)]);
    steps.push(['google-tts', () => googleTts(clean)]);

    for (const [via, run] of steps) {
        const r = await run();
        if (r.buf) return via === 'groq-orpheus' ? { buffer: r.buf, ext: r.ext, via } : polish(r, via);
        console.error(`[voice] ${via} failed: ${r.err}`);
    }
    return null;
}

/** Runs every provider once and reports. → { lines: string[], sample } */
async function diagnose() {
    const lines = [];
    const ff = await media.hasFfmpeg();
    lines.push(ff ? `[ok] ffmpeg: ${ff}` : '[fail] ffmpeg: NOT FOUND. Install ffmpeg on the server (or let npm install ffmpeg-static)');
    lines.push(groq.hasKey() ? '[ok] GROQ_API_KEY: set' : '[fail] GROQ_API_KEY: missing');
    const text = 'Voice check. If you can hear this, my voice is working.';
    let sample = null;
    for (const [name, run] of [
        [`Groq Orpheus (${cfg.TTS_VOICE})`, () => groqTts(text)],
        [`Edge Opus (${cfg.EDGE_VOICE})`, () => edgeTts(text, 'ogg')],
        ['Edge MP3', () => edgeTts(text, 'mp3')],
        ['Google TTS', () => googleTts(text)],
    ]) {
        const r = await run();
        if (r.buf) { lines.push(`[ok] ${name}: ${(r.buf.length / 1024).toFixed(0)} KB`); sample = sample || { buffer: r.buf, ext: r.ext }; }
        else lines.push(`[fail] ${name}: ${String(r.err).slice(0, 140)}`);
    }
    return { lines, sample };
}

module.exports = { generate, diagnose, VOICES, DEFAULT_ID, findVoice, MAX_CHARS, cleanForSpeech };
