/**
 * Astralena AI — the always-on chatbot. Called for every non-command message.
 *
 * Triggers
 *   DM     : everything (text, voice notes, images, stickers, videos)
 *   Group  : someone says "astralena", tags the bot (@username), or replies to one of Astralena's messages
 *            (/chatbot mode tag  → only when tagged)
 *
 * DM replies use Telegram's live message streaming (sendMessageDraft): "Astralena is thinking" for a few
 * seconds, then the answer appears line by line. Groups show the "typing…" indicator instead
 * (drafts are private-chat only) and wait the same thinking time.
 */
const cfg = require('./config');
const store = require('./store');
const persona = require('./persona');
const ai = require('./ai');
const groq = require('./groq');
const media = require('./media');
const voice = require('./voice');
const mediaFlow = require('./mediaFlow');
const intents = require('./intents');
const pending = require('./pending');
const { sendText, plain } = require('./format');
const { mediaRef, kindOf, stripAddress, replier, messageUrls } = require('./context');
const web = require('./web');
const webFlow = require('./webFlow');
const fetcher = require('./fetcher');
const tools = require('./tools');
const agent = require('./agent');
const memory = require('./memory');
const docs = require('./docs');
const stats = require('./stats');
const alerts = require('./alerts');

const VOICE_REQUEST = /\b(voice\s?-?(note|message|reply|memo)s?|voicenote|vn|audio (note|reply|message)|speak to me|talk to me|say it (out )?loud|out loud|aloud)\b|\b(send|give|reply|answer|respond|speak|say|tell|record)\b.{0,30}\b(voice|audio)\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tiny rate limiter ──
const hits = new Map();
function rateLimited(key, max, windowMs = 60000) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(now);
    hits.set(key, arr);
    return false;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.length || n - v[v.length - 1] > 120000) hits.delete(k); }, 5 * 60 * 1000).unref?.();

const memoryKey = (m) => (m.isGroup ? `grp:${m.chatId}` : `dm:${m.userId}`);

// ── "thinking" + live streaming ─────────────────────────────────────────────
async function think({ ctx, chatId, isDm, live, action = 'typing', produce }) {
    const thinkMs = cfg.THINK_SECONDS * 1000;
    const start = Date.now();
    const revealAt = start + thinkMs;
    const draftId = Math.floor(Math.random() * 2147483646) + 1;
    let draftOk = isDm;

    const draft = async (text) => {
        if (!draftOk) return;
        try {
            await ctx.telegram.callApi('sendMessageDraft', { chat_id: Number(chatId), draft_id: draftId, text: String(text).slice(0, 4000) || '…' });
        } catch (e) {
            draftOk = false; // older Bot API / client — fall back to the typing indicator
        }
    };

    if (isDm) await draft('Astralena is thinking');

    let typingOn = true;
    (async () => {
        while (typingOn) {
            if (!isDm || !draftOk) await ctx.sendChatAction(action).catch(() => {});
            await sleep(4000);
        }
    })();
    const refreshThinking = setInterval(() => { if (isDm && draftOk && Date.now() < revealAt) draft('Astralena is thinking'); }, 5000);

    let shown = 0, lastNl = 0, lastLen = 0, lastAt = 0;
    const onText = live && isDm
        ? async (t) => {
            if (!draftOk || Date.now() < revealAt) return;
            const p = plain(t);
            const nl = (p.match(/\n/g) || []).length;
            const now = Date.now();
            if (nl > lastNl || (p.length - lastLen >= 40 && now - lastAt >= 700)) {
                await draft(p);
                shown = p.length; lastNl = nl; lastLen = p.length; lastAt = now;
            }
        }
        : null;

    let answer = '', error = null;
    try { answer = await produce(onText); } catch (e) { error = e; }

    const remain = revealAt - Date.now();
    if (remain > 0) await sleep(remain); // always think for the full THINK_SECONDS

    // finish revealing whatever the live stream hasn't shown yet — line by line
    if (live && isDm && draftOk && answer) {
        const full = plain(answer);
        let cur = full.slice(0, Math.min(shown, full.length));
        const rest = full.slice(cur.length);
        const pieces = rest.split(/(?<=\n)|(?<=[.!?])\s+/).filter(Boolean);
        const delay = Math.max(120, Math.min(650, Math.floor(6000 / Math.max(1, pieces.length))));
        for (const piece of pieces) {
            cur += (cur && !cur.endsWith('\n') && !piece.startsWith('\n') && !/\n$/.test(cur) ? ' ' : '') + piece;
            await draft(cur);
            await sleep(Math.min(delay, 150 + piece.length * 10));
        }
        await sleep(700);
    }

    typingOn = false;
    clearInterval(refreshThinking);
    return { answer, error };
}

