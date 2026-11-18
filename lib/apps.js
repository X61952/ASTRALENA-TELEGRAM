/**
 * /app <name> — search free & open-source Android apps on F-Droid and send the APK on request.
 * (Play Store apps can't be downloaded legally by a bot, so for those she gives you the store link.)
 */
const web = require('./web');
const { esc } = require('./format');
const { replier } = require('./context');

const tokens = new Map(); // token -> { owner, pkgs:[{pkg,name}], expires }
setInterval(() => { const n = Date.now(); for (const [k, v] of tokens) if (n > v.expires) tokens.delete(k); }, 10 * 60 * 1000).unref?.();

const decode = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

async function search(query) {
    const r = await web.safeGet(`https://search.f-droid.org/?q=${encodeURIComponent(query)}&lang=en`, { maxBytes: 1.5 * 1024 * 1024 });
    if (r.status >= 400) throw new Error(`F-Droid search answered HTTP ${r.status}`);
    const html = r.body.toString('utf8');
    const out = [];
    for (const m of html.matchAll(/<a\b[^>]*class="[^"]*package-header[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const pkg = (m[1].match(/\/packages\/([^/?#]+)/) || [])[1];
        if (!pkg) continue;
        const name = decode((m[2].match(/package-name[^>]*>([\s\S]*?)<\//i) || [])[1] || pkg);
        const summary = decode((m[2].match(/package-summary[^>]*>([\s\S]*?)<\//i) || [])[1] || '');
        if (!out.some((o) => o.pkg === pkg)) out.push({ pkg, name, summary });
        if (out.length >= 6) break;
    }
    return out;
}

async function apkFor(pkg) {
    const r = await web.safeGet(`https://f-droid.org/api/v1/packages/${encodeURIComponent(pkg)}`, { maxBytes: 600 * 1024, accept: 'application/json' });
    if (r.status >= 400) throw new Error('F-Droid has no downloadable build for that app.');
    const j = JSON.parse(r.body.toString('utf8'));
    const code = j.suggestedVersionCode || j.packages?.[0]?.versionCode;
    const ver = (j.packages || []).find((p) => p.versionCode === code)?.versionName || String(code);
    if (!code) throw new Error('Could not find a version to download.');
    const url = `https://f-droid.org/repo/${pkg}_${code}.apk`;
    const file = await web.safeGet(url, { maxBytes: 49 * 1024 * 1024, timeout: 120000, accept: '*/*' });
    if (file.status >= 400) throw new Error('The APK could not be downloaded.');
    if (file.truncated) throw new Error('That APK is larger than 49 MB, which is Telegram\'s upload limit for bots. Use the F-Droid link instead: https://f-droid.org/packages/' + pkg);
    return { buffer: file.body, name: `${pkg}_${ver}.apk`, version: ver };
}

async function run({ ctx, replyTo, query, userId }) {
    const rep = replier(ctx, replyTo);
    const play = `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps`;
    let results = [];
    try { results = await search(query); } catch (e) { console.error('[app search]', e.message); }
    if (!results.length) {
        await rep.plain(`I found nothing for "${query}" on F-Droid (free and open-source apps).\nTry the Play Store: ${play}`, { link_preview_options: { is_disabled: true } });
        return true;
    }
    const token = Math.random().toString(36).slice(2, 10);
    tokens.set(token, { owner: String(userId), pkgs: results, expires: Date.now() + 15 * 60 * 1000 });
    const lines = results.map((a, i) => `${i + 1}. <b>${esc(a.name)}</b>${a.summary ? ' - ' + esc(a.summary.slice(0, 90)) : ''}`).join('\n');
    await ctx.reply(`<b>Apps matching "${esc(query)}"</b> (free and open-source, from F-Droid)\n\n${lines}\n\nTap a number to get the APK.\nPlay Store search: ${esc(play)}`, rep.extra({
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [results.map((_, i) => ({ text: String(i + 1), callback_data: `app:${userId}:${i}:${token}` }))] },
    }));
    return true;
}

async function handleButton(ctx) {
    const [, owner, idx, token] = String(ctx.callbackQuery.data).split(':');
    if (String(ctx.from.id) !== owner) return ctx.answerCbQuery('This list is for someone else.').catch(() => {});
    const t = tokens.get(token);
    const app = t?.pkgs?.[+idx];
    if (!app) return ctx.answerCbQuery('That list expired. Search again.', { show_alert: true }).catch(() => {});
    await ctx.answerCbQuery('Downloading ' + app.name).catch(() => {});
    const replyTo = ctx.callbackQuery.message?.reply_to_message?.message_id || ctx.callbackQuery.message?.message_id;
    const rep = replier(ctx, replyTo);
    try {
        await ctx.sendChatAction('upload_document').catch(() => {});
        const apk = await apkFor(app.pkg);
        await ctx.replyWithDocument({ source: apk.buffer, filename: apk.name }, rep.extra({ caption: `${app.name} ${apk.version}\nSource: F-Droid (open source)` }));
    } catch (e) {
        console.error('[app apk]', e.message);
        await rep.plain(`Could not get that APK: ${String(e.message).slice(0, 220)}`).catch(() => {});
    }
}

module.exports = { run, handleButton, search };
