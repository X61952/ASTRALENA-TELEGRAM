/**
 * Long-term memory: short facts about each person that Astralena remembers across chats and restarts.
 * Added three ways: the agent's remember tool, /remember, and automatic extraction every few messages
 * (switch off per person with /memory off). Anyone can read and delete their facts with /memory and /forget.
 */
const store = require('./store');
const groq = require('./groq');
const { stripEmoji } = require('./format');

const MAX_FACTS = 40;
const SENSITIVE = /\b(password|passcode|pin code|otp|cvv|card number|credit card|bank account|account number|iban|bvn|nin|ssn|social security|passport|id number|private key|seed phrase|api[ -]?key|token|secret)\b|\b\d{9,}\b/i;

const facts = (uid) => (store.data().memory[uid] = store.data().memory[uid] || []);
const list = (uid) => facts(uid).slice();

function add(uid, text) {
    const fact = stripEmoji(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (fact.length < 4) return { ok: false, reason: 'too short' };
    if (SENSITIVE.test(fact)) return { ok: false, reason: 'that looks like sensitive information, so I will not store it' };
    const arr = facts(uid);
    const key = fact.toLowerCase();
    if (arr.some((f) => f.fact.toLowerCase() === key)) return { ok: true, duplicate: true };
    const id = (arr.reduce((a, f) => Math.max(a, f.id), 0)) + 1;
    arr.push({ id, fact, at: Date.now() });
    while (arr.length > MAX_FACTS) arr.shift();
    store.save();
    return { ok: true, id };
}

/** remove by number (as shown in /memory), by text, or everything */
function remove(uid, what) {
    const arr = facts(uid);
    const w = String(what || '').trim().toLowerCase();
    if (w === 'all') { const n = arr.length; store.data().memory[uid] = []; store.save(); return n; }
    const before = arr.length;
    const n = parseInt(w, 10);
    let keep;
    if (Number.isFinite(n) && String(n) === w) keep = arr.filter((_, i) => i + 1 !== n);
    else keep = arr.filter((f) => !f.fact.toLowerCase().includes(w));
    store.data().memory[uid] = keep;
    store.save();
    return before - keep.length;
}

const promptFacts = (uid) => (store.getSettings(uid).memory ? facts(uid).slice(-15).map((f) => f.fact) : []);

// ── automatic extraction ──
const counters = new Map();
async function extract(uid, name, exchange) {
    if (!groq.hasKey() || !store.getSettings(uid).memory) return;
    try {
        const out = await groq.chat({
            system: 'You extract long-term facts about a person from a chat. Output ONLY a JSON array of at most 3 short strings (each under 120 characters, third person, e.g. "Works as a robotics engineer", "Is building an ESP32 weather station", "Prefers short answers"). Only include durable, useful facts the PERSON stated about themselves: job, studies, projects, tools they use, interests, goals, location they chose to share, preferences. Never include passwords, financial, medical, legal or identity details, other people\'s private info, or temporary things. If there is nothing worth keeping output []. No emojis.',
            messages: [{ role: 'user', content: `Person: ${name}\n\nRecent chat:\n${exchange}`.slice(0, 3500) }],
            maxTokens: 250,
        });
        const m = out.match(/\[[\s\S]*\]/);
        if (!m) return;
        const arr = JSON.parse(m[0]);
        for (const f of arr.slice(0, 3)) if (typeof f === 'string') add(uid, f);
    } catch (e) { console.error('[memory extract]', e.message); }
}

/** call after every exchange; every 5th message from a person triggers a background extraction */
function observe(uid, name, history) {
    if (!store.getSettings(uid).memory) return;
    const n = (counters.get(uid) || 0) + 1;
    counters.set(uid, n);
    if (n % 5 !== 0) return;
    const exchange = history.slice(-10).map((h) => `${h.role === 'user' ? name : 'Astralena'}: ${h.content}`).join('\n');
    setImmediate(() => extract(uid, name, exchange));
}

function register(bot) {
    const argsOf = (ctx) => String(ctx.message.text || '').replace(/^\/\S+\s*/, '').trim();
    bot.command('memory', async (ctx) => {
        const uid = ctx.from.id;
        const a = argsOf(ctx).toLowerCase();
        if (a === 'off' || a === 'on') {
            store.setSettings(uid, { memory: a === 'on' });
            return ctx.reply(a === 'on' ? 'Memory is on. I will remember useful things you tell me.' : 'Memory is off. I will not use or collect facts about you. Your saved ones stay until you /forget them.');
        }
        const arr = list(uid);
        const on = store.getSettings(uid).memory;
        await ctx.reply(arr.length
            ? `What I remember about you (${on ? 'memory on' : 'memory off'}):\n\n${arr.map((f, i) => `${i + 1}. ${f.fact}`).join('\n')}\n\n/forget <number> removes one, /forget all clears everything, /remember <text> adds one, /memory off stops me collecting.`
            : `I don't have anything saved about you yet. Tell me about yourself, or use /remember <text>. Memory is ${on ? 'on' : 'off'}.`);
    });
    bot.command('remember', async (ctx) => {
        const a = argsOf(ctx);
        if (!a) return ctx.reply('Usage: /remember I am building a line-following robot with an ESP32');
        const r = add(ctx.from.id, a);
        await ctx.reply(r.ok ? (r.duplicate ? 'I already had that.' : 'Got it, I will remember that.') : `I did not save it: ${r.reason}.`);
    });
    bot.command('forget', async (ctx) => {
        const a = argsOf(ctx);
        if (!a) return ctx.reply('Usage: /forget <number from /memory>, /forget all, or /forget <words>');
        const n = remove(ctx.from.id, a);
        await ctx.reply(n ? `Done, removed ${n} thing${n > 1 ? 's' : ''}.` : 'I could not find that in my notes.');
    });
}

module.exports = { list, add, remove, promptFacts, observe, register };
