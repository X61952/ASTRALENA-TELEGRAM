/**
 * Image / sticker / video handling — the Telegram version of the WhatsApp "what should I do with it?" flow.
 *   offerMenu()      → "Got your image! What should I do with it?" + numbered list (+ tap buttons)
 *   resolvePending() → the person answers with a number or words
 *   runAction()      → does the thing
 *   askAbout()       → free-text question about a picture
 */
const media = require('./media');
const groq = require('./groq');
const pending = require('./pending');
const intents = require('./intents');
const stickers = require('./stickers');
const store = require('./store');
const { sendText } = require('./format');
const { replier } = require('./context');

const QUESTION_ABOUT_MEDIA = /\?\s*$|\b(this|that|it|image|photo|pic|picture|video|sticker|him|her|them|they)\b/i;
const VISION_SYSTEM = 'You are Astralena AI, a female space-and-tech AI (JARVIS-style). Answer about the image naturally and briefly, like a person texting, with a light touch of space/tech radio slang. Do not invent details you cannot see. Mention any visible text. If it is relevant, add one sharp insight about the space, technology or engineering side of what you see.';
const TG_LIMIT = 20 * 1024 * 1024;

const typing = (ctx, action = 'typing') => ctx.sendChatAction(action).catch(() => {});

function keyboard(kind, ownerId) {
    const n = intents.TABLES[kind].length;
    const rows = [];
    for (let i = 1; i <= n; i += 5) {
        rows.push(Array.from({ length: Math.min(5, n - i + 1) }, (_, k) => ({ text: String(i + k), callback_data: `mf:${ownerId}:${i + k}` })));
    }
    rows.push([{ text: 'Cancel', callback_data: `mf:${ownerId}:x` }]);
    return { inline_keyboard: rows };
}

// ── get image bytes out of a media reference ──
async function fetchRef(ctx, ref) {
    if (ref.size && ref.size > TG_LIMIT) throw new Error("That file is too big for me to download (Telegram's limit is 20 MB).");
    return media.download(ctx.telegram, ref.fileId);
}

/** Any image/sticker/video reference → an image buffer sharp can read. */
async function imageBuffer(ctx, ref) {
    if (ref.kind === 'image') return fetchRef(ctx, ref);
    if (ref.kind === 'sticker') {
        if (ref.isAnimated) { // .tgs can't be decoded here — use Telegram's own preview image
            if (!ref.thumbId) throw new Error("Animated stickers can't be converted — Telegram gave me no preview for this one.");
            return media.download(ctx.telegram, ref.thumbId);
        }
        const buf = await fetchRef(ctx, ref);
        return ref.isVideo ? media.webmFrame(buf) : buf;
    }
    return media.videoFrame(await fetchRef(ctx, ref));
}

function visionError(r) {
    const e = r?.error || '';
    if (/not set/i.test(e)) return 'Image understanding needs GROQ_API_KEY to be set in the .env file.';
    return "I couldn't read that image right now. Try again in a bit.";
}

// ── the menu ──
async function offerMenu(ctx, m, ref) {
    pending.set(m.pendKey, { kind: ref.kind, ref, chatId: m.chatId, ownerId: m.userId });
    const rep = replier(ctx, m.msg.message_id);
    await rep.plain(intents.menuText(ref.kind), { reply_markup: keyboard(ref.kind, m.userId) });
    return true;
}

/** Sticker flow: answer with one of Astralena's own stickers first, THEN ask what to do with theirs. */
async function stickerFlow(ctx, m, ref) {
    const rep = replier(ctx, m.msg.message_id);
    try {
        const id = await stickers.random(ctx.telegram);
        if (id) await rep.sticker(id);
    } catch (e) { console.error('[sticker reply]', e.message); }
    return offerMenu(ctx, m, ref);
}

// ── actions ──
/**
 * run({ ctx, chatId, userId, replyTo, kind, id, ref, pendKey, extra })
 * `extra` = the person's own words (sizes, "as document"…).
 */
