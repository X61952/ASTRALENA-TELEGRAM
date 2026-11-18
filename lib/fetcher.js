/** /fetch (aliases /get, /download): download a file from a URL and send it with the right Telegram media type. */
const web = require('./web');
const { replier } = require('./context');

const LIMIT = 49 * 1024 * 1024; // Telegram bots can upload up to 50 MB

function filenameOf(headers, finalUrl) {
    const cd = headers.get('content-disposition') || '';
    const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
    const plain = cd.match(/filename="?([^";]+)"?/i);
    let name = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain ? plain[1].trim() : '';
    if (!name) {
        try {
            const last = new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || '';
            if (last && last.includes('.')) name = decodeURIComponent(last);
        } catch { /* ignore */ }
    }
    return (name || 'fetched_file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
}

async function fetchFile(url) {
    const r = await web.safeGet(url, { maxBytes: LIMIT, timeout: 90000, accept: '*/*' });
    if (r.status >= 400) throw new Error(`The server answered HTTP ${r.status}.`);
    if (r.truncated) throw new Error('That file is bigger than 49 MB, which is the most Telegram lets a bot upload.');
    if (!r.body.length) throw new Error('The link returned an empty file.');
    const type = String(r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    return { buffer: r.body, type, name: filenameOf(r.headers, r.finalUrl), finalUrl: r.finalUrl };
}

/** Sends the downloaded file as photo / animation / video / audio / document depending on its type. */
async function sendFile(ctx, rep, file, { asDocument = false } = {}) {
    const { buffer, type, name } = file;
    const size = buffer.length;
    const src = { source: buffer, filename: name };
    if (!asDocument) {
        if (/^image\/(jpeg|png|webp)$/.test(type) && size <= 10 * 1024 * 1024) { await ctx.replyWithPhoto({ source: buffer }, rep.extra({ caption: name })); return; }
        if (type === 'image/gif') { await ctx.replyWithAnimation(src, rep.extra({ caption: name })); return; }
        if (/^video\/(mp4|webm|quicktime)$/.test(type)) { await ctx.replyWithVideo(src, rep.extra({ caption: name })); return; }
        if (/^audio\/(mpeg|mp3|ogg|mp4|x-m4a|aac|wav|x-wav|flac)$/.test(type)) { await ctx.replyWithAudio(src, rep.extra({ caption: name })); return; }
    }
    await ctx.replyWithDocument(src, rep.extra({ caption: `${name}\n${size >= 1048576 ? (size / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB'}` }));
}

async function run({ ctx, replyTo, url, asDocument = false, noLimit = false }) {
    const rep = replier(ctx, replyTo);
    if (!noLimit && !require('./stats').heavyAllowed(ctx.from?.id)) { await rep.plain('You have used a lot of heavy tools this hour. Try again a bit later.'); return true; }
    let ack = null;
    try { ack = await rep.plain('Fetching that file...'); } catch { /* ignore */ }
    try {
        await ctx.sendChatAction('upload_document').catch(() => {});
        const file = await fetchFile(url);
        await sendFile(ctx, rep, file, { asDocument });
    } catch (e) {
        console.error('[fetch]', e.message);
        await rep.plain(`Could not fetch that: ${String(e.message).slice(0, 200)}`).catch(() => {});
    } finally {
        if (ack?.message_id) ctx.telegram.deleteMessage(ctx.chat.id, ack.message_id).catch(() => {});
    }
    return true;
}

module.exports = { run, fetchFile, sendFile };
