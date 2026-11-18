/**
 * The agent: Astralena decides for herself which tools to use, in what order, then answers.
 * Uses Groq tool calling (OpenAI-compatible). Up to 5 tool rounds per message.
 * Messages that clearly need no tools skip the agent and use the fast streaming path.
 */
const cfg = require('./config');
const store = require('./store');
const stats = require('./stats');
const memory = require('./memory');
const search = require('./search');
const web = require('./web');
const tools = require('./tools');
const apps = require('./apps');
const webFlow = require('./webFlow');
const fetcher = require('./fetcher');
const { replier } = require('./context');
const { stripEmoji } = require('./format');

const BASE = 'https://api.groq.com/openai/v1';
const MAX_STEPS = 5;
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n[truncated]' : String(s));

// ── the tools ───────────────────────────────────────────────────────────────
const TOOLS = [
    { name: 'web_search', readonly: true, description: 'Search the web for current information: news, recent events, prices, launch dates, anything that may have changed or that you are unsure about. Returns titles, links and snippets.',
        parameters: obj({ query: str('The search query') }, ['query']),
        run: async ({ query }) => { const r = await search.search(query, 5); return r.results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n'); } },
    { name: 'read_webpage', readonly: true, description: 'Open a web page and read its text content (title, description, main text). Use after web_search to read a result, or when the person gives a link.',
        parameters: obj({ url: str('The page URL') }, ['url']),
        run: async ({ url }) => {
            const u = web.normalizeUrl(url); if (!u) throw new Error('That is not a valid URL.');
            const d = await web.explorePage(u);
            if (d.notHtml) return `That link is a file (${d.contentType}), not a web page.`;
            return `Title: ${d.title}\nDescription: ${d.description}\nTech: ${d.tech.join(', ') || 'unknown'}\n\n${clip(d.text, 5000)}`;
        } },
    { name: 'http_request', readonly: true, description: 'Make an HTTP request like curl (GET, POST, PUT, PATCH, DELETE, HEAD) to a public URL and read the response. Useful for APIs.',
        parameters: obj({ method: str('HTTP method, default GET'), url: str('Public URL'), headers: { type: 'object', description: 'Optional headers', additionalProperties: { type: 'string' } }, body: str('Optional request body') }, ['url']),
        run: async ({ method = 'GET', url, headers = {}, body }, host, readonly) => {
            method = String(method).toUpperCase();
            if (readonly && !['GET', 'HEAD'].includes(method)) throw new Error('Only GET requests are allowed here.');
            const u = web.normalizeUrl(url); if (!u) throw new Error('That is not a valid URL.');
            const r = await tools.runCurl({ url: u, method, headers, data: body ?? null, timeout: 20 });
            const text = /text|json|xml|javascript|html/.test(String(r.headers.get('content-type') || '')) ? r.buf.toString('utf8') : `(binary, ${r.buf.length} bytes)`;
            return `HTTP ${r.status} (${r.ms} ms, ${String(r.headers.get('content-type') || '').split(';')[0]})\n${clip(text, 3500)}`;
        } },
    { name: 'get_weather', readonly: true, description: 'Current weather and a 3-day forecast for a place.',
        parameters: obj({ place: str('City or place name') }, ['place']),
        run: async ({ place }) => {
            const g = await tools.getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`);
            const loc = g.results?.[0]; if (!loc) return `No place found called "${place}".`;
            const w = await tools.getJson(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3`);
            const c = w.current, d = w.daily;
            return `${loc.name}, ${loc.country || ''}: now ${Math.round(c.temperature_2m)}C (feels ${Math.round(c.apparent_temperature)}C), ${tools.WMO[c.weather_code] || 'unknown'}, humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h.\n` +
                d.time.map((t, i) => `${t}: ${Math.round(d.temperature_2m_min[i])} to ${Math.round(d.temperature_2m_max[i])}C, rain chance ${d.precipitation_probability_max[i] ?? 0}%`).join('\n');
        } },
    { name: 'get_iss_location', readonly: true, description: 'Where the International Space Station is right now (latitude, longitude, altitude, speed).', parameters: obj({}),
        run: async () => { const d = await tools.getJson('https://api.wheretheiss.at/v1/satellites/25544'); return `ISS: lat ${d.latitude.toFixed(3)}, lon ${d.longitude.toFixed(3)}, altitude ${tools.fmt(d.altitude, 1)} km, speed ${tools.fmt(d.velocity, 0)} km/h, ${d.visibility}.`; } },
    { name: 'get_people_in_space', readonly: true, description: 'Who is in space right now and on which spacecraft.', parameters: obj({}),
        run: async () => { const d = await tools.getJson('http://api.open-notify.org/astros.json'); return `${d.number} people in space: ` + (d.people || []).map((p) => `${p.name} (${p.craft})`).join(', '); } },
    { name: 'get_upcoming_launches', readonly: true, description: 'The next scheduled rocket launches worldwide with dates and launch sites.', parameters: obj({}),
        run: async () => { const d = await tools.getJson('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=6&mode=list'); return (d.results || []).map((l) => `${l.name} | ${tools.utc(l.net)} | ${l.status?.abbrev || ''} | ${l.pad?.location?.name || ''}`).join('\n') || 'No launches returned.'; } },
    { name: 'get_nasa_picture_of_the_day', readonly: true, description: "NASA's Astronomy Picture of the Day: title and explanation.", parameters: obj({}),
        run: async () => { const d = await tools.getJson(`https://api.nasa.gov/planetary/apod?api_key=${process.env.NASA_API_KEY || 'DEMO_KEY'}`, 20000); return `${d.title} (${d.date})\n${clip(d.explanation || '', 900)}\n${d.url}`; } },
    { name: 'calculate', readonly: true, description: 'Evaluate a math expression exactly (+ - * / ^ %, brackets, sqrt, sin, cos, tan, log, ln, abs, round, pi, e). Use for any arithmetic you must get right.',
        parameters: obj({ expression: str('Math expression') }, ['expression']),
        run: async ({ expression }) => `${expression} = ${tools.calc(expression)}` },
    { name: 'convert_units', readonly: true, description: 'Convert units (length incl. au, ly, pc; mass; speed; data; time; volume; temperature C/F/K). Format: "10 km to miles".',
        parameters: obj({ query: str('e.g. "5 ly to km"') }, ['query']),
        run: async ({ query }) => tools.convert(query) },
    { name: 'search_open_source_apps', readonly: true, description: 'Search free and open-source Android apps (F-Droid). Returns names and summaries. To get the APK file the person can use /app.',
        parameters: obj({ query: str('App name or keyword') }, ['query']),
        run: async ({ query }) => { const r = await apps.search(query); return r.length ? r.map((a) => `${a.name} (${a.pkg}): ${a.summary}`).join('\n') : 'Nothing found on F-Droid.'; } },

    // ---- tools that act in the chat (not available in guest mode) ----
    { name: 'screenshot_website', heavy: true, description: 'Take a screenshot of a public website and send it to the chat.',
        parameters: obj({ url: str('Website URL'), full_page: bool('Capture the whole page') }, ['url']),
        run: async ({ url, full_page }, host) => { const u = web.normalizeUrl(url); if (!u) throw new Error('Not a valid URL.'); await webFlow.run({ ctx: host.ctx, replyTo: host.replyTo, url: u, shot: true, full: !!full_page, userId: host.userId, noLimit: true }); return 'The screenshot was sent to the chat.'; } },
    { name: 'scrape_website_to_zip', heavy: true, description: 'Download a website (HTML, CSS, JS, images) as an offline zip and send it to the chat.',
        parameters: obj({ url: str('Website URL'), all_pages: bool('Include several pages, not just the first') }, ['url']),
        run: async ({ url, all_pages }, host) => { const u = web.normalizeUrl(url); if (!u) throw new Error('Not a valid URL.'); await webFlow.run({ ctx: host.ctx, replyTo: host.replyTo, url: u, scrape: true, multi: !!all_pages, userId: host.userId, noLimit: true }); return 'The zip was sent to the chat.'; } },
    { name: 'download_file', heavy: true, description: 'Download a file from a direct URL and send it to the chat (images, videos, audio, PDFs, any file up to 49 MB).',
        parameters: obj({ url: str('Direct file URL') }, ['url']),
        run: async ({ url }, host) => { const u = web.normalizeUrl(url); if (!u) throw new Error('Not a valid URL.'); await fetcher.run({ ctx: host.ctx, replyTo: host.replyTo, url: u, noLimit: true }); return 'The file was sent to the chat (or an error was shown).'; } },
    { name: 'generate_image', heavy: true, description: 'Generate an image from a text description and send it to the chat.',
        parameters: obj({ prompt: str('Detailed description of the image') }, ['prompt']),
        run: async ({ prompt }, host) => { await tools.imagine(host.ctx, host.rep, prompt, true); return 'The image was sent to the chat.'; } },
    { name: 'make_qr_code', description: 'Create a QR code image for some text or a link and send it to the chat.',
        parameters: obj({ text: str('Text or URL to encode') }, ['text']),
        run: async ({ text }, host) => { await tools.qr(host.ctx, host.rep, text); return 'The QR code was sent.'; } },
    { name: 'set_reminder', description: 'Set a reminder for the person. "when" is a duration from now like "30m", "2h", "1d 4h".',
        parameters: obj({ when: str('Duration from now, e.g. "45m" or "2h 30m"'), text: str('What to remind them about') }, ['when', 'text']),
        run: async ({ when, text }, host) => {
            const ms = tools.parseDuration(String(when)); if (!ms || ms < 5000 || ms > 365 * 864e5) throw new Error('I need a duration like 30m, 2h or 1d (between 5 seconds and a year).');
            const d = store.data();
            const id = d.reminders.reduce((a, r) => Math.max(a, r.id), 0) + 1;
            d.reminders.push({ id, chatId: host.chatId, userId: host.userId, name: host.userName || '', at: Date.now() + ms, text: String(text).slice(0, 300) });
            store.save();
            return `Reminder #${id} set for ${tools.durText(ms)} from now: ${text}`;
        } },
    { name: 'list_reminders', description: "List the person's pending reminders.", parameters: obj({}),
        run: async (_a, host) => { const mine = store.data().reminders.filter((r) => r.userId === host.userId); return mine.length ? mine.map((r) => `#${r.id} in ${tools.durText(r.at - Date.now())}: ${r.text}`).join('\n') : 'No reminders.'; } },
    { name: 'remember_fact', description: 'Save a durable fact about the person for future conversations (their job, projects, preferences). Use when they ask you to remember something or share something clearly worth keeping. Never store passwords or sensitive data.',
        parameters: obj({ fact: str('Short fact in third person, e.g. "Is building an ESP32 weather station"') }, ['fact']),
        run: async ({ fact }, host) => { const r = memory.add(host.userId, fact); return r.ok ? (r.duplicate ? 'Already remembered.' : 'Saved.') : `Not saved: ${r.reason}.`; } },
    { name: 'forget_fact', description: 'Delete a remembered fact (by words it contains) when the person asks you to forget something.',
        parameters: obj({ about: str('Words from the fact to delete, or "all"') }, ['about']),
        run: async ({ about }, host) => `Removed ${memory.remove(host.userId, about)} fact(s).` },
];
if (cfg.PISTON_URL) {
    TOOLS.push({ name: 'run_code', heavy: true, description: 'Run code in a remote sandbox and return the output. Languages like python, javascript, c, cpp, java, go, rust, bash.',
        parameters: obj({ language: str('Language name'), code: str('The code'), stdin: str('Optional standard input') }, ['language', 'code']),
        run: async ({ language, code, stdin }) => {
            const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
            try {
                const res = await fetch(`${cfg.PISTON_URL.replace(/\/$/, '')}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify({ language, version: '*', files: [{ content: code }], stdin: stdin || '' }) });
                const j = await res.json();
                if (!res.ok) throw new Error(j.message || `HTTP ${res.status}`);
                return clip(`${j.run?.output || ''}${j.compile?.stderr ? '\n[compile] ' + j.compile.stderr : ''}` || '(no output)', 2500);
            } finally { clearTimeout(t); }
        } });
}

const schemas = (readonly) => TOOLS.filter((t) => !readonly || t.readonly).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

async function execTool(call, host, readonly) {
    const tool = TOOLS.find((t) => t.name === call.name);
    if (!tool || (readonly && !tool.readonly)) return `Error: unknown tool ${call.name}.`;
    let args = {};
    try { args = call.args ? JSON.parse(call.args) : {}; } catch { return 'Error: the arguments were not valid JSON.'; }
    if (tool.heavy && host && !stats.heavyAllowed(host.userId)) return 'Error: this person has used too many heavy tools this hour. Tell them to try again later.';
    stats.tool(call.name);
    try {
        const out = await Promise.race([tool.run(args, host, readonly), new Promise((_, rej) => setTimeout(() => rej(new Error('the tool took too long')), 90000))]);
        return clip(out, 6000);
    } catch (e) { return `Error: ${String(e.message).slice(0, 300)}`; }
}

// ── streaming one model turn (content + tool calls) ──
const cleanThink = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/^\s+/, '');

async function streamTurn(model, messages, defs, onText, think) {
    const body = { model, messages, stream: true, temperature: 0.7, max_tokens: think ? 3000 : 1400 };
    if (defs.length) { body.tools = defs; body.tool_choice = 'auto'; }
    if (/gpt-oss/.test(model)) body.reasoning_effort = think ? 'medium' : 'low';
    else if (/qwen3/.test(model)) body.reasoning_effort = think ? 'default' : 'none';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${cfg.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try { const j = await res.json(); msg = j?.error?.message || msg; } catch { /* ignore */ }
            throw new Error(`${model}: ${String(msg).slice(0, 220)}`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', content = '';
        const calls = [];
        let finished = false;
        while (!finished) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop();
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const p = t.slice(5).trim();
                if (p === '[DONE]') { finished = true; break; }
                let j; try { j = JSON.parse(p); } catch { continue; }
                if (j.error) throw new Error(`${model}: ${j.error.message || 'stream error'}`);
                const delta = j.choices?.[0]?.delta || {};
                if (delta.content) { content += delta.content; if (onText) { try { await onText(cleanThink(content)); } catch { /* ignore */ } } }
                for (const tc of delta.tool_calls || []) {
                    const i = tc.index ?? 0;
                    calls[i] = calls[i] || { id: '', name: '', args: '' };
                    if (tc.id) calls[i].id = tc.id;
                    if (tc.function?.name) calls[i].name += tc.function.name;
                    if (tc.function?.arguments) calls[i].args += tc.function.arguments;
                }
            }
        }
        const real = calls.filter((c) => c && c.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
        return { content: cleanThink(content), calls: real };
    } catch (e) { throw e.name === 'AbortError' ? new Error(`${model}: timed out`) : e; } finally { clearTimeout(timer); }
}

/**
 * run({ system, history, user, host, onText, think, readonly })
 * host = { ctx, replyTo, userId, userName, chatId } (null in read-only mode)
 */
async function run({ system, history = [], user, host = null, onText = null, think = false, readonly = false }) {
    if (!cfg.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
    if (host && !host.rep) host.rep = replier(host.ctx, host.replyTo);
    const defs = schemas(readonly || !host);
    const ro = readonly || !host;
    const messages = [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: user }];
    const models = [cfg.GROQ_CHAT_MODELS[0], ...cfg.GROQ_CHAT_MODELS.slice(1)];
    let mi = 0, lastErr = null;

    const turn = async (useDefs) => {
        for (; mi < models.length; mi++) {
            try { return await streamTurn(models[mi], messages, useDefs, onText, think); }
            catch (e) { lastErr = e; console.error('[agent]', e.message); }
        }
        throw lastErr || new Error('No model answered');
    };

    for (let step = 0; step < MAX_STEPS; step++) {
        const t = await turn(defs);
        if (!t.calls.length) return stripEmoji(t.content).trim();
        messages.push({ role: 'assistant', content: t.content || null, tool_calls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
        for (const c of t.calls) messages.push({ role: 'tool', tool_call_id: c.id, content: await execTool(c, host, ro) });
    }
    messages.push({ role: 'user', content: 'Now answer the person using what you found. Do not call any more tools.' });
    const last = await turn([]);
    return stripEmoji(last.content).trim();
}

// ── deciding whether a message needs the agent ──
const GATE = /\b(search|look ?up|google|find|latest|news|today|tonight|tomorrow|yesterday|current(ly)?|right now|recent(ly)?|price|cost of|weather|forecast|temperature|launch(es)?|iss\b|space station|astronauts?|nasa|apod|remind(er)?s?|alarm|calculate|compute|convert|translate|qr|generate|draw|image of|picture of|screenshot|explore|scrape|download|fetch|curl|zip|http|www\.|\.com|\.org|\.io|\.ng|\.net|api|remember|forget|apk|app for|wiki|who (is|was|won)|when (is|was|will)|how (much|many|far|long|old|tall|fast)|release date|score|stock|crypto|bitcoin|exchange rate|run (this|the|my)|execute|check (if|whether|this|the|my)|is it (true|real)|open (this|the))\b|\d+\s?[-+*/^x]\s?\d+|https?:\/\//i;
function shouldUse(text, { search: searchOn = false, hasDoc = false } = {}) {
    if (cfg.AGENT === 'off' || !cfg.GROQ_API_KEY) return false;
    if (searchOn) return true;
    return GATE.test(String(text || ''));
}

module.exports = { run, shouldUse, TOOLS };
