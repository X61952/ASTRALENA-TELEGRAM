/** Telegram side of the website tools: /screenshot, /explore, and the /buttons for bare links. */
const web = require('./web');
const groq = require('./groq');
const persona = require('./persona');
const store = require('./store');
const media = require('./media');
const { esc, mdToHtml, split } = require('./format');
const { replier } = require('./context');
const browser = require('./browser');
const scraper = require('./scrape');
const fetcher = require('./fetcher');

const tokens = new Map(); // short id -> { url, owner, expires }
const TTL = 15 * 60 * 1000;
setInterval(() => { const n = Date.now(); for (const [k, v] of tokens) if (n > v.expires) tokens.delete(k); }, TTL).unref?.();

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const short = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function keyboard(token, owner) {
    return {
        inline_keyboard: [
            [{ text: 'Screenshot', callback_data: `wb:${owner}:s:${token}` }, { text: 'Explore', callback_data: `wb:${owner}:e:${token}` }],
            [{ text: 'Scrape to zip', callback_data: `wb:${owner}:z:${token}` }, { text: 'Record video', callback_data: `wb:${owner}:r:${token}` }],
            [{ text: 'Download file', callback_data: `wb:${owner}:f:${token}` }],
        ],
    };
}

/** A bare link was sent: ask what to do with it. */
async function offer(ctx, m, url) {
    const token = Math.random().toString(36).slice(2, 10);
    tokens.set(token, { url, owner: String(m.userId), expires: Date.now() + TTL });
    await replier(ctx, m.msg.message_id).plain(
        `Got the link: ${hostOf(url)}\n\nWhat should I do with it?\n\nScreenshot it, explore it (what it is and what is on it), scrape it into a zip, record a scrolling video, or download it as a file.\n\nTap a button, or just tell me.`,
        { reply_markup: keyboard(token, m.userId) });
    return true;
}

function briefing(data, note) {
    const lines = [
        `URL: ${data.finalUrl}`,
        `Title: ${data.title || '(none)'}`,
        data.siteName ? `Site name: ${data.siteName}` : '',
        `Meta description: ${data.description || '(none)'}`,
        data.lang ? `Language: ${data.lang}` : '',
        `HTTP status: ${data.status}`,
        data.tech.length ? `Detected tech: ${data.tech.join(', ')}` : '',
        `Words: ${data.words} · images: ${data.images} · forms: ${data.forms} · internal links: ${data.internal} · external links: ${data.external}`,
        data.headings.length ? 'Headings:\n' + data.headings.slice(0, 18).map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n') : '',
        data.links.length ? 'Notable links:\n' + data.links.slice(0, 10).map((l) => `- ${l.label} -> ${l.href}`).join('\n') : '',
        `Page text (truncated):\n${data.text.slice(0, 6000)}`,
    ].filter(Boolean).join('\n');
    return note ? `${lines}\n\nThe person also said: "${note}"` : lines;
}

async function summarise(data, note) {
    if (!groq.hasKey()) return '';
    const system = persona.buildSystem(store.chatbot(), {}) +
        '\n\nYou just explored a website. Using ONLY the extracted data you are given, write a sharp, friendly briefing: what the site is, what it offers or its key sections, who it is for, anything notable (tech, design, red flags). 90-170 words, in your usual voice, no headers, no bullet walls. If the data is thin (e.g. a JavaScript-only page), say so honestly. Never invent content that is not in the data. If the person asked a specific question about the site, answer it first.';
    const text = await groq.chat({ system, messages: [{ role: 'user', content: briefing(data, note) }], maxTokens: 700 });
    return text;
}

async function doScreenshot(ctx, rep, url, full) {
    await ctx.sendChatAction('upload_photo').catch(() => {});
    let buf = null;
    if (browser.available()) { try { buf = await browser.screenshot(url, { full }); } catch (e) { console.error('[browser screenshot]', e.message); } }
    if (!buf) buf = await web.screenshot(url, { full });
    const caption = `<b>${esc(hostOf(url))}</b>\n${esc(short(url, 300))}`;
    await ctx.replyWithPhoto({ source: buf }, rep.extra({ caption, parse_mode: 'HTML' }));
    if (full) {
        const png = buf[0] === 0x89;
        await rep.document(buf, `${hostOf(url)}-fullpage.${png ? 'png' : 'jpg'}`, 'Full-resolution file');
    }
}

