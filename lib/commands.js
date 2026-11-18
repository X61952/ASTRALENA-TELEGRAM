/** Commands + menu buttons: /start /help /new /settings /voice /modes /screenshot /explore /scrape /record /fetch /app /chatbot */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');
const persona = require('./persona');
const web = require('./web');
const webFlow = require('./webFlow');
const fetcher = require('./fetcher');
const apps = require('./apps');
const voice = require('./voice');
const tools = require('./tools');
const { esc } = require('./format');
const { messageUrls } = require('./context');

const isOwner = (id) => cfg.OWNER_IDS.includes(String(id));
const HERO = path.join(__dirname, '..', 'assets', 'astralena.jpg');
let heroFileId = null; // after the first upload Telegram lets us reuse the picture by id

async function isAdmin(ctx) {
    try {
        const mem = await ctx.getChatMember(ctx.from.id);
        return mem.status === 'creator' || mem.status === 'administrator';
    } catch { return false; }
}

// Every page is a photo caption, so each one stays under Telegram's 1024-character limit.
const LINE = '━━━━━━━━━━━━━━━━━━━━━';

function homeText(name) {
    return `<b>ASTRALENA AI</b>
<i>Space, technology and engineering, in your pocket</i>
${LINE}
Hi ${esc(name)}. I'm Astralena, an AI built by ${esc(persona.BUILT_BY)}. Space is my favourite subject, along with technology and innovation, mechatronics and robotics, and software engineering. Ask me anything, though. I'm happy to help.

<b>What I can do</b>
Chat in DMs and groups, with voice notes both ways
Read images, stickers and videos
Screenshot, explore, scrape and record websites
Fetch any file from a link
ISS tracker, launches, NASA picture of the day
QR codes, weather, calculator, reminders and more
Inline mode, guest mode and secretary mode
${LINE}
<i>In groups, say "astralena", tag me, or reply to me.
Send /tools to see everything.</i>`;
}

const CAPS = `<b>WHAT I CAN DO</b>
${LINE}
<b>Focus</b>  space and astronomy, technology and innovation, mechatronics and robotics, software engineering, futuristic tech
<b>Chat</b>  DMs and groups, live replies, voice notes in and out, your choice of voice with /voice
<b>Images</b>  describe, scan text, remove background, stickers, resize, black and white, compress
<b>Stickers</b>  reply with one: to image, GIF, remove background
<b>Video</b>  describe, screenshot, audio, transcript
<b>Websites</b>  screenshot, explore, scrape to zip, record, web search
<b>Files</b>  /fetch any link, /app for open-source apps, and I read PDF, Word, Excel, PowerPoint, text and code you send
<b>Agent</b>  I pick and chain tools myself, and remember useful facts about you (/memory)
<b>Modes</b>  inline (@me anywhere), guest (tag me in any chat), secretary (I answer your private chats)`;

const WEB = `<b>WEBSITE AND FILE TOOLS</b>
${LINE}
<b>/screenshot example.com</b>  add "full" for the whole page
<b>/explore example.com</b>  what it is, key sections, the tech behind it
<b>/scrape example.com</b>  the site as an offline zip (add "all" for several pages)
<b>/record example.com</b>  scrolling video (needs a browser on the server)
<b>/fetch link</b>  download any file and send it here
<b>/app name</b>  free open-source Android apps

You can also just talk to me: reply to a link with "astralena screenshot this page for me", "explore this and tell me what you got", "scrape this site into a zip" or "download this". Send a bare link and I'll offer buttons.`;

const HELP = `<b>FIELD MANUAL</b>
${LINE}
Private chat: just talk. Text, voice, images, stickers, videos.
Groups: say <b>astralena</b>, tag me, or reply to my messages.
Send an image and pick a tool. Send a sticker and I'll answer, then ask what to do with it.
Ask for a <b>voice note</b> and I'll send one. Pick my voice with /voice.
Inline: type my @username in any chat.

<b>Main commands</b>
/tools  the full toolbox
/new  fresh conversation
/voice  choose my voice
/settings  reasoning and live search
/modes  check inline, guest and secretary mode
/memory  what I remember about you
/chatbot  on/off, mode, training (admins and owner)`;

const homeMenu = (botUser) => ({
    inline_keyboard: [
        [{ text: 'What I can do', callback_data: 'menu:caps' }, { text: 'Toolbox', callback_data: 'menu:tools' }],
        [{ text: 'Website tools', callback_data: 'menu:web' }, { text: 'My voice', callback_data: 'menu:voice' }],
        [{ text: 'Settings', callback_data: 'menu:settings' }, { text: 'Help', callback_data: 'menu:help' }],
        ...(botUser ? [[{ text: 'Add me to a group', url: `https://t.me/${botUser}?startgroup=true` }]] : []),
    ],
});
const backMenu = () => ({ inline_keyboard: [[{ text: 'Back', callback_data: 'menu:root' }]] });

