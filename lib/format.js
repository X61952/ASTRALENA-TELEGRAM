/** Markdown (what the AI writes) → Telegram HTML, plus safe splitting/sending helpers. */
// Astralena never uses emojis: everything that goes out passes through this filter.
const EMOJI = '[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{2300}-\\u{23FF}\\u{FE0F}\\u{200D}\\u{20E3}\\u{E0020}-\\u{E007F}]';
const EMOJI_RE = new RegExp(EMOJI + '+[ \\t]?', 'gu');
const HAS_EMOJI = new RegExp(EMOJI, 'u');
function stripEmoji(text) {
    const t = String(text ?? '');
    if (!HAS_EMOJI.test(t)) return t;
    return t.replace(EMOJI_RE, '').replace(/ +([.,!?;:])(?=\s|$)/g, '$1').replace(/[ \t]+(?=\n|$)/g, '');
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mdToHtml(src) {
    const codeBlocks = [];
    const inline = [];
    let t = stripEmoji(src);
    t = t.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code) => {
        codeBlocks.push(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`);
        return `\u0000B${codeBlocks.length - 1}\u0000`;
    });
    t = t.replace(/`([^`\n]+)`/g, (_, c) => {
        inline.push(`<code>${esc(c)}</code>`);
        return `\u0000I${inline.length - 1}\u0000`;
    });
    t = esc(t);
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url.replace(/"/g, '%22')}">${label}</a>`);
    t = t.replace(/\u0000I(\d+)\u0000/g, (_, i) => inline[+i]);
    t = t.replace(/\u0000B(\d+)\u0000/g, (_, i) => codeBlocks[+i]);
    return t;
}

/** Plain text for live drafts (no markdown symbols showing). */
function plain(src) {
    return stripEmoji(src)
        .replace(/```[\w+-]*\n?/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/`([^`\n]+)`/g, '$1');
}

function split(text, max = 4000) {
    const out = [];
    let rest = String(text ?? '');
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n\n', max);
        if (cut < max * 0.4) cut = rest.lastIndexOf('\n', max);
        if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.4) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.length ? out : [''];
}

/** Sends text with HTML formatting; falls back to plain text if Telegram rejects the markup. */
async function sendText(ctx, text, extra = {}) {
    const chunks = split(text);
    let last = null;
    for (let i = 0; i < chunks.length; i++) {
        const opts = { ...extra, link_preview_options: { is_disabled: true } };
        if (i > 0) delete opts.reply_parameters;
        try {
            last = await ctx.reply(mdToHtml(chunks[i]), { ...opts, parse_mode: 'HTML' });
        } catch (e) {
            if (/can't parse|parse entities|Bad Request: can't/i.test(e.message || '')) {
                last = await ctx.reply(chunks[i], opts);
            } else throw e;
        }
    }
    return last;
}

module.exports = { esc, stripEmoji, mdToHtml, plain, split, sendText };