async function runAction(o) {
    const { ctx, kind, id, ref, pendKey, extra = '' } = o;
    const rep = replier(ctx, o.replyTo);
    const fail = (msg) => rep.plain(`${msg}`);
    const name = () => Math.random().toString(36).slice(2, 7);

    try {
        switch (id) {
            // ── images ──
            case 'removebg': {
                await rep.plain('Removing the background…');
                await typing(ctx, 'upload_document');
                const out = await media.removeBackground(await imageBuffer(ctx, ref));
                // sent as a file so the transparency survives (Telegram photos turn transparent areas black)
                await rep.document(out, `${name()}_nobg.png`, 'BACKGROUND REMOVED VIA ASTRALENA AI');
                break;
            }
            case 'sticker':
            case 'rsticker': {
                const stk = await media.imageToSticker(await imageBuffer(ctx, ref), { round: id === 'rsticker' });
                await rep.sticker(stk);
                break;
            }
            case 'ocr': {
                await rep.plain('Scanning image for text...');
                const buf = await imageBuffer(ctx, ref);
                let found = '';
                try { found = await media.ocrSpace(buf); } catch (e) { console.error('[OCR]', e.message); }
                if (!found) {
                    try {
                        const { base64, mimetype } = await media.toBase64Jpeg(buf);
                        const r = await groq.vision({
                            base64, mimetype, maxTokens: 1200,
                            prompt: 'Extract ALL text visible in this image exactly as written, keeping line breaks. Output only the text. If there is no readable text, output exactly: NO_TEXT',
                        });
                        if (r.ok && !/^NO_TEXT\b/i.test(r.text)) found = r.text;
                    } catch { /* ignore */ }
                }
                if (!found) return await fail('No text detected in the image.');
                await rep.plain(`OCR RESULT\n\n${found}`.slice(0, 4000));
                break;
            }
            case 'describe': {
                await typing(ctx);
                const { base64, mimetype } = await media.toBase64Jpeg(await imageBuffer(ctx, ref));
                const r = await groq.vision({
                    base64, mimetype,
                    system: 'You are Astralena AI, a female space-and-tech AI (JARVIS-style). Describe images naturally in 2-4 short sentences: main subject, setting, mood, any visible text, with a light touch of space/tech slang. If it shows space, hardware, a circuit, a robot or a machine, name what it is and the key details. Do not invent details.',
                    prompt: kind === 'sticker' ? 'Describe this sticker briefly (subject, expression, style).' : kind === 'video' ? 'Describe this image, it is the first frame of a video.' : 'Describe this image.',
                });
                if (!r.ok) return await fail(visionError(r));
                await sendText(ctx, r.text, rep.extra());
                break;
            }
            case 'resize': {
                const spec = media.parseResizeSpec(extra);
                if (!spec) {
                    pending.set(pendKey, { kind: 'image', ref, step: 'resize', tries: 0, chatId: o.chatId, ownerId: o.userId });
                    return await rep.plain('What size? Send something like 800x600, 50%, or a preset: small, medium, large, hd.');
                }
                const out = await media.resizeImage(await imageBuffer(ctx, ref), spec);
                await rep.document(out.buffer, `resized_${out.width}x${out.height}.jpg`, `Resized to ${out.width}×${out.height}`);
                break;
            }
            case 'bw':
                await rep.photo(await media.blackAndWhite(await imageBuffer(ctx, ref)), 'Black & white');
                break;
            case 'compress': {
                const buf = await imageBuffer(ctx, ref);
                const out = await media.compress(buf);
                await rep.document(out, `compressed_${name()}.jpg`, `Compressed: ${(buf.length / 1024).toFixed(0)} KB → ${(out.length / 1024).toFixed(0)} KB`);
                break;
            }
            case 'document': {
                const buf = await imageBuffer(ctx, ref);
                const isPng = buf[0] === 0x89 && buf[1] === 0x50;
                await rep.document(buf, `astralena_${Date.now()}.${isPng ? 'png' : 'jpg'}`);
                break;
            }

            // ── stickers ──
            case 'image': {
                const jpg = await media.toJpeg(await imageBuffer(ctx, ref), 1600, 92); // white background instead of black
                await rep.photo(jpg, 'Sticker converted to image');
                break;
            }
            case 'gif': {
                await typing(ctx, 'upload_video');
                const useVideo = ref.kind === 'sticker' && ref.isVideo;
                const buf = useVideo ? await fetchRef(ctx, ref) : await imageBuffer(ctx, ref);
                await rep.animation(await media.stickerToGif(buf, { isVideo: useVideo }), 'Converted to GIF');
                break;
            }
            case 'img_nobg': {
                await rep.plain('Converting and removing the background…');
                await typing(ctx, 'upload_document');
                const png = await media.toPng(await imageBuffer(ctx, ref));
                const out = await media.removeBackground(png);
                await rep.document(out, `${name()}_nobg.png`, 'BACKGROUND REMOVED VIA ASTRALENA AI');
                break;
            }

            // ── videos ──
            case 'frame':
                await rep.photo(await media.videoFrame(await fetchRef(ctx, ref)), 'First frame');
                break;
            case 'audio': {
                const mp3 = await media.audioFromVideo(await fetchRef(ctx, ref));
                if (!mp3) return await rep.plain("That video doesn't seem to have any sound.");
                await rep.audio(mp3, 'audio.mp3');
                break;
            }
            case 'transcribe': {
                await rep.plain('Listening…');
                const mp3 = await media.audioFromVideo(await fetchRef(ctx, ref));
                if (!mp3) return await rep.plain("That video doesn't seem to have any sound.");
                const r = await groq.transcribe(mp3, { mimetype: 'audio/mpeg', filename: 'audio.mp3' });
                if (!r.ok) return await fail("Couldn't transcribe that" + (/not set/i.test(r.error) ? ' — GROQ_API_KEY is missing.' : '.'));
                await rep.plain(`Transcript:\n\n${r.text}`.slice(0, 4000));
                break;
            }
            default:
                return false;
        }
        pending.clear(pendKey);
        return true;
    } catch (e) {
        console.error('[media action]', id, e.message);
        pending.clear(pendKey);
        await fail(e.message && e.message.length < 160 ? e.message : 'Something went wrong with that. Try again?');
        return true;
    }
}

