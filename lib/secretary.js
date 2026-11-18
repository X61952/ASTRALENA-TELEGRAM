/**
 * SECRETARY MODE (Telegram's former "Business Mode").
 * A person connects Astralena in Telegram: Settings -> Chat automation (or Telegram Business -> Chatbots),
 * after Secretary Mode was switched on for the bot in BotFather. Astralena then receives that person's private
 * chats as business_message updates and can answer on their behalf.
 *
 * Safety defaults: she stays OFF until the owner sends /secretary on, she only answers other people (never the owner),
 * she stays quiet while the owner is actively typing in that chat, and she introduces herself as the owner's AI assistant.
 */
const store = require('./store');
const persona = require('./persona');
const ai = require('./ai');
const groq = require('./groq');
const media = require('./media');
const cfg = require('./config');
const { esc, mdToHtml, split, stripEmoji } = require('./format');

const lastOwnerMsg = new Map();  // `${connId}:${chatId}` -> time the owner last wrote in that chat
const greeted = new Map();       // `${connId}:${chatId}` -> time we last introduced ourselves
const replyLog = new Map();      // rate limit per chat
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sec = () => store.data().secretary;
const owner = (userId) => (sec().owners[userId] = sec().owners[userId] || { enabled: false, brief: '', quietMinutes: 10 });

async function loadConnection(telegram, id) {
    let c = sec().connections[id];
    if (c) return c;
    try {
        const bc = await telegram.callApi('getBusinessConnection', { business_connection_id: id });
        c = remember(bc);
    } catch (e) { console.error('[secretary] unknown connection', e.message); }
    return c || null;
}
function remember(bc) {
    const c = {
        id: bc.id, userId: bc.user.id, userChatId: bc.user_chat_id, name: [bc.user.first_name, bc.user.last_name].filter(Boolean).join(' ') || bc.user.username || 'the owner',
        canReply: bc.rights ? !!bc.rights.can_reply : bc.can_reply !== false, enabled: bc.is_enabled !== false,
    };
    sec().connections[bc.id] = c;
    store.save();
    return c;
}

async function send(telegram, conn, chatId, text, extra = {}) {
    for (const chunk of split(text)) {
        const base = { business_connection_id: conn.id, chat_id: chatId, link_preview_options: { is_disabled: true }, ...extra };
        try { await telegram.callApi('sendMessage', { ...base, text: mdToHtml(chunk), parse_mode: 'HTML' }); }
        catch (e) { if (/parse entities/i.test(e.message)) await telegram.callApi('sendMessage', { ...base, text: stripEmoji(chunk) }); else throw e; }
        extra = {};
    }
}

async function describeIncoming(telegram, msg) {
    const caption = String(msg.text || msg.caption || '').trim();
    if (msg.voice) {
        try {
            const buf = await media.download(telegram, msg.voice.file_id);
            const r = await groq.transcribe(buf, { mimetype: msg.voice.mime_type || 'audio/ogg', toMp3: media.toMp3 });
            return r.ok ? `(voice note) ${r.text}` : '(sent a voice note that could not be understood)';
        } catch { return '(sent a voice note that could not be understood)'; }
    }
    if (msg.photo?.length) {
        try {
            const buf = await media.download(telegram, msg.photo[msg.photo.length - 1].file_id);
            const { base64, mimetype } = await media.toBase64Jpeg(buf);
            const r = await groq.vision({ base64, mimetype, prompt: 'Describe this image in one or two sentences.', maxTokens: 250 });
            return `(sent a photo${r.ok ? ': ' + r.text : ''}) ${caption}`.trim();
        } catch { return `(sent a photo) ${caption}`.trim(); }
    }
    if (msg.sticker) return `(sent a sticker ${msg.sticker.emoji || ''})`.trim();
    if (msg.video || msg.animation || msg.video_note) return `(sent a video) ${caption}`.trim();
    if (msg.document) return `(sent a file: ${msg.document.file_name || 'document'}) ${caption}`.trim();
    return caption;
}

