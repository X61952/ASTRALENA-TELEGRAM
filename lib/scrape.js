/**
 * Website -> ZIP. Downloads the page (or several pages), its CSS, JavaScript, images and fonts, rewrites the
 * links so the copy opens offline, and packs everything into a zip. Pure JavaScript (fflate), no zip binary needed.
 * Note: it is a static snapshot — content that a site builds with JavaScript after loading may be missing.
 */
const crypto = require('crypto');
const web = require('./web');

const MAX_TOTAL = 24 * 1024 * 1024;
const MAX_FILE = 6 * 1024 * 1024;
const MAX_ASSETS = 140;

let fflate = null;
function zipLib() {
    if (!fflate) { try { fflate = require('fflate'); } catch { throw new Error('The zip engine (fflate) is not installed. Run npm install.'); } }
    return fflate;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const skip = (u) => !u || /^(data:|mailto:|tel:|javascript:|blob:|#|about:)/i.test(u.trim());

function safeName(s) { return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'file'; }

function localAssetPath(abs, contentType) {
    let base = 'file';
    let ext = '';
    try {
        const u = new URL(abs);
        const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        const m = last.match(/^(.*?)(\.[a-z0-9]{1,5})?$/i);
        base = safeName(m?.[1] || 'file'); ext = (m?.[2] || '').toLowerCase();
    } catch { /* ignore */ }
    if (!ext) {
        const t = String(contentType || '');
        ext = /css/.test(t) ? '.css' : /javascript|ecmascript/.test(t) ? '.js' : /png/.test(t) ? '.png' : /jpe?g/.test(t) ? '.jpg' : /webp/.test(t) ? '.webp'
            : /svg/.test(t) ? '.svg' : /gif/.test(t) ? '.gif' : /woff2/.test(t) ? '.woff2' : /woff/.test(t) ? '.woff' : /icon/.test(t) ? '.ico' : '';
    }
    const h = crypto.createHash('md5').update(abs).digest('hex').slice(0, 6);
    return `assets/${base}-${h}${ext}`;
}

/** Collects asset references (raw string as written in the HTML + absolute URL). */
function htmlAssets(html, pageUrl) {
    const out = [];
    const add = (raw) => {
        raw = String(raw || '').trim();
        if (skip(raw)) return;
        try { out.push({ raw, abs: new URL(raw.replace(/&amp;/g, '&'), pageUrl).href }); } catch { /* ignore */ }
    };
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/rel=["'][^"']*(stylesheet|icon|apple-touch-icon)[^"']*["']/i.test(tag)) continue;
        const h = tag.match(/href=["']([^"']+)["']/i); if (h) add(h[1]);
    }
    for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1]);
    for (const m of html.matchAll(/<(?:img|source|video|audio|input|embed)\b[^>]*>/gi)) {
        const tag = m[0];
        for (const a of ['src', 'data-src', 'poster']) { const x = tag.match(new RegExp(`\\b${a}=["']([^"']+)["']`, 'i')); if (x) add(x[1]); }
        const ss = tag.match(/\b(?:srcset|data-srcset)=["']([^"']+)["']/i);
        if (ss) ss[1].split(',').slice(0, 6).forEach((c) => add(c.trim().split(/\s+/)[0]));
    }
    for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]); // inline styles
    const seen = new Set();
    return out.filter((a) => (seen.has(a.raw) ? false : seen.add(a.raw)));
}

function rewrite(text, map) {
    let out = text;
    for (const [raw, local] of map) {
        out = out.replace(new RegExp(`(?<=["'(,\\s=])${escRe(raw)}(?=["')\\s,>])`, 'g'), local);
    }
    return out;
}

async function pool(items, size, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (i < items.length) { const item = items[i++]; await fn(item).catch(() => {}); }
    }));
}