const currentVoice = (uid) => voice.findVoice(store.getSettings(uid).voice || voice.DEFAULT_ID) || voice.VOICES[0];

const settingsText = (s) => `<b>SETTINGS</b>
${LINE}
<b>Deep reasoning</b>  ${s.think ? 'on' : 'off'}
Slower, but I work problems out step by step.

<b>Live search</b>  ${s.search ? 'on' : 'off'}
I look things up on the web for fresh facts.

<b>Voice</b>  ${(voice.findVoice(s.voice || voice.DEFAULT_ID) || voice.VOICES[0]).label}
Change it from the voice menu.`;
const settingsMenu = (s) => ({
    inline_keyboard: [
        [{ text: `Deep reasoning: ${s.think ? 'on' : 'off'}`, callback_data: 'settings:toggle_think' }],
        [{ text: `Live search: ${s.search ? 'on' : 'off'}`, callback_data: 'settings:toggle_search' }],
        [{ text: 'Change voice', callback_data: 'menu:voice' }],
        [{ text: 'Back', callback_data: 'menu:root' }],
    ],
});

// ── voice picker ──
const voiceText = (uid) => `<b>MY VOICE</b>
${LINE}
Current voice: <b>${esc(currentVoice(uid).label)}</b> (${esc(currentVoice(uid).note)})

Tap a name to switch. I'll send a short sample so you can hear it.
You can also type /voice hannah, /voice ezinne and so on.`;
const voiceMenu = (uid) => {
    const cur = currentVoice(uid).id;
    const btns = voice.VOICES.map((v) => ({ text: (v.id === cur ? '* ' : '') + v.label, callback_data: `voice:${v.id}` }));
    const rows = [];
    for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
    rows.push([{ text: 'Back', callback_data: 'menu:root' }]);
    return { inline_keyboard: rows };
};
async function setVoice(ctx, v) {
    store.setSettings(ctx.from.id, { voice: v.id });
    try {
        const sample = await voice.generate("Hi, I'm Astralena. This is how I sound. Tell me what you're working on.", { voice: v.id });
        if (sample) await ctx.replyWithVoice({ source: sample.buffer, filename: `sample.${sample.ext}` });
    } catch (e) { console.error('[voice sample]', e.message); }
}

async function sendHome(ctx) {
    const name = ctx.from?.first_name || 'there';
    const extra = { parse_mode: 'HTML', reply_markup: homeMenu(ctx.botInfo?.username) };
    const caption = homeText(name);
    try {
        if (heroFileId) { await ctx.replyWithPhoto(heroFileId, { ...extra, caption }); return; }
        const sent = await ctx.replyWithPhoto({ source: fs.createReadStream(HERO) }, { ...extra, caption });
        heroFileId = sent?.photo?.[sent.photo.length - 1]?.file_id || null;
    } catch (e) {
        console.error('[start photo]', e.message);
        await ctx.reply(caption, { ...extra, link_preview_options: { is_disabled: true } });
    }
}

/** URL + optional extra words from "/command <args>" or from the message being replied to. */
function commandTarget(ctx) {
    const args = String(ctx.message.text || '').replace(/^\/\S+\s*/, '');
    const quoted = ctx.message.reply_to_message;
    const urls = web.extractUrls(args);
    const qurls = quoted ? messageUrls(quoted) : [];
    return {
        url: urls[0] || qurls[0] || null, rest: web.stripUrls(args),
        full: /\b(full|fullpage|full-page|entire|whole)\b/i.test(args), multi: /\b(all|multi|deep|pages|whole site|entire site)\b/i.test(args),
    };
}

