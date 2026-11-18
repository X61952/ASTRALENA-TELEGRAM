/**
 * Website tools — screenshot + explore.
 *  • URL detection / intent detection from chat text
 *  • SSRF-safe page fetching (public internet only, redirects re-checked, size & time limits)
 *  • readable-text / metadata / tech extraction
 *  • screenshots through free screenshot services (custom one via SCREENSHOT_API)
 */
const dns = require('dns').promises;
const net = require('net');
const cfg = require('./config');

// ── finding URLs in text ────────────────────────────────────────────────────
const TLDS = 'com|net|org|io|ai|dev|app|co|ng|me|xyz|info|tech|site|online|store|edu|gov|ly|gg|tv|so|sh|cloud|space|page|blog|news|uk|us|ca|de|fr|in|za|ke|gh|eu|biz|club|top|tools|digital|world|live|pro|studio|design|shop|agency|network|systems|zone';
const URL_RE = new RegExp(`\\bhttps?:\\/\\/[^\\s<>"'\`]+|\\bwww\\.[^\\s<>"'\`]+|\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})\\b(?:\\/[^\\s<>"'\`]*)?`, 'gi');

function normalizeUrl(raw) {
    let u = String(raw || '').trim().replace(/[)\].,;:!?'"]+$/g, '');
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
        const parsed = new URL(u);
        if (!/^https?:$/.test(parsed.protocol)) return null;
        if (!parsed.hostname.includes('.') && !net.isIP(parsed.hostname)) return null;
        return parsed.href;
    } catch { return null; }
}

function extractUrls(text) {
    const found = String(text || '').match(URL_RE) || [];
    const out = [];
    for (const f of found) {
        if (/^[\w.+-]+@/.test(f)) continue; // email-ish
        const n = normalizeUrl(f);
        if (n && !out.includes(n)) out.push(n);
    }
    return out;
}

/** Removes URLs from text (to see what the person asked besides the link). */
const stripUrls = (text) => String(text || '').replace(URL_RE, ' ').replace(/\s{2,}/g, ' ').trim();

// ── what does the person want? ──────────────────────────────────────────────
const SHOT_RE = /\b(screen\s?-?shots?|screen\s?-?grab|screen\s?-?cap(ture)?|snap(shot)?|capture|ss|preview|thumbnail|take a (pic|picture|photo)|(pic|picture|photo|image) of (it|this|that|the)|show me (what )?(it|this|that|the (site|page|website|link)).{0,20}looks?|how (does|do) (it|this|that|the (site|page|website)) look|what (does|do) (it|this|that|the (site|page|website)) look)\b/i;
const EXPLORE_RE = /\b(explore|analy[sz]e|analysis|summari[sz]e|summary|review|inspect|scan|check( (it|this|that|out))?|what('?s| is| does| do)|tell me (about|what|more)|read|visit|open|crawl|break ?down|audit|describe|look (at|into|up|through)|take a look|go (through|over)|investigate|research|extract|info( on| about)?|details|find out|about)\b/i;
const RECORD_RE = /\b(screen\s?-?record(ing)?|screen\s?-?cast|record (this|the|that|it)?\s?(site|website|page|link|url)|(scroll(ing)?|walkthrough|demo) video|video (of|from) (this|the|that|it)( (site|website|page))?|make a video (of|from))\b/i;
const SCRAPE_RE = /\b(scrape|scraper|clone|mirror|rip|save (this|the|that|it)?\s?(site|website|page)|(download|get|grab|save|export|pack(age)?).{0,25}(site|website|web ?page|source( code)?|html).{0,25}(zip|archive|files?)?|(site|website|web ?page|source( code)?|html).{0,25}(as|into|in) (a )?(zip|archive)|zip (this|the|that|it|up))\b/i;
const FETCH_RE = /\b(fetch|download|get( me)?|grab|send( me)?)\b.{0,20}\b(this|that|the|it|file|link|url|image|video|audio|pdf|apk|document|attachment)\b|^\s*(fetch|download|get)\s*$/i;
const FULL_RE = /\b(full\s?-?page|entire|whole (page|site|thing)|scroll|long)\b/i;
const MULTI_RE = /\b(all (the )?pages|whole site|entire site|full site|every page|multiple pages|multi-?page|deep)\b/i;
// "this page", "that link", "the website" ...
const PAGE_REF_RE = /\b(this|that|the|these|those)\s+(web\s?page|page|site|website|link|url|domain|web\s?site)s?\b/i;
const FILE_EXT_RE = /\.(zip|rar|7z|tar|gz|pdf|apk|exe|dmg|iso|mp3|mp4|mkv|mov|avi|wav|ogg|flac|png|jpe?g|gif|webp|svg|csv|json|xml|txt|docx?|xlsx?|pptx?|epub)(\?|#|$)/i;

/** -> { shot, explore, record, scrape, fetch, full, multi, any } for the words around a link. */
function intentOf(text, url = '') {
    const t = stripUrls(text);
    const record = RECORD_RE.test(t);
    const scrape = !record && SCRAPE_RE.test(t);
    const fileUrl = FILE_EXT_RE.test(url);
    const fetchIt = !record && !scrape && (FETCH_RE.test(t) || (fileUrl && /\b(download|fetch|get|send|grab)\b/i.test(t)));
    const shot = !record && !scrape && !fetchIt && SHOT_RE.test(t);
    const explore = !record && !scrape && !fetchIt && EXPLORE_RE.test(t);
    return { shot, explore, record, scrape, fetch: fetchIt, full: FULL_RE.test(t), multi: MULTI_RE.test(t), any: shot || explore || record || scrape || fetchIt };
}
const refersToPage = (text) => PAGE_REF_RE.test(stripUrls(text));
const mentionsPage = (text) => /\b(page|site|website|web\s?page|link|url|web)\b/i.test(text);

// ── safe networking ─────────────────────────────────────────────────────────
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || a >= 224
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
            || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
    }
    if (net.isIPv6(ip)) {
        const l = ip.toLowerCase();
        if (l === '::1' || l === '::') return true;
        if (l.startsWith('fc') || l.startsWith('fd') || /^fe[89ab]/.test(l)) return true;
        const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateIp(mapped[1]);
        return false;
    }
    return true;
}

async function assertPublic(urlStr) {
    const u = new URL(urlStr);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links are supported.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('That address is not on the public internet.');
    if (net.isIP(host)) {
        if (isPrivateIp(host)) throw new Error('That address is not on the public internet.');
        return;
    }
    let addrs;
    try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error(`I can't find "${host}" — check the address.`); }
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not on the public internet.');
}