/** Free-text question about a held image / sticker / video frame. */
async function askAbout({ ctx, replyTo, ref, question, userId }) {
    const rep = replier(ctx, replyTo);
    try {
        await typing(ctx);
        const { base64, mimetype } = await media.toBase64Jpeg(await imageBuffer(ctx, ref));
        const r = await groq.vision({
            base64, mimetype, system: VISION_SYSTEM,
            prompt: question + (ref.kind === 'video' ? '\n(This is the first frame of a video.)' : ''),
        });
        if (r.ok) {
            await sendText(ctx, r.text, rep.extra());
            if (userId) { // let the conversation remember what was just discussed
                const key = ctx.chat.type === 'private' ? `dm:${userId}` : `grp:${ctx.chat.id}`;
                store.pushHistory(key, 'user', `[sent ${ref.kind === 'image' ? 'an image' : 'a ' + ref.kind}] ${question}`);
                store.pushHistory(key, 'assistant', r.text);
            }
        } else await rep.plain(`${visionError(r)}`);
    } catch (e) {
        console.error('[media question]', e.message);
        await rep.plain('Couldn\'t get a lock on that one.');
    }
    return true;
}

/** The person answered a menu we showed (typed text). Returns true if it was handled. */
async function resolvePending({ ctx, m, text, pend }) {
    const rep = replier(ctx, m.msg.message_id);
    const base = { ctx, chatId: m.chatId, userId: m.userId, replyTo: m.msg.message_id, pendKey: m.pendKey, ref: pend.ref };

    if (pend.step === 'resize') {
        if (intents.CANCEL.test(text)) { pending.clear(m.pendKey); await rep.plain('Okay, cancelled.'); return true; }
        if (!media.parseResizeSpec(text)) {
            const tries = (pend.tries || 0) + 1;
            if (tries >= 3) { pending.clear(m.pendKey); await rep.plain('No worries, cancelled the resize.'); return true; }
            pending.set(m.pendKey, { ...pend, tries });
            await rep.plain('I need a size like 800x600, 50%, or small / medium / large / hd.');
            return true;
        }
        return runAction({ ...base, kind: 'image', id: 'resize', extra: text });
    }

    const r = intents.resolve(pend.kind, text);
    if (r?.cancel) { pending.clear(m.pendKey); await rep.plain('Alright '); return true; }
    if (r?.id) return runAction({ ...base, kind: pend.kind, id: r.id, extra: text });

    if (text.trim().length >= 3 && QUESTION_ABOUT_MEDIA.test(text)) {
        pending.clear(m.pendKey);
        return askAbout({ ctx, replyTo: m.msg.message_id, ref: pend.ref, question: text, userId: m.userId });
    }
    pending.clear(m.pendKey);
    return false;
}

/** A number button was tapped. */
async function handleButton(ctx) {
    const [, owner, choice] = String(ctx.callbackQuery.data).split(':');
    if (String(ctx.from.id) !== owner) return ctx.answerCbQuery('This menu is for someone else ', { show_alert: false }).catch(() => {});
    const chatId = ctx.callbackQuery.message?.chat?.id;
    const pendKey = `${chatId}:${owner}`;
    const pend = pending.get(pendKey);
    if (!pend) return ctx.answerCbQuery('That menu expired — send the picture again.', { show_alert: true }).catch(() => {});
    if (choice === 'x') {
        pending.clear(pendKey);
        await ctx.answerCbQuery('Cancelled').catch(() => {});
        return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    }
    const picked = intents.TABLES[pend.kind][+choice - 1];
    if (!picked) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery(picked.label).catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const replyTo = ctx.callbackQuery.message?.reply_to_message?.message_id || ctx.callbackQuery.message?.message_id;
    return runAction({ ctx, chatId, userId: ctx.from.id, replyTo, kind: pend.kind, id: picked.id, ref: pend.ref, pendKey, extra: '' });
}

module.exports = { offerMenu, stickerFlow, runAction, askAbout, resolvePending, handleButton, QUESTION_ABOUT_MEDIA };