// ── human-style delivery: a few short paragraphs go out as separate messages, like texting ──
function humanChunks(text) {
    const t = String(text || '').trim();
    if (t.length > 900 || t.includes('```') || /^\s*([-*]|\d+[.)])\s/m.test(t)) return [t];
    const parts = t.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 4) return [t];
    return parts;
}
async function sendHuman(ctx, text, rep, isGroup) {
    const parts = humanChunks(text);
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
            await ctx.sendChatAction('typing').catch(() => {});
            await sleep(Math.min(1600, 450 + parts[i].length * 18));
        }
        await sendText(ctx, parts[i], i === 0 ? rep.extra() : {});
    }
}

// ── conversation ────────────────────────────────────────────────────────────
function quotedText(msg) {
    const q = msg.reply_to_message;
    if (!q) return '';
    return String(q.text || q.caption || '').trim();
}

async function converse({ ctx, m, text, voiceIn = false }) {
    const key = memoryKey(m);
    if (rateLimited('cb:' + key, 14) || rateLimited('cbu:' + m.userId, 8)) return true;
    stats.message(m.userId);
    if (!stats.messageAllowed(m.userId)) {
        if (!rateLimited('limitnote:' + m.userId, 1, 3600000)) await replier(ctx, m.isGroup ? m.msg.message_id : null).plain("You've reached today's message limit. It resets tomorrow (UTC).");
        return true;
    }

    const clean = stripAddress(text, m.me) || text;
    let userContent = m.isGroup ? `${m.userName}: ${clean}` : clean;
    const qt = quotedText(m.msg);
    if (qt && m.msg.reply_to_message?.from?.id !== m.me?.id) userContent += `\n(they are replying to this message: "${qt.slice(0, 300)}")`;

    const cb = store.chatbot();
    const settings = store.getSettings(m.userId);
    const doc = docs.get(m.pendKey);
    const useAgent = agent.shouldUse(clean, { search: settings.search });
    const system = persona.buildSystem(cb, {
        isGroup: m.isGroup, groupName: m.chatTitle, userName: m.userName,
        memoryFacts: memory.promptFacts(m.userId), document: doc, tools: useAgent,
    });
    const history = store.getHistory(key);
    const host = { ctx, replyTo: m.msg.message_id, userId: m.userId, userName: m.userName, chatId: m.chatId, isGroup: m.isGroup };
    const instant = persona.acknowledgement(clean);
    const wantsVoice = cb.voice === 'on' || (cb.voice === 'auto' && voiceIn) || VOICE_REQUEST.test(clean);

    const { answer, error } = await think({
        ctx, chatId: m.chatId, isDm: !m.isGroup, live: !wantsVoice, action: wantsVoice ? 'record_voice' : 'typing',
        produce: async (onText) => {
            if (instant) return instant;
            if (useAgent) {
                try { return await agent.run({ system, history, user: userContent, host, onText, think: settings.think }); }
                catch (e) { console.error('[agent] falling back to plain chat:', e.message); }
            }
            return ai.generate({ system, history, user: userContent, think: settings.think, search: settings.search, onText });
        },
    });

    const rep = replier(ctx, m.isGroup ? m.msg.message_id : null);
    if (error || !answer) {
        console.error('[chat] failed:', error?.message);
        alerts.notify('chat', error || 'empty answer');
        await rep.plain("Something went wrong on my side. Try that again in a moment.");
        return true;
    }

    store.pushHistory(key, 'user', userContent);
    store.pushHistory(key, 'assistant', answer);
    memory.observe(m.userId, m.userName, store.getHistory(key));

    if (wantsVoice) {
        try {
            await ctx.sendChatAction('record_voice').catch(() => {});
            const v = await voice.generate(answer, { voice: settings.voice });
            if (v) { await rep.voice(v.buffer, v.ext); return true; }
            console.error('[chat] voice reply unavailable (too long or every TTS provider failed) — sending text instead');
        } catch (e) { console.error('[chat voice reply]', e.message); }
        if (voice.cleanForSpeech(answer).length <= voice.MAX_CHARS) {
            await sendText(ctx, answer + '\n\n_My voice is unavailable right now, so here it is as text._', rep.extra());
            return true;
        }
    }
    await sendHuman(ctx, answer, rep, m.isGroup);
    return true;
}

