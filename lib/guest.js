/**
 * Guest mode (Bot API 10.0) — people tag the bot in a chat it is NOT a member of. Telegram sends a
 * `guest_message` update and the bot may answer ONCE with answerGuestQuery. The reply shows up as if
 * Astralena were in the chat (bot name + profile visible).
 *
 * Needs: Guest Mode switched on for the bot in @BotFather, and "guest_message" in allowed_updates (done in index.js).
 * Because there is only one reply, images/stickers/voice notes are answered directly (no menu).
 */
const store = require('./store');
const persona = require('./persona');
const ai = require('./ai');
const agent = require('./agent');
const memory = require('./memory');
const groq = require('./groq');
const media = require('./media');
const { mdToHtml } = require('./format');
const { stripAddress, mediaRef, fullName } = require('./context');

const VISION_SYSTEM = 'You are Astralena AI, a female space-and-tech AI. Answer about the image naturally and briefly, like a person texting, with a light touch of space/tech slang. Do not invent details you cannot see. Mention any visible text.';

async function answerGuest(telegram, queryId, text) {
    const body = String(text || '').slice(0, 3900);
    return telegram.callApi('answerGuestQuery', {
        guest_query_id: queryId,
        result: {
            type: 'article',
            id: `g${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
            title: 'Astralena AI',
            input_message_content: {
                message_text: mdToHtml(body),
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
            },
        },
    });
}

async function imageQuestion(telegram, ref, question) {
    const buf = ref.kind === 'sticker' && ref.isAnimated
        ? await media.download(telegram, ref.thumbId || ref.fileId)
        : await media.download(telegram, ref.fileId);
    let frame = buf;
    if (ref.kind === 'video') frame = await media.videoFrame(buf);
    else if (ref.kind === 'sticker' && ref.isVideo) frame = await media.webmFrame(buf);
    const { base64, mimetype } = await media.toBase64Jpeg(frame);
    const r = await groq.vision({ base64, mimetype, system: VISION_SYSTEM, prompt: question || 'Describe this image.' });
    return r.ok ? r.text : null;
}

async function handle(ctx, gm) {
    const queryId = gm.guest_query_id;
    if (!queryId) return;
    const telegram = ctx.telegram;
    const caller = gm.guest_bot_caller_user || gm.from || {};
    const callerName = fullName(caller);
    const me = ctx.botInfo || {};

    try {
        if (!store.isActive(caller.id || 0, false)) return await answerGuest(telegram, queryId, 'Astralena is switched off right now.');

        let text = stripAddress(String(gm.text || gm.caption || ''), me);
        const replied = gm.reply_to_message;
        const quotedText = String(replied?.text || replied?.caption || '').trim();

        // picture / sticker / video / voice note — in the message itself or in the one being replied to
        const ref = mediaRef(gm) || mediaRef(replied);
        const voiceMsg = gm.voice || replied?.voice;

        let answer = null;
        if (ref) {
            const q = text || (ref.kind === 'sticker' ? 'Describe this sticker briefly.' : 'Describe this image.');
            answer = await imageQuestion(telegram, ref, q).catch((e) => { console.error('[guest media]', e.message); return null; });
            if (!answer) answer = "I couldn't look at that one — try again in a moment.";
        } else if (voiceMsg) {
            const buf = await media.download(telegram, voiceMsg.file_id);
            const r = await groq.transcribe(buf, { mimetype: voiceMsg.mime_type || 'audio/ogg', toMp3: media.toMp3 });
            text = r.ok ? `${text ? text + '\n' : ''}${r.text}` : text;
            if (!r.ok && !text) answer = "Couldn't catch that voice note, say it again?";
        }

        if (!answer) {
            if (!text && !quotedText) {
                answer = "Hey, Astralena here. What do you need?";
            } else {
                const quick = persona.acknowledgement(text);
                if (quick) answer = quick;
                else {
                    const cb = store.chatbot();
                    const settings = store.getSettings(caller.id || 0);
                    let user = text || 'Respond to this message.';
                    if (quotedText) user += `\n(they are replying to this message: "${quotedText.slice(0, 600)}")`;
                    const useAgent = agent.shouldUse(user, { search: settings.search });
                    const system = persona.buildSystem(cb, { guest: true, userName: callerName, tools: useAgent, memoryFacts: memory.promptFacts(caller.id || 0) });
                    const history = store.getHistory(`guest:${caller.id}`);
                    if (useAgent) {
                        // guest mode gives exactly one reply, so only look-up tools (no sending files) are allowed
                        try { answer = await agent.run({ system, history, user, host: null, readonly: true, think: settings.think }); }
                        catch (e) { console.error('[guest agent]', e.message); }
                    }
                    if (!answer) answer = await ai.generate({ system, history, user, think: settings.think, search: settings.search });
                    store.pushHistory(`guest:${caller.id}`, 'user', user);
                    store.pushHistory(`guest:${caller.id}`, 'assistant', answer);
                }
            }
        }
        await answerGuest(telegram, queryId, answer);
    } catch (e) {
        console.error('[guest]', e.message);
        try { await answerGuest(telegram, queryId, "Something went wrong on my side. Try again in a moment."); } catch { /* expired */ }
    }
}

module.exports = { handle };
