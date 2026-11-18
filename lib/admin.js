/**
 * Owner controls + group moderation.
 * Owner (OWNER_ID): /ban /unban /banned /broadcast /usage
 * Group admins (and the owner): /warn /unwarn /warns /mute /unmute /kick /antilink /antiflood /welcome /rules
 * Moderation needs Astralena to be a group admin with permission to delete messages and restrict members.
 */
const cfg = require('./config');
const store = require('./store');
const stats = require('./stats');
const web = require('./web');
const { esc } = require('./format');

const isOwner = (id) => cfg.OWNER_IDS.includes(String(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── bot-wide bans ──
const banned = () => store.data().banned;
const isBanned = (id) => !!id && !!banned()[id] && !isOwner(id);

// ── group admin cache ──
const adminCache = new Map();
async function isGroupAdmin(telegram, chatId, userId) {
    if (isOwner(userId)) return true;
    const key = `${chatId}:${userId}`;
    const hit = adminCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.v;
    let v = false;
    try { const m = await telegram.getChatMember(chatId, userId); v = m.status === 'creator' || m.status === 'administrator'; } catch { /* not a member / no rights */ }
    adminCache.set(key, { v, at: Date.now() });
    if (adminCache.size > 2000) adminCache.delete(adminCache.keys().next().value);
    return v;
}

const mod = (chatId) => (store.data().mod[chatId] = store.data().mod[chatId] || { antilink: false, antiflood: false, welcome: null, rules: null, warns: {} });
const nameOf = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || String(u?.id);
const mention = (u) => `<a href="tg://user?id=${u.id}">${esc(nameOf(u))}</a>`;

/** target user: replied-to message's sender, or a numeric id in the arguments */
function targetOf(ctx) {
    const r = ctx.message.reply_to_message;
    if (r?.from) return { id: r.from.id, user: r.from };
    const m = String(ctx.message.text || '').match(/\s(-?\d{5,})\b/);
    return m ? { id: +m[1], user: { id: +m[1], first_name: m[1] } } : null;
}
const argsOf = (ctx) => String(ctx.message.text || '').replace(/^\/\S+\s*/, '').trim();

const NO_PERMS = { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false };
const ALL_PERMS = Object.fromEntries(Object.keys(NO_PERMS).map((k) => [k, true]));

async function muteUser(telegram, chatId, userId, minutes) {
    await telegram.callApi('restrictChatMember', { chat_id: chatId, user_id: userId, permissions: NO_PERMS, until_date: Math.floor(Date.now() / 1000) + Math.max(1, minutes) * 60 });
}
async function unmuteUser(telegram, chatId, userId) {
    let perms = ALL_PERMS;
    try { const c = await telegram.getChat(chatId); if (c.permissions) perms = { ...ALL_PERMS, ...c.permissions }; } catch { /* default */ }
    await telegram.callApi('restrictChatMember', { chat_id: chatId, user_id: userId, permissions: perms });
}

const dur = (m) => (m >= 1440 ? `${Math.round(m / 1440)} day(s)` : m >= 60 ? `${Math.round(m / 60)} hour(s)` : `${m} minute(s)`);
const needAdminRights = 'I could not do that. I need to be a group admin with permission to restrict members and delete messages.';

// ── group message hook (anti-link / anti-flood). Returns true if the message was handled. ──
const floods = new Map();
const noticed = new Map();
async function onGroupMessage(ctx) {
    const msg = ctx.message;
    const ms = store.data().mod[msg.chat.id];
    if (!ms || (!ms.antilink && !ms.antiflood)) return false;
    if (await isGroupAdmin(ctx.telegram, msg.chat.id, msg.from.id)) return false;

    const notice = async (text) => {
        const k = `${msg.chat.id}:${msg.from.id}`;
        if (Date.now() - (noticed.get(k) || 0) < 30000) return;
        noticed.set(k, Date.now());
        await ctx.telegram.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }).catch(() => {});
    };

    if (ms.antilink) {
        const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
        const hasLink = entities.some((e) => e.type === 'url' || e.type === 'text_link') || web.extractUrls(msg.text || msg.caption || '').length > 0;
        if (hasLink) {
            await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
            await notice(`${mention(msg.from)}, links are not allowed in this group.`);
            return true;
        }
    }
    if (ms.antiflood) {
        const k = `${msg.chat.id}:${msg.from.id}`;
        const now = Date.now();
        const arr = (floods.get(k) || []).filter((t) => now - t < 6000);
        arr.push(now); floods.set(k, arr);
        if (floods.size > 3000) floods.delete(floods.keys().next().value);
        if (arr.length > 7) {
            floods.delete(k);
            try { await muteUser(ctx.telegram, msg.chat.id, msg.from.id, 10); await notice(`${mention(msg.from)} was muted for 10 minutes for flooding the chat.`); }
            catch { /* no rights */ }
            return true;
        }
    }
    return false;
}

