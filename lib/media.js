/**
 * Astralena AI — media toolbox. Everything takes/returns Buffers.
 * sharp = images · ffmpeg = video/audio (ffmpeg-static if installed, otherwise the system ffmpeg).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const cfg = require('./config');

let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

const TEMP = path.join(__dirname, '..', 'temp');

function needSharp() {
    if (!sharp) throw new Error('Image engine (sharp) is not installed.');
    return sharp;
}
function ffmpegBin() {
    try { const p = require('ffmpeg-static'); if (p) return p; } catch { /* next */ }
    return 'ffmpeg';
}
function tmp(ext) {
    fs.mkdirSync(TEMP, { recursive: true });
    return path.join(TEMP, `g_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
}
function rm(...files) { for (const f of files) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
function ff(args, timeout = 60000) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegBin(), ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, _o, se) => {
            if (err) reject(new Error(err.code === 'ENOENT' ? 'ffmpeg is not installed on this server.' : String(se || err.message).slice(0, 200)));
            else resolve();
        });
    });
}

let ffmpegChecked = null;
/** → version string if ffmpeg works on this server, else null (cached). */
function hasFfmpeg() {
    if (!ffmpegChecked) {
        ffmpegChecked = new Promise((resolve) => {
            execFile(ffmpegBin(), ['-version'], { timeout: 8000 }, (err, out) => resolve(err ? null : String(out).split('\n')[0].slice(0, 60)));
        });
    }
    return ffmpegChecked;
}

// ── download from Telegram ──
async function download(telegram, fileId) {
    const link = await telegram.getFileLink(fileId);
    const res = await fetch(link.href || String(link));
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
}

// ── images ──
async function toJpeg(buffer, max = 1600, quality = 85) {
    return needSharp()(buffer, { animated: false })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
}
async function toBase64Jpeg(buffer) {
    return { base64: (await toJpeg(buffer)).toString('base64'), mimetype: 'image/jpeg' };
}
async function toPng(buffer) {
    return needSharp()(buffer, { animated: false }).png().toBuffer();
}
async function isAnimated(buffer) {
    try {
        const meta = await needSharp()(buffer, { animated: true }).metadata();
        return !!(meta.pages && meta.pages > 1);
    } catch { return false; }
}

// ── remove background (your API) ──
async function removeBackground(buffer) {
    const jpg = await toJpeg(buffer, 2000, 90);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 70000);
    try {
        const res = await fetch(cfg.REMOVEBG_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: `data:image/jpeg;base64,${jpg.toString('base64')}` }),
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('The background-removal service is down right now.');
        const out = Buffer.from(await res.arrayBuffer());
        if (out.length < 500 || out[0] === 0x7b) throw new Error('Background removal failed.');
        return out;
    } finally { clearTimeout(timer); }
}

// ── stickers (Telegram wants a 512px WebP) ──
async function imageToSticker(buffer, { round = false } = {}) {
    const s = needSharp();
    const img = s(buffer, { animated: false }).rotate();
    if (round) {
        const mask = Buffer.from('<svg width="512" height="512"><circle cx="256" cy="256" r="256" fill="#fff"/></svg>');
        const square = await img.resize(512, 512, { fit: 'cover' }).png().toBuffer();
        return s(square).composite([{ input: mask, blend: 'dest-in' }]).webp({ quality: 85 }).toBuffer();
    }
    return img.resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 85 }).toBuffer();
}

async function webmFrame(buffer) {
    const input = tmp('webm'), output = tmp('png');
    try {
        fs.writeFileSync(input, buffer);
        await ff(['-i', input, '-frames:v', '1', output]);
        return fs.readFileSync(output);
    } finally { rm(input, output); }
}

/** Sticker (static webp / video webm / animated tgs thumbnail) → MP4 that Telegram plays as a GIF. */
async function stickerToGif(buffer, { isVideo = false } = {}) {
    const input = tmp(isVideo ? 'webm' : 'png'), output = tmp('mp4');
    try {
        const vf = 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p';
        if (isVideo) {
            fs.writeFileSync(input, buffer);
            await ff(['-i', input, '-vf', vf, '-movflags', '+faststart', '-an', output]);
        } else {
            const flat = await needSharp()(buffer, { animated: false }).flatten({ background: '#ffffff' }).png().toBuffer();
            fs.writeFileSync(input, flat);
            await ff(['-loop', '1', '-i', input, '-t', '3', '-r', '15', '-vf', vf, '-movflags', '+faststart', '-an', output]);
        }
        return fs.readFileSync(output);
    } finally { rm(input, output); }
}

// ── resize / tweak ──
const PRESETS = { tiny: 320, small: 480, medium: 800, large: 1280, big: 1280, hd: 1920, '4k': 3840 };

function parseResizeSpec(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return null;
    let m = t.match(/(\d{2,4})\s*[x×*]\s*(\d{2,4})/);
    if (m) return { width: +m[1], height: +m[2] };
    m = t.match(/(\d{1,3})\s*%/);
    if (m && +m[1] >= 1 && +m[1] <= 400) return { percent: +m[1] };
    if (/\bhalf\b/.test(t)) return { percent: 50 };
    if (/\bdouble\b/.test(t)) return { percent: 200 };
    for (const k of Object.keys(PRESETS)) if (new RegExp(`\\b${k}\\b`).test(t)) return { width: PRESETS[k] };
    m = t.match(/(?:width|w)\s*(?:of|=|to)?\s*(\d{2,4})|^(\d{2,4})(?:\s*px)?$|(\d{2,4})\s*px/);
    if (m) return { width: +(m[1] || m[2] || m[3]) };
    m = t.match(/(?:height|h)\s*(?:of|=|to)?\s*(\d{2,4})/);
    if (m) return { height: +m[1] };
    return null;
}

async function resizeImage(buffer, spec) {
    const s = needSharp();
    const base = s(buffer, { animated: false }).rotate();
    const meta = await s(buffer, { animated: false }).metadata();
    let w = spec.width, h = spec.height;
    if (spec.percent) {
        w = Math.round((meta.width || 512) * spec.percent / 100);
        h = Math.round((meta.height || 512) * spec.percent / 100);
    }
    w = w ? Math.min(w, 4096) : undefined;
    h = h ? Math.min(h, 4096) : undefined;
    const out = await base.resize({ width: w, height: h, fit: spec.width && spec.height ? 'fill' : 'inside', withoutEnlargement: false }).jpeg({ quality: 90 }).toBuffer();
    const m2 = await s(out).metadata();
    return { buffer: out, width: m2.width, height: m2.height };
}

async function blackAndWhite(buffer) {
    return needSharp()(buffer, { animated: false }).rotate().grayscale().jpeg({ quality: 90 }).toBuffer();
}
async function compress(buffer) {
    return needSharp()(buffer, { animated: false }).rotate()
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 55, mozjpeg: true }).toBuffer();
}

// ── video / audio ──
async function videoFrame(buffer) {
    const input = tmp('mp4'), output = tmp('jpg');
    try {
        fs.writeFileSync(input, buffer);
        await ff(['-i', input, '-frames:v', '1', '-q:v', '3', output]);
        return fs.readFileSync(output);
    } finally { rm(input, output); }
}
async function audioFromVideo(buffer, seconds = 600) {
    const input = tmp('mp4'), output = tmp('mp3');
    try {
        fs.writeFileSync(input, buffer);
        await ff(['-i', input, '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', output]);
        if (!fs.existsSync(output)) return null;
        const out = fs.readFileSync(output);
        return out.length > 2000 ? out : null;
    } catch { return null; } finally { rm(input, output); }
}
async function toMp3(buffer) {
    const input = tmp('ogg'), output = tmp('mp3');
    try {
        fs.writeFileSync(input, buffer);
        await ff(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', output]);
        return fs.existsSync(output) ? fs.readFileSync(output) : null;
    } catch { return null; } finally { rm(input, output); }
}
/** Any audio → ogg/opus (what Telegram shows as a voice note). */
async function toOpus(buffer, ext = 'mp3') {
    const input = tmp(ext), output = tmp('ogg');
    try {
        fs.writeFileSync(input, buffer);
        try {
            await ff(['-i', input, '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', output]);
        } catch {
            await ff(['-i', input, '-vn', '-c:a', 'opus', '-strict', '-2', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', output]);
        }
        const out = fs.readFileSync(output);
        return out.length > 500 ? out : null;
    } catch (e) { console.error('[voice] opus encode failed:', e.message); return null; } finally { rm(input, output); }
}

// ── OCR (OCR.space if a key is set; otherwise the vision model does it) ──
async function ocrSpace(buffer) {
    if (!cfg.OCRSPACE_API_KEY) return '';
    let jpg = await toJpeg(buffer, 1800, 85);
    if (jpg.length > 950 * 1024) jpg = await toJpeg(buffer, 1400, 70);
    if (jpg.length > 950 * 1024) jpg = await toJpeg(buffer, 1000, 60);
    const form = new FormData();
    form.append('apikey', cfg.OCRSPACE_API_KEY);
    form.append('language', 'eng');
    form.append('isOverlayRequired', 'false');
    form.append('file', new Blob([jpg], { type: 'image/jpeg' }), 'scan.jpg');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
        const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form, signal: ctrl.signal });
        const data = await res.json();
        return String(data?.ParsedResults?.[0]?.ParsedText || '').trim();
    } finally { clearTimeout(timer); }
}

module.exports = {
    hasFfmpeg, download, toJpeg, toBase64Jpeg, toPng, isAnimated,
    removeBackground, imageToSticker, webmFrame, stickerToGif,
    parseResizeSpec, resizeImage, blackAndWhite, compress,
    videoFrame, audioFromVideo, toMp3, toOpus, ocrSpace,
};
