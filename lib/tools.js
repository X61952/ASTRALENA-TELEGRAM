/**
 * Astralena's tool belt. Pure HTTP + Node (no system binaries), so it runs fine on a Pterodactyl panel.
 * Space: /iss /crew /launches /apod      Info: /weather /wiki /define /ip /dns /headers
 * Utility: /qr /calc /convert /remind /short /password /hash /b64 /translate /imagine /tts /color
 * Server: /ping /id /stats
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const os = require('os');
const cfg = require('./config');
const store = require('./store');
const web = require('./web');
const groq = require('./groq');
const voice = require('./voice');
const media = require('./media');
const { esc, mdToHtml, stripEmoji } = require('./format');
const { replier } = require('./context');

const UA = { 'User-Agent': 'AstralenaBot/3.0 (Telegram bot)' };
async function getJson(url, timeout = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { ...UA, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'the service took too long' : e.message); } finally { clearTimeout(t); }
}
const argsOf = (ctx) => String(ctx.message?.text || '').replace(/^\/\S+\s*/, '').trim();
const fmt = (n, d = 2) => Number(n).toLocaleString('en', { maximumFractionDigits: d });
const utc = (iso) => new Date(iso).toUTCString().replace(' GMT', ' UTC');

// ───────────────────────── space ─────────────────────────
async function iss(ctx, rep) {
    const d = await getJson('https://api.wheretheiss.at/v1/satellites/25544');
    await ctx.reply(
        `<b>International Space Station</b>\nLatitude ${d.latitude.toFixed(3)}, longitude ${d.longitude.toFixed(3)}\nAltitude ${fmt(d.altitude, 1)} km, speed ${fmt(d.velocity, 0)} km/h\nIt is currently in ${esc(d.visibility)}.\n<a href="https://www.openstreetmap.org/?mlat=${d.latitude}&mlon=${d.longitude}#map=4/${d.latitude}/${d.longitude}">Open on a map</a>`,
        rep.extra({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
    await ctx.replyWithLocation(d.latitude, d.longitude, rep.extra()).catch(() => {});
}
async function crew(ctx, rep) {
    const d = await getJson('http://api.open-notify.org/astros.json');
    const by = {};
    for (const p of d.people || []) (by[p.craft] = by[p.craft] || []).push(p.name);
    const text = Object.entries(by).map(([c, n]) => `<b>${esc(c)}</b> (${n.length})\n${n.map(esc).join(', ')}`).join('\n\n');
    await ctx.reply(`<b>${d.number} people in space right now</b>\n\n${text}`, rep.extra({ parse_mode: 'HTML' }));
}
async function launches(ctx, rep) {
    const d = await getJson('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=6&mode=list');
    const rows = (d.results || []).slice(0, 6).map((l) => `<b>${esc(l.name)}</b>\n${esc(utc(l.net))}${l.status?.abbrev ? ' - ' + esc(l.status.abbrev) : ''}${l.pad?.location?.name ? '\n' + esc(l.pad.location.name) : ''}`);
    if (!rows.length) return ctx.reply('No upcoming launches came back right now.', rep.extra());
    await ctx.reply(`<b>Upcoming launches</b>\n\n${rows.join('\n\n')}\n\nTimes are NET (no earlier than) and can slip.`, rep.extra({ parse_mode: 'HTML' }));
}
async function apod(ctx, rep) {
    const d = await getJson(`https://api.nasa.gov/planetary/apod?api_key=${process.env.NASA_API_KEY || 'DEMO_KEY'}`, 20000);
    const cap = `<b>${esc(d.title)}</b> (${esc(d.date)})\n${esc(String(d.explanation || '').slice(0, 700))}${(d.explanation || '').length > 700 ? '...' : ''}`;
    if (d.media_type === 'image') {
        try { await ctx.replyWithPhoto(d.url, rep.extra({ caption: cap.slice(0, 1024), parse_mode: 'HTML' })); return; } catch { /* send as text */ }
    }
    await ctx.reply(`${cap}\n\n${esc(d.url)}`, rep.extra({ parse_mode: 'HTML' }));
}

// ───────────────────────── info ─────────────────────────
const WMO = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm' };
async function weather(ctx, rep, place) {
    if (!place) return ctx.reply('Tell me a place, for example: /weather Lagos', rep.extra());
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`);
    const loc = g.results?.[0];
    if (!loc) return ctx.reply(`I could not find a place called "${place}".`, rep.extra());
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3`);
    const c = w.current, d = w.daily;
    const days = d.time.map((t, i) => `${t}: ${Math.round(d.temperature_2m_min[i])} to ${Math.round(d.temperature_2m_max[i])} C, rain chance ${d.precipitation_probability_max[i] ?? 0}%`).join('\n');
    await ctx.reply(`<b>Weather in ${esc(loc.name)}${loc.country ? ', ' + esc(loc.country) : ''}</b>\nNow: ${Math.round(c.temperature_2m)} C (feels ${Math.round(c.apparent_temperature)} C), ${WMO[c.weather_code] || 'unknown'}\nHumidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h\n\n${esc(days)}`, rep.extra({ parse_mode: 'HTML' }));
}
async function wiki(ctx, rep, q) {
    if (!q) return ctx.reply('Usage: /wiki <topic>', rep.extra());
    const s = await getJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=1&format=json`);
    const title = s?.[1]?.[0];
    if (!title) return ctx.reply(`Wikipedia has nothing on "${q}".`, rep.extra());
    const d = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    await ctx.reply(`<b>${esc(d.title)}</b>\n${esc(String(d.extract || '').slice(0, 1500))}\n\n${esc(d.content_urls?.desktop?.page || '')}`, rep.extra({ parse_mode: 'HTML' }));
}
async function define(ctx, rep, word) {
    if (!word) return ctx.reply('Usage: /define <word>', rep.extra());
    let d;
    try { d = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.split(/\s+/)[0])}`); } catch { return ctx.reply(`No definition found for "${word}".`, rep.extra()); }
    const e = d[0];
    const meanings = (e.meanings || []).slice(0, 3).map((m) => `<i>${esc(m.partOfSpeech)}</i>: ${esc(m.definitions?.[0]?.definition || '')}`).join('\n');
    await ctx.reply(`<b>${esc(e.word)}</b>${e.phonetic ? ' ' + esc(e.phonetic) : ''}\n${meanings}`, rep.extra({ parse_mode: 'HTML' }));
}
async function ipinfo(ctx, rep, q) {
    if (!q) return ctx.reply('Usage: /ip <ip address or domain>', rep.extra());
    const d = await getJson(`https://ipwho.is/${encodeURIComponent(q)}`);
    if (d.success === false) return ctx.reply(`Lookup failed: ${esc(d.message || 'unknown')}`, rep.extra());
    await ctx.reply(`<b>${esc(d.ip)}</b>\n${esc([d.city, d.region, d.country].filter(Boolean).join(', '))}\nISP: ${esc(d.connection?.isp || d.connection?.org || 'unknown')}\nTimezone: ${esc(d.timezone?.id || 'unknown')}`, rep.extra({ parse_mode: 'HTML' }));
}
async function dnsLookup(ctx, rep, q) {
    const host = String(q || '').replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
    if (!host) return ctx.reply('Usage: /dns <domain>', rep.extra());
    const out = [];
    for (const [type, fn] of [['A', () => dns.resolve4(host)], ['AAAA', () => dns.resolve6(host)], ['MX', () => dns.resolveMx(host).then((r) => r.map((x) => `${x.priority} ${x.exchange}`))], ['NS', () => dns.resolveNs(host)], ['TXT', () => dns.resolveTxt(host).then((r) => r.map((x) => x.join('')))]]) {
        try { const r = await fn(); if (r?.length) out.push(`<b>${type}</b>\n${r.slice(0, 6).map((x) => esc(String(x).slice(0, 160))).join('\n')}`); } catch { /* none */ }
    }
    await ctx.reply(out.length ? `<b>DNS for ${esc(host)}</b>\n\n${out.join('\n\n')}` : `No DNS records found for ${esc(host)}.`, rep.extra({ parse_mode: 'HTML' }));
}
async function headers(ctx, rep, q) {
    const url = web.extractUrls(q)[0];
    if (!url) return ctx.reply('Usage: /headers <url>', rep.extra());
    const r = await web.safeGet(url, { maxBytes: 50 * 1024, timeout: 15000 });
    const lines = [...r.headers.entries()].slice(0, 30).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`);
    await ctx.reply(`<b>HTTP ${r.status}</b> ${esc(r.finalUrl)}\n\n<pre>${esc(lines.join('\n'))}</pre>`, rep.extra({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
}

// ───────────────────────── utility ─────────────────────────
async function qr(ctx, rep, text) {
    if (!text) return ctx.reply('Usage: /qr <text or link>', rep.extra());
    let QR;
    try { QR = require('qrcode'); } catch { return ctx.reply('The QR engine is not installed. Run npm install.', rep.extra()); }
    const buf = await QR.toBuffer(text.slice(0, 1000), { width: 640, margin: 2 });
    await ctx.replyWithPhoto({ source: buf }, rep.extra({ caption: 'QR code' }));
}

// safe calculator (no eval): + - * / ^ % ( ) and functions
function calc(expr) {
    const src = String(expr).toLowerCase().replace(/,/g, '').replace(/\bpi\b/g, String(Math.PI)).replace(/\be\b/g, String(Math.E)).replace(/(?<=[\d)\s])x(?=[\d(.\s])/g, '*').replace(/\^/g, '**');
    const tokens = src.match(/\d*\.?\d+(?:e[+-]?\d+)?|\*\*|[a-z]+|[-+*/%(),]/g);
    if (!tokens || tokens.join('').length < src.replace(/\s/g, '').length) throw new Error('I can only handle numbers, + - * / ^ %, brackets and functions like sqrt, sin, log.');
    let i = 0;
    const FN = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, log: Math.log10, ln: Math.log, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, exp: Math.exp };
    const peek = () => tokens[i], next = () => tokens[i++];
    function primary() {
        const t = next();
        if (t === undefined) throw new Error('The expression ended too early.');
        if (t === '(') { const v = addsub(); if (next() !== ')') throw new Error('Missing a closing bracket.'); return v; }
        if (t === '-') return -power();
        if (t === '+') return power();
        if (/^[a-z]+$/.test(t)) {
            if (!FN[t]) throw new Error(`Unknown function "${t}".`);
            if (next() !== '(') throw new Error(`${t} needs brackets, like ${t}(4).`);
            const v = addsub(); if (next() !== ')') throw new Error('Missing a closing bracket.');
            return FN[t](v);
        }
        const n = Number(t); if (Number.isNaN(n)) throw new Error(`I did not understand "${t}".`); return n;
    }
    function power() { const b = primary(); if (peek() === '**') { next(); return Math.pow(b, power()); } return b; }
    function muldiv() { let v = power(); while (['*', '/', '%'].includes(peek())) { const o = next(); const r = power(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; }
    function addsub() { let v = muldiv(); while (['+', '-'].includes(peek())) { const o = next(); const r = muldiv(); v = o === '+' ? v + r : v - r; } return v; }
    const out = addsub();
    if (i < tokens.length) throw new Error('Something in that expression did not make sense.');
    return out;
}

const UNITS = {
    length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, mile: 1609.344, miles: 1609.344, ft: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, yd: 0.9144, nm: 1852, au: 1.495978707e11, ly: 9.4607304725808e15, pc: 3.0856775814914e16 },
    mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, lbs: 0.45359237, oz: 0.028349523125 },
    speed: { 'm/s': 1, 'km/h': 1 / 3.6, kmh: 1 / 3.6, mph: 0.44704, knot: 0.514444, knots: 0.514444, c: 299792458, mach: 343 },
    data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1048576, gib: 1073741824 },
    time: { s: 1, sec: 1, min: 60, h: 3600, hr: 3600, day: 86400, days: 86400, week: 604800, year: 31557600, yr: 31557600 },
    volume: { l: 1, ml: 0.001, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625 },
};
function convert(text) {
    const m = String(text).trim().match(/^(-?[\d.,]+)\s*([a-z/°]+)\s*(?:to|in|into|->|=)\s*([a-z/°]+)$/i);
    if (!m) throw new Error('Usage: /convert 10 km to miles');
    const v = parseFloat(m[1].replace(/,/g, '')); const from = m[2].toLowerCase().replace('°', ''); const to = m[3].toLowerCase().replace('°', '');
    const temp = { c: (x) => x, f: (x) => (x - 32) * 5 / 9, k: (x) => x - 273.15 };
    const tempOut = { c: (x) => x, f: (x) => x * 9 / 5 + 32, k: (x) => x + 273.15 };
    if (temp[from] && tempOut[to]) return `${fmt(v, 4)} ${from.toUpperCase()} = ${fmt(tempOut[to](temp[from](v)), 4)} ${to.toUpperCase()}`;
    for (const table of Object.values(UNITS)) {
        if (table[from] !== undefined && table[to] !== undefined) return `${fmt(v, 6)} ${from} = ${fmt(v * table[from] / table[to], 8)} ${to}`;
    }
    throw new Error(`I cannot convert ${from} to ${to}. I know length (incl. au, ly, pc), mass, speed, data, time, volume and temperature (C, F, K).`);
}

function parseDuration(s) {
    const re = /(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\b/gi;
    let ms = 0, found = false, m;
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
    while ((m = re.exec(s))) { found = true; ms += parseFloat(m[1]) * unit[m[2][0].toLowerCase()]; }
    return found ? ms : null;
}
const durText = (ms) => { const s = Math.round(ms / 1000); if (s < 90) return `${s} seconds`; const m = Math.round(s / 60); if (m < 90) return `${m} minutes`; const h = Math.round(m / 60); if (h < 36) return `${h} hours`; return `${Math.round(h / 24)} days`; };

function remind(ctx, rep, args) {
    const sub = args.split(/\s+/)[0]?.toLowerCase();
    const mine = store.data().reminders.filter((r) => r.userId === ctx.from.id);
    if (sub === 'list' || !args) {
        if (!mine.length) return ctx.reply('You have no reminders. Usage: /remind 30m drink water  or  /remind 2h 15m check the rocket launch', rep.extra());
        return ctx.reply('Your reminders\n\n' + mine.map((r) => `#${r.id}  in ${durText(r.at - Date.now())}: ${r.text}`).join('\n') + '\n\n/remind cancel <number> to remove one.', rep.extra());
    }
    if (sub === 'cancel' || sub === 'delete') {
        const id = parseInt(args.split(/\s+/)[1], 10);
        const d = store.data();
        const before = d.reminders.length;
        d.reminders = d.reminders.filter((r) => !(r.id === id && r.userId === ctx.from.id));
        store.save();
        return ctx.reply(d.reminders.length < before ? `Reminder #${id} removed.` : 'I could not find that reminder.', rep.extra());
    }
    const ms = parseDuration(args);
    if (!ms) return ctx.reply('Usage: /remind 30m drink water  (units: s, m, h, d, w; you can combine like 1h 30m)', rep.extra());
    if (ms < 5000 || ms > 365 * 864e5) return ctx.reply('Pick a time between 5 seconds and one year.', rep.extra());
    const text = args.replace(/(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\b/gi, '').replace(/^\s*(to|about|that)\s+/i, '').trim() || 'your reminder';
    const d = store.data();
    const id = (d.reminders.reduce((a, r) => Math.max(a, r.id), 0)) + 1;
    d.reminders.push({ id, chatId: ctx.chat.id, userId: ctx.from.id, name: ctx.from.first_name || '', at: Date.now() + ms, text: text.slice(0, 300) });
    store.save();
    return ctx.reply(`Okay, I will remind you in ${durText(ms)}: ${text}`, rep.extra());
}
function startReminders(bot) {
    const tick = async () => {
        const d = store.data();
        const due = d.reminders.filter((r) => r.at <= Date.now());
        if (!due.length) return;
        d.reminders = d.reminders.filter((r) => r.at > Date.now());
        store.save();
        for (const r of due) {
            const who = r.chatId < 0 ? `<a href="tg://user?id=${r.userId}">${esc(r.name || 'you')}</a>, ` : '';
            await bot.telegram.sendMessage(r.chatId, `${who}reminder: ${esc(r.text)}`, { parse_mode: 'HTML' }).catch((e) => console.error('[reminder]', e.message));
        }
    };
    setInterval(() => tick().catch(() => {}), 15000).unref?.();
}