async function onBusinessMessage(bot, msg) {
    const telegram = bot.telegram;
    const conn = await loadConnection(telegram, msg.business_connection_id);
    if (!conn || !conn.enabled) return;
    const key = `${conn.id}:${msg.chat.id}`;

    if (msg.from?.id === conn.userId) { lastOwnerMsg.set(key, Date.now()); return; } // the owner is writing themselves
    if (msg.from?.is_bot) return;
    const o = owner(conn.userId);
    if (!o.enabled || !conn.canReply) return;
    if (Date.now() - (lastOwnerMsg.get(key) || 0) < (o.quietMinutes ?? 10) * 60000) return; // owner is active here

    const now = Date.now();
    const log = (replyLog.get(key) || []).filter((t) => now - t < 3600000);
    if (log.length >= 20) return;
    log.push(now); replyLog.set(key, log);

    const incoming = await describeIncoming(telegram, msg);
    if (!incoming) return;

    const system = persona.buildSystem(store.chatbot(), { secretary: { ownerName: conn.name, brief: o.brief }, userName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') });
    const hKey = `sec:${conn.userId}:${msg.chat.id}`;
    const act = () => telegram.callApi('sendChatAction', { business_connection_id: conn.id, chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
    await act();
    const started = Date.now();
    let answer;
    try { answer = await ai.generate({ system, history: store.getHistory(hKey), user: incoming }); }
    catch (e) { console.error('[secretary] ai failed:', e.message); return; }
    const wait = cfg.THINK_SECONDS * 1000 - (Date.now() - started);
    if (wait > 0) { const end = Date.now() + wait; while (Date.now() < end) { await act(); await sleep(Math.min(4000, end - Date.now())); } }

    store.pushHistory(hKey, 'user', incoming);
    store.pushHistory(hKey, 'assistant', answer);
    let text = answer;
    if (Date.now() - (greeted.get(key) || 0) > 12 * 3600000) {
        text = `Hi, this is Astralena, ${conn.name}'s AI assistant.\n\n${answer}`;
        greeted.set(key, Date.now());
    }
    await send(telegram, conn, msg.chat.id, text).catch((e) => console.error('[secretary] send failed:', e.message));
}

async function onConnection(bot, bc) {
    if (bc.is_enabled === false) { delete sec().connections[bc.id]; store.save(); return; }
    const c = remember(bc);
    const o = owner(c.userId);
    const text = `Secretary mode is connected to your account.\n\n` +
        `Status: ${o.enabled ? 'answering for you' : 'OFF (nothing will be answered yet)'}\n` +
        `Permission to reply: ${c.canReply ? 'yes' : 'NO, enable "Reply to messages" for me in Settings, Chat automation'}\n\n` +
        `/secretary on  start answering your private chats\n/secretary off  stop\n/secretary brief <text>  tell me how to handle people\n/secretary quiet <minutes>  stay silent after you reply in a chat\n/secretary status`;
    await bot.telegram.sendMessage(c.userChatId, text).catch((e) => console.error('[secretary] notice failed:', e.message));
}

/** Raw update router. Returns true if the update was a business update. */
function handleUpdate(bot, update) {
    if (update.business_connection) { onConnection(bot, update.business_connection).catch((e) => console.error('[secretary]', e.message)); return true; }
    if (update.business_message) { onBusinessMessage(bot, update.business_message).catch((e) => console.error('[secretary]', e.message)); return true; }
    if (update.edited_business_message || update.deleted_business_messages) return true;
    return false;
}

function register(bot) {
    bot.command('secretary', async (ctx) => {
        const uid = ctx.from.id;
        const conns = Object.values(sec().connections).filter((c) => c.userId === uid);
        const isOwnerOfBot = cfg.OWNER_IDS.includes(String(uid));
        const parts = String(ctx.message.text || '').trim().split(/\s+/).slice(1);
        const sub = (parts[0] || 'status').toLowerCase();
        const rest = parts.slice(1).join(' ');

        if (!conns.length && sub !== 'help') {
            return ctx.reply(`Secretary mode is not connected to your account yet.\n\nHow to set it up:\n1. In BotFather: your bot, Bot Settings, Secretary Mode, Turn on.\n2. In Telegram: Settings, Chat automation (or Telegram Business, Chatbots), enter @${ctx.botInfo?.username || 'this bot'} and allow it to reply.\n3. Come back here and send /secretary on.${isOwnerOfBot ? '\n\nTip: /modes shows what is enabled for this bot.' : ''}`);
        }
        const o = owner(uid);
        if (sub === 'on') { o.enabled = true; store.save(); return ctx.reply('Secretary mode is ON. I will answer people who message you, and stay quiet while you are replying yourself.'); }
        if (sub === 'off') { o.enabled = false; store.save(); return ctx.reply('Secretary mode is OFF.'); }
        if (sub === 'brief') {
            if (!rest) return ctx.reply(`Current instructions: ${o.brief || 'none'}\n\nSet them with: /secretary brief I am a robotics engineer. If someone asks for a quote, take their details and say I will reply tonight.`);
            o.brief = rest.slice(0, 1500); store.save(); return ctx.reply('Got it. I will follow those instructions when I answer for you.');
        }
        if (sub === 'quiet') {
            const n = parseInt(rest, 10);
            if (!Number.isFinite(n) || n < 0 || n > 1440) return ctx.reply(`I stay silent in a chat for ${o.quietMinutes ?? 10} minutes after you write there. Change it with: /secretary quiet 30`);
            o.quietMinutes = n; store.save(); return ctx.reply(`Okay, I will stay silent for ${n} minutes after you reply in a chat.`);
        }
        const c = conns[0];
        return ctx.reply(`Secretary mode\nAnswering for you: ${o.enabled ? 'ON' : 'OFF'}\nConnected as: ${c.name}\nCan reply: ${c.canReply ? 'yes' : 'no'}\nQuiet time after you write: ${o.quietMinutes ?? 10} min\nInstructions: ${o.brief || 'none'}\n\n/secretary on | off | brief <text> | quiet <minutes>`);
    });
}

module.exports = { handleUpdate, register };
