// Sabah Masası — Katman 1 MCP sunucusu (Cloudflare Worker, bağımlılıksız).
// MCP Streamable HTTP, durumsuz JSON yanıtlar. Veri: GitHub "data" dalı.

const H = 3600e3;
const DAY = 24 * H;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DAYS_TR = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
const TARGET_LANGS = ["tr", "en", "fr", "de", "es", "ar", "zh", "he"];
const GDELT_LANG = { english: "en", turkish: "tr", french: "fr", german: "de", spanish: "es", arabic: "ar", chinese: "zh", hebrew: "he" };

const TOOLS = [
  {
    name: "sabah_digest",
    description:
      "Sabah Masası için günün ham malzemesi. Varsayılan: otomatik pencere (Pzt: Cum 06:00→Pzt 06:00, diğer günler: dün 06:00→bugün 06:00, İstanbul) ve günün takvimine göre otomatik bölümler. Bölümler içinde kaynaklar sırayla harmanlanır (denge). Sonda dil/eğilim dağılımı ve EKSİK/BOŞ uyarıları verilir. Satır biçimi: dil|kaynak|eğilim|tarih · başlık — özet · link. Google News ve uzun linkler kısa referansla verilir ([MMGG-xxxxxxxx]); tam link için get_links.",
    inputSchema: {
      type: "object",
      properties: {
        sections: {
          type: "array", items: { type: "string" },
          description: "Bölümleri elle seç (boşsa günün takvimi). Örn: turkiye, koseyazarlari, dunya, hukuk, fikir, secim_abd, secim_israil, secim_fransa, secim_brezilya, abd_sol, teknoloji_guc, dusunce_kuruluslari, kultur, istanbul, turkiye_dis_basin",
        },
        langs: { type: "array", items: { type: "string" }, description: "Dil filtresi (tr,en,fr,de,es,ar,zh,he). Boşsa hepsi." },
        hours: { type: "number", description: "Otomatik pencere yerine son N saat." },
        max_per_section: { type: "integer", default: 20, minimum: 1, maximum: 60 },
        summary_chars: { type: "integer", default: 110, minimum: 0, maximum: 200, description: "Özet uzunluğu; 0 = yalnız başlık (en ucuz)." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "feed_search",
    description: "Toplanmış akışta (son günler) başlık+özet içinde kelime araması. Bir konuyu web_search'e gitmeden önce derinleştirmek için.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Tüm kelimeler eşleşmeli (büyük/küçük harf ve aksan duyarsız)." },
        days: { type: "integer", default: 3, minimum: 1, maximum: 5 },
        langs: { type: "array", items: { type: "string" } },
        max: { type: "integer", default: 25, minimum: 1, maximum: 60 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "gdelt_search",
    description: "GDELT DOC 2.0 üzerinden canlı, çok dilli haber araması (ücretsiz). İngilizce anahtar kelime + isteğe bağlı kaynak dili. Akışta temsil edilmeyen dil/ülke boşlukları için.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: 'Örn: "Brazil election" veya ("political ban" OR "barred from running")' },
        sourcelang: { type: "string", description: "arabic, chinese, hebrew, french, german, spanish, turkish, english" },
        hours: { type: "integer", default: 24, minimum: 1, maximum: 168 },
        max: { type: "integer", default: 20, minimum: 1, maximum: 75 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_links",
    description: "Digest/feed_search satırlarındaki kısa referansların ([1004-6eb3d3cb] gibi) tam linklerini verir. Yalnız tam okuma (web_fetch) yapılacak öğeler için çağır.",
    inputSchema: {
      type: "object",
      required: ["refs"],
      properties: {
        refs: { type: "array", items: { type: "string" }, maxItems: 40, description: 'Örn: ["1004-6eb3d3cb", "1003-a1b2c3d4"] (köşeli parantezli de olur).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "feed_health",
    description: "Akışın tazeliği ve çalışmayan kaynaklar. Her bültenin başında bir kez çağır.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ── HTTP / JSON-RPC ─────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.ACCESS_KEY || url.pathname !== `/mcp/${env.ACCESS_KEY}`) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const batch = Array.isArray(body);
    const out = [];
    for (const msg of batch ? body : [body]) {
      const res = await handle(msg, env);
      if (res) out.push(res);
    }
    if (!out.length) return new Response(null, { status: 202 });
    return json(batch ? out : out[0]);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function handle(msg, env) {
  if (!msg || msg.id === undefined || msg.id === null) return null; // bildirim
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const req = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(req) ? req : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sabah-masasi-feed", version: "1.1.0" },
        instructions: "Önce feed_health, sonra sabah_digest. Boşluklar için feed_search ve gdelt_search. Tam okuma gereken öğelerin linkleri için get_links.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params || {};
      try {
        const text = await runTool(name, args, env);
        return ok({ content: [{ type: "text", text }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Hata (${name}): ${e.message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

async function runTool(name, args, env) {
  switch (name) {
    case "sabah_digest": return digest(args, env);
    case "feed_search": return search(args, env);
    case "gdelt_search": return gdelt(args);
    case "get_links": return links(args, env);
    case "feed_health": return health(env);
    default: throw new Error(`Bilinmeyen araç: ${name}`);
  }
}

// ── Veri ────────────────────────────────────────────────────────────
async function getJSON(env, file) {
  const headers = { "User-Agent": "sabah-masasi-worker" };
  if (env.GITHUB_TOKEN) headers.Authorization = `token ${env.GITHUB_TOKEN}`;
  const res = await fetch(`${env.DATA_BASE.replace(/\/$/, "")}/${file}`, { headers, cf: { cacheTtl: 300 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

async function loadItems(env, dates) {
  const shards = await Promise.all(dates.map((d) => getJSON(env, `${d}.json`)));
  return shards.filter(Boolean).flatMap((s) => s.items);
}

// "Yerel" ms = UTC ms + tz; getUTC* ile İstanbul saati okunur.
const isoDate = (localMs) => new Date(localMs).toISOString().slice(0, 10);
function datesBetween(startLocal, endLocal) {
  const out = [];
  for (let t = Date.parse(isoDate(startLocal)); t <= endLocal; t += DAY) out.push(isoDate(t));
  return out;
}
function fmtLocal(dIso, tz) {
  const d = new Date(Date.parse(dIso) + tz * H);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function autoWindow(tz) {
  const nowL = Date.now() + tz * H;
  const n = new Date(nowL);
  const today06 = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 6);
  const wd = n.getUTCDay(); // 0=Paz
  const endL = Math.min(nowL, today06);
  const startL = today06 - (wd === 1 ? 3 : 1) * DAY;
  return { startL, endL, wd, edition: isoDate(today06) };
}

function scheduleFor(cfg, wd, edition) {
  const iso = wd === 0 ? 7 : wd;
  const out = {};
  for (const [sec, rule] of Object.entries(cfg.schedule || {})) {
    const r = Array.isArray(rule) ? { days: rule } : rule;
    if (r.days.includes(iso) && (!r.until || edition <= r.until)) out[sec] = r.lookback_days || 0;
  }
  return out;
}

function interleave(items, max) {
  const groups = new Map();
  for (const it of items.sort((a, b) => (a.d < b.d ? 1 : -1))) {
    if (!groups.has(it.f)) groups.set(it.f, []);
    groups.get(it.f).push(it);
  }
  const queues = [...groups.values()];
  const out = [];
  for (let i = 0; out.length < max && queues.some((q) => i < q.length); i++) {
    for (const q of queues) if (i < q.length && out.length < max) out.push(q[i]);
  }
  return out;
}

// Kısa referans: yerel gün (MMGG) + kimliğin ilk 8 hanesi → get_links ile parçadan çözülür.
const MAX_INLINE_URL = 100;
function ref(it, tz) {
  const day = isoDate(Date.parse(it.d) + tz * H);
  return `${day.slice(5, 7)}${day.slice(8, 10)}-${it.id.slice(0, 8)}`;
}
function linkOf(it, tz) {
  return it.u.includes("news.google.com/") || it.u.length > MAX_INLINE_URL ? `[${ref(it, tz)}]` : it.u;
}

function line(it, tz, sumChars) {
  const x = sumChars > 0 && it.x ? ` — ${it.x.length > sumChars ? it.x.slice(0, sumChars - 1) + "…" : it.x}` : "";
  return `- ${it.l}|${it.s}|${it.b}|${fmtLocal(it.d, tz)} · ${it.t}${x} · ${linkOf(it, tz)}`;
}

// ── Araçlar ─────────────────────────────────────────────────────────
async function digest(args, env) {
  const cfg = await getJSON(env, "config.json");
  if (!cfg) throw new Error("config.json yok — toplayıcı henüz çalışmamış.");
  const tz = cfg.tz_offset_hours ?? 3;
  const w = autoWindow(tz);
  if (args.hours) w.startL = w.endL - args.hours * H;

  const plan = args.sections?.length
    ? Object.fromEntries(args.sections.map((s) => [s, cfg.schedule?.[s]?.lookback_days || 0]))
    : scheduleFor(cfg, w.wd, w.edition);
  const secs = Object.keys(plan);
  if (!secs.length) {
    return `${DAYS_TR[w.wd]} ${w.edition}: takvimde bugün için bölüm yok (bülten hafta içi). Gerekirse sections parametresiyle iste.`;
  }

  // Günlük bölümler pencere parçalarından; geri bakışlı bölümler küçük sec/<bölüm>.json dosyalarından.
  const daily = secs.some((s) => !plan[s]);
  const [shardItems, ...secFiles] = await Promise.all([
    daily ? loadItems(env, datesBetween(w.startL, w.endL)) : [],
    ...secs.filter((s) => plan[s]).map((s) => getJSON(env, `sec/${s}.json`)),
  ]);
  const seen = new Set(shardItems.map((i) => i.id));
  const all = shardItems.concat(secFiles.filter(Boolean).flatMap((f) => f.items).filter((i) => !seen.has(i.id) && seen.add(i.id)));
  const langs = args.langs?.length ? new Set(args.langs) : null;
  const max = args.max_per_section ?? 20;
  const sumChars = args.summary_chars ?? 110;
  const endU = w.endL - tz * H;

  const shown = new Set();
  const langCount = {}, leanCount = {};
  const blocks = [], empty = [];
  for (const sec of secs) {
    const startU = (plan[sec] ? Math.min(w.startL, w.endL - plan[sec] * DAY) : w.startL) - tz * H;
    const pool = all.filter((it) => {
      const t = Date.parse(it.d);
      return it.sec.includes(sec) && t >= startU && t < endU && !shown.has(it.id) && (!langs || langs.has(it.l));
    });
    const picked = interleave(pool, max);
    if (!picked.length) { empty.push(sec); continue; }
    picked.forEach((it) => {
      shown.add(it.id);
      langCount[it.l] = (langCount[it.l] || 0) + 1;
      leanCount[it.b] = (leanCount[it.b] || 0) + 1;
    });
    const look = plan[sec] ? ` · ${plan[sec]} gün geriye` : "";
    blocks.push(`[${sec}] ${picked.length}/${pool.length}${look}\n` + picked.map((it) => line(it, tz, sumChars)).join("\n"));
  }

  const age = Math.round((Date.now() - Date.parse(cfg.generated)) / 6e4);
  const head = `SABAH MASASI AKIŞI · ${DAYS_TR[w.wd]} ${w.edition} · pencere ${fmtLocal(new Date(w.startL - tz * H).toISOString(), tz)} → ${fmtLocal(new Date(endU).toISOString(), tz)} (İst.) · veri ${age} dk önce · ${shown.size} öğe`;
  const missing = TARGET_LANGS.filter((l) => !langCount[l] && (!langs || langs.has(l)));
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  const foot = [
    `Dil dağılımı: ${fmt(langCount)}`,
    `Eğilim dağılımı: ${fmt(leanCount)}`,
    missing.length ? `EKSİK DİL: ${missing.join(", ")}` : "",
    empty.length ? `BOŞ BÖLÜM: ${empty.join(", ")}` : "",
    age > 180 ? `UYARI: veri ${age} dk eski — toplayıcıyı kontrol et.` : "",
  ].filter(Boolean).join("\n");
  return `${head}\n\n${blocks.join("\n\n")}\n\n${foot}`;
}

const fold = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("tr").replace(/ı/g, "i");

async function search(args, env) {
  const cfg = await getJSON(env, "config.json");
  const tz = cfg?.tz_offset_hours ?? 3;
  const nowL = Date.now() + tz * H;
  const days = args.days ?? 3;
  const all = await loadItems(env, datesBetween(nowL - days * DAY, nowL));
  const terms = fold(args.query).split(/\s+/).filter(Boolean);
  const langs = args.langs?.length ? new Set(args.langs) : null;
  const hits = all.filter((it) => {
    if (langs && !langs.has(it.l)) return false;
    const hay = fold(`${it.t} ${it.x}`);
    return terms.every((t) => hay.includes(t));
  }).sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, args.max ?? 25);
  if (!hits.length) return `"${args.query}" için son ${days} günde akışta sonuç yok. gdelt_search veya web_search dene.`;
  return `"${args.query}" · ${hits.length} sonuç\n` + hits.map((it) => line(it, tz, 110)).join("\n");
}

async function links(args, env) {
  const cfg = await getJSON(env, "config.json");
  const tz = cfg?.tz_offset_hours ?? 3;
  const nowL = Date.now() + tz * H;
  const year = new Date(nowL).getUTCFullYear();
  const wanted = new Map(); // gün → [{ref, pfx}]
  const bad = [];
  for (const raw of args.refs || []) {
    const r = String(raw).trim().replace(/^\[|\]$/g, "");
    const m = /^(\d{2})(\d{2})-([0-9a-f]{4,12})$/i.exec(r);
    if (!m) { bad.push(r); continue; }
    let day = `${year}-${m[1]}-${m[2]}`;
    if (Date.parse(day) > nowL + DAY) day = `${year - 1}-${m[1]}-${m[2]}`; // yılbaşı geçişi
    if (!wanted.has(day)) wanted.set(day, []);
    wanted.get(day).push({ ref: r, pfx: m[3].toLowerCase() });
  }
  if (!wanted.size) throw new Error(`Geçerli referans yok (biçim: MMGG-xxxxxxxx)${bad.length ? `: ${bad.join(", ")}` : ""}`);
  const days = [...wanted.keys()];
  const shards = await Promise.all(days.map((d) => getJSON(env, `${d}.json`)));
  const out = [];
  days.forEach((d, i) => {
    const items = shards[i]?.items || [];
    for (const { ref: r, pfx } of wanted.get(d)) {
      const it = items.find((x) => x.id.startsWith(pfx));
      if (it) out.push(`- [${r}] ${it.s} · ${it.t} · ${it.u}`);
      else bad.push(r);
    }
  });
  if (bad.length) out.push(`Bulunamadı: ${bad.join(", ")} (parça silinmiş ya da referans hatalı olabilir; başlık ve yayın adıyla web_search yap).`);
  return out.join("\n");
}

async function gdelt(args) {
  const q = args.sourcelang ? `${args.query} sourcelang:${args.sourcelang}` : args.query;
  const p = new URLSearchParams({
    query: q, mode: "ArtList", format: "json", sort: "DateDesc",
    maxrecords: String(args.max ?? 20), timespan: `${args.hours ?? 24}h`,
  });
  const res = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${p}`, { headers: { "User-Agent": "sabah-masasi-worker" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}: ${text.slice(0, 150)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`GDELT yanıtı JSON değil (sorgu sözdizimi?): ${text.slice(0, 150)}`); }
  const arts = data.articles || [];
  if (!arts.length) return `GDELT: "${q}" için sonuç yok.`;
  return `GDELT · "${q}" · ${arts.length} sonuç\n` + arts.map((a) => {
    const d = a.seendate ? `${a.seendate.slice(6, 8)}.${a.seendate.slice(4, 6)} ${a.seendate.slice(9, 11)}:${a.seendate.slice(11, 13)}Z` : "";
    return `- ${GDELT_LANG[(a.language || "").toLowerCase()] || a.language || "?"}|${a.domain}|${a.sourcecountry || "?"}|${d} · ${a.title} · ${a.url}`;
  }).join("\n");
}

async function health(env) {
  const h = await getJSON(env, "health.json");
  if (!h) return "health.json yok — toplayıcı henüz çalışmamış.";
  const age = Math.round((Date.now() - Date.parse(h.generated)) / 6e4);
  const fail = h.failing.map((f) => `- ${f.id} (${f.lang}): ${f.error || "?"}`).join("\n");
  return [
    `Son toplama: ${age} dk önce · ${h.ok_count}/${h.total} kaynak çalıştı`,
    `Günlük parçalar: ${Object.entries(h.shards).map(([d, n]) => `${d}: ${n}`).join(", ")}`,
    h.failing.length ? `Çalışmayan kaynaklar:\n${fail}` : "Çalışmayan kaynak yok.",
    h.empty.length ? `Boş dönen: ${h.empty.join(", ")}` : "",
    age > 180 ? "UYARI: veri 3 saatten eski." : "",
  ].filter(Boolean).join("\n");
}