async function shorten(ctx, rep, q) {
    const url = web.extractUrls(q)[0];
    if (!url) return ctx.reply('Usage: /short <url>', rep.extra());
    const res = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { headers: UA });
    const t = (await res.text()).trim();
    if (!res.ok || !/^https?:/.test(t)) throw new Error(t.slice(0, 120) || 'shortener failed');
    await ctx.reply(t, rep.extra());
}
function password(ctx, rep, q) {
    const len = Math.min(64, Math.max(8, parseInt(q, 10) || 16));
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
    return ctx.reply(`<code>${esc(out)}</code>\nGenerated on the spot and not stored anywhere.`, rep.extra({ parse_mode: 'HTML' }));
}
function hash(ctx, rep, q) {
    if (!q) return ctx.reply('Usage: /hash <text>', rep.extra());
    const h = (a) => crypto.createHash(a).update(q).digest('hex');
    return ctx.reply(`<b>MD5</b>\n<code>${h('md5')}</code>\n<b>SHA-1</b>\n<code>${h('sha1')}</code>\n<b>SHA-256</b>\n<code>${h('sha256')}</code>`, rep.extra({ parse_mode: 'HTML' }));
}
function b64(ctx, rep, q) {
    const m = q.match(/^(enc(?:ode)?|dec(?:ode)?)\s+([\s\S]+)$/i);
    if (!m) return ctx.reply('Usage: /b64 encode <text>  or  /b64 decode <text>', rep.extra());
    const out = /^enc/i.test(m[1]) ? Buffer.from(m[2], 'utf8').toString('base64') : Buffer.from(m[2], 'base64').toString('utf8');
    return ctx.reply(`<code>${esc(out.slice(0, 3500))}</code>`, rep.extra({ parse_mode: 'HTML' }));
}
async function translate(ctx, rep, q) {
    const m = q.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return ctx.reply('Usage: /translate <language> <text>   e.g. /translate french good morning', rep.extra());
    if (!groq.hasKey()) return ctx.reply('Translation needs GROQ_API_KEY.', rep.extra());
    const out = await groq.chat({ system: 'You are a translator. Output only the translation, nothing else, no quotes, no notes, no emojis.', messages: [{ role: 'user', content: `Translate into ${m[1]}:\n\n${m[2]}` }], maxTokens: 800 });
    await ctx.reply(stripEmoji(out) || 'I could not translate that.', rep.extra());
}
async function imagine(ctx, rep, prompt, noLimit = false) {
    if (!prompt) return ctx.reply('Usage: /imagine <describe the image>', rep.extra());
    if (!noLimit && !require('./stats').heavyAllowed(ctx.from?.id)) return ctx.reply('You have used a lot of heavy tools this hour. Try again a bit later.', rep.extra());
    await ctx.sendChatAction('upload_photo').catch(() => {});
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 500))}?width=1024&height=1024&nologo=true&enhance=true&seed=${Math.floor(Math.random() * 1e6)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: UA });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 3000) throw new Error('no image came back');
        await ctx.replyWithPhoto({ source: buf }, rep.extra({ caption: prompt.slice(0, 200) }));
    } finally { clearTimeout(t); }
}
async function tts(ctx, rep, text) {
    if (!text) return ctx.reply('Usage: /tts <text to speak>', rep.extra());
    await ctx.sendChatAction('record_voice').catch(() => {});
    const v = await voice.generate(text, { voice: store.getSettings(ctx.from.id).voice });
    if (!v) return ctx.reply('I could not generate the voice right now. Run /voicetest to see what is wrong.', rep.extra());
    await rep.voice(v.buffer, v.ext);
}
async function color(ctx, rep, q) {
    const m = String(q).trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (!m) return ctx.reply('Usage: /color #ff8800', rep.extra());
    let hex = m[1]; if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let png;
    try { png = await require('sharp')({ create: { width: 400, height: 200, channels: 3, background: { r, g, b } } }).png().toBuffer(); } catch { return ctx.reply(`#${hex}  rgb(${r}, ${g}, ${b})`, rep.extra()); }
    await ctx.replyWithPhoto({ source: png }, rep.extra({ caption: `#${hex.toUpperCase()}\nrgb(${r}, ${g}, ${b})` }));
}