async function modesReport(ctx) {
    const me = await ctx.telegram.getMe().catch(() => ({}));
    const flag = (v) => (v === true ? 'ON' : v === false ? 'OFF' : 'unknown');
    const conns = Object.values(store.data().secretary.connections);
    return `<b>MODES CHECK</b> (@${esc(me.username || '?')})
${LINE}
<b>Inline mode</b>  ${flag(me.supports_inline_queries)}
Turn on in BotFather: /setinline, pick the bot, set a placeholder text.

<b>Guest mode</b>  ${flag(me.supports_guest_queries)}
Telegram keeps this one out of the chat menus. Open the BotFather profile, tap Open App (or Menu), choose this bot, Settings, Guest Mode, switch on.

<b>Secretary mode</b>  ${flag(me.can_connect_to_business)}
BotFather: /mybots, this bot, Bot Settings, Secretary Mode, Turn on. Then in your own Telegram: Settings, Chat automation (or Telegram Business, Chatbots), enter @${esc(me.username || 'bot')}, allow replies. Then send me /secretary on.
Connected accounts: ${conns.length}

Groups: can join ${flag(me.can_join_groups)}, reads all messages ${flag(me.can_read_all_group_messages)}`;
}

function register(bot) {
    bot.command('start', async (ctx) => {
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Astralena here. Say "astralena", tag me, or reply to my messages and I will answer.');
        }
        await sendHome(ctx);
    });
    bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
    bot.command('settings', (ctx) => {
        const s = store.getSettings(ctx.from.id);
        return ctx.reply(settingsText(s), { parse_mode: 'HTML', reply_markup: settingsMenu(s) });
    });
    bot.command('modes', async (ctx) => ctx.reply(await modesReport(ctx), { parse_mode: 'HTML' }));

    bot.command('voice', async (ctx) => {
        const arg = String(ctx.message.text || '').replace(/^\/\S+\s*/, '').trim();
        if (!arg) return ctx.reply(voiceText(ctx.from.id), { parse_mode: 'HTML', reply_markup: voiceMenu(ctx.from.id) });
        const v = voice.findVoice(arg);
        if (!v) return ctx.reply(`I don't have a voice called "${arg}". Available: ${voice.VOICES.map((x) => x.label).join(', ')}.`);
        await ctx.reply(`Voice switched to ${v.label}.`);
        await setVoice(ctx, v);
    });

    bot.command('new', async (ctx) => {
        const group = ctx.chat.type !== 'private';
        if (group && !isOwner(ctx.from.id) && !(await isAdmin(ctx))) return ctx.reply('Group admins only.');
        store.clearHistory(group ? `grp:${ctx.chat.id}` : `dm:${ctx.from.id}`);
        await ctx.reply('Memory cleared. Fresh start. What are we working on?');
    });

    // voice self-test: tells you exactly what works on this server
    bot.command('voicetest', async (ctx) => {
        if (cfg.OWNER_IDS.length && !isOwner(ctx.from.id)) return ctx.reply('Owner only.');
        await ctx.reply('Running voice diagnostics...');
        const { lines, sample } = await voice.diagnose();
        await ctx.reply('VOICE DIAGNOSTICS\n\n' + lines.join('\n') + (sample ? '\n\nSending a sample...' : '\n\nNo provider worked. See the [fail] lines above.'));
        if (sample) await ctx.replyWithVoice({ source: sample.buffer, filename: `test.${sample.ext}` }).catch((e) => ctx.reply('Telegram rejected the sample: ' + e.message));
    });

    bot.command(['screenshot', 'ss', 'shot'], (ctx) => {
        const t = commandTarget(ctx);
        if (!t.url) return ctx.reply('Give me a link: /screenshot example.com\nAdd "full" for the whole page: /ss example.com full');
        setImmediate(() => webFlow.run({ ctx, replyTo: ctx.message.message_id, url: t.url, shot: true, full: t.full, userId: ctx.from.id }).catch((e) => console.error('[/screenshot]', e.message)));
    });
    bot.command('explore', (ctx) => {
        const t = commandTarget(ctx);
        if (!t.url) return ctx.reply('Give me a link: /explore example.com');
        setImmediate(() => webFlow.run({ ctx, replyTo: ctx.message.message_id, url: t.url, explore: true, note: t.rest, userId: ctx.from.id }).catch((e) => console.error('[/explore]', e.message)));
    });
    bot.command(['scrape', 'zip'], (ctx) => {
        const t = commandTarget(ctx);
        if (!t.url) return ctx.reply('Give me a link: /scrape example.com\nAdd "all" to grab several pages: /scrape example.com all');
        setImmediate(() => webFlow.run({ ctx, replyTo: ctx.message.message_id, url: t.url, scrape: true, multi: t.multi, userId: ctx.from.id }).catch((e) => console.error('[/scrape]', e.message)));
    });
    bot.command(['record', 'screenrecord'], (ctx) => {
        const t = commandTarget(ctx);
        if (!t.url) return ctx.reply('Give me a link: /record example.com');
        setImmediate(() => webFlow.run({ ctx, replyTo: ctx.message.message_id, url: t.url, record: true, userId: ctx.from.id }).catch((e) => console.error('[/record]', e.message)));
    });
    bot.command(['fetch', 'get', 'download'], (ctx) => {
        const t = commandTarget(ctx);
        if (!t.url) return ctx.reply('Please provide a valid link.\nExample: /fetch https://example.com/image.jpg');
        setImmediate(() => fetcher.run({ ctx, replyTo: ctx.message.message_id, url: t.url, asDocument: /\b(file|document|doc)\b/i.test(t.rest) }).catch((e) => console.error('[/fetch]', e.message)));
    });
    bot.command(['app', 'apps'], (ctx) => {
        const q = String(ctx.message.text || '').replace(/^\/\S+\s*/, '').trim();
        if (!q) return ctx.reply('Tell me which app: /app telegram\nI search free and open-source Android apps (F-Droid) and can send you the APK.');
        setImmediate(() => apps.run({ ctx, replyTo: ctx.message.message_id, query: q, userId: ctx.from.id }).catch((e) => console.error('[/app]', e.message)));
    });

    bot.command(['chatbot', 'astralena'], async (ctx) => {
        const parts = String(ctx.message.text || '').trim().split(/\s+/).slice(1);
        const sub = (parts[0] || 'status').toLowerCase();
        const rest = parts.slice(1);
        const group = ctx.chat.type !== 'private';
        const owner = isOwner(ctx.from.id);
        const admin = group ? await isAdmin(ctx) : false;
        const cb = store.chatbot();
        const key = group ? `grp:${ctx.chat.id}` : `dm:${ctx.from.id}`;
        const ownerOnly = () => ctx.reply('Bot owner only — this changes Astralena for every chat. (Set OWNER_ID in the .env file.)');

        if (sub === 'status' || sub === 'help' || sub === 'menu') {
            const here = group ? `\n• This group: ${cb.chats[ctx.chat.id]?.enabled === true ? 'FORCED ON' : cb.chats[ctx.chat.id]?.enabled === false ? 'OFF' : 'follows master'} · mode ${store.groupMode(ctx.chat.id).toUpperCase()}` : '';
            return ctx.reply(
`Astralena AI chatbot

• Master switch: ${cb.enabled ? 'ON ' : 'OFF '}${here}
• Training: ${cb.useDefault || !cb.customTrain ? 'DEFAULT' : 'CUSTOM'}${cb.customTrain ? ` (custom ${cb.useDefault ? 'saved, not active' : 'active'})` : ''}
• Voice replies: ${cb.voice.toUpperCase()}
• Memory here: ${store.historyCount(key)} msgs

Commands
/chatbot on | off          (group admins: this group · owner in DM: everywhere)
/chatbot on all | off all  (owner: everywhere)
/chatbot mode group | tag  (group: answers to "astralena", tags and replies · tag: only when tagged)
/chatbot voice on | off | auto  (owner · auto = voice note in → voice note out)
/chatbot train <prompt>    (owner · custom personality)
/chatbot default | custom  (owner · switch personality)
/chatbot clear`);
        }

        if (sub === 'on' || sub === 'off') {
            const on = sub === 'on';
            const global = (rest[0] || '').toLowerCase() === 'all' || !group;
            if (global) {
                if (!owner) return ownerOnly();
                store.updateChatbot((d) => { d.enabled = on; });
                return ctx.reply(on ? 'Astralena is ON.' : 'Astralena is OFF everywhere (groups that were forced on stay on — use /chatbot off inside them).');
            }
            if (!owner && !admin) return ctx.reply('Group admins only.');
            store.updateChatbot((d) => { d.chats[ctx.chat.id] = { ...(d.chats[ctx.chat.id] || {}), enabled: on }; });
            return ctx.reply(on ? 'Astralena is ON in this group.' : 'Astralena is OFF in this group.');
        }

        if (sub === 'mode') {
            if (!group) return ctx.reply('Modes are per group — use this command inside a group.');
            if (!owner && !admin) return ctx.reply('Group admins only.');
            const mode = (rest[0] || '').toLowerCase();
            if (!['group', 'tag'].includes(mode)) return ctx.reply(`Current mode: ${store.groupMode(ctx.chat.id).toUpperCase()}\n\n• group — I answer when someone says "astralena", tags me, or replies to me\n• tag — I answer only when I'm tagged\n\nUsage: /chatbot mode group | tag`);
            store.updateChatbot((d) => { d.chats[ctx.chat.id] = { ...(d.chats[ctx.chat.id] || {}), mode }; });
            return ctx.reply(`Mode set to ${mode.toUpperCase()} for this group.`);
        }

        if (sub === 'voice') {
            if (!owner) return ownerOnly();
            const v = (rest[0] || '').toLowerCase();
            if (!['on', 'off', 'auto'].includes(v)) return ctx.reply(`Voice replies: ${cb.voice.toUpperCase()}\n\n/chatbot voice on | off | auto\n• off — text (voice only when asked)\n• auto — voice note in → voice note out\n• on — always a voice note`);
            store.updateChatbot((d) => { d.voice = v; });
            return ctx.reply(`Voice replies: ${v.toUpperCase()}`);
        }

        if (sub === 'train' || sub === 'training') {
            if (!owner) return ownerOnly();
            const prompt = rest.join(' ').trim();
            if (!prompt) return ctx.reply('Usage: /chatbot train <your prompt>\n\nExample:\n/chatbot train You are Zara, a funny assistant for my store. Keep replies short.' + (cb.customTrain ? `\n\nSaved custom training:\n${cb.customTrain.slice(0, 400)}` : ''));
            if (prompt.length > 6000) return ctx.reply('That training is too long (max 6000 characters).');
            store.updateChatbot((d) => { d.customTrain = prompt; d.useDefault = false; });
            store.clearHistory();
            return ctx.reply(`Custom training is now ACTIVE.\n\n${prompt.slice(0, 400)}${prompt.length > 400 ? '…' : ''}\n\n/chatbot default goes back to ${persona.AI_NAME}'s default personality (your training stays saved).`);
        }
        if (sub === 'default') {
            if (!owner) return ownerOnly();
            store.updateChatbot((d) => { d.useDefault = true; });
            store.clearHistory();
            return ctx.reply(`Back on the default personality.${cb.customTrain ? '\nYour custom training is still saved — /chatbot custom brings it back.' : ''}`);
        }
        if (sub === 'custom') {
            if (!owner) return ownerOnly();
            if (!cb.customTrain) return ctx.reply('No custom training saved yet. Use /chatbot train <your prompt>');
            store.updateChatbot((d) => { d.useDefault = false; });
            store.clearHistory();
            return ctx.reply('Custom training is active again.');
        }

        if (sub === 'clear' || sub === 'reset') {
            if (group && !owner && !admin) return ctx.reply('Group admins only.');
            store.clearHistory(key);
            return ctx.reply('Memory cleared for this chat.');
        }

        return ctx.reply('Unknown option. Send /chatbot status to see everything.');
    });


}

