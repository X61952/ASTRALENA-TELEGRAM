/**
 * Real web search. Providers, first one that answers wins:
 *   Tavily (TAVILY_API_KEY) -> Brave (BRAVE_API_KEY) -> DuckDuckGo HTML (no key) -> Wikipedia
 * -> [{ title, url, snippet }]
 */
const cfg = require('./config');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function http(url, opts = {}, timeout = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    } finally { clearTimeout(t); }
}

async function tavily(q, n) {
    const res = await http('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: cfg.TAVILY_API_KEY, query: q, max_results: n, search_depth: 'basic' }),
    });
    const j = await res.json();
    return (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.content || '').slice(0, 300) }));
}
async function brave(q, n) {
    const res = await http(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { 'X-Subscription-Token': cfg.BRAVE_API_KEY, Accept: 'application/json' } });
    const j = await res.json();
    return (j.web?.results || []).map((r) => ({ title: strip(r.title), url: r.url, snippet: strip(r.description).slice(0, 300) }));
}
async function duck(q, n) {
    const res = await http(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    const html = await res.text();
    const out = [];
    const anchors = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (let i = 0; i < anchors.length && out.length < n; i++) {
        const m = anchors[i];
        let url = m[1].replace(/&amp;/g, '&');
        const u = url.match(/[?&]uddg=([^&]+)/);
        if (u) { try { url = decodeURIComponent(u[1]); } catch { /* keep */ } }
        if (url.startsWith('//')) url = 'https:' + url;
        if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
        const between = html.slice(m.index + m[0].length, anchors[i + 1] ? anchors[i + 1].index : m.index + m[0].length + 2500);
        const sn = between.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
        out.push({ title: strip(m[2]), url, snippet: strip(sn ? sn[1] : '').slice(0, 300) });
    }
    return out;
}
async function wikipedia(q, n) {
    const res = await http(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${n}&format=json`, { headers: { 'User-Agent': 'AstralenaBot/4.0' } });
    const j = await res.json();
    return (j.query?.search || []).map((r) => ({ title: r.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`, snippet: strip(r.snippet) }));
}

async function search(query, n = 5) {
    const q = String(query || '').trim().slice(0, 300);
    if (!q) throw new Error('Empty search query.');
    const chain = [];
    if (cfg.TAVILY_API_KEY) chain.push(['tavily', tavily]);
    if (cfg.BRAVE_API_KEY) chain.push(['brave', brave]);
    chain.push(['duckduckgo', duck], ['wikipedia', wikipedia]);
    let lastErr = '';
    for (const [name, fn] of chain) {
        try {
            const r = await fn(q, n);
            if (r.length) return { provider: name, results: r.slice(0, n) };
            lastErr = `${name}: no results`;
        } catch (e) { lastErr = `${name}: ${e.message}`; console.error('[search]', lastErr); }
    }
    throw new Error('Web search failed (' + lastErr + ').');
}

module.exports = { search };