async function scrapeSite(startUrl, { pages = 1 } = {}) {
    const { zipSync, strToU8 } = zipLib();
    const startHost = new URL(startUrl).hostname.replace(/^www\./, '');
    const files = {};
    let total = 0;
    const stats = { pages: 0, assets: 0, skipped: 0 };

    // 1) pages
    const queue = [startUrl];
    const seen = new Set([startUrl]);
    const list = [];
    while (queue.length && list.length < pages) {
        const u = queue.shift();
        let r;
        try { r = await web.safeGet(u, { maxBytes: 3 * 1024 * 1024 }); } catch (e) { if (!list.length) throw e; continue; }
        const type = String(r.headers.get('content-type') || '').toLowerCase();
        if (type && !/html|xml/.test(type)) { if (!list.length) throw new Error('That link is a file, not a web page. Use /fetch for files.'); continue; }
        const html = r.body.toString('utf8');
        list.push({ url: r.finalUrl, html });
        if (pages > 1) {
            for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
                let abs; try { abs = new URL(m[1].replace(/&amp;/g, '&'), r.finalUrl); } catch { continue; }
                abs.hash = '';
                if (!/^https?:$/.test(abs.protocol) || abs.hostname.replace(/^www\./, '') !== startHost) continue;
                if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|mp4|mp3|css|js|ico|xml|json)(\?|$)/i.test(abs.pathname)) continue;
                if (!seen.has(abs.href) && seen.size < 60) { seen.add(abs.href); queue.push(abs.href); }
            }
        }
    }
    if (!list.length) throw new Error('Could not read that page.');
    const pagePath = new Map(); // abs page url -> local path
    list.forEach((p, i) => pagePath.set(p.url, i === 0 ? 'index.html' : `pages/${safeName(new URL(p.url).pathname.replace(/\/$/, '').split('/').pop() || 'page' + i)}-${i}.html`));

    // 2) assets
    const assetMap = new Map(); // abs -> local
    const wanted = new Map();   // abs -> true
    for (const p of list) for (const a of htmlAssets(p.html, p.url)) wanted.set(a.abs, true);
    const absList = [...wanted.keys()].slice(0, MAX_ASSETS);
    stats.skipped += Math.max(0, wanted.size - absList.length);

    const cssQueue = [];
    await pool(absList, 6, async (abs) => {
        if (total > MAX_TOTAL) { stats.skipped++; return; }
        const r = await web.safeGet(abs, { maxBytes: MAX_FILE, timeout: 20000, accept: '*/*' });
        if (r.status >= 400 || r.truncated || !r.body.length) { stats.skipped++; return; }
        const type = String(r.headers.get('content-type') || '').toLowerCase();
        const local = localAssetPath(r.finalUrl, type);
        total += r.body.length;
        files[local] = new Uint8Array(r.body);
        assetMap.set(abs, local);
        stats.assets++;
        if (/css/.test(type) || /\.css(\?|$)/i.test(abs)) cssQueue.push({ local, abs: r.finalUrl, css: r.body.toString('utf8') });
    });

    // 3) files referenced from CSS (fonts, images) — one level deep
    for (const c of cssQueue) {
        const refs = [];
        for (const m of c.css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) { if (!skip(m[1])) { try { refs.push({ raw: m[1].trim(), abs: new URL(m[1].trim(), c.abs).href }); } catch { /* ignore */ } } }
        const cmap = new Map();
        await pool(refs.slice(0, 40), 6, async (ref) => {
            if (total > MAX_TOTAL || stats.assets >= MAX_ASSETS + 60) return;
            let local = assetMap.get(ref.abs);
            if (!local) {
                const r = await web.safeGet(ref.abs, { maxBytes: MAX_FILE, timeout: 20000, accept: '*/*' });
                if (r.status >= 400 || r.truncated || !r.body.length) return;
                local = localAssetPath(r.finalUrl, String(r.headers.get('content-type') || ''));
                total += r.body.length; files[local] = new Uint8Array(r.body); assetMap.set(ref.abs, local); stats.assets++;
            }
            cmap.set(ref.raw, local.replace(/^assets\//, '')); // css lives in assets/, so the path is relative to it
        });
        files[c.local] = strToU8(rewrite(c.css, cmap));
    }

    // 4) rewrite pages + write them
    const readable = [];
    for (const p of list) {
        const local = pagePath.get(p.url);
        const up = local.includes('/') ? '../' : '';
        const map = new Map();
        for (const a of htmlAssets(p.html, p.url)) { const l = assetMap.get(a.abs); if (l) map.set(a.raw, up + l); }
        for (const m of p.html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
            try { const abs = new URL(m[1].replace(/&amp;/g, '&'), p.url); abs.hash = ''; const l = pagePath.get(abs.href); if (l) map.set(m[1], (local.includes('/') ? (l.startsWith('pages/') ? l.slice(6) : '../' + l) : l)); } catch { /* ignore */ }
        }
        let html = rewrite(p.html, map)
            .replace(/<base\b[^>]*>/gi, '')
            .replace(/\sintegrity=["'][^"']*["']/gi, '')
            .replace(/\scrossorigin(=["'][^"']*["'])?/gi, '');
        files[local] = strToU8(html);
        const info = web.extract(p.html, p.url);
        readable.push(`=== ${p.url}\n${info.title ? info.title + '\n' : ''}${info.text}\n`);
        stats.pages++;
    }
    files['content.txt'] = strToU8(readable.join('\n'));
    files['_scrape-info.txt'] = strToU8(
        `Scraped by Astralena AI\nSource: ${startUrl}\nDate: ${new Date().toISOString()}\nPages: ${stats.pages}\nAssets: ${stats.assets}\nSkipped: ${stats.skipped}\n\n` +
        'This is a static snapshot. Content a site builds with JavaScript after loading may be missing. Open index.html in a browser.\n');

    const zip = Buffer.from(zipSync(files, { level: 6 }));
    return { buffer: zip, stats, host: startHost };
}

module.exports = { scrapeSite, htmlAssets, rewrite };
