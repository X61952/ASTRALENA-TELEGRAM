/** Helpers that turn a raw Telegram message into something easy to reason about. */

const web = require('./web');

const hasText = (msg) => String(msg.text ?? msg.caption ?? '');

/** Every link in a message: typed URLs, hidden hyperlinks (text_link), and the link-preview URL. */
function messageUrls(msg) {
    if (!msg) return [];
    const out = [];
    const add = (u) => { const n = web.normalizeUrl(u); if (n && !out.includes(n)) out.push(n); };
    const text = String(msg.text ?? msg.caption ?? '');
    const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
    for (const e of entities) {
        if (e.type === 'text_link' && e.url) add(e.url);
        else if (e.type === 'url') add(text.substr(e.offset, e.length));
    }
    for (const u of web.extractUrls(text)) add(u);
    if (msg.link_preview_options?.url) add(msg.link_preview_options.url);
    return out;
}


/** → 'text' | 'photo' | 'sticker' | 'video' | 'voice' | 'other' */
function kindOf(msg) {
    if (msg.photo?.length) return 'photo';
    if (msg.sticker) return 'sticker';
    if (msg.voice) return 'voice';
    if (msg.video || msg.animation || msg.video_note) return 'video';
    if (msg.document && /^image\//i.test(msg.document.mime_type || '')) return 'photo';
    if (msg.document) return 'document';
    if (msg.text) return 'text';
    return 'other';
}

/** Reference to the downloadable media inside a message (or null). Kind is the menu kind: image | sticker | video. */
function mediaRef(msg) {
    if (!msg) return null;
    if (msg.photo?.length) {
        const p = msg.photo[msg.photo.length - 1];
        return { kind: 'image', fileId: p.file_id, size: p.file_size || 0 };
    }
    if (msg.document && /^image\//i.test(msg.document.mime_type || '')) {
        return { kind: 'image', fileId: msg.document.file_id, size: msg.document.file_size || 0 };
    }
    if (msg.sticker) {
        const s = msg.sticker;
        return { kind: 'sticker', fileId: s.file_id, thumbId: s.thumbnail?.file_id || null, isVideo: !!s.is_video, isAnimated: !!s.is_animated, size: s.file_size || 0 };
    }
    const v = msg.video || msg.animation || msg.video_note;
    if (v) return { kind: 'video', fileId: v.file_id, size: v.file_size || 0 };
    return null;
}

/** How was Astralena addressed?  tag = @mention · reply = replied to Astralena's message · name = said "astralena" */
function addressInfo(msg, text, me) {
    const t = String(text || '');
    const uname = String(me?.username || '').toLowerCase();
    const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
    const tag = !!(uname && t.toLowerCase().includes('@' + uname))
        || entities.some((e) => e.type === 'text_mention' && e.user && me && e.user.id === me.id);
    const reply = !!(me && msg.reply_to_message?.from && msg.reply_to_message.from.id === me.id);
    const name = /\bastralena\b/i.test(t);
    return { tag, reply, name, any: tag || reply || name };
}

/** Removes "@botname" and a leading "astralena," from the text. */
function stripAddress(text, me) {
    let out = String(text || '');
    if (me?.username) out = out.replace(new RegExp('@' + me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
    out = out.replace(/^\s*(hey|hi|yo|ok|okay)?[\s,]*astralena(\s*ai)?[,:!\s-]*/i, '');
    out = out.replace(/\s{2,}/g, ' ').trim();
    return out;
}

const fullName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || 'friend';

/** Normalised view of an incoming message. */
function build(ctx, msg, me) {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const text = hasText(msg).trim();
    return {
        ctx, msg, me,
        chatId: msg.chat.id,
        chatTitle: msg.chat.title || null,
        isGroup,
        userId: msg.from.id,
        userName: fullName(msg.from),
        kind: kindOf(msg),
        text,
        address: isGroup ? addressInfo(msg, text, me) : { tag: false, reply: false, name: false, any: true },
        pendKey: `${msg.chat.id}:${msg.from.id}`,
    };
}

/** Replier that quotes `replyTo` (a message id) when given. */
function replier(ctx, replyTo) {
    const extra = (o = {}) => (replyTo ? { ...o, reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : o);
    return {
        extra,
        plain: (t, o) => ctx.reply(t, extra(o)),
        photo: (buf, caption) => ctx.replyWithPhoto({ source: buf }, extra(caption ? { caption } : {})),
        document: (buf, filename, caption) => ctx.replyWithDocument({ source: buf, filename }, extra(caption ? { caption } : {})),
        sticker: (src) => ctx.replyWithSticker(typeof src === 'string' ? src : { source: src, filename: 'sticker.webp' }, extra()),
        animation: (buf, caption) => ctx.replyWithAnimation({ source: buf, filename: 'astralena.mp4' }, extra(caption ? { caption } : {})),
        audio: (buf, filename) => ctx.replyWithAudio({ source: buf, filename }, extra()),
        voice: (buf, ext = 'ogg') => ctx.replyWithVoice({ source: buf, filename: `astralena.${ext}` }, extra()),
    };
}

module.exports = { messageUrls, kindOf, mediaRef, addressInfo, stripAddress, fullName, build, replier, hasText };
