/**
 * Astralena AI — configuration. Everything comes from .env (see the .env file).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = (k, d = '') => {
    const v = process.env[k];
    return v === undefined || String(v).trim() === '' ? d : String(v).trim();
};
const int = (k, d) => {
    const n = parseInt(env(k), 10);
    return Number.isFinite(n) ? n : d;
};
const list = (k, d = []) => {
    const v = env(k);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d;
};

module.exports = {
    // ── Telegram ──
    TELEGRAM_TOKEN: env('TELEGRAM_BOT_TOKEN'),
    DB_PATH: path.resolve(process.cwd(), env('DB_PATH', 'data/astralena.json')),
    MAX_HISTORY: int('MAX_HISTORY', 20),
    REQUEST_TIMEOUT_MS: int('REQUEST_TIMEOUT', 120) * 1000,

    // ── Owner(s): numeric Telegram IDs, comma separated ──
    OWNER_IDS: list('OWNER_ID'),

    // ── Identity ──
    AI_NAME: 'Astralena AI',
    BUILT_BY: env('ASTRALENA_CREATOR', '@X61952'),
    RELEASED_ON: env('ASTRALENA_RELEASED_ON', 'Monday, 16th November 2026 at 7:37 PM (UTC)'),

    // ── Behaviour ──
    THINK_SECONDS: int('THINK_SECONDS', 6),
    INLINE_DEBOUNCE_MS: int('INLINE_DEBOUNCE_MS', 600),

    // ── Groq: the brain (chat), eyes (vision), ears (speech-to-text) and voice (text-to-speech) ──
    GROQ_API_KEY: env('GROQ_API_KEY'),
    GROQ_CHAT_MODELS: list('GROQ_CHAT_MODELS', ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']),
    GROQ_SEARCH_MODEL: env('GROQ_SEARCH_MODEL', 'groq/compound-mini'), // used when "Live Search" is switched on
    GROQ_VISION_MODELS: list('GROQ_VISION_MODELS', ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'meta-llama/llama-4-scout-17b-16e-instruct']),
    GROQ_WHISPER_MODELS: list('GROQ_WHISPER_MODELS', ['whisper-large-v3-turbo', 'whisper-large-v3']),

    // ── Voice (FEMALE) ──
    TTS_MODEL: env('TTS_MODEL', 'canopylabs/orpheus-v1-english'),
    TTS_VOICE: env('TTS_VOICE', 'hannah'),             // Groq Orpheus female voices: hannah, diana, autumn
    EDGE_VOICE: env('EDGE_VOICE', 'en-US-AriaNeural'), // free female fallback voice

    // ── Tools ──
    REMOVEBG_API: env('REMOVEBG_API', 'https://removebg-api-kord-two.vercel.app/api/removebg'),
    OCRSPACE_API_KEY: env('OCRSPACE_API_KEY'),
    // Optional custom screenshot service; {url} and {full} are replaced. Leave empty to use the built-in free services.
    SCREENSHOT_API: env('SCREENSHOT_API'),

    // ── Agent, search, limits, alerts ──
    AGENT: env('AGENT', 'on'),                        // on | off  (tool-calling agent for chat)
    TAVILY_API_KEY: env('TAVILY_API_KEY'),            // optional, best web search
    BRAVE_API_KEY: env('BRAVE_API_KEY'),              // optional
    PISTON_URL: env('PISTON_URL'),                    // optional remote code runner, e.g. https://your-piston/api/v2
    DAILY_LIMIT: int('DAILY_LIMIT', 0),               // messages per person per day (0 = unlimited)
    HEAVY_LIMIT_HOURLY: int('HEAVY_LIMIT_HOURLY', 25),// heavy tools (scrape, image, download...) per person per hour
    ALERTS: env('ALERTS', 'on'),                      // send errors to the owner
    WARN_LIMIT: int('WARN_LIMIT', 3),                 // group warnings before an automatic mute

    // ── Astralena's own sticker packs (short names, comma separated). Empty = no sticker reply. ──
    STICKER_PACKS: list('STICKER_PACKS', []),
};