// ───────────────────────── curl ─────────────────────────
function shellSplit(input) {
    const src = String(input).replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\\\r?\n/g, ' ');
    const out = [];
    let cur = '', has = false, q = null;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (q) {
            if (c === q) q = null;
            else if (c === '\\' && q === '"' && /["\\$`]/.test(src[i + 1] || '')) cur += src[++i];
            else cur += c;
        } else if (c === '"' || c === "'") { q = c; has = true; }
        else if (c === '\\' && i + 1 < src.length) { cur += src[++i]; has = true; }
        else if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
        else { cur += c; has = true; }
    }
    if (q) throw new Error('A quote was opened but never closed.');
    if (has || cur) out.push(cur);
    return out;
}

/** Parses "curl -X POST -H 'A: b' -d '{...}' https://..." (the leading "curl" is optional). */
function parseCurl(text) {
    const t = shellSplit(text);
    if (t[0] && t[0].toLowerCase() === 'curl') t.shift();
    const o = { method: null, headers: {}, data: null, url: null, head: false, include: false, auth: null, timeout: 20 };
    const need = (i, flag) => { if (i + 1 >= t.length) throw new Error(`${flag} needs a value.`); return t[i + 1]; };
    for (let i = 0; i < t.length; i++) {
        const a = t[i];
        if (a === '-X' || a === '--request') o.method = need(i++, a).toUpperCase();
        else if (a === '-H' || a === '--header') {
            const h = need(i++, a); const k = h.indexOf(':');
            if (k > 0) o.headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
        }
        else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '--data-ascii') o.data = (o.data == null ? '' : o.data + '&') + need(i++, a);
        else if (a === '--json') { o.data = need(i++, a); o.headers['Content-Type'] = o.headers['Content-Type'] || 'application/json'; o.headers.Accept = o.headers.Accept || 'application/json'; }
        else if (a === '-A' || a === '--user-agent') o.headers['User-Agent'] = need(i++, a);
        else if (a === '-u' || a === '--user') o.auth = need(i++, a);
        else if (a === '-e' || a === '--referer') o.headers.Referer = need(i++, a);
        else if (a === '-b' || a === '--cookie') o.headers.Cookie = need(i++, a);
        else if (a === '-m' || a === '--max-time') o.timeout = Math.min(30, Math.max(2, parseFloat(need(i++, a)) || 20));
        else if (a === '-I' || a === '--head') o.head = true;
        else if (a === '-i' || a === '--include') o.include = true;
        else if (a === '-o' || a === '--output' || a === '-w' || a === '--write-out' || a === '--connect-timeout' || a === '--retry') i++;
        else if (/^-[a-zA-Z]+$/.test(a) && !/[XHdAuebmoIiw]/.test(a.slice(1))) continue; // -sSLk and friends
        else if (a.startsWith('-')) continue; // unknown switches are ignored
        else if (!o.url) o.url = a;
    }
    if (!o.url) throw new Error('I could not find a URL in that.');
    o.url = web.normalizeUrl(o.url);
    if (!o.url) throw new Error('That URL does not look valid.');
    o.method = o.head ? 'HEAD' : (o.method || (o.data != null ? 'POST' : 'GET'));
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(o.method)) throw new Error(`The ${o.method} method is not supported.`);
    if (o.auth) o.headers.Authorization = 'Basic ' + Buffer.from(o.auth).toString('base64');
    if (o.data != null && !Object.keys(o.headers).some((h) => h.toLowerCase() === 'content-type')) {
        o.headers['Content-Type'] = /^\s*[{\[]/.test(o.data) ? 'application/json' : 'application/x-www-form-urlencoded';
    }
    return o;
}

const curlHits = new Map();
async function runCurl(o) {
    let url = o.url, method = o.method, body = o.data;
    const started = Date.now();
    for (let hop = 0; hop <= 5; hop++) {
        await web.assertPublic(url); // public internet only, re-checked on every redirect
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), o.timeout * 1000);
        try {
            const res = await fetch(url, {
                method, redirect: 'manual', signal: ctrl.signal,
                headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*', ...o.headers },
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
            });
            const loc = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && loc) {
                url = new URL(loc, url).href;
                if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
                continue;
            }
            let buf = Buffer.alloc(0), truncated = false;
            if (method !== 'HEAD' && res.body) {
                const reader = res.body.getReader();
                const chunks = []; let total = 0;
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    total += value.length; chunks.push(Buffer.from(value));
                    if (total > 1024 * 1024) { truncated = true; try { await reader.cancel(); } catch { /* ignore */ } break; }
                }
                buf = Buffer.concat(chunks).subarray(0, 1024 * 1024);
            }
            return { status: res.status, statusText: res.statusText, headers: res.headers, buf, truncated, finalUrl: url, ms: Date.now() - started, method };
        } catch (e) {
            throw new Error(e.name === 'AbortError' ? `Timed out after ${o.timeout}s.` : e.message);
        } finally { clearTimeout(timer); }
    }
    throw new Error('Too many redirects.');
}

