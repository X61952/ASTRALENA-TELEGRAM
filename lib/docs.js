/**
 * Document reading. Pure JavaScript, works on a Pterodactyl panel (no system tools).
 * PDF (pdf-parse), DOCX, PPTX, XLSX (unzipped with fflate), plain text / code / CSV / JSON / HTML.
 */
const media = require('./media');

const MAX_BYTES = 20 * 1024 * 1024; // Telegram bot download limit
const MAX_CHARS = 14000;            // what is handed to the model
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|log|ya?ml|ini|toml|env|conf|cfg|sql|css|scss|js|mjs|cjs|jsx|ts|tsx|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|bat|ps1|kt|swift|lua|r|ino|gcode|srt|vtt|tex|rtf)$/i;

const decode = (s) => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } });

function unzip(buffer) {
    let fflate;
    try { fflate = require('fflate'); } catch { throw new Error('The zip engine (fflate) is not installed. Run npm install.'); }
    return fflate.unzipSync(new Uint8Array(buffer));
}
const u8 = (x) => Buffer.from(x).toString('utf8');

function docx(buffer) {
    const f = unzip(buffer);
    const xml = f['word/document.xml'];
    if (!xml) throw new Error('That does not look like a Word document.');
    return decode(u8(xml).replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}
function pptx(buffer) {
    const f = unzip(buffer);
    const slides = Object.keys(f).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    if (!slides.length) throw new Error('That does not look like a PowerPoint file.');
    return slides.map((k, i) => `--- Slide ${i + 1} ---\n` + [...u8(f[k]).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decode(m[1])).join('\n')).join('\n\n');
}
function xlsx(buffer) {
    const f = unzip(buffer);
    const ssXml = f['xl/sharedStrings.xml'] ? u8(f['xl/sharedStrings.xml']) : '';
    const strings = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
    const sheets = Object.keys(f).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort().slice(0, 4);
    if (!sheets.length) throw new Error('That does not look like an Excel file.');
    return sheets.map((k, si) => {
        const rows = [];
        for (const rm of u8(f[k]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells = [];
            for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const attrs = cm[1], inner = cm[2] || '';
                const col = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1] || '';
                let val = '';
                if (/t="s"/.test(attrs)) val = strings[parseInt((inner.match(/<v>(\d+)<\/v>/) || [])[1], 10)] ?? '';
                else if (/t="inlineStr"/.test(attrs)) val = decode((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
                else val = decode((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
                cells.push(`${val}`.replace(/\t|\n/g, ' '));
                void col;
            }
            if (cells.some(Boolean)) rows.push(cells.join(' | '));
            if (rows.length >= 300) break;
        }
        return `--- Sheet ${si + 1} ---\n${rows.join('\n')}`;
    }).join('\n\n');
}
async function pdf(buffer) {
    let parse;
    try { parse = require('pdf-parse/lib/pdf-parse.js'); } catch { throw new Error('The PDF reader (pdf-parse) is not installed. Run npm install.'); }
    const r = await parse(buffer);
    const text = String(r.text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 20) throw new Error('That PDF has no selectable text (it may be a scan). Send it as images and I can read them with the scan tool.');
    return { text, pages: r.numpages };
}

/** -> { text, name, words, pages?, truncated } */
async function extract(buffer, name = 'file', mime = '') {
    if (buffer.length > MAX_BYTES) throw new Error('That file is too big for me (20 MB is the Telegram limit for bots).');
    const n = String(name).toLowerCase();
    let text = '', pages;
    if (/\.pdf$/.test(n) || /pdf/.test(mime)) ({ text, pages } = await pdf(buffer));
    else if (/\.docx$/.test(n) || /wordprocessingml/.test(mime)) text = docx(buffer);
    else if (/\.pptx$/.test(n) || /presentationml/.test(mime)) text = pptx(buffer);
    else if (/\.xlsx$/.test(n) || /spreadsheetml/.test(mime)) text = xlsx(buffer);
    else if (/\.(doc|xls|ppt)$/.test(n)) throw new Error('That is an old Office format. Save it as .docx, .xlsx or .pptx and send it again.');
    else if (TEXT_EXT.test(n) || /^text\//.test(mime) || /json|xml|javascript/.test(mime)) {
        text = buffer.toString('utf8');
        if (/\.html?$/.test(n)) text = decode(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
        if (text.includes('\u0000')) throw new Error('That looks like a binary file, not a readable document.');
    } else throw new Error(`I can't read ${name} yet. I can read PDF, Word, Excel, PowerPoint, text, code, CSV, JSON and HTML files.`);
    text = text.trim();
    if (!text) throw new Error('I could not find any text in that file.');
    const words = text.split(/\s+/).length;
    return { text: text.slice(0, MAX_CHARS), name, words, pages, truncated: text.length > MAX_CHARS };
}

async function fromTelegram(telegram, fileId, name, mime, size) {
    if (size && size > MAX_BYTES) throw new Error('That file is too big for me (20 MB is the Telegram limit for bots).');
    return extract(await media.download(telegram, fileId), name, mime);
}

// ── what each person shared recently (kept for 30 minutes) ──
const held = new Map();
const TTL = 30 * 60 * 1000;
const hold = (key, doc) => held.set(key, { ...doc, at: Date.now() });
function get(key) { const d = held.get(key); if (!d) return null; if (Date.now() - d.at > TTL) { held.delete(key); return null; } return d; }
const drop = (key) => held.delete(key);
setInterval(() => { const n = Date.now(); for (const [k, v] of held) if (n - v.at > TTL) held.delete(k); }, TTL).unref?.();

module.exports = { extract, fromTelegram, hold, get, drop, MAX_BYTES };