async function readLimited(res, maxBytes) {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        chunks.push(Buffer.from(value));
        if (total > maxBytes) { truncated = true; try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
    return { buf: Buffer.concat(chunks).subarray(0, maxBytes), truncated };
}

/** GET with manual redirects (each hop re-checked), size + time limits. */
async function safeGet(url, { maxBytes = 2 * 1024 * 1024, timeout = 15000, headers = {}, accept } = {}) {
    let current = url;
    for (let hop = 0; hop <= 4; hop++) {
        await assertPublic(current);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(current, {
                redirect: 'manual',
                signal: ctrl.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AstralenaBot/2.0; +https://t.me)',
                    Accept: accept || 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
                    'Accept-Language': 'en',
                    ...headers,
                },
            });
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                current = new URL(res.headers.get('location'), current).href;
                continue;
            }
            const { buf, truncated } = await readLimited(res, maxBytes);
            return { finalUrl: current, status: res.status, headers: res.headers, body: buf, truncated };
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('The site took too long to respond.');
            throw e;
        } finally { clearTimeout(timer); }
    }
    throw new Error('Too many redirects.');
}

// ── reading a page ──────────────────────────────────────────────────────────
const decodeEntities = (s) => String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;|&ndash;/g, '-').replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } });

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const TECH = [
    ['WordPress', /wp-content|wp-includes|wordpress/i], ['Next.js', /_next\/static|__next/i], ['React', /react(-dom)?(\.|\/|@)|data-reactroot|__REACT/i],
    ['Vue', /vue(\.|\/|@)|data-v-[0-9a-f]{6}/i], ['Angular', /ng-version|angular(\.|\/)/i], ['Svelte', /svelte/i], ['Nuxt', /_nuxt\//i],
    ['Shopify', /cdn\.shopify\.com|shopify/i], ['Wix', /wixstatic|wix\.com/i], ['Squarespace', /squarespace/i], ['Webflow', /webflow/i],
    ['Bootstrap', /bootstrap(\.|\/|@)/i], ['Tailwind CSS', /tailwind/i], ['jQuery', /jquery/i],
    ['Google Analytics', /google-analytics\.com|googletagmanager\.com|gtag\(/i], ['Cloudflare', /cloudflare/i],
    ['Stripe', /js\.stripe\.com/i], ['Firebase', /firebase/i], ['Vercel', /vercel/i], ['Netlify', /netlify/i],
];

function extract(html, finalUrl) {
    const src = String(html || '');
    const pick = (re) => { const m = src.match(re); return m ? decodeEntities(m[1]).trim() : ''; };
    const meta = (name) => pick(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
        || pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'));

    const title = stripTags(pick(/<title[^>]*>([\s\S]*?)<\/title>/i)) || meta('og:title');
    const description = meta('description') || meta('og:description');
    const siteName = meta('og:site_name');
    const lang = pick(/<html[^>]+lang=["']([^"']+)["']/i);
    const generator = meta('generator');

    const body = src
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ');

    const headings = [];
    for (const m of body.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
        const t = stripTags(m[2]);
        if (t && t.length < 140 && !headings.some((h) => h.text === t)) headings.push({ level: +m[1], text: t });
        if (headings.length >= 24) break;
    }

    const links = [];
    let internal = 0, external = 0;
    let host = '';
    try { host = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    for (const m of body.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        let href;
        try { href = new URL(decodeEntities(m[1]), finalUrl); } catch { continue; }
        if (!/^https?:$/.test(href.protocol)) continue;
        const isInternal = href.hostname.replace(/^www\./, '') === host;
        isInternal ? internal++ : external++;
        const label = stripTags(m[2]).slice(0, 60);
        if (label && links.length < 15 && !links.some((l) => l.href === href.href)) links.push({ label, href: href.href, internal: isInternal });
    }

    const images = (body.match(/<img\b/gi) || []).length;
    const forms = (body.match(/<form\b/gi) || []).length;
    const mainHtml = (body.match(/<main[\s\S]*?<\/main>/i) || body.match(/<article[\s\S]*?<\/article>/i) || [body])[0];
    const text = decodeEntities(
        mainHtml.replace(/<\/(p|div|li|h[1-6]|tr|section|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

    const tech = TECH.filter(([, re]) => re.test(src)).map(([n]) => n);
    if (generator && !tech.includes(generator)) tech.unshift(generator);

    return {
        title, description, siteName, lang, headings, links, internal, external, images, forms,
        text: text.slice(0, 9000), words: text.split(/\s+/).filter(Boolean).length, tech: tech.slice(0, 8),
        ogImage: meta('og:image'),
    };
}

/** Fetches + reads a page. Falls back to a "reader" proxy when the page is JavaScript-only. */
async function explorePage(url) {
    const r = await safeGet(url, { maxBytes: 2 * 1024 * 1024 });
    const type = String(r.headers.get('content-type') || '').toLowerCase();
    const server = r.headers.get('server') || '';
    const poweredBy = r.headers.get('x-powered-by') || '';
    if (type && !/html|xml|text/.test(type)) {
        return { url, finalUrl: r.finalUrl, status: r.status, contentType: type, notHtml: true, server, poweredBy, size: r.body.length };
    }
    const html = r.body.toString('utf8');
    const info = extract(html, r.finalUrl);
    let usedReader = false;
    if (info.words < 60) { // probably rendered by JavaScript — try a reader service for the text
        try {
            const rr = await safeGet('https://r.jina.ai/' + r.finalUrl, { maxBytes: 600 * 1024, timeout: 25000, headers: { Accept: 'text/plain' } });
            const txt = rr.body.toString('utf8').trim();
            if (rr.status === 200 && txt.length > 200) { info.text = txt.slice(0, 9000); info.words = txt.split(/\s+/).length; usedReader = true; }
        } catch { /* keep what we have */ }
    }
    if (server && !info.tech.includes(server) && /cloudflare|nginx|apache|vercel|netlify|litespeed|caddy/i.test(server)) info.tech.push(server);
    if (poweredBy) info.tech.push(poweredBy);
    return { url, finalUrl: r.finalUrl, status: r.status, contentType: type, server, poweredBy, usedReader, ...info };
}

// ── screenshots ─────────────────────────────────────────────────────────────
function looksLikeImage(buf) {
    if (!buf || buf.length < 2000) return false;
    return (buf[0] === 0xff && buf[1] === 0xd8)                                   // jpeg
        || (buf[0] === 0x89 && buf[1] === 0x50)                                   // png
        || (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP'); // webp
}

async function getImage(url, timeout = 50000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AstralenaBot/2.0)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!looksLikeImage(buf)) throw new Error('not an image');
        return buf;
    } finally { clearTimeout(timer); }
}

/** → Buffer (jpeg/png). Tries the services in order; throws if all fail. */
async function screenshot(url, { full = false } = {}) {
    await assertPublic(url); // never send private addresses to a third-party service
    const enc = encodeURIComponent(url);
    const attempts = [];
    if (cfg.SCREENSHOT_API) attempts.push(cfg.SCREENSHOT_API.replace(/\{url\}/g, enc).replace(/\{full\}/g, full ? 'true' : 'false'));
    attempts.push(`https://image.thum.io/get/width/1280/crop/${full ? 4200 : 800}/noanimate/${url}`);
    attempts.push(`https://api.microlink.io/?url=${enc}&screenshot=true&meta=false&embed=screenshot.url&viewport.width=1280&viewport.height=800&fullPage=${full}`);

    let lastErr = '';
    for (const a of attempts) {
        try { return await getImage(a); } catch (e) { lastErr = e.message; console.error('[screenshot]', a.split('?')[0].slice(0, 60), e.message); }
    }
    throw new Error('The screenshot services did not respond (' + lastErr + '). Try again in a minute.');
}

module.exports = { safeGet, FILE_EXT_RE, extractUrls, normalizeUrl, stripUrls, intentOf, refersToPage, mentionsPage, explorePage, screenshot, assertPublic, isPrivateIp, extract };