async function curl(ctx, rep, text) {
    if (!text) return ctx.reply('Usage: /curl <url>  or a full command, for example:\n/curl -X POST https://httpbin.org/post -H "Content-Type: application/json" -d \'{"name":"astralena"}\'\n\nSupported: -X, -H, -d, --json, -u, -A, -I, -i, -m. Only public websites.', rep.extra());
    const uid = ctx.from.id, now = Date.now();
    const hits = (curlHits.get(uid) || []).filter((t) => now - t < 60000);
    if (hits.length >= 10) return ctx.reply('Slow down a little, that is 10 requests in the last minute.', rep.extra());
    hits.push(now); curlHits.set(uid, hits);

    const o = parseCurl(text);
    await ctx.sendChatAction('typing').catch(() => {});
    const r = await runCurl(o);
    const type = String(r.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const isText = !type || /text|json|xml|javascript|html|x-www-form|yaml|csv|svg/.test(type);
    const head = [`${r.method} ${r.finalUrl}`, `HTTP ${r.status} ${r.statusText}`.trim(), `${r.ms} ms, ${r.buf.length}${r.truncated ? '+' : ''} bytes${type ? ', ' + type : ''}`];
    let hdrs = '';
    if (o.include || o.head) hdrs = [...r.headers.entries()].map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`).join('\n');
    else hdrs = ['content-type', 'content-length', 'server', 'location', 'cache-control', 'set-cookie'].filter((k) => r.headers.get(k)).map((k) => `${k}: ${String(r.headers.get(k)).slice(0, 160)}`).join('\n');

    let bodyText = '';
    if (r.buf.length && isText) {
        bodyText = r.buf.toString('utf8');
        if (/json/.test(type)) { try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* keep raw */ } }
    } else if (r.buf.length) bodyText = `(binary content, ${(r.buf.length / 1024).toFixed(1)} KB. Use /fetch to download it.)`;

    const summary = head.join('\n') + (hdrs ? '\n\n' + hdrs : '');
    const full = summary + (bodyText ? '\n\n' + bodyText : '');
    if (full.length <= 3500) return ctx.reply(`<pre>${esc(full)}</pre>`, rep.extra({ parse_mode: 'HTML' }));
    await ctx.reply(`<pre>${esc(summary.slice(0, 1200))}\n\n${esc(bodyText.slice(0, 1800))}\n...</pre>`, rep.extra({ parse_mode: 'HTML' }));
    await ctx.replyWithDocument({ source: Buffer.from(full, 'utf8'), filename: 'curl-response.txt' }, rep.extra({ caption: 'Full response' }));
}

// ───────────────────────── server ─────────────────────────
async function ping(ctx) {
    const t0 = Date.now();
    const m = await ctx.reply('Pinging...');
    await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, `Pong. ${Date.now() - t0} ms round trip to Telegram.`).catch(() => {});
}
const uptime = () => { const s = Math.floor(process.uptime()); return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
async function stats(ctx, rep) {
    const mem = process.memoryUsage();
    const ff = await media.hasFfmpeg();
    const browser = require('./browser');
    await ctx.reply(`Astralena status\nUptime: ${uptime()}\nMemory: ${(mem.rss / 1048576).toFixed(0)} MB used\nNode ${process.version} on ${os.platform()} ${os.arch()}\nffmpeg: ${ff ? 'available' : 'not found'}\nBrowser (screen recording): ${browser.available() ? 'available' : 'not installed'}\nReminders pending: ${store.data().reminders.length}`, rep.extra());
}

// ───────────────────────── wiring ─────────────────────────
const TOOLS_TEXT = `<b>ASTRALENA TOOLBOX</b>
━━━━━━━━━━━━━━━━━

<b>Space</b>  /iss  /crew  /launches  /apod
<b>Web</b>  /search  /screenshot  /explore  /scrape  /record  /fetch  /app
<b>Everyday</b>  /weather  /wiki  /define  /translate  /calc  /convert  /remind  /qr  /color  /imagine  /tts  /voice
<b>Network and dev</b>  /ip  /dns  /headers  /short  /curl  /password  /hash  /b64
<b>Memory</b>  /memory  /remember  /forget
<b>Modes</b>  /modes  /secretary
<b>Group admins</b>  /warn  /mute  /kick  /antilink  /antiflood  /welcome  /rules
<b>Owner</b>  /broadcast  /usage  /ban  /unban  /stats

Send me a document (PDF, Word, Excel, PowerPoint, text, code) and ask about it. I can also chain tools on my own: ask for something that needs a search, a link and a reminder and I'll work through it.`;

/** Quick natural-language shortcuts (only called for messages addressed to her). Returns true if handled. */
async function nlRoute(ctx, m, text) {
    const t = String(text).trim();
    const rep = replier(ctx, m.msg.message_id);
    const guard = (fn) => fn().catch((e) => ctx.reply('That did not work: ' + String(e.message).slice(0, 160), rep.extra()).catch(() => {}));
    if (/^curl\s/i.test(t)) { await guard(() => curl(ctx, rep, t)); return true; }
    // with the agent on, only short, direct requests use these shortcuts; longer ones go to the agent
    if (cfg.AGENT !== 'off' && t.split(/\s+/).length > 6) return false;
    let x;
    if ((x = t.match(/\bweather\b.{0,12}\b(?:in|at|for|of)\s+([^?.!]+)/i)) || (x = t.match(/^(?:what'?s |how'?s )?(?:the )?weather\s+([^?.!]+)/i))) { await guard(() => weather(ctx, rep, x[1].trim())); return true; }
    if (/\bwhere\b.{0,10}\b(is|'s)\b.{0,10}\b(the )?iss\b|\biss\b.{0,15}\b(location|position|now|right now)\b/i.test(t)) { await guard(() => iss(ctx, rep)); return true; }
    if (/\bwho\b.{0,15}\b(is|are)\b.{0,10}\b(in|on)\b.{0,6}\b(space|the iss)\b/i.test(t)) { await guard(() => crew(ctx, rep)); return true; }
    if (/\b(upcoming|next|latest)\b.{0,12}\b(rocket )?launch(es)?\b/i.test(t)) { await guard(() => launches(ctx, rep)); return true; }
    if (/\b(astronomy picture|picture of the day|\bapod\b|nasa picture)\b/i.test(t)) { await guard(() => apod(ctx, rep)); return true; }
    if ((x = t.match(/^(?:make|generate|create|draw)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|art|illustration)\s+(?:of|showing|with)\s+(.+)/i))) { await guard(() => imagine(ctx, rep, x[1])); return true; }
    if ((x = t.match(/^(?:make|generate|create)\s+(?:me\s+)?(?:a\s+)?qr(?:\s*code)?\s+(?:for|of|with)\s+(.+)/i))) { await guard(() => qr(ctx, rep, x[1])); return true; }
    if ((x = t.match(/^(?:calculate|calc|compute|what is|what's)\s+([\d(][\d\s+\-*/^%().,x]*[\d)])\s*\??$/i)) && /[+\-*/^%]/.test(x[1])) {
        try { await ctx.reply(`${x[1].trim()} = ${fmt(calc(x[1]), 10)}`, rep.extra()); return true; } catch { /* let the AI handle it */ }
    }
    if (/^curl\s/i.test(t)) { await guard(() => curl(ctx, rep, t)); return true; }
    if ((x = t.match(/^remind me (?:in|after)\s+(.+)/i))) { await guard(async () => remind(ctx, rep, x[1])); return true; }
    return false;
}

function register(bot) {
    const wrap = (fn) => (ctx) => {
        const rep = replier(ctx, ctx.chat.type === 'private' ? null : ctx.message.message_id);
        return Promise.resolve(fn(ctx, rep, argsOf(ctx))).catch((e) => {
            console.error('[tool]', ctx.message?.text?.split(' ')[0], e.message);
            return ctx.reply('That did not work: ' + String(e.message).slice(0, 180), rep.extra()).catch(() => {});
        });
    };
    bot.command('tools', (ctx) => ctx.reply(TOOLS_TEXT, { parse_mode: 'HTML' }));
    bot.command('iss', wrap((c, r) => iss(c, r)));
    bot.command('crew', wrap((c, r) => crew(c, r)));
    bot.command('launches', wrap((c, r) => launches(c, r)));
    bot.command('apod', wrap((c, r) => apod(c, r)));
    bot.command('weather', wrap((c, r, a) => weather(c, r, a)));
    bot.command('wiki', wrap((c, r, a) => wiki(c, r, a)));
    bot.command('define', wrap((c, r, a) => define(c, r, a)));
    bot.command('ip', wrap((c, r, a) => ipinfo(c, r, a)));
    bot.command('dns', wrap((c, r, a) => dnsLookup(c, r, a)));
    bot.command('headers', wrap((c, r, a) => headers(c, r, a)));
    bot.command('curl', wrap((c, r, a) => curl(c, r, a)));
    bot.command('qr', wrap((c, r, a) => qr(c, r, a)));
    bot.command(['calc', 'math'], wrap((c, r, a) => { try { return c.reply(`${a} = ${fmt(calc(a), 10)}`, r.extra()); } catch (e) { return c.reply(e.message, r.extra()); } }));
    bot.command(['convert', 'conv'], wrap((c, r, a) => { try { return c.reply(convert(a), r.extra()); } catch (e) { return c.reply(e.message, r.extra()); } }));
    bot.command(['remind', 'reminder'], wrap((c, r, a) => remind(c, r, a)));
    bot.command(['short', 'shorten'], wrap((c, r, a) => shorten(c, r, a)));
    bot.command(['password', 'pass'], wrap((c, r, a) => password(c, r, a)));
    bot.command('hash', wrap((c, r, a) => hash(c, r, a)));
    bot.command('b64', wrap((c, r, a) => b64(c, r, a)));
    bot.command(['translate', 'tr'], wrap((c, r, a) => translate(c, r, a)));
    bot.command(['imagine', 'generate', 'img'], wrap((c, r, a) => imagine(c, r, a)));
    bot.command('tts', wrap((c, r, a) => tts(c, r, a)));
    bot.command(['search', 'google'], wrap(async (c, r, a) => {
        if (!a) return c.reply('Usage: /search <what to look up>', r.extra());
        await c.sendChatAction('typing').catch(() => {});
        const res = await require('./search').search(a, 6);
        const text = res.results.map((x, i) => `${i + 1}. <a href="${esc(x.url).replace(/"/g, '%22')}">${esc(x.title.slice(0, 90))}</a>\n${esc(x.snippet.slice(0, 160))}`).join('\n\n');
        await c.reply(`<b>${esc(a)}</b>\n\n${text}`, r.extra({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
    }));
    bot.command('color', wrap((c, r, a) => color(c, r, a)));
    bot.command('ping', (ctx) => ping(ctx));
    bot.command('id', (ctx) => ctx.reply(`Your ID: ${ctx.from.id}\nThis chat: ${ctx.chat.id}${ctx.message.reply_to_message?.from ? `\nReplied user: ${ctx.message.reply_to_message.from.id}` : ''}`));
    bot.command('stats', wrap((c, r) => stats(c, r)));
}

module.exports = { register, startReminders, nlRoute, TOOLS_TEXT, calc, convert, parseDuration, parseCurl, shellSplit, runCurl, getJson, WMO, imagine, qr, fmt, utc, durText };
