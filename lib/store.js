/**
 * Tiny JSON database (no native modules, works on any panel).
 *   settings : per-user think / search switches
 *   history  : rolling conversation memory per chat
 *   chatbot  : global + per-chat chatbot settings
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DEFAULTS = () => ({
    settings: {},
    history: {},
    chatbot: {
        enabled: true,
        voice: 'auto',        // off | on | auto  (auto = answer a voice note with a voice note)
        customTrain: null,
        useDefault: true,
        chats: {},            // chatId -> { enabled?: bool, mode?: 'group' | 'tag' }
    },
    reminders: [],          // { id, chatId, userId, name, at, text }
    secretary: { connections: {}, owners: {} }, // secretary (business) mode
    users: {},              // id -> { name, username, first, last, count }
    groups: {},             // chatId -> { title, first, last }
    banned: {},             // id -> { reason, at }
    memory: {},             // userId -> [{ id, fact, at }]
    stats: { days: {} },    // per-day usage counters
    mod: {},                // chatId -> group moderation settings
});

let data = DEFAULTS();
try {
    const raw = JSON.parse(fs.readFileSync(cfg.DB_PATH, 'utf8'));
    data = { ...DEFAULTS(), ...raw, chatbot: { ...DEFAULTS().chatbot, ...(raw.chatbot || {}) }, secretary: { ...DEFAULTS().secretary, ...(raw.secretary || {}) }, stats: { days: {}, ...(raw.stats || {}) } };
} catch { /* first run */ }

let timer = null;
function flush() {
    clearTimeout(timer);
    timer = null;
    try {
        fs.mkdirSync(path.dirname(cfg.DB_PATH), { recursive: true });
        const tmp = cfg.DB_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, cfg.DB_PATH);
    } catch (e) { console.error('[store] save failed:', e.message); }
}
function save() { if (!timer) { timer = setTimeout(flush, 800); timer.unref?.(); } }
process.on('exit', () => { if (timer) flush(); });

// ── user settings ──
function getSettings(uid) {
    const s = data.settings[uid] || {};
    return { think: !!s.think, search: !!s.search, voice: s.voice || null, memory: s.memory !== false };
}
function setSettings(uid, patch) {
    data.settings[uid] = { ...getSettings(uid), ...patch };
    save();
    return getSettings(uid);
}

// ── conversation memory ──
function getHistory(key) { return (data.history[key] || []).slice(); }
function pushHistory(key, role, content) {
    if (!key || !content) return;
    const arr = data.history[key] || [];
    arr.push({ role, content: String(content).slice(0, 2000) });
    while (arr.length > cfg.MAX_HISTORY) arr.shift();
    data.history[key] = arr;
    save();
}
function clearHistory(key) {
    if (key) delete data.history[key]; else data.history = {};
    save();
}
function historyCount(key) { return (data.history[key] || []).length; }

// ── chatbot settings ──
const chatbot = () => data.chatbot;
function updateChatbot(fn) { fn(data.chatbot); save(); return data.chatbot; }

/** Is Astralena allowed to talk in this chat? */
function isActive(chatId, isGroup) {
    const cb = data.chatbot;
    if (!isGroup) return cb.enabled !== false;
    const ov = cb.chats[chatId]?.enabled;
    if (ov === true) return true;
    if (ov === false) return false;
    return cb.enabled !== false;
}
const groupMode = (chatId) => data.chatbot.chats[chatId]?.mode || 'group';

module.exports = {
    data: () => data, save,
    getSettings, setSettings,
    getHistory, pushHistory, clearHistory, historyCount,
    chatbot, updateChatbot, isActive, groupMode, flush,
};
