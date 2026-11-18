/**
 * Inline mode — type @astralena_bot_username <question> in ANY chat (the bot doesn't need to be there).
 * Telegram itself adds the "via @botusername" label to inline messages.
 */
const cfg = require('./config');
const store = require('./store');
const persona = require('./persona');
const ai = require('./ai');
const { mdToHtml, plain } = require('./format');

const latest = new Map(); // userId -> sequence number of the newest query (debounce typing)
let seq = 0;
const cache = new Map();  // `${userId}|${query}` -> { answer, at }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function article(username, plainAnswer, { title, description } = {}) {
    const body = String(plainAnswer || '').slice(0, 3500);
    const first = plain(body).replace(/\s+/g, ' ').trim();
    return {
        type: 'article',
        id: `astralena-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: title || (first.length > 64 ? first.slice(0, 61).trimEnd() + '…' : first || 'Astralena AI'),
        description: description || 'Send this answer to the chat',
        input_message_content: {
            message_text: mdToHtml(body),
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
        },
    };
}

async function handle(ctx) {
    const q = String(ctx.inlineQuery?.query || '').trim();
    const uid = ctx.from.id;
    const username = ctx.botInfo?.username || ctx.me;
    const answer = (results) => ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
    console.log(`[inline] query from ${uid}: "${q.slice(0, 60)}"`);

    try {
        if (!store.isActive(uid, false)) {
            return await answer([article(username, 'Astralena is switched off right now.')]);
        }
        if (q.length < 2) {
            return await answer([article(username, 'Type your question after my username and pause for a second and I\'ll answer right here.', { title: 'Ask Astralena anything', description: 'Keep typing...' })]);
        }

        const mine = ++seq;
        latest.set(uid, mine);
        await sleep(cfg.INLINE_DEBOUNCE_MS);
        if (latest.get(uid) !== mine) return; // they kept typing, a newer query will be answered instead

        const ck = `${uid}|${q}`;
        let text = cache.get(ck)?.answer;
        if (!text) {
            const quick = persona.acknowledgement(q);
            if (quick) text = quick;
            else {
                const cb = store.chatbot();
                const system = persona.buildSystem(cb, { inline: true, userName: ctx.from.first_name });
                let partial = '';
                const gen = ai.generate({ system, history: [], user: q, think: false, search: store.getSettings(uid).search, fast: true, onText: (t) => { partial = t; } });
                gen.catch(() => {});
                // Telegram drops inline answers that arrive too late, so answer within ~8 seconds with whatever we have
                const res = await Promise.race([gen, sleep(8000).then(() => null)]);
                text = res || (partial.length > 40 ? partial : null);
                if (!text) {
                    console.log('[inline] model too slow, sending retry hint');
                    return await answer([article(username, 'I need a little longer for that one. Add a space at the end of your question to ask again.', { title: 'Still thinking...', description: 'Add a space to retry' })]);
                }
            }
            cache.set(ck, { answer: text, at: Date.now() });
            if (cache.size > 200) cache.delete(cache.keys().next().value);
        }
        await answer([article(username, text)]);
    } catch (e) {
        console.error('[inline] failed:', e.message);
        try { await answer([article(username, "Something went wrong on my side. Try again in a moment.")]); } catch { /* query expired */ }
    }
}

module.exports = { handle };