// ── voice notes ─────────────────────────────────────────────────────────────
async function handleVoice(ctx, m) {
    try {
        const v = m.msg.voice;
        if (v.file_size && v.file_size > 20 * 1024 * 1024) return true;
        await ctx.sendChatAction('typing').catch(() => {});
        const buf = await media.download(ctx.telegram, v.file_id);
        const r = await groq.transcribe(buf, { mimetype: v.mime_type || 'audio/ogg', filename: 'voice.ogg', toMp3: media.toMp3 });
        const rep = replier(ctx, m.isGroup ? m.msg.message_id : null);
        if (!r.ok) {
            if (/not set/i.test(r.error)) await rep.plain('I need GROQ_API_KEY set in the .env file to understand voice notes.');
            else await rep.plain("Couldn't catch that voice note, say it again?");
            return true;
        }
        return await converse({ ctx, m, text: r.text, voiceIn: true });
    } catch (e) {
        console.error('[chat voice]', e.message);
        return true;
    }
}

// ── documents (PDF, Word, Excel, PowerPoint, text, code...) ──
async function loadDocument(ctx, m, docMsg) {
    const d = docMsg.document;
    const doc = await docs.fromTelegram(ctx.telegram, d.file_id, d.file_name || 'file', d.mime_type || '', d.file_size);
    docs.hold(m.pendKey, { ...doc, fid: d.file_unique_id });
    return doc;
}
async function handleDocument(ctx, m) {
    const rep = replier(ctx, m.isGroup ? m.msg.message_id : null);
    try {
        await ctx.sendChatAction('typing').catch(() => {});
        const doc = await loadDocument(ctx, m, m.msg);
        const caption = stripAddress(m.text, m.me);
        if (caption) return await converse({ ctx, m, text: m.text });
        await rep.plain(`Got ${doc.name}${doc.pages ? ` (${doc.pages} pages)` : ''}, around ${doc.words.toLocaleString('en')} words${doc.truncated ? ', and it is long so I only have the first part' : ''}. Want a summary, or do you have a specific question about it?`);
    } catch (e) {
        console.error('[document]', e.message);
        await rep.plain(String(e.message).slice(0, 220));
    }
    return true;
}