async function doExplore(ctx, rep, url, note, userId) {
    await ctx.sendChatAction('typing').catch(() => {});
    const data = await web.explorePage(url);

    if (data.notHtml) {
        await ctx.reply(`That link is a file, not a web page.\n\nType: ${data.contentType}\nSize: ~${(data.size / 1024).toFixed(0)} KB\nHTTP ${data.status}`, rep.extra());
        return;
    }
    let summary = '';
    try { summary = await summarise(data, note); } catch (e) { console.error('[explore summary]', e.message); }

    const out = [];
    out.push(`<b>${esc(short(data.title || data.siteName || hostOf(data.finalUrl), 120))}</b>`);
    out.push(`<code>${esc(hostOf(data.finalUrl))}</code> · HTTP ${data.status}${data.usedReader ? ' · JS-rendered page' : ''}`);
    out.push('');
    if (summary) out.push(mdToHtml(summary));
    else if (data.description) out.push(esc(short(data.description, 400)));
    else out.push(esc(short(data.text, 400)) || 'Not much readable content on that page.');
    out.push('');
    if (data.tech.length) out.push(`<b>Tech:</b> ${esc(data.tech.join(' · '))}`);
    out.push(`${data.words.toLocaleString('en')} words · ${data.images} images · ${data.internal} internal / ${data.external} external links`);
    const top = data.links.filter((l) => l.internal).slice(0, 5);
    if (top.length) out.push(`${top.map((l) => `<a href="${esc(l.href).replace(/"/g, '%22')}">${esc(short(l.label, 28))}</a>`).join(' · ')}`);

    let html = out.join('\n');
    if (html.length > 4000) html = html.slice(0, 3990) + '…';
    try {
        await ctx.reply(html, rep.extra({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
    } catch (e) {
        await ctx.reply(`${data.title || hostOf(url)}\n\n${summary || data.description || ''}`.slice(0, 4000), rep.extra());
    }
    if (summary && userId) {
        const key = ctx.chat.type === 'private' ? `dm:${userId}` : `grp:${ctx.chat.id}`;
        store.pushHistory(key, 'user', `[asked me to explore ${data.finalUrl}]`);
        store.pushHistory(key, 'assistant', summary);
    }
}

async function doScrape(ctx, rep, url, multi) {
    await ctx.sendChatAction('upload_document').catch(() => {});
    const r = await scraper.scrapeSite(url, { pages: multi ? 8 : 1 });
    if (r.buffer.length > 49 * 1024 * 1024) throw new Error('The zip came out bigger than 49 MB, which is Telegram\'s limit for bots.');
    await ctx.replyWithDocument({ source: r.buffer, filename: `${r.host}-site.zip` }, rep.extra({
        caption: `${r.host}: ${r.stats.pages} page(s), ${r.stats.assets} files, ${(r.buffer.length / 1048576).toFixed(2)} MB.\nStatic snapshot: open index.html. Content a site builds with JavaScript may be missing.`,
    }));
}

async function doRecord(ctx, rep, url) {
    if (!browser.available()) {
        await ctx.reply('Screen recording needs a real browser on the server, and this one does not have it. The owner can enable it by installing the "puppeteer" package (see the README). Screenshots, exploring and scraping already work without it.', rep.extra());
        return;
    }
    await ctx.sendChatAction('upload_video').catch(() => {});
    const mp4 = await browser.record(url, { seconds: 10 });
    await ctx.replyWithVideo({ source: mp4, filename: `${hostOf(url)}.mp4` }, rep.extra({ caption: `${hostOf(url)} (scrolling recording)` }));
}

/** run({ ctx, replyTo, url, shot, explore, scrape, record, multi, full, note, userId }) */
async function run({ ctx, replyTo, url, shot = false, explore = false, scrape = false, record = false, multi = false, full = false, note = '', userId, noLimit = false }) {
    const rep = replier(ctx, replyTo);
    if (!noLimit && (scrape || record) && !require('./stats').heavyAllowed(userId)) { await rep.plain('You have used a lot of heavy tools this hour. Try again a bit later.'); return true; }
    if (!shot && !explore && !scrape && !record) explore = true;
    let ack = null;
    try { ack = await rep.plain(`Looking at ${hostOf(url)}, give me a moment...`); } catch { /* ignore */ }

    const task = (fn) => fn().then(() => null, (e) => e);
    const shotP = shot ? task(() => doScreenshot(ctx, rep, url, full)) : Promise.resolve(null);
    const exploreP = explore ? task(() => doExplore(ctx, rep, url, note, userId)) : Promise.resolve(null);
    const scrapeP = scrape ? task(() => doScrape(ctx, rep, url, multi)) : Promise.resolve(null);
    const recordP = record ? task(() => doRecord(ctx, rep, url)) : Promise.resolve(null);
    const [e1, e2, e3, e4] = [await shotP, await exploreP, await scrapeP, await recordP];

    if (ack?.message_id) ctx.telegram.deleteMessage(ctx.chat.id, ack.message_id).catch(() => {});
    for (const [what, err] of [['screenshot', e1], ['exploration', e2], ['scrape', e3], ['recording', e4]]) {
        if (!err) continue;
        console.error(`[web ${what}]`, err.message);
        const msg = String(err.message || '').slice(0, 220);
        await rep.plain(`The ${what} failed: ${msg || 'unknown error'}`).catch(() => {});
    }
    return true;
}

async function handleButton(ctx) {
    const [, owner, mode, token] = String(ctx.callbackQuery.data).split(':');
    if (String(ctx.from.id) !== owner) return ctx.answerCbQuery('This one is for someone else ').catch(() => {});
    const t = tokens.get(token);
    if (!t) return ctx.answerCbQuery('That link expired — send it again.', { show_alert: true }).catch(() => {});
    await ctx.answerCbQuery({ s: 'Capturing...', e: 'Exploring...', z: 'Scraping...', r: 'Recording...', f: 'Downloading...' }[mode] || 'Working...').catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    tokens.delete(token);
    const replyTo = ctx.callbackQuery.message?.reply_to_message?.message_id || ctx.callbackQuery.message?.message_id;
    if (mode === 'f') return fetcher.run({ ctx, replyTo, url: t.url });
    return run({ ctx, replyTo, url: t.url, shot: mode === 's', explore: mode === 'e', scrape: mode === 'z', record: mode === 'r', userId: ctx.from.id });
}

module.exports = { offer, run, handleButton, hostOf };
