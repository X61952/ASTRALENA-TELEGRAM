/**
 * Astralena's own stickers. When someone sends a sticker to Astralena (DM, or replying to one of Astralena's
 * messages in a group) it first answers with a random sticker from these packs.
 * Packs are loaded once at startup with getStickerSet. Edit the pack list in .env (STICKER_PACKS)
 * or in lib/config.js.
 */
const cfg = require('./config');

let pool = [];
let loadedAt = 0;

async function init(telegram) {
    const ids = [];
    for (const name of cfg.STICKER_PACKS) {
        try {
            const set = await telegram.getStickerSet(name);
            const got = (set.stickers || []).map((s) => s.file_id);
            ids.push(...got);
            console.log(`[stickers] loaded ${got.length} stickers from "${name}"`);
        } catch (e) {
            console.log(`[stickers] couldn't load "${name}": ${e.message}`);
        }
    }
    pool = ids;
    loadedAt = Date.now();
    console.log(`[stickers] ${pool.length} stickers ready`);
}

async function random(telegram) {
    if (!pool.length && telegram && Date.now() - loadedAt > 60000) await init(telegram).catch(() => {});
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

module.exports = { init, random };