async function onNewMembers(ctx) {
    const ms = store.data().mod[ctx.chat.id];
    if (!ms?.welcome) return;
    for (const u of ctx.message.new_chat_members || []) {
        if (u.is_bot) continue;
        const text = ms.welcome.replace(/\{name\}/gi, mention(u)).replace(/\{group\}/gi, esc(ctx.chat.title || 'the group'));
        await ctx.telegram.sendMessage(ctx.chat.id, text + (ms.rules ? '\n\nSend /rules to read the group rules.' : ''), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => {});
    }
}

// ── broadcast ──
const tokens = new Map();
function recipients(kind) {
    const d = store.data();
    const out = [];
    if (kind === 'users' || kind === 'all') for (const [id, u] of Object.entries(d.users)) if (u.dm && !d.banned[id]) out.push(+id);
    if (kind === 'groups' || kind === 'all') for (const id of Object.keys(d.groups)) out.push(+id);
    return out;
}
async function onBroadcastButton(ctx) {
    const [, action, token] = String(ctx.callbackQuery.data).split(':');
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('Owner only.').catch(() => {});
    const t = tokens.get(token);
    if (!t) return ctx.answerCbQuery('That broadcast expired.', { show_alert: true }).catch(() => {});
    tokens.delete(token);
    if (action === 'cancel') { await ctx.answerCbQuery('Cancelled').catch(() => {}); return ctx.editMessageText('Broadcast cancelled.').catch(() => {}); }
    await ctx.answerCbQuery('Sending...').catch(() => {});
    const list = recipients(t.kind);
    let ok = 0, fail = 0;
    await ctx.editMessageText(`Sending to ${list.length} chats...`).catch(() => {});
    for (const id of list) {
        try { await ctx.telegram.sendMessage(id, t.text, { link_preview_options: { is_disabled: true } }); ok++; } catch { fail++; }
        await sleep(60); // stay well under Telegram's 30 messages per second
    }
    await ctx.editMessageText(`Broadcast finished. Delivered: ${ok}, failed: ${fail} (blocked the bot or left).`).catch(() => {});
}

