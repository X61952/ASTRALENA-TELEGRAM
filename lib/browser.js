/**
 * OPTIONAL real-browser features (better screenshots of JavaScript sites + scrolling screen recordings).
 * Needs Chromium. On a panel: add the package "puppeteer" (npm install puppeteer) or "puppeteer-core" with CHROME_PATH
 * pointing at a Chrome/Chromium binary. If neither is available, available() is false and the bot says so politely.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const web = require('./web');
const media = require('./media');

let pp = null;
let tried = false;
function lib() {
    if (!tried) {
        tried = true;
        for (const n of ['puppeteer', 'puppeteer-core']) { try { pp = require(n); break; } catch { /* next */ } }
    }
    return pp;
}
const available = () => !!lib();
function ffBin() { try { return require('ffmpeg-static') || 'ffmpeg'; } catch { return 'ffmpeg'; } }

async function launch() {
    const p = lib();
    if (!p) throw new Error('A browser is not installed on this server (add the "puppeteer" package).');
    return p.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--mute-audio'],
    });
}

async function openPage(browser, url, { width = 1280, height = 720 } = {}) {
    await web.assertPublic(url);
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        try {
            const h = new URL(req.url()).hostname;
            if (/^(localhost)$/i.test(h) || (/^[\d.]+$|:/.test(h) && web.isPrivateIp(h.replace(/^\[|\]$/g, '')))) return req.abort();
        } catch { /* ignore */ }
        req.continue();
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 }).catch(async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); });
    await new Promise((r) => setTimeout(r, 800));
    return page;
}

async function screenshot(url, { full = false } = {}) {
    const browser = await launch();
    try {
        const page = await openPage(browser, url);
        const buf = await page.screenshot({ type: 'jpeg', quality: 82, fullPage: full });
        return Buffer.from(buf);
    } finally { await browser.close().catch(() => {}); }
}

/** Scrolls through the page and returns an MP4 (needs ffmpeg). */
async function record(url, { seconds = 10 } = {}) {
    if (!(await media.hasFfmpeg())) throw new Error('Recording needs ffmpeg on the server.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-rec-'));
    const browser = await launch();
    try {
        const page = await openPage(browser, url);
        const fps = 6;
        const frames = Math.max(12, seconds * fps);
        const total = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
        const view = 720;
        const maxY = Math.max(0, total - view);
        for (let i = 0; i < frames; i++) {
            const t = i / (frames - 1);
            const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            await page.evaluate((y) => window.scrollTo(0, y), Math.round(maxY * eased));
            await new Promise((r) => setTimeout(r, 90));
            const buf = await page.screenshot({ type: 'jpeg', quality: 72 });
            fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.jpg`), buf);
        }
        const out = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.mp4`);
        await new Promise((resolve, reject) => {
            execFile(ffBin(), ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.jpg'),
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-movflags', '+faststart', out], { timeout: 90000 }, (e, _o, se) => (e ? reject(new Error(String(se || e.message).slice(0, 160))) : resolve()));
        });
        return fs.readFileSync(out);
    } finally {
        await browser.close().catch(() => {});
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

module.exports = { available, screenshot, record };
