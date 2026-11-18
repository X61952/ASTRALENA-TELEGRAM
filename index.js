/**
 * Astralena AI — Telegram bot (JavaScript).
 * Start with:  npm install  ->  npm start
 */
const { Telegraf } = require('telegraf');
const cfg = require('./lib/config');
const store = require('./lib/store');
const stickers = require('./lib/stickers');
const commands = require('./lib/commands');
const chat = require('./lib/chat');
const mediaFlow = require('./lib/mediaFlow');
const webFlow = require('./lib/webFlow');
const apps = require('./lib/apps');
const tools = require('./lib/tools');
const secretary = require('./lib/secretary');
const admin = require('./lib/admin');
const memory = require('./lib/memory');
const stats = require('./lib/stats');
const alerts = require('./lib/alerts');
const inline = require('./lib/inline');
const guest = require('./lib/guest');
const { build } = require('./lib/context');
const { stripEmoji } = require('./lib/format');

if (!cfg.TELEGRAM_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN. Fill it in the .env file.');
    process.exit(1);
}
if (!cfg.GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY. Astralena needs it to think, see, hear and speak. Fill it in the .env file.');
    process.exit(1);
}

// handlerTimeout off: a reply can legitimately take a while (thinking time + streaming)
const bot = new Telegraf(cfg.TELEGRAM_TOKEN, { handlerTimeout: Infinity });

// ── No emojis, ever: every outgoing text field is filtered, whatever produced it ──
const TEXT_KEYS = new Set(['text', 'caption', 'message_text', 'title', 'description', 'question', 'explanation']);
function clean(node) {
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === 'object' && !Buffer.isBuffer(node) && typeof node.pipe !== 'function' && node.source === undefined) {
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = typeof v === 'string' && TEXT_KEYS.has(k) ? stripEmoji(v) : clean(v);
        return out;
    }
    return node;
}
try {
    let proto = Object.getPrototypeOf(bot.telegram);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'callApi')) proto = Object.getPrototypeOf(proto);
    if (proto) {
        const original = proto.callApi;
        proto.callApi = function (method, payload, ...rest) { return original.call(this, method, clean(payload), ...rest); };
    } else {
        const original = bot.telegram.callApi.bind(bot.telegram);
        bot.telegram.callApi = (method, payload, ...rest) => original(method, clean(payload), ...rest);
    }
} catch (e) { console.error('[emoji filter]', e.message); }

// DMs are answered strictly in order, one at a time per chat
const dmQueues = new Map();
function enqueue(key, work) {
    const prev = dmQueues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    dmQueues.set(key, next);
    next.finally(() => { if (dmQueues.get(key) === next) dmQueues.delete(key); }).catch(() => {});
    return next;
}

// ── 1. special updates: guest mode + secretary mode (banned people are ignored everywhere) ──
bot.use((ctx, next) => {
    const upd = ctx.update || {};
    if (upd.guest_message) {
        setImmediate(() => guest.handle(ctx, upd.guest_message).catch((e) => console.error('[guest]', e.message)));
        return;
    }
    if (secretary.handleUpdate(bot, upd)) return;
    const uid = ctx.from?.id;
    if (admin.isBanned(uid)) return; // banned with /ban
    return next();
});

// ── 2. commands + buttons ──
commands.register(bot);
secretary.register(bot);
admin.register(bot);
memory.register(bot);
tools.register(bot);
bot.action(/^(menu|settings|voice):/, (ctx) => commands.onMenuButton(ctx));
bot.action(/^wb:/, (ctx) => webFlow.handleButton(ctx).catch((e) => console.error('[wb button]', e.message)));
bot.action(/^app:/, (ctx) => apps.handleButton(ctx).catch((e) => console.error('[app button]', e.message)));
bot.action(/^bc:/, (ctx) => admin.onBroadcastButton(ctx).catch((e) => console.error('[broadcast]', e.message)));
bot.action(/^mf:/, (ctx) => mediaFlow.handleButton(ctx).catch((e) => console.error('[mf button]', e.message)));

// ── 3. inline mode ──
bot.on('inline_query', (ctx) => {
    setImmediate(() => inline.handle(ctx).catch((e) => console.error('[inline]', e.message)));
});

// ── 4. every other message goes to the chatbot ──
bot.on('message', (ctx) => {
    const msg = ctx.message;
    if (!msg || !msg.from || msg.from.is_bot) return;
    if (msg.new_chat_members) { stats.track(msg); setImmediate(() => admin.onNewMembers(ctx).catch(() => {})); return; }
    if (msg.left_chat_member) return;
    stats.track(msg);
    if (String(msg.text || '').startsWith('/')) return; // an unknown command

    const m = build(ctx, msg, ctx.botInfo);
    const run = async () => {
        try {
            if (m.isGroup && await admin.onGroupMessage(ctx)) return; // anti-link / anti-flood removed it
            await chat.handle(ctx, m);
        } catch (e) { console.error('[chat]', e.stack || e.message); alerts.notify('message handler', e); }
    };
    if (m.isGroup) setImmediate(run);
    else enqueue(`dm:${m.chatId}`, run);
});

bot.catch((err) => { console.error('[bot error]', err?.message || err); alerts.notify('bot', err); });

async function main() {
    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`Astralena AI starting as @${me.username}`);
    console.log(`[modes] inline: ${me.supports_inline_queries ?? 'unknown'} | guest: ${me.supports_guest_queries ?? 'unknown'} | secretary: ${me.can_connect_to_business ?? 'unknown'}  (send /modes to the bot for how to switch each on)`);

    await bot.telegram.setMyCommands([
        { command: 'start', description: 'Start' },
        { command: 'tools', description: 'See everything I can do' },
        { command: 'new', description: 'Start a fresh conversation' },
        { command: 'voice', description: 'Choose my voice' },
        { command: 'search', description: 'Search the web' },
        { command: 'memory', description: 'What I remember about you' },
        { command: 'screenshot', description: 'Screenshot a website' },
        { command: 'explore', description: 'Explore a website' },
        { command: 'scrape', description: 'Download a site as a zip' },
        { command: 'fetch', description: 'Download a file from a link' },
        { command: 'imagine', description: 'Generate an image' },
        { command: 'settings', description: 'Reasoning, live search, voice' },
        { command: 'modes', description: 'Check inline, guest, secretary mode' },
        { command: 'help', description: 'Help' },
    ]).catch((e) => console.error('[commands]', e.message));

    await stickers.init(bot.telegram).catch((e) => console.error('[stickers]', e.message));
    alerts.init(bot);
    tools.startReminders(bot);

    bot.launch({
        dropPendingUpdates: true,
        allowedUpdates: [
            'message', 'callback_query', 'inline_query', 'guest_message', 'my_chat_member',
            'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages',
        ],
    }).catch((e) => { console.error('[launch]', e.message); process.exit(1); });
    console.log('Astralena AI is live (polling).');
}

main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });

const stop = (sig) => { try { store.flush(); } catch { /* ignore */ } try { bot.stop(sig); } catch { /* ignore */ } process.exit(0); };
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e?.message || e); alerts.notify('unhandled rejection', e); });