function register(bot) {
    const ownerOnly = (fn) => async (ctx) => { if (!isOwner(ctx.from.id)) return ctx.reply('Owner only. (Set OWNER_ID in the .env file.)'); return fn(ctx); };
    const adminOnly = (fn) => async (ctx) => {
        if (ctx.chat.type === 'private') return ctx.reply('This command works inside groups.');
        if (!(await isGroupAdmin(ctx.telegram, ctx.chat.id, ctx.from.id))) return ctx.reply('Group admins only.');
        return fn(ctx);
    };
    const protectedTarget = async (ctx, t) => {
        if (t.id === ctx.botInfo?.id) { await ctx.reply('Nice try.'); return true; }
        if (isOwner(t.id) || await isGroupAdmin(ctx.telegram, ctx.chat.id, t.id)) { await ctx.reply('I will not do that to an admin.'); return true; }
        return false;
    };

    // ---- owner ----
    bot.command('ban', ownerOnly(async (ctx) => {
        const t = targetOf(ctx);
        if (!t) return ctx.reply('Reply to someone, or use /ban <user id> [reason].');
        if (isOwner(t.id)) return ctx.reply('That is an owner.');
        const reason = argsOf(ctx).replace(/-?\d{5,}/, '').trim().slice(0, 200);
        banned()[t.id] = { reason, at: Date.now(), name: nameOf(t.user) };
        store.save();
        await ctx.reply(`${nameOf(t.user)} (${t.id}) is banned from using me.${reason ? ' Reason: ' + reason : ''}`);
    }));
    bot.command('unban', ownerOnly(async (ctx) => {
        const t = targetOf(ctx);
        if (!t) return ctx.reply('Reply to someone, or use /unban <user id>.');
        const had = !!banned()[t.id];
        delete banned()[t.id]; store.save();
        await ctx.reply(had ? `${t.id} is unbanned.` : 'That person was not banned.');
    }));
    bot.command('banned', ownerOnly(async (ctx) => {
        const rows = Object.entries(banned()).map(([id, b]) => `${id}  ${b.name || ''}${b.reason ? ' - ' + b.reason : ''}`);
        await ctx.reply(rows.length ? `Banned (${rows.length})\n\n${rows.join('\n')}` : 'Nobody is banned.');
    }));
    bot.command('broadcast', ownerOnly(async (ctx) => {
        const m = argsOf(ctx).match(/^(users|groups|all)\s+([\s\S]+)$/i);
        if (!m) return ctx.reply('Usage: /broadcast users|groups|all <message>\n\nYou will see a preview and confirm before anything is sent.');
        const kind = m[1].toLowerCase(), text = m[2].trim().slice(0, 3500);
        const n = recipients(kind).length;
        if (!n) return ctx.reply('There is nobody to send that to yet.');
        const token = Math.random().toString(36).slice(2, 10);
        tokens.set(token, { kind, text });
        setTimeout(() => tokens.delete(token), 15 * 60 * 1000).unref?.();
        await ctx.reply(`Preview (to ${n} ${kind === 'all' ? 'chats' : kind}):\n\n${text}`, { reply_markup: { inline_keyboard: [[{ text: `Send to ${n}`, callback_data: `bc:send:${token}` }, { text: 'Cancel', callback_data: `bc:cancel:${token}` }]] } });
    }));
    bot.command('usage', ownerOnly(async (ctx) => {
        const s = stats.summary();
        await ctx.reply(`USAGE\n\nPeople who ever messaged me: ${s.users} (${s.dmUsers} in DM)\nGroups: ${s.groups}\nBanned: ${s.banned}\n\nToday: ${s.messagesToday} messages from ${s.activeToday} people\nLast 7 days: ${s.messages7} messages, ${s.active7} active people, ${s.errors7} errors\nReminders waiting: ${s.reminders}\n\nTop tools (7 days)\n${s.topTools.length ? s.topTools.map(([n, c]) => `${n}: ${c}`).join('\n') : 'none yet'}`);
    }));

    // ---- group moderation ----
    bot.command('warn', adminOnly(async (ctx) => {
        const t = targetOf(ctx);
        if (!t) return ctx.reply('Reply to the person you want to warn.');
        if (await protectedTarget(ctx, t)) return;
        const ms = mod(ctx.chat.id);
        const n = ms.warns[t.id] = (ms.warns[t.id] || 0) + 1;
        store.save();
        const reason = argsOf(ctx).slice(0, 150);
        if (n >= cfg.WARN_LIMIT) {
            ms.warns[t.id] = 0; store.save();
            try { await muteUser(ctx.telegram, ctx.chat.id, t.id, 1440); return ctx.reply(`${nameOf(t.user)} reached ${cfg.WARN_LIMIT} warnings and is muted for 24 hours.`); }
            catch { return ctx.reply(`${nameOf(t.user)} reached ${cfg.WARN_LIMIT} warnings, but ${needAdminRights}`); }
        }
        await ctx.reply(`${nameOf(t.user)} has been warned (${n}/${cfg.WARN_LIMIT}).${reason ? ' Reason: ' + reason : ''}`);
    }));
    bot.command('unwarn', adminOnly(async (ctx) => {
        const t = targetOf(ctx);
        if (!t) return ctx.reply('Reply to the person.');
        const ms = mod(ctx.chat.id);
        ms.warns[t.id] = Math.max(0, (ms.warns[t.id] || 0) - 1); store.save();
        await ctx.reply(`${nameOf(t.user)} now has ${ms.warns[t.id]}/${cfg.WARN_LIMIT} warnings.`);
    }));
    bot.command('warns', async (ctx) => {
        if (ctx.chat.type === 'private') return ctx.reply('This command works inside groups.');
        const t = targetOf(ctx) || { id: ctx.from.id, user: ctx.from };
        await ctx.reply(`${nameOf(t.user)} has ${mod(ctx.chat.id).warns[t.id] || 0}/${cfg.WARN_LIMIT} warnings.`);
    });
    bot.command('mute', adminOnly(async (ctx) => {
        const t = targetOf(ctx);
        if (!t) return ctx.reply('Reply to the person, optionally with minutes: /mute 30');
        if (await protectedTarget(ctx, t)) return;
        const minutes = Math.min(527040, Math.max(1, parseInt(argsOf(ctx).replace(/-?\d{5,}/, ''), 10) || 60));
        try { await muteUser(ctx.telegram, ctx.chat.id, t.id, minutes); await ctx.reply(`${nameOf(t.user)} is muted for ${dur(minutes)}.`); }
        catch { await ctx.reply(needAdminRights); }
    }));
    bot.command('unmute', adminOnly(async (ctx) => {
        const t = targetOf(ctx);
        if (!t) return ctx.reply('Reply to the person.');
        try { await unmuteUser(ctx.telegram, ctx.chat.id, t.id); await ctx.reply(`${nameOf(t.user)} can talk again.`); }
        catch { await ctx.reply(needAdminRights); }
    }));
    bot.command('kick', adminOnly(async (ctx) => {
        const t = targetOf(ctx);
        if (!t) return ctx.reply('Reply to the person you want to remove.');
        if (await protectedTarget(ctx, t)) return;
        try { await ctx.telegram.banChatMember(ctx.chat.id, t.id); await ctx.telegram.unbanChatMember(ctx.chat.id, t.id, { only_if_banned: true }); await ctx.reply(`${nameOf(t.user)} was removed. They can rejoin with a link.`); }
        catch { await ctx.reply(needAdminRights); }
    }));
    const toggle = (key, label) => adminOnly(async (ctx) => {
        const ms = mod(ctx.chat.id);
        const a = argsOf(ctx).toLowerCase();
        if (a === 'on' || a === 'off') { ms[key] = a === 'on'; store.save(); }
        await ctx.reply(`${label} is ${ms[key] ? 'ON' : 'OFF'}. Use /${key} on or /${key} off.${ms[key] ? '' : ''}`);
    });
    bot.command('antilink', toggle('antilink', 'Anti-link'));
    bot.command('antiflood', toggle('antiflood', 'Anti-flood'));
    bot.command('welcome', adminOnly(async (ctx) => {
        const ms = mod(ctx.chat.id);
        const a = argsOf(ctx);
        if (!a) return ctx.reply(`Welcome message: ${ms.welcome ? ms.welcome : 'off'}\n\nSet one with /welcome Welcome {name} to {group}! or turn it off with /welcome off`);
        ms.welcome = /^off$/i.test(a) ? null : a.slice(0, 800); store.save();
        await ctx.reply(ms.welcome ? 'Welcome message saved.' : 'Welcome message turned off.');
    }));
    bot.command('rules', async (ctx) => {
        if (ctx.chat.type === 'private') return ctx.reply('This command works inside groups.');
        const ms = mod(ctx.chat.id);
        const a = argsOf(ctx);
        if (a && await isGroupAdmin(ctx.telegram, ctx.chat.id, ctx.from.id)) {
            ms.rules = /^off$/i.test(a) ? null : a.slice(0, 1500); store.save();
            return ctx.reply(ms.rules ? 'Rules saved.' : 'Rules removed.');
        }
        await ctx.reply(ms.rules ? `Group rules\n\n${ms.rules}` : 'No rules are set for this group yet. Admins can set them with /rules <text>.');
    });
}

module.exports = { register, isBanned, isOwner, onGroupMessage, onNewMembers, onBroadcastButton, isGroupAdmin };