// ── entry point ─────────────────────────────────────────────────────────────
async function handle(ctx, m) {
    if (!store.isActive(m.chatId, m.isGroup)) return false;
    const isMedia = m.kind === 'photo' || m.kind === 'sticker' || m.kind === 'video';
    if (m.kind === 'other') return false;
    if (m.kind === 'text' && !m.text) return false;

    let pend = pending.get(m.pendKey);
    if (pend && (isMedia || m.kind === 'voice')) { pending.clear(m.pendKey); pend = null; } // a new media message replaces the old menu

    let addressed = true;
    if (m.isGroup) {
        addressed = store.groupMode(m.chatId) === 'tag' ? m.address.tag : m.address.any;
        if (!addressed && !pend) return false;
    }

    // 1) answering a menu we showed
    if (pend && m.text) {
        const done = await mediaFlow.resolvePending({ ctx, m, text: m.text, pend });
        if (done) return true;
        if (!addressed) return false;
    }

    // 2) voice notes
    if (m.kind === 'voice') {
        if (m.isGroup && !addressed) return false;
        return handleVoice(ctx, m);
    }

    // 2b) documents
    if (m.kind === 'document') {
        if (m.isGroup && !addressed) return false;
        return handleDocument(ctx, m);
    }

    // 3) fresh image / sticker / video
    if (isMedia) {
        if (m.isGroup && !addressed) return false;
        const ref = mediaRef(m.msg);
        if (!ref) return false;
        try {
            if (ref.kind === 'sticker') return await mediaFlow.stickerFlow(ctx, m, ref);
            const caption = stripAddress(m.text, m.me);
            if (caption) {
                const r = intents.resolve(ref.kind, caption);
                if (r?.id) return await mediaFlow.runAction({ ctx, chatId: m.chatId, userId: m.userId, replyTo: m.msg.message_id, kind: ref.kind, id: r.id, ref, pendKey: m.pendKey, extra: caption });
                if (caption.length >= 3 && mediaFlow.QUESTION_ABOUT_MEDIA.test(caption)) {
                    return await mediaFlow.askAbout({ ctx, replyTo: m.msg.message_id, ref, question: caption, userId: m.userId });
                }
            }
            return await mediaFlow.offerMenu(ctx, m, ref);
        } catch (e) {
            console.error('[chat media]', e.message);
            return true;
        }
    }

    // 4) text
    if (!addressed) return false;
    const clean = stripAddress(m.text, m.me);

    // replying to a picture / sticker / video with an instruction or question
    const quoted = m.msg.reply_to_message;
    if (quoted && clean) {
        const qref = mediaRef(quoted);
        if (qref) {
            const r = intents.resolve(qref.kind, clean);
            const asks = mediaFlow.QUESTION_ABOUT_MEDIA.test(clean);
            if (r?.id) return await mediaFlow.runAction({ ctx, chatId: m.chatId, userId: m.userId, replyTo: m.msg.message_id, kind: qref.kind, id: r.id, ref: qref, pendKey: m.pendKey, extra: clean });
            if (qref.kind === 'image' && asks && clean.length >= 3) return await mediaFlow.askAbout({ ctx, replyTo: m.msg.message_id, ref: qref, question: clean, userId: m.userId });
        }
    }

    // replying to a document with a question: load it first
    if (quoted?.document && !/^image\//i.test(quoted.document.mime_type || '') && quoted.from?.id !== m.me?.id) {
        if (docs.get(m.pendKey)?.fid !== quoted.document.file_unique_id) {
            try { await ctx.sendChatAction('typing').catch(() => {}); await loadDocument(ctx, m, quoted); }
            catch (e) { await replier(ctx, m.msg.message_id).plain(String(e.message).slice(0, 220)); return true; }
        }
    }

    // links: screenshot / explore / scrape / record / fetch
    {
        const refers = web.refersToPage(clean);
        const own = messageUrls(m.msg);
        const quotedUrls = quoted ? messageUrls(quoted) : [];
        const intent = web.intentOf(clean, own[0] || quotedUrls[0] || '');
        const url = own[0] || ((intent.any || refers) ? quotedUrls[0] : null);
        if (url) {
            if (intent.fetch) return fetcher.run({ ctx, replyTo: m.msg.message_id, url, asDocument: /\b(as (a )?(file|document)|uncompressed|original)\b/i.test(clean) });
            if (intent.any || refers) {
                return webFlow.run({
                    ctx, replyTo: m.msg.message_id, url,
                    shot: intent.shot, explore: intent.explore || (refers && !intent.any), scrape: intent.scrape, record: intent.record,
                    full: intent.full, multi: intent.multi, note: intent.explore ? web.stripUrls(clean) : '', userId: m.userId,
                });
            }
            if (!web.stripUrls(clean) && own.length) return webFlow.offer(ctx, m, url);
        } else if (intent.any && web.mentionsPage(clean) && (refers || /\b(screen\s?-?shot|explore|scrape|record|download|fetch)\b/i.test(clean))) {
            await replier(ctx, m.msg.message_id).plain('I need a link for that. Send me one, or reply to a message that has it and tell me what you want.');
            return true;
        }
    }

    // quick tools in plain language (weather, ISS, launches, QR, calculator...)
    if (clean && await tools.nlRoute(ctx, m, clean)) return true;

    if (!clean) {
        if (m.isGroup) await replier(ctx, m.msg.message_id).plain('Yes? I am here.');
        return true;
    }
    return converse({ ctx, m, text: m.text });
}

module.exports = { handle, converse };
