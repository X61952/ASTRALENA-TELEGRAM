/** Usage counters (rolling 35 days), user/group registry and per-person limits. */
const store = require('./store');
const cfg = require('./config');

const today = () => new Date().toISOString().slice(0, 10);
const isOwner = (id) => cfg.OWNER_IDS.includes(String(id));

function day() {
    const days = store.data().stats.days;
    const k = today();
    if (!days[k]) {
        days[k] = { messages: 0, users: {}, tools: {}, errors: 0 };
        for (const old of Object.keys(days).sort().slice(0, -35)) delete days[old];
    }
    return days[k];
}

/** Remember who talks to the bot. */
function track(msg) {
    const d = store.data();
    const u = msg.from;
    if (u && !u.is_bot) {
        const r = d.users[u.id] || { first: Date.now(), count: 0 };
        r.name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);
        r.username = u.username || r.username || '';
        r.last = Date.now(); r.count++;
        if (msg.chat?.type === 'private') r.dm = true;
        d.users[u.id] = r;
    }
    if (msg.chat && msg.chat.type !== 'private') {
        const g = d.groups[msg.chat.id] || { first: Date.now() };
        g.title = msg.chat.title || g.title || ''; g.last = Date.now();
        d.groups[msg.chat.id] = g;
    }
    store.save();
}

function message(userId) { const x = day(); x.messages++; x.users[userId] = (x.users[userId] || 0) + 1; store.save(); }
function tool(name) { const x = day(); x.tools[name] = (x.tools[name] || 0) + 1; store.save(); }
function error() { day().errors++; store.save(); }
const usedToday = (userId) => day().users[userId] || 0;

// ── limits ──
function messageAllowed(userId) {
    if (!cfg.DAILY_LIMIT || isOwner(userId)) return true;
    return usedToday(userId) <= cfg.DAILY_LIMIT;
}
const heavyHits = new Map();
function heavyAllowed(userId) {
    if (isOwner(userId) || !cfg.HEAVY_LIMIT_HOURLY) return true;
    const now = Date.now();
    const arr = (heavyHits.get(userId) || []).filter((t) => now - t < 3600000);
    if (arr.length >= cfg.HEAVY_LIMIT_HOURLY) { heavyHits.set(userId, arr); return false; }
    arr.push(now); heavyHits.set(userId, arr);
    return true;
}

function summary() {
    const d = store.data();
    const days = d.stats.days;
    const t = today();
    const lastN = (n) => Object.keys(days).sort().slice(-n);
    const sum = (keys, f) => keys.reduce((a, k) => a + f(days[k]), 0);
    const uniq = (keys) => new Set(keys.flatMap((k) => Object.keys(days[k].users))).size;
    const toolTotals = {};
    for (const k of lastN(7)) for (const [n, c] of Object.entries(days[k].tools)) toolTotals[n] = (toolTotals[n] || 0) + c;
    const topTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return {
        users: Object.keys(d.users).length, dmUsers: Object.values(d.users).filter((u) => u.dm).length, groups: Object.keys(d.groups).length,
        banned: Object.keys(d.banned).length,
        messagesToday: days[t]?.messages || 0, activeToday: days[t] ? Object.keys(days[t].users).length : 0,
        messages7: sum(lastN(7), (x) => x.messages), active7: uniq(lastN(7)), errors7: sum(lastN(7), (x) => x.errors),
        topTools, reminders: d.reminders.length,
    };
}

module.exports = { track, message, tool, error, usedToday, messageAllowed, heavyAllowed, summary, isOwner };
