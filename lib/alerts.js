/** Sends important errors to the bot owner (throttled so it never spams). */
const cfg = require('./config');
const stats = require('./stats');

let bot = null;
const last = new Map();

const init = (b) => { bot = b; };

async function notify(source, err) {
    stats.error();
    if (!bot || cfg.ALERTS !== 'on' || !cfg.OWNER_IDS.length) return;
    const msg = String(err?.message || err || 'unknown').slice(0, 300);
    const key = `${source}:${msg.slice(0, 60)}`;
    const now = Date.now();
    if (now - (last.get(key) || 0) < 10 * 60 * 1000) return; // same problem: at most once per 10 minutes
    last.set(key, now);
    if (last.size > 200) last.delete(last.keys().next().value);
    for (const id of cfg.OWNER_IDS) {
        await bot.telegram.sendMessage(id, `Alert from ${source}\n\n${msg}`).catch(() => {});
    }
}

module.exports = { init, notify };