/** Menu / settings / voice buttons (the home screen is a photo, so pages are edited as captions). */
async function onMenuButton(ctx) {
    const data = ctx.callbackQuery.data || '';
    const uid = ctx.from.id;
    const isPhoto = !!ctx.callbackQuery.message?.photo;
    const edit = (text, markup) => (isPhoto
        ? ctx.editMessageCaption(text, { parse_mode: 'HTML', reply_markup: markup })
        : ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } })).catch(() => {});

    if (data.startsWith('voice:')) {
        const v = voice.findVoice(data.slice(6));
        if (!v) return ctx.answerCbQuery().catch(() => {});
        await ctx.answerCbQuery(`Voice: ${v.label}`).catch(() => {});
        store.setSettings(uid, { voice: v.id });
        await edit(voiceText(uid), voiceMenu(uid));
        return setVoice(ctx, v);
    }
    await ctx.answerCbQuery().catch(() => {});

    if (data === 'menu:root') return edit(homeText(ctx.from.first_name || 'there'), homeMenu(ctx.botInfo?.username));
    if (data === 'menu:caps') return edit(CAPS, backMenu());
    if (data === 'menu:tools') return edit(tools.TOOLS_TEXT, backMenu());
    if (data === 'menu:web') return edit(WEB, backMenu());
    if (data === 'menu:help') return edit(HELP, backMenu());
    if (data === 'menu:voice') return edit(voiceText(uid), voiceMenu(uid));
    if (data === 'menu:settings') { const s = store.getSettings(uid); return edit(settingsText(s), settingsMenu(s)); }
    if (data === 'settings:toggle_think') {
        const s = store.setSettings(uid, { think: !store.getSettings(uid).think });
        return edit(settingsText(s), settingsMenu(s));
    }
    if (data === 'settings:toggle_search') {
        const s = store.setSettings(uid, { search: !store.getSettings(uid).search });
        return edit(settingsText(s), settingsMenu(s));
    }
}

module.exports = { register, onMenuButton, isOwner, homeText, CAPS, WEB, HELP, settingsText, voiceText };
