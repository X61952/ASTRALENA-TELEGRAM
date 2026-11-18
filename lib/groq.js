/** Groq helpers: streaming chat (the brain), vision, speech-to-text, text-to-speech (OpenAI-compatible API). */
const cfg = require('./config');

const BASE = 'https://api.groq.com/openai/v1';
const hasKey = () => cfg.GROQ_API_KEY.length >= 10;

async function call(path, { json, form, timeout = 45000, raw = false } = {}) {
    if (!hasKey()) return { ok: false, error: 'GROQ_API_KEY is not set' };
    const headers = { Authorization: `Bearer ${cfg.GROQ_API_KEY}` };
    if (json) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(BASE + path, { method: 'POST', headers, body: json ? JSON.stringify(json) : form, signal: ctrl.signal });
        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try { const j = await res.json(); msg = j?.error?.message || msg; } catch { /* ignore */ }
            return { ok: false, status: res.status, error: String(msg).slice(0, 300) };
        }
        if (raw) return { ok: true, buffer: Buffer.from(await res.arrayBuffer()) };
        return { ok: true, data: await res.json() };
    } catch (e) {
        return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
    } finally { clearTimeout(timer); }
}

const strip = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

async function _complete(models, messages, { maxTokens = 700, temperature = 0.8 } = {}) {
    let lastErr = 'no model';
    for (const model of models) {
        const body = { model, messages, max_tokens: maxTokens, temperature };
        if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
        if (/qwen3/.test(model)) body.reasoning_effort = 'none';
        let r = await call('/chat/completions', { json: body });
        if (!r.ok && body.reasoning_effort) { delete body.reasoning_effort; r = await call('/chat/completions', { json: body }); }
        if (!r.ok) { lastErr = `${model}: ${r.error}`; continue; }
        const text = strip(r.data?.choices?.[0]?.message?.content);
        if (text) return { ok: true, text, model };
        lastErr = `${model}: empty reply`;
    }
    console.error('[groq]', lastErr);
    return { ok: false, error: lastErr };
}

/** One-shot text chat (no streaming). */
async function chat({ system, messages, maxTokens = 700 }) {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push(...messages);
    const r = await _complete(cfg.GROQ_CHAT_MODELS, msgs, { maxTokens });
    return r.ok ? r.text : '';
}


// ── streaming chat (the brain) ──────────────────────────────────────────────
function cleanThink(t) {
    return String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/^\s+/, '');
}

async function streamOne(model, messages, { think, onText, fast }) {
    const body = { model, messages, stream: true, temperature: 0.8, max_tokens: fast ? 500 : think ? 3000 : 1100 };
    if (/gpt-oss/.test(model)) body.reasoning_effort = think ? 'medium' : 'low';
    else if (/qwen3/.test(model)) body.reasoning_effort = think ? 'default' : 'none';

    for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), cfg.REQUEST_TIMEOUT_MS);
        let acc = '';
        try {
            const res = await fetch(BASE + '/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            if (!res.ok) {
                let msg = `HTTP ${res.status}`;
                try { const j = await res.json(); msg = j?.error?.message || msg; } catch { /* ignore */ }
                // some models reject reasoning_effort — retry once without it
                if (res.status === 400 && body.reasoning_effort && attempt === 0) { delete body.reasoning_effort; continue; }
                throw new Error(`${model}: ${String(msg).slice(0, 200)}`);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            let finished = false;
            while (!finished) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const p = t.slice(5).trim();
                    if (p === '[DONE]') { finished = true; break; }
                    try {
                        const j = JSON.parse(p);
                        if (j.error) throw new Error(j.error.message || 'stream error');
                        const delta = j.choices?.[0]?.delta?.content;
                        if (delta) {
                            acc += delta;
                            if (onText) { try { await onText(cleanThink(acc)); } catch { /* ignore */ } }
                        }
                    } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
                }
            }
            const out = cleanThink(acc).trim();
            if (!out) throw new Error(`${model}: empty reply`);
            return out;
        } catch (e) {
            if (acc.trim()) return cleanThink(acc).trim(); // stream broke late — keep what we have
            throw e.name === 'AbortError' ? new Error(`${model}: timed out`) : e;
        } finally { clearTimeout(timer); }
    }
}

/**
 * Streaming chat. Tries the live-search model first when search is on, then the chat models in order.
 * onText(partial) fires as tokens arrive. Returns the full reply.
 */
async function streamChat({ system = '', history = [], user, think = false, search = false, onText = null, fast = false }) {
    if (!hasKey()) throw new Error('GROQ_API_KEY is not set');
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push(...history.map((h) => ({ role: h.role, content: h.content })));
    messages.push({ role: 'user', content: user });

    const models = [];
    if (search && cfg.GROQ_SEARCH_MODEL) models.push(cfg.GROQ_SEARCH_MODEL);
    models.push(...cfg.GROQ_CHAT_MODELS);

    let lastErr;
    for (const model of models) {
        try { return await streamOne(model, messages, { think, onText, fast }); } catch (e) { lastErr = e; console.error('[groq]', e.message); }
    }
    throw lastErr || new Error('No Groq model answered');
}

/** One-shot image question → { ok, text } */
async function vision({ base64, mimetype = 'image/jpeg', prompt = 'Describe this image.', system = '', maxTokens = 900 }) {
    if (!hasKey()) return { ok: false, error: 'GROQ_API_KEY is not set' };
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
    });
    return _complete(cfg.GROQ_VISION_MODELS, messages, { maxTokens, temperature: 0.4 });
}

/** Voice note / audio → text (Whisper). */
async function transcribe(buffer, { mimetype = 'audio/ogg', filename = 'voice.ogg', toMp3 = null } = {}) {
    if (!buffer?.length) return { ok: false, error: 'Empty audio.' };
    if (!hasKey()) return { ok: false, error: 'GROQ_API_KEY is not set' };
    let lastErr = '';
    let mp3 = null;
    const once = (model, buf, name, type) => {
        const form = new FormData();
        form.append('file', new Blob([buf], { type }), name);
        form.append('model', model);
        form.append('response_format', 'json');
        return call('/audio/transcriptions', { form, timeout: 60000 });
    };
    for (const model of cfg.GROQ_WHISPER_MODELS) {
        let r = await once(model, buffer, filename, mimetype);
        if (!r.ok && toMp3) {
            if (!mp3) mp3 = await toMp3(buffer).catch(() => null);
            if (mp3) r = await once(model, mp3, 'voice.mp3', 'audio/mpeg');
        }
        if (r.ok) {
            const text = String(r.data?.text || '').trim();
            if (text) return { ok: true, text };
            lastErr = 'no speech detected';
        } else lastErr = r.error;
    }
    console.error('[groq] transcribe failed:', lastErr);
    return { ok: false, error: lastErr };
}

/** Text → speech (Orpheus, female voice). → { ok, buffer } | { ok:false, error } (WAV audio) */
async function speech(text, voice = cfg.TTS_VOICE) {
    const r = await call('/audio/speech', {
        json: { model: cfg.TTS_MODEL, voice, input: String(text).slice(0, 190), response_format: 'wav' },
        timeout: 30000,
        raw: true,
    });
    if (!r.ok) return { ok: false, error: r.error };
    if (r.buffer.length < 800) return { ok: false, error: 'audio too small' };
    return { ok: true, buffer: r.buffer };
}

module.exports = { hasKey, chat, streamChat, vision, transcribe, speech };
