import { useState, useEffect, useCallback, useRef } from "react";
// ─── CONSTANTS Y CONFIG NUBE ──────────────────────────────────────────────────
const INIT_CAPITAL = 100; // Simulación de $100 reales
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

const CATEGORIES = {
  ALL: { label: "Todos", icon: "◈" },
  POLITICS: { label: "Política", icon: "🏛" },
  CRYPTO: { label: "Crypto", icon: "₿" },
  SPORTS: { label: "Deportes", icon: "⚽" },
  FINANCE: { label: "Finanzas", icon: "📈" },
  SCIENCE: { label: "Ciencia/Tech", icon: "🔬" },
  ENTERTAINMENT: { label: "Entretenimiento", icon: "🎬" },
  OTHER: { label: "Otros", icon: "◯" },
};

const SIGNAL_TYPES = {
  ARB: { label: "Arbitraje", color: "#00d4ff", icon: "⚖" },
  MISPRICING: { label: "Precio Erróneo", color: "#aa77ff", icon: "💎" },
  NEWS: { label: "Noticia", color: "#ff9944", icon: "📰" },
  MOMENTUM: { label: "Momentum", color: "#00ff88", icon: "📈" },
  VOL_SPIKE: { label: "Vol. Anómalo", color: "#ffee44", icon: "⚡" },
  TIME_DECAY: { label: "Time Decay", color: "#ff5577", icon: "⏰" },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function detectCategory(q = "") {
  const t = q.toLowerCase();
  if (/bitcoin|eth|crypto|solana|doge|coin|token|defi|nft|blockchain|btc/i.test(t)) return "CRYPTO";
  if (/election|president|congress|senate|vote|party|democrat|republican|biden|trump|minister|govern|politic/i.test(t)) return "POLITICS";
  if (/nba|nfl|mlb|nhl|fifa|league|cup|championship|match|game|sport|team|player|score|win|final/i.test(t)) return "SPORTS";
  if (/stock|market|fed|rate|gdp|inflation|economy|s&p|nasdaq|dow|earnings|ipo|bond|oil|gold|dollar/i.test(t)) return "FINANCE";
  if (/ai|gpt|model|tech|space|nasa|drug|fda|vaccine|science|launch|satellite|discovery/i.test(t)) return "SCIENCE";
  if (/oscar|grammy|emmy|movie|film|show|singer|actor|celebrity|award|music|spotify/i.test(t)) return "ENTERTAINMENT";
  return "OTHER";
}

function fmtMoney(n) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n) { return `${(n * 100).toFixed(2)}%`; }
function fmtDate(s) { return s ? new Date(s).toLocaleDateString("es-CO") : "—"; }
function nowStr() { return new Date().toLocaleString("es-CO"); }
function uid() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function fmtDlr(n) {
  const v = parseFloat(n || 0);
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
}

// ─── POLYMARKET API ───────────────────────────────────────────────────────────
async function fetchAllMarkets(onProgress) {
  const all = [];
  let offset = 0;
  const limit = 100;
  let page = 1;
  while (true) {
    onProgress?.(`Descargando página ${page} (offset ${offset})…`);
    const r = await fetch(`${API_POLY}?limit=${limit}&offset=${offset}&active=true&closed=false`, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Polymarket API error: ${r.status}`);
    const batch = await r.json();
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    page++;
    if (page > 20) break; // safety cap ~2000 markets
    await new Promise(res => setTimeout(res, 120)); // polite delay
  }
  return all;
}

// ─── PRELIMINARY SCORING (no AI) ─────────────────────────────────────────────
function preliminaryScore(m, prevSnapshot) {
  let p = [0.5, 0.5];
  try { p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || [0.5, 0.5]); } catch(e){}
  const yesP = parseFloat(p[0]);
  const noP = parseFloat(p[1]);
  const vol = parseFloat(m.volume || 0);
  const vol24 = parseFloat(m.volumeNum || m.volume24hr || 0);
  const liq = parseFloat(m.liquidityNum || m.liquidity || 0);
  const sum = yesP + noP;
  const signals = [];
  let score = 0;

  // 1. Arbitrage
  const arbDev = Math.abs(sum - 1);
  if (arbDev > 0.05) { signals.push("ARB"); score += 40; }
  else if (arbDev > 0.03) { signals.push("ARB"); score += 20; }

  // 2. Liquidity filter
  if (liq < 200) return { score: 0, signals: [], skip: true };

  // 3. Price in tradeable zone
  const edge = Math.max(yesP, noP);
  if (edge > 0.15 && edge < 0.85) score += 15;
  if (edge > 0.25 && edge < 0.75) score += 10;

  // 4. Volume
  if (vol > 500000) score += 20;
  else if (vol > 50000) score += 12;
  else if (vol > 5000) score += 6;

  // 5. Price movement vs previous snapshot
  if (prevSnapshot) {
    const prevY = parseFloat(prevSnapshot.yesP ?? 0.5);
    const delta = Math.abs(yesP - prevY);
    if (delta > 0.05) { signals.push("MOMENTUM"); score += 25; }
    else if (delta > 0.02) { signals.push("MOMENTUM"); score += 10; }
  }

  // 6. Estrategia Atrevida (Time decay: Enfocado en resoluciones rápidas 1 a 15 días)
  if (m.endDateIso || m.endDate) {
    const closes = new Date(m.endDateIso || m.endDate);
    const daysLeft = (closes - Date.now()) / 86400000;
    
    if (daysLeft < 0) return { score: 0, signals: [], skip: true }; // cerrado
    
    if (daysLeft <= 1) { signals.push("CRITICO_HOY"); score += 35; }
    else if (daysLeft > 1 && daysLeft <= 15) { signals.push("15_DIAS"); score += 25; }
    else if (daysLeft > 15 && daysLeft < 30) score += 5;
  }

  return { score, signals, yesP, noP, vol, liq, sum, skip: false };
}

// ─── DEEP AI ANALYSIS (Tavily + Groq Llama 3) ────────────────────────────────
const _newsCache = {}; // Cache global de noticias (6h TTL por mercado)

async function deepAnalyze(m, prelim, existingNewsCache) {
  const { yesP, noP, vol, liq, sum } = prelim;
  const marketId = m.id || m.conditionId;
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  // 1. Cache de Noticias (Ahorrador de Tokens Tavily - 60% menos llamadas)
  let newsContext = "Sin noticias recientes.";
  let topSource = "none";
  let topSnippet = "none";
  let usedCache = false;

  const cachedNews = _newsCache[marketId] || (existingNewsCache?.[marketId]);
  if (cachedNews && (Date.now() - cachedNews.ts) < SIX_HOURS) {
    newsContext = cachedNews.context;
    topSource = cachedNews.source;
    topSnippet = cachedNews.snippet;
    usedCache = true;
  } else {
    try {
      const tRes = await fetch(API_TAVILY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query: m.question,
          search_depth: "basic",
          include_answers: false,
          max_results: 2,
        })
      });
      if (tRes.ok) {
        const tData = await tRes.json();
        if (tData.results && tData.results.length > 0) {
          newsContext = tData.results.map(r => `[${r.url}] ${r.content.slice(0, 200)}`).join("\n");
          topSource = tData.results[0].url;
          topSnippet = tData.results[0].content.slice(0, 150) + "...";
          _newsCache[marketId] = { ts: Date.now(), context: newsContext, source: topSource, snippet: topSnippet };
        }
      }
    } catch (e) { console.warn("Tavily fallido:", e); }
  }

  // 2. Groq Llama 3 — Prompt ultra-compacto (40% menos tokens, misma inteligencia)
  const daysLeft = (m.endDateIso || m.endDate)
    ? Math.max(0, (new Date(m.endDateIso || m.endDate) - Date.now()) / 86400000).toFixed(1)
    : "?";

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: `Polymarket quant analyst. Return ONLY raw JSON. Find real mispricing edges using news+math. Be concise.`
      },
      {
        role: "user",
        content: `DATE:${new Date().toISOString().slice(0,10)} CLOSES_IN:${daysLeft}d
Q:"${m.question}"
YES=${fmtPct(yesP)} NO=${fmtPct(noP)} SUM=${fmtPct(sum)}${Math.abs(sum-1)>0.03?" ⚠ARB":""} VOL=${fmtMoney(vol)} LIQ=${fmtMoney(liq)}
SIGNALS:${prelim.signals.join(",")||"none"}
NEWS${usedCache?"(cache)":""}:${newsContext.slice(0,500)}

JSON:{"action":"BUY_YES"|"BUY_NO"|"SKIP","confidence":0-100,"edge_pct":number,"signal_types":[],"news_found":"string","news_source":"url","reasoning":"brief","risk":"LOW"|"MEDIUM"|"HIGH","score":0-100}`
      }
    ],
    temperature: 0.15,
    max_tokens: 350,
    response_format: { type: "json_object" }
  };

  const r = await fetch(API_GROQ, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json();
    throw new Error(`Groq error: ${err.error?.message || r.status}`);
  }
  const data = await r.json();
  const txt = data.choices[0]?.message?.content || "{}";
  const clean = txt.replace(/```[\w]*\n?|```/g, "").trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");
  const result = JSON.parse(jsonMatch[0]);
  result._newsCached = usedCache;
  return result;
}

// ─── STYLES & COMPONENTS ──────────────────────────────────────────────────────
const S = {
  bg: "#07090e",
  panel: "rgba(18, 22, 31, 0.6)",
  panelB: "rgba(25, 30, 42, 0.8)",
  border: "rgba(255, 255, 255, 0.05)",
  border2: "rgba(255, 255, 255, 0.08)",
  cyan: "#00f0ff",
  cyanD: "#008a99",
  green: "#00ff9d",
  greenD: "#00995c",
  red: "#ff3366",
  redD: "#991133",
  amber: "#ffb020",
  purple: "#b533ff",
  blue: "#3388ff",
  text: "#aebbc9",
  white: "#ffffff",
  muted: "#566678",
  muted2: "#7a8a9e",
  accent: "#00f0ff",
};

function Tag({ txt, color }) {
  return (
    <span style={{
      background: `${color}15`, border: `1px solid ${color}33`,
      color, padding: "3px 8px", borderRadius: "6px",
      fontSize: "9px", fontWeight: 700, letterSpacing: "1px",
      display: "inline-block", whiteSpace: "nowrap", fontFamily: "'Inter', sans-serif"
    }}>{txt}</span>
  );
}

function Btn({ label, color = S.cyan, onClick, disabled, filled, sm }) {
  return (
    <button className="neon-btn" onClick={onClick} disabled={disabled} style={{
      background: filled ? color : "transparent",
      border: `1px solid ${disabled ? S.muted : color}`,
      color: filled ? "#000" : disabled ? S.muted : color,
      padding: sm ? "5px 12px" : "8px 18px",
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: sm ? "10px" : "11px",
      fontWeight: 700,
      borderRadius: "6px",
      opacity: disabled ? 0.5 : 1,
    }}>{label}</button>
  );
}

function StatCard({ label, value, color, sub }) {
  return (
    <div className="glass-panel" style={{
      padding: "12px 16px", minWidth: "140px",
      display: "flex", flexDirection: "column", gap: "4px"
    }}>
      <div style={{ color: S.muted2, fontSize: "10px", letterSpacing: "1px", textTransform: "uppercase", fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>{label}</div>
      <div style={{ color: color || S.white, fontSize: "20px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textShadow: `0 0 15px ${color || S.white}33` }}>{value}</div>
      {sub && <div style={{ color: S.muted, fontSize: "10px", fontFamily: "'Inter', sans-serif" }}>{sub}</div>}
    </div>
  );
}

const logC = { SYSTEM: S.cyan, AI: S.purple, OPPORTUNITY: S.amber, TRADE: S.green, WIN: S.green, LOSS: S.red, ERROR: S.red, RISK: S.red, NEWS: "#ffb020", SCAN: S.blue, INFO: S.text, FILTER: S.cyan };

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function PolyBotV2() {
  const [tab, setTab] = useState("scan");
  const [capital, setCapital] = useState(INIT_CAPITAL);
  const [trades, setTrades] = useState([]);
  const [signals, setSignals] = useState([]);
  const [allMarkets, setAllMarkets] = useState([]);
  const [marketSnapshots, setMarketSnapshots] = useState({});
  const [logEntries, setLogEntries] = useState([]);
  const [scanStatus, setScanStatus] = useState({ running: false, phase: "", progress: 0, total: 0, lastScan: null });
  const [autoScan, setAutoScan] = useState(true);
  const [autoInterval, setAutoInterval] = useState(30); // 30 min = equilibrio óptimo tokens/velocidad
  const [catFilter, setCatFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("score");
  const [newsCache, setNewsCache] = useState({});
  const [closeInputs, setCloseInputs] = useState({});
  const [dailyPnl, setDailyPnl] = useState(0);
  const [dailyDate, setDailyDate] = useState(""); // YYYY-MM-DD del día actual
  const DAILY_GOAL = 1.50; // Objetivo diario en $
  const [goalReached, setGoalReached] = useState(false); // True cuando se alcanza DAILY_GOAL
  const [closeHour, setCloseHour] = useState(15); // Hora de cierre del día (0-23)
  const [marketSearch, setMarketSearch] = useState("");
  const [config, setConfig] = useState({
    maxTradePct: 12, stopLoss: 6, takeProfit: 18,
    dailyLossLimit: 25, minLiq: 1500, minVol: 8000,
    minScore: 25, aiTopN: 2, autoTrade: true
  });
  const autoRef = useRef(null);
  const scanningRef = useRef(false);

  // ── Load persisted state ──
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.innerHTML = `
      * { box-sizing: border-box; }
      body { margin: 0; padding: 0; background: #07090e; overflow-x: hidden; min-height: 100vh; }
      .glass-panel { background: rgba(18, 22, 31, 0.6); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.05); box-shadow: 0 4px 24px -1px rgba(0, 0, 0, 0.4); border-radius: 12px; }
      .neon-btn { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); cursor: pointer; text-transform: uppercase; letter-spacing: 1px; }
      .neon-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.25); box-shadow: 0 4px 12px rgba(0, 240, 255, 0.15); }
      .neon-btn:active:not(:disabled) { transform: translateY(0); }
      .tab-item { transition: all 0.2s; border-radius: 8px; flex-shrink: 0; }
      .tab-item:hover { background: rgba(255,255,255,0.03); }
      .glass-row { transition: all 0.15s; }
      .glass-row:hover { background: rgba(255,255,255,0.02) !important; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
      .animated-bg { background-image: radial-gradient(circle at 15% 50%, rgba(0, 240, 255, 0.04), transparent 25%), radial-gradient(circle at 85% 30%, rgba(181, 51, 255, 0.04), transparent 25%); background-attachment: fixed; min-height: 100vh; display: flex; flex-direction: column; }
      .main-content { padding: 0 16px 24px 16px; flex: 1; overflow-y: auto; overflow-x: hidden; }
    `;
    document.head.appendChild(style);
  }, []);

  // ── FETCH DESDE BACKEND EN LA NUBE ──
  useEffect(() => {
    const fetchBackend = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/status`);
        if (!res.ok) return;
        const data = await res.json();
        setCapital(data.capital);
        setTrades(data.trades);
        setDailyPnl(data.dailyPnl);
        setGoalReached(data.goalReached);
        setSignals(data.signals);
        setScanStatus(data.scanStatus);
        setLogEntries(data.logEntries);
        if (data.allMarkets && data.allMarkets.length > 0) setAllMarkets(data.allMarkets);
      } catch (err) { }
    };
    fetchBackend();
    const id = setInterval(fetchBackend, 3000);
    return () => clearInterval(id);
  }, []);

  const persist = () => {};
  const setCapitalP = () => {};
  const setTradesP = () => {};
  const setSignalsP = () => {};
  const addLog = () => {};
  function runFullScan() { alert('Operación manejada por el Backend en la nube.'); }
  function executeTrade(sig) { alert('El Backend en la nube auto-ejecuta compras.'); }
  function closeTrade(id, closePrice) { alert('El Backend se encarga del Stop Loss y Take Profit.'); }
  // ── Derived stats ──
  const openTrades = trades.filter(t => t.status === "OPEN");
  const closedTrades = trades.filter(t => t.status === "CLOSED");
  const invested = openTrades.reduce((s, t) => s + t.cost, 0);
  const totalValue = capital + invested;
  const totalPnl = parseFloat((totalValue - INIT_CAPITAL).toFixed(2));
  const totalPnlPct = parseFloat(((totalPnl / INIT_CAPITAL) * 100).toFixed(2));
  const realizedPnl = parseFloat(closedTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2));
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(1) : "—";
  const activeSignals = signals.filter(s => !s.executed);

  const filteredMarkets = allMarkets
    .filter(m => catFilter === "ALL" || m._cat === catFilter)
    .filter(m => !marketSearch || m.question?.toLowerCase().includes(marketSearch.toLowerCase()))
    .map(m => {
      const id = m.id || m.conditionId;
      const pre = preliminaryScore(m, marketSnapshots[id]);
      return { m, pre };
    })
    .filter(({ pre }) => !pre.skip)
    .sort((a, b) => {
      if (sortBy === "score") return b.pre.score - a.pre.score;
      if (sortBy === "vol") return b.pre.vol - a.pre.vol;
      if (sortBy === "liq") return b.pre.liq - a.pre.liq;
      return 0;
    });

  const TABS = [
    { id: "scan", label: "⬡ SCAN" },
    { id: "signals", label: "💡 SEÑALES", badge: activeSignals.length },
    { id: "markets", label: "📊 MERCADOS", badge: allMarkets.length },
    { id: "news", label: "📰 NOTICIAS" },
    { id: "portfolio", label: "💼 CARTERA", badge: openTrades.length },
    { id: "analytics", label: "📈 ANALÍTICA" },
    { id: "log", label: "📋 LOG" },
    { id: "config", label: "⚙ CONFIG" },
  ];

  const mono = "'JetBrains Mono', monospace";
  const sans = "'Inter', sans-serif";
  const heading = sans;

  return (
    <div className="animated-bg" style={{ background: S.bg, color: S.text, minHeight: "100vh", fontFamily: sans, fontSize: "13px" }}>

      {/* ─── HEADER ─── */}
      <div className="glass-panel" style={{
        margin: "16px", padding: "16px 24px", display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap",
        borderTop: `1px solid rgba(255,255,255,0.1)`, flexShrink: 0
      }}>
        <div style={{ marginRight: "12px", display: "flex", flexDirection: "column", gap: "2px" }}>
          <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "24px", letterSpacing: "2px", color: S.cyan, textShadow: `0 0 20px ${S.cyan}55` }}>
            POLYBOT<span style={{ color: S.white, opacity: 0.5, fontSize: "14px", marginLeft: "4px" }}>v2</span>
          </div>
          <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1.5px", fontFamily: sans, textTransform: "uppercase", fontWeight: 600 }}>Cerebro Llama 3 • Groq</div>
        </div>

        <div style={{ width: "1px", height: "40px", background: S.border2, margin: "0 4px" }} />

        <StatCard label="Dólares Disponibles" value={`$${capital.toFixed(2)}`} color={S.cyan} sub={`Márgen Libre`} />
        <StatCard label="Capital Invertido" value={`$${invested.toFixed(2)}`} color={S.text} sub={`En ${openTrades.length} trades vivos`} />
        <StatCard label="Valor Total (Equidad)" value={`$${totalValue.toFixed(2)}`} color={S.white} />
        <StatCard label="P&L Hoy" value={fmtDlr(dailyPnl)} color={dailyPnl >= 0 ? S.green : S.red} sub={`Ganancia Neta Diaria`} />
        <StatCard label="Win Rate" value={`${winRate}%`} color={parseFloat(winRate) >= 50 ? S.green : parseFloat(winRate) > 0 ? S.amber : S.muted2} sub={`${wins}W / ${closedTrades.length - wins}L`} />
        <StatCard label="Mercados" value={allMarkets.length || "—"} color={S.white} sub={scanStatus.lastScan ? `Scan: ${scanStatus.lastScan?.slice(0, 8)}` : "Sin escaneo"} />
        <StatCard label="Señales" value={activeSignals.length} color={activeSignals.length > 0 ? S.amber : S.muted2} />

        {/* ── OBJETIVO DIARIO $1.50 ── */}
        <div className="glass-panel" style={{ padding: "12px 16px", minWidth: "160px", display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ color: S.muted2, fontSize: "10px", letterSpacing: "1px", textTransform: "uppercase", fontFamily: "'Inter', sans-serif", fontWeight: 600 }}>🎯 Meta Diaria</div>
          <div style={{ color: dailyPnl >= DAILY_GOAL ? S.green : S.amber, fontSize: "18px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
            {fmtDlr(dailyPnl)} <span style={{ fontSize: "11px", color: S.muted2 }}>/ ${DAILY_GOAL.toFixed(2)}</span>
          </div>
          <div style={{ height: "6px", background: "rgba(255,255,255,0.07)", borderRadius: "3px", overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${Math.min(100, Math.max(0, (dailyPnl / DAILY_GOAL) * 100)).toFixed(1)}%`,
              background: dailyPnl >= DAILY_GOAL ? S.green : dailyPnl >= 0 ? `linear-gradient(90deg, ${S.amber}, ${S.green})` : S.red,
              borderRadius: "3px", transition: "width 0.6s ease"
            }} />
          </div>
          <div style={{ color: S.muted, fontSize: "9px" }}>
            {dailyPnl >= DAILY_GOAL ? "✅ META ALCANZADA" : `Faltan $${(DAILY_GOAL - dailyPnl).toFixed(2)}`}
            {" · Cierre: 3:00 PM"}
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ color: S.muted2, fontSize: "9px" }}>AUTO</span>
            <div
              onClick={() => setAutoScan(a => !a)}
              style={{
                width: "32px", height: "16px", borderRadius: "8px",
                background: autoScan ? `${S.green}44` : S.muted,
                border: `1px solid ${autoScan ? S.green : S.muted2}`,
                cursor: "pointer", position: "relative", transition: "all 0.3s",
              }}
            >
              <div style={{
                width: "12px", height: "12px", borderRadius: "50%",
                background: autoScan ? S.green : S.muted2,
                position: "absolute", top: "1px",
                left: autoScan ? "17px" : "1px", transition: "all 0.3s",
              }} />
            </div>
            {autoScan && (
              <select value={autoInterval} onChange={e => setAutoInterval(+e.target.value)}
                style={{ background: S.panelB, border: `1px solid ${S.border2}`, color: S.text, padding: "1px 4px", fontSize: "9px", fontFamily: mono }}>
                {[5,10,15,30,60].map(v => <option key={v} value={v}>{v}min</option>)}
              </select>
            )}
          </div>
          <button
            onClick={runFullScan} disabled={scanStatus.running}
            style={{
              background: scanStatus.running ? `${S.amber}22` : `${S.cyan}22`,
              border: `1px solid ${scanStatus.running ? S.amber : S.cyan}`,
              color: scanStatus.running ? S.amber : S.cyan,
              padding: "8px 20px", fontFamily: mono, fontWeight: 700, fontSize: "11px",
              cursor: scanStatus.running ? "wait" : "pointer", borderRadius: "3px",
              letterSpacing: "2px", boxShadow: scanStatus.running ? `0 0 20px ${S.amber}22` : `0 0 20px ${S.cyan}22`,
            }}
          >{scanStatus.running ? "⟳ ESCANEANDO…" : "▶ SCAN TOTAL"}</button>
        </div>
      </div>

      {/* ─── TABS ─── */}
      <div style={{ display: "flex", padding: "0 16px", gap: "8px", overflowX: "auto", borderBottom: `1px solid ${S.border}`, paddingBottom: "12px", marginBottom: "16px", flexShrink: 0 }}>
        {TABS.map(t => (
          <div key={t.id} onClick={() => setTab(t.id)} className="tab-item" style={{
            padding: "8px 16px", cursor: "pointer", fontSize: "11px", fontWeight: tab === t.id ? 600 : 500,
            letterSpacing: "1px", color: tab === t.id ? S.bg : S.muted2,
            background: tab === t.id ? S.cyan : "transparent",
            whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "8px",
            boxShadow: tab === t.id ? `0 4px 15px ${S.cyan}44` : "none"
          }}>
            {t.label}
            {t.badge > 0 && <span style={{ background: tab === t.id ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.05)", padding: "2px 6px", borderRadius: "10px", fontSize: "9px", fontWeight: 700 }}>{t.badge}</span>}
          </div>
        ))}
      </div>

      {/* ─── CONTENT ─── */}
      <div className="main-content">

        {/* ══════════ SCAN TAB ══════════ */}
        {tab === "scan" && (
          <div style={{ maxWidth: "1000px", margin: "0 auto" }}>
            {/* Status card */}
            <div style={{
              background: S.panel, border: `1px solid ${scanStatus.running ? S.amber : S.border2}`,
              borderRadius: "6px", padding: "20px", marginBottom: "14px",
              boxShadow: scanStatus.running ? `0 0 30px ${S.amber}15` : "none",
            }}>
              <div style={{ fontFamily: heading, fontSize: "14px", color: S.white, letterSpacing: "2px", marginBottom: "14px" }}>
                {scanStatus.running ? "⟳ ESCANEANDO POLYMARKET…" : scanStatus.lastScan ? "✅ ÚLTIMO ESCANEO" : "⬡ LISTO PARA ESCANEAR"}
              </div>

              {scanStatus.running && (
                <div style={{ marginBottom: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span style={{ color: S.amber }}>{scanStatus.phase}</span>
                    <span style={{ color: S.muted2 }}>{scanStatus.progress}%</span>
                  </div>
                  <div style={{ height: "4px", background: S.border, borderRadius: "2px" }}>
                    <div style={{ height: "100%", width: `${scanStatus.progress}%`, background: S.amber, borderRadius: "2px", transition: "width 0.5s" }} />
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px", marginBottom: "16px" }}>
                {[
                  ["Mercados escaneados", scanStatus.total || allMarkets.length || "—", S.cyan],
                  ["Señales activas", activeSignals.length, activeSignals.length > 0 ? S.amber : S.muted2],
                  ["Último scan", scanStatus.lastScan || "Nunca", S.text],
                  ["Auto-scan", autoScan ? `Cada ${autoInterval}min` : "Desactivado", autoScan ? S.green : S.muted2],
                  ["Trades abiertos", openTrades.length, openTrades.length > 0 ? S.green : S.muted2],
                  ["Capital libre", `$${capital.toFixed(2)}`, S.white],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ background: S.panelB, border: `1px solid ${S.border}`, padding: "8px 12px", borderRadius: "4px" }}>
                    <div style={{ color: S.muted2, fontSize: "8px", letterSpacing: "1px", marginBottom: "3px" }}>{l}</div>
                    <div style={{ color: c, fontWeight: 600 }}>{v}</div>
                  </div>
                ))}
              </div>

              {/* What the scan does */}
              <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: "14px" }}>
                <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px", marginBottom: "10px" }}>QUÉ HACE EL SCAN</div>
                {[
                  ["📡", "Descarga TODOS los mercados activos de Polymarket (paginado, sin límite)", S.cyan],
                  ["🏷", "Categoriza automáticamente: Política, Crypto, Deportes, Finanzas, Ciencia, Entretenimiento", S.text],
                  ["🔢", "Score preliminar: ARB matemático · momentum · time decay · volumen · liquidez", S.text],
                  ["🤖", `Análisis IA profundo en top ${config.aiTopN} mercados con Groq (Llama 3) en tiempo real`, S.purple],
                  ["📰", "Tavily Firehose: Busca noticias actuales en tiempo real e inyecta la realidad del mundo a Groq para generar una ventaja", "#ff9944"],
                  ["💾", "Guarda snapshots de precios para detectar movimientos entre escaneos", S.text],
                  ["⚖", "Detecta arbitraje: YES + NO ≠ 100% (ganancia sin riesgo si fees lo permiten)", S.green],
                  ["🎯", "Genera señales priorizadas con score 0-100, acción recomendada y tamaño de trade", S.amber],
                ].map(([icon, desc, color]) => (
                  <div key={desc} style={{ display: "flex", gap: "10px", padding: "4px 0", borderBottom: `1px solid ${S.border}33` }}>
                    <span style={{ fontSize: "13px", flexShrink: 0 }}>{icon}</span>
                    <span style={{ color, fontSize: "10px", lineHeight: 1.5 }}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent log preview */}
            <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden", display: "flex", flexDirection: "column", height: "500px" }}>
              <div style={{ padding: "8px 14px", borderBottom: `1px solid ${S.border2}`, color: S.muted2, fontSize: "9px", letterSpacing: "1px", flexShrink: 0 }}>
                LOG RECIENTE (últimas 20 entradas)
              </div>
              <div style={{ padding: "8px 14px", overflowY: "auto", flex: 1 }}>
                {logEntries.slice(0, 20).map(e => (
                  <div key={e.id} style={{ display: "flex", gap: "8px", padding: "1px 0", fontSize: "9px", lineHeight: 1.7 }}>
                    <span style={{ color: S.muted, flexShrink: 0 }}>{new Date(e.ts).toLocaleTimeString("es-CO")}</span>
                    <span style={{ color: logC[e.type] || S.text }}>{e.msg}</span>
                  </div>
                ))}
                {logEntries.length === 0 && <div style={{ color: S.muted, textAlign: "center", padding: "20px" }}>Presiona ▶ SCAN TOTAL para comenzar</div>}
              </div>
            </div>
          </div>
        )}

        {/* ══════════ SIGNALS TAB ══════════ */}
        {tab === "signals" && (
          <div>
            {activeSignals.length === 0 ? (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "60px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "40px", marginBottom: "14px" }}>💡</div>
                <div style={{ color: S.white, fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>Sin señales activas</div>
                <div style={{ color: S.muted2 }}>Ejecuta ▶ SCAN TOTAL para analizar todos los mercados con IA + noticias en tiempo real</div>
              </div>
            ) : (
              activeSignals.sort((a, b) => (b.analysis?.score || 0) - (a.analysis?.score || 0)).map(sig => {
                const { analysis: a, market: m, prelim } = sig;
                const rC = a.risk === "LOW" ? S.green : a.risk === "HIGH" ? S.red : S.amber;
                const actC = a.action === "BUY_YES" ? S.green : a.action === "BUY_NO" ? S.red : S.cyan;
                const tradeAmt = parseFloat((capital * config.maxTradePct / 100 * Math.min((a.confidence || 60) / 100, 1)).toFixed(2));
                const cat = m._cat || detectCategory(m.question);
                return (
                  <div key={sig.id} style={{
                    background: S.panel, border: `1px solid ${rC}33`,
                    borderLeft: `3px solid ${rC}`, borderRadius: "6px",
                    padding: "16px", marginBottom: "10px",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px", alignItems: "flex-start" }}>
                      <div style={{ flex: 1, marginRight: "12px" }}>
                        <div style={{ display: "flex", gap: "6px", marginBottom: "5px", flexWrap: "wrap" }}>
                          <Tag txt={`${CATEGORIES[cat]?.icon} ${CATEGORIES[cat]?.label}`} color={S.blue} />
                          <Tag txt={a.action} color={actC} />
                          {(a.signal_types || []).map(st => <Tag key={st} txt={SIGNAL_TYPES[st]?.icon + " " + st} color={SIGNAL_TYPES[st]?.color || S.text} />)}
                          {a.arb_detected && <Tag txt="⚖ ARB" color={S.cyan} />}
                          {!a.liquidity_ok && <Tag txt="⚠ LIQUIDEZ" color={S.red} />}
                        </div>
                        <div style={{ color: S.white, fontWeight: 600, fontSize: "12px", lineHeight: 1.5, marginBottom: "4px" }}>
                          {m.question}
                        </div>
                        <div style={{ color: S.muted, fontSize: "8px" }}>
                          Detectado: {new Date(sig.detectedAt).toLocaleString("es-CO")} · ID: {(m.id || m.conditionId || "").slice(0, 14)} · 
                          Cierra: {fmtDate(m.endDateIso || m.endDate)}
                        </div>
                      </div>
                      <div style={{ textAlign: "center", flexShrink: 0 }}>
                        <div style={{ color: S.amber, fontSize: "28px", fontWeight: 700, lineHeight: 1, fontFamily: heading }}>{a.score}</div>
                        <div style={{ color: S.muted, fontSize: "8px", letterSpacing: "1px" }}>SCORE/100</div>
                        <div style={{ color: a.confidence >= 70 ? S.green : a.confidence >= 55 ? S.amber : S.red, fontSize: "13px", fontWeight: 700, marginTop: "4px" }}>{a.confidence}%</div>
                        <div style={{ color: S.muted, fontSize: "7px" }}>CONF</div>
                      </div>
                    </div>

                    {/* Prices */}
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                      {[
                        ["YES actual", fmtPct(parseFloat((typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices)?.[0] ?? 0.5)), S.green],
                        ["NO actual", fmtPct(parseFloat((typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices)?.[1] ?? 0.5)), S.red],
                        ["Valor justo YES", a.fair_value_yes ? fmtPct(a.fair_value_yes) : "—", S.cyan],
                        ["Edge", a.edge_pct ? `${a.edge_pct.toFixed(1)}%` : "—", S.amber],
                        ["Vol total", fmtMoney(prelim?.vol || 0), S.text],
                        ["Liquidez", fmtMoney(prelim?.liq || 0), S.text],
                        ["Sum YES+NO", fmtPct(prelim?.sum || 1), Math.abs((prelim?.sum || 1) - 1) > 0.03 ? S.amber : S.muted2],
                      ].map(([l, v, c]) => (
                        <div key={l} style={{ background: "#0005", border: `1px solid ${S.border}`, padding: "3px 9px", borderRadius: "3px" }}>
                          <span style={{ color: S.muted, fontSize: "8px" }}>{l} </span>
                          <span style={{ color: c, fontWeight: 600, fontSize: "10px" }}>{v}</span>
                        </div>
                      ))}
                    </div>

                    {/* News */}
                    {a.news_found && a.news_found !== "none" && (
                      <div style={{
                        background: `#ff994408`, border: `1px solid #ff994433`,
                        padding: "8px 12px", borderRadius: "4px", marginBottom: "10px",
                      }}>
                        <div style={{ color: "#ff9944", fontSize: "8px", fontWeight: 700, marginBottom: "4px" }}>📰 NOTICIA DETECTADA</div>
                        <div style={{ color: S.white, fontSize: "10px", lineHeight: 1.5 }}>{a.news_found}</div>
                        {a.news_source && <div style={{ color: S.muted2, fontSize: "8px", marginTop: "3px" }}>Fuente: {a.news_source}</div>}
                      </div>
                    )}

                    {/* AI Reasoning */}
                    <div style={{
                      background: `${S.purple}08`, border: `1px solid ${S.purple}22`,
                      padding: "8px 12px", borderRadius: "4px", marginBottom: "10px",
                      color: S.purple, fontSize: "10px", lineHeight: 1.5,
                    }}>
                      🤖 {a.reasoning}
                    </div>

                    {/* Trade sizing */}
                    <div style={{
                      background: "#0006", border: `1px solid ${S.border}`,
                      padding: "8px 12px", borderRadius: "4px", marginBottom: "12px",
                      display: "flex", gap: "16px", flexWrap: "wrap",
                    }}>
                      {[
                        ["Monto a usar", `$${tradeAmt}`, S.white],
                        ["% del capital", `${config.maxTradePct}%`, S.amber],
                        ["Riesgo máx", `-$${(tradeAmt * config.stopLoss / 100).toFixed(2)}`, S.red],
                        ["Target profit", `+$${(tradeAmt * config.takeProfit / 100).toFixed(2)}`, S.green],
                        ["R/R ratio", `1:${(config.takeProfit / config.stopLoss).toFixed(1)}`, S.cyan],
                        ["Riesgo IA", a.risk, rC],
                      ].map(([l, v, c]) => (
                        <div key={l}>
                          <span style={{ color: S.muted, fontSize: "8px" }}>{l} </span>
                          <span style={{ color: c, fontWeight: 700 }}>{v}</span>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      <Btn label={`✓ EJECUTAR ${a.action}`} color={actC} onClick={() => executeTrade(sig)} filled />
                      <Btn label="✗ DESCARTAR" color={S.muted2} onClick={() => setSignalsP(signals.filter(s => s.id !== sig.id))} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ══════════ MARKETS TAB ══════════ */}
        {tab === "markets" && (
          <div>
            {/* Filters */}
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap", alignItems: "center" }}>
              {Object.entries(CATEGORIES).map(([k, v]) => (
                <div key={k} onClick={() => setCatFilter(k)} style={{
                  padding: "4px 11px", borderRadius: "3px", cursor: "pointer", fontSize: "9px", fontWeight: 700,
                  letterSpacing: "1px", transition: "all 0.2s",
                  background: catFilter === k ? `${S.cyan}22` : "transparent",
                  border: `1px solid ${catFilter === k ? S.cyan : S.border2}`,
                  color: catFilter === k ? S.cyan : S.muted2,
                }}>
                  {v.icon} {v.label}
                  {k !== "ALL" && allMarkets.filter(m => m._cat === k).length > 0 && (
                    <span style={{ marginLeft: "5px", color: S.muted }}>{allMarkets.filter(m => m._cat === k).length}</span>
                  )}
                </div>
              ))}
              <input
                value={marketSearch} onChange={e => setMarketSearch(e.target.value)}
                placeholder="Buscar mercado…"
                style={{
                  background: S.panelB, border: `1px solid ${S.border2}`, color: S.white,
                  padding: "4px 10px", borderRadius: "3px", fontFamily: mono, fontSize: "10px",
                  outline: "none", marginLeft: "auto", width: "200px",
                }}
              />
              <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                style={{ background: S.panelB, border: `1px solid ${S.border2}`, color: S.text, padding: "4px 8px", fontSize: "9px", fontFamily: mono }}>
                <option value="score">Sort: Score</option>
                <option value="vol">Sort: Volumen</option>
                <option value="liq">Sort: Liquidez</option>
              </select>
            </div>

            {allMarkets.length === 0 ? (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "40px", textAlign: "center", color: S.muted }}>
                Presiona ▶ SCAN TOTAL para cargar todos los mercados activos de Polymarket
              </div>
            ) : (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "8px 14px", borderBottom: `1px solid ${S.border2}`, color: S.muted2, fontSize: "9px", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
                  <span>{filteredMarkets.length} mercados {catFilter !== "ALL" ? `en ${CATEGORIES[catFilter]?.label}` : "totales"} (mostrando top 200)</span>
                  <span>gamma-api.polymarket.com · {scanStatus.lastScan || "sin datos"}</span>
                </div>
                <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "65vh" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: `${S.border}55` }}>
                        {["SCORE", "CAT", "PREGUNTA", "YES%", "NO%", "SUM%", "SEÑALES", "VOLUMEN", "LIQUIDEZ", "CIERRE", ""].map(h => (
                          <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: S.muted2, fontSize: "8px", letterSpacing: "1px", borderBottom: `1px solid ${S.border2}`, whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMarkets.slice(0, 200).map(({ m, pre }, i) => {
                        const arb = Math.abs(pre.sum - 1) > 0.03;
                        const cat = m._cat || "OTHER";
                        return (
                          <tr key={m.id || i} style={{
                            background: arb ? `${S.cyan}05` : i % 2 === 0 ? `${S.border}22` : "transparent",
                            borderBottom: `1px solid ${S.border}`,
                          }}>
                            <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                              <div style={{
                                display: "inline-block", background: `${pre.score > 70 ? S.amber : pre.score > 50 ? S.cyan : S.muted}22`,
                                color: pre.score > 70 ? S.amber : pre.score > 50 ? S.cyan : S.muted2,
                                fontWeight: 700, padding: "1px 8px", borderRadius: "2px", fontSize: "10px",
                              }}>{pre.score}</div>
                            </td>
                            <td style={{ padding: "7px 10px", fontSize: "13px" }}>{CATEGORIES[cat]?.icon}</td>
                            <td style={{ padding: "7px 10px", maxWidth: "220px" }}>
                              <div style={{ color: S.text, fontSize: "10px", lineHeight: 1.3 }}>
                                {m.question?.slice(0, 70)}{m.question?.length > 70 ? "…" : ""}
                              </div>
                            </td>
                            <td style={{ padding: "7px 10px", color: S.green, fontWeight: 600, whiteSpace: "nowrap" }}>{fmtPct(pre.yesP)}</td>
                            <td style={{ padding: "7px 10px", color: S.red, fontWeight: 600, whiteSpace: "nowrap" }}>{fmtPct(pre.noP)}</td>
                            <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                              <span style={{ color: arb ? S.amber : S.muted2, fontWeight: arb ? 700 : 400 }}>
                                {fmtPct(pre.sum)}{arb ? " ⚖" : ""}
                              </span>
                            </td>
                            <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                              <div style={{ display: "flex", gap: "3px", flexWrap: "nowrap" }}>
                                {pre.signals.map(st => <span key={st} style={{ fontSize: "11px" }}>{SIGNAL_TYPES[st]?.icon}</span>)}
                              </div>
                            </td>
                            <td style={{ padding: "7px 10px", color: pre.vol > 500000 ? S.white : pre.vol > 50000 ? S.text : S.muted2, whiteSpace: "nowrap" }}>
                              {fmtMoney(pre.vol)}
                            </td>
                            <td style={{ padding: "7px 10px", color: pre.liq > 5000 ? S.text : pre.liq > 1000 ? S.muted2 : S.red, whiteSpace: "nowrap" }}>
                              {fmtMoney(pre.liq)}
                            </td>
                            <td style={{ padding: "7px 10px", color: S.muted, fontSize: "9px", whiteSpace: "nowrap" }}>
                              {fmtDate(m.endDateIso || m.endDate)}
                            </td>
                            <td style={{ padding: "7px 10px" }}>
                              <Btn label="IA" color={S.purple} sm onClick={async () => {
                                addLog(`🤖 Análisis manual + noticias: "${m.question?.slice(0, 50)}"`, "AI");
                                try {
                                  const a = await deepAnalyze(m, pre);
                                  if (a.score >= 40 && a.action !== "SKIP") {
                                    const sig = { id: uid(), detectedAt: new Date().toISOString(), market: { ...m, _cat: cat }, prelim: pre, analysis: a, executed: false };
                                    setSignalsP([sig, ...signals]);
                                    addLog(`✨ Señal: ${a.action} score:${a.score} conf:${a.confidence}%`, "OPPORTUNITY");
                                    setTab("signals");
                                  } else {
                                    addLog(`Sin ventaja suficiente: ${a.reasoning?.slice(0, 80)}`, "INFO");
                                  }
                                } catch (e) { addLog(`Error IA: ${e.message}`, "ERROR"); }
                              }} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════════ NEWS TAB ══════════ */}
        {tab === "news" && (
          <div>
            {Object.keys(newsCache).length === 0 ? (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "50px 20px", textAlign: "center", color: S.muted }}>
                📰 Las noticias aparecerán aquí durante el escaneo IA.<br />
                El bot usa web search para encontrar noticias actuales de cada mercado.
              </div>
            ) : (
              Object.entries(newsCache)
                .sort(([, a], [, b]) => b.ts - a.ts)
                .map(([id, news]) => {
                  const m = allMarkets.find(x => (x.id || x.conditionId) === id);
                  return (
                    <div key={id} style={{
                      background: S.panel, border: `1px solid #ff994433`,
                      borderLeft: `3px solid #ff9944`, borderRadius: "6px",
                      padding: "12px 16px", marginBottom: "8px",
                    }}>
                      <div style={{ color: "#ff9944", fontSize: "8px", fontWeight: 700, marginBottom: "4px" }}>
                        📰 {new Date(news.ts).toLocaleString("es-CO")}
                      </div>
                      {m && <div style={{ color: S.muted2, fontSize: "9px", marginBottom: "6px" }}>
                        Mercado: {m.question?.slice(0, 80)}
                      </div>}
                      <div style={{ color: S.white, fontSize: "11px", lineHeight: 1.6 }}>{news.news}</div>
                      {news.source && <div style={{ color: S.muted2, fontSize: "8px", marginTop: "5px" }}>Fuente: {news.source}</div>}
                    </div>
                  );
                })
            )}
          </div>
        )}

        {/* ══════════ PORTFOLIO TAB ══════════ */}
        {tab === "portfolio" && (
          <div>
            {/* Summary stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginBottom: "14px" }}>
              {[
                ["P&L Total", `${totalPnl >= 0 ? "+" : ""}$${totalPnl}`, `${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct}%`, totalPnl >= 0 ? S.green : S.red],
                ["P&L Realizado", `${realizedPnl >= 0 ? "+" : ""}$${realizedPnl}`, `${closedTrades.length} trades cerrados`, realizedPnl >= 0 ? S.green : S.red],
                ["Win Rate", `${winRate}%`, `${wins}W / ${closedTrades.length - wins}L`, parseFloat(winRate) >= 50 ? S.green : S.amber],
                ["P&L Diario", `${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`, `Límite: -$${(INIT_CAPITAL * config.dailyLossLimit / 100).toFixed(0)}`, dailyPnl >= 0 ? S.green : S.red],
              ].map(([l, v, sub, c]) => (
                <div key={l} style={{ background: S.panel, border: `1px solid ${S.border2}`, padding: "12px 16px", borderRadius: "6px" }}>
                  <div style={{ color: S.muted2, fontSize: "8px", letterSpacing: "1px", marginBottom: "4px" }}>{l}</div>
                  <div style={{ color: c, fontSize: "16px", fontWeight: 700 }}>{v}</div>
                  <div style={{ color: S.muted2, fontSize: "8px", marginTop: "3px" }}>{sub}</div>
                </div>
              ))}
            </div>

            {/* Open trades */}
            <div style={{ color: S.muted2, fontSize: "9px", fontWeight: 700, letterSpacing: "1px", marginBottom: "8px" }}>
              TRADES ABIERTOS ({openTrades.length}) · CAPITAL EN JUEGO: ${invested.toFixed(2)}
            </div>
            {openTrades.length === 0 ? (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "20px", color: S.muted, textAlign: "center", marginBottom: "14px" }}>
                Sin trades abiertos. Ejecuta señales desde la pestaña 💡 SEÑALES.
              </div>
            ) : (
              openTrades.map(t => (
                <div key={t.id} style={{
                  background: S.panel, border: `1px solid ${S.border2}`,
                  borderLeft: `3px solid ${t.side === "YES" ? S.green : S.red}`,
                  borderRadius: "6px", padding: "14px", marginBottom: "10px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <div style={{ flex: 1, marginRight: "10px" }}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "4px" }}>
                        <Tag txt={t.id} color={S.muted2} />
                        <Tag txt={`${CATEGORIES[t.category]?.icon} ${CATEGORIES[t.category]?.label}`} color={S.blue} />
                        <Tag txt={`${t.side}`} color={t.side === "YES" ? S.green : S.red} />
                        {(t.signal_types || []).map(st => <Tag key={st} txt={SIGNAL_TYPES[st]?.icon + " " + st} color={SIGNAL_TYPES[st]?.color || S.text} />)}
                      </div>
                      <div style={{ color: S.white, fontWeight: 600, fontSize: "11px", lineHeight: 1.4 }}>
                        {t.question}
                      </div>
                      <div style={{ color: S.muted, fontSize: "8px", marginTop: "3px" }}>
                        Abierto: {new Date(t.ts).toLocaleString("es-CO")} · Mercado: {t.marketId?.slice(0, 12)}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
                    {[
                      ["ENTRADA", fmtPct(t.entryPrice || t.price || 0), S.white],
                      ["COSTO", `$${t.cost || 0}`, S.white],
                      ["SHARES", (t.shares || 0).toFixed(5), S.text],
                      ["SL (-)", fmtPct(t.stopLoss || 0), S.red],
                      ["TP (+)", fmtPct(t.takeProfit || 0), S.green],
                      ["CONF IA", `${t.confidence || 0}%`, S.amber],
                      ["EDGE IA", `${((t.edge_pct || 0)).toFixed(1)}%`, S.amber],
                      ["RIESGO", (t.risk || 'DESCONOCIDO'), t.risk === "LOW" ? S.green : t.risk === "HIGH" ? S.red : S.amber],
                    ].map(([l, v, c]) => (
                      <div key={l} style={{ background: "#0005", border: `1px solid ${S.border}`, padding: "3px 8px", borderRadius: "3px" }}>
                        <span style={{ color: S.muted, fontSize: "7px" }}>{l} </span>
                        <span style={{ color: c, fontWeight: 600, fontSize: "10px" }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px", borderTop: `1px solid ${S.border}`, paddingTop: "12px" }}>
                    {[
                      ["PRECIO ACTUAL", fmtPct(t.currentPrice || t.entryPrice || 0), S.cyan],
                      ["P&L VIVO", fmtDlr((((t.currentPrice || t.entryPrice) - t.entryPrice) * (t.shares || 0))), (((t.currentPrice || t.entryPrice) - t.entryPrice) * (t.shares || 0)) >= 0 ? S.green : S.red],
                      ["ROI AUTONOMO", `${((((t.currentPrice || t.entryPrice) - t.entryPrice) / (t.entryPrice || 1)) * 100).toFixed(1)}%`, (((t.currentPrice || t.entryPrice) - t.entryPrice)) >= 0 ? S.green : S.red],
                    ].map(([l, v, c]) => (
                      <div key={l} style={{ background: `${c}15`, border: `1px solid ${c}33`, padding: "6px 12px", borderRadius: "6px" }}>
                        <span style={{ color: S.muted, fontSize: "8px", letterSpacing: "1px" }}>{l} </span>
                        <span style={{ color: c, fontWeight: 700, fontSize: "13px" }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  {t.news && (
                    <div style={{ background: `#ff994408`, border: `1px solid #ff994422`, padding: "6px 10px", borderRadius: "3px", marginBottom: "8px", color: "#ff9944", fontSize: "9px" }}>
                      📰 {t.news}
                    </div>
                  )}
                  {t.reasoning && (
                    <div style={{ color: S.purple, fontSize: "9px", fontStyle: "italic", marginBottom: "10px" }}>🤖 {t.reasoning}</div>
                  )}

                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <Btn label="WIN 0.95¢" color={S.green} onClick={() => closeTrade(t.id, 0.95)} filled sm />
                    <Btn label="LOSS 0.05¢" color={S.red} onClick={() => closeTrade(t.id, 0.05)} filled sm />
                    <Btn label="BREAK EVEN" color={S.amber} onClick={() => closeTrade(t.id, t.entryPrice)} sm />
                    <input
                      type="number" min="0" max="1" step="0.01" placeholder="Precio (0-1)"
                      value={closeInputs[t.id] || ""}
                      onChange={e => setCloseInputs(p => ({ ...p, [t.id]: e.target.value }))}
                      style={{
                        background: S.panelB, border: `1px solid ${S.border2}`, color: S.white,
                        padding: "4px 8px", borderRadius: "3px", fontFamily: mono, fontSize: "10px", width: "110px",
                      }}
                    />
                    <Btn label="CERRAR" color={S.muted2} onClick={() => closeTrade(t.id, closeInputs[t.id])} sm />
                  </div>
                </div>
              ))
            )}

            {/* Closed trades */}
            {closedTrades.length > 0 && (
              <>
                <div style={{ color: S.muted2, fontSize: "9px", fontWeight: 700, letterSpacing: "1px", margin: "18px 0 8px" }}>
                  HISTORIAL ({closedTrades.length}) · P&L REALIZADO: {realizedPnl >= 0 ? "+" : ""}${realizedPnl}
                </div>
                <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: `${S.border}55` }}>
                        {["ID", "CAT", "MERCADO", "LADO", "ENTRADA", "CIERRE", "COSTO", "P&L", "ROI", "CERRADO"].map(h => (
                          <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: S.muted2, fontSize: "8px", letterSpacing: "1px", borderBottom: `1px solid ${S.border2}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {closedTrades.map((t, i) => (
                        <tr key={t.id} style={{ background: i % 2 === 0 ? `${S.border}22` : "transparent", borderBottom: `1px solid ${S.border}` }}>
                          <td style={{ padding: "7px 10px", color: S.muted, fontSize: "9px", whiteSpace: "nowrap" }}>{t.id}</td>
                          <td style={{ padding: "7px 10px", fontSize: "12px" }}>{CATEGORIES[t.category || "OTHER"]?.icon}</td>
                          <td style={{ padding: "7px 10px", maxWidth: "180px" }}>
                            <span style={{ color: S.text, fontSize: "9px" }}>{t.question?.slice(0, 55)}…</span>
                          </td>
                          <td style={{ padding: "7px 10px" }}><Tag txt={t.side} color={t.side === "YES" ? S.green : S.red} /></td>
                          <td style={{ padding: "7px 10px", color: S.text, whiteSpace: "nowrap" }}>{fmtPct(t.entryPrice)}</td>
                          <td style={{ padding: "7px 10px", color: S.text, whiteSpace: "nowrap" }}>{fmtPct(t.currentPrice)}</td>
                          <td style={{ padding: "7px 10px", color: S.text, whiteSpace: "nowrap" }}>${t.cost}</td>
                          <td style={{ padding: "7px 10px", fontWeight: 700, whiteSpace: "nowrap", color: t.pnl >= 0 ? S.green : S.red }}>
                            {t.pnl >= 0 ? "+" : ""}${t.pnl}
                          </td>
                          <td style={{ padding: "7px 10px", whiteSpace: "nowrap", color: t.pnl >= 0 ? S.green : S.red }}>
                            {((t.pnl / t.cost) * 100).toFixed(1)}%
                          </td>
                          <td style={{ padding: "7px 10px", color: S.muted, fontSize: "9px", whiteSpace: "nowrap" }}>
                            {t.closedAt ? new Date(t.closedAt).toLocaleString("es-CO") : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "analytics" && (() => {
          const now = Date.now();
          const closed = trades.filter(t => t.status === "CLOSED");
          const last24h = closed.filter(t => t.closedAt && (now - new Date(t.closedAt).getTime() < 86400000));
          
          const won = closed.filter(t => t.pnl > 0);
          const lost = closed.filter(t => t.pnl < 0);
          
          const won24 = last24h.filter(t => t.pnl > 0);
          const lost24 = last24h.filter(t => t.pnl < 0);
          const pnl24 = last24h.reduce((acc, t) => acc + (t.pnl || 0), 0);
          const vol24 = last24h.reduce((acc, t) => acc + (t.cost || 0), 0);
          
          const bestTrade = closed.reduce((b, t) => (t.pnl > (b?.pnl || -9999)) ? t : b, null);
          const worstTrade = closed.reduce((w, t) => (t.pnl < (w?.pnl || 9999)) ? t : w, null);

          return (
            <div style={{ maxWidth: "1000px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ color: S.cyan, fontSize: "16px", fontWeight: 700, letterSpacing: "2px", fontFamily: heading }}>
                RENDIMIENTO Y MÉTRICAS CUANTITATIVAS
              </div>
              
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
                 <StatCard label="P&L REALIZADO HISTÓRICO" value={`${realizedPnl >= 0 ? "+" : ""}$${realizedPnl}`} color={realizedPnl >= 0 ? S.green : S.red} sub={`Basado en ${closed.length} operaciones`} />
                 <StatCard label="TASA DE ACIERTO (WIN RATE)" value={winRate + "%"} color={winRate > 50 ? S.green : S.amber} sub={`${won.length} Ganadas · ${lost.length} Perdidas`} />
                 <StatCard label="BALANCE LÍQUIDO" value={`$${capital.toFixed(2)}`} color={capital >= INIT_CAPITAL ? S.green : S.amber} sub={`Excluye margen bloqueado ($${invested.toFixed(2)})`} />
              </div>

              <div className="glass-panel" style={{ padding: "20px", marginTop: "16px", background: `linear-gradient(135deg, ${S.panel} 0%, rgba(0, 50, 80, 0.1) 100%)` }}>
                 <div style={{ color: S.accent, fontSize: "12px", fontWeight: 700, marginBottom: "16px", fontFamily: heading, borderBottom: `1px solid ${S.border}`, paddingBottom: "10px", letterSpacing: "1px" }}>
                   REPORTE ÚLTIMAS 24 HORAS
                 </div>
                 <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "20px" }}>
                   <div>
                     <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px", marginBottom: "4px" }}>BENEFICIO NETO 24H</div>
                     <div style={{ color: pnl24 >= 0 ? S.green : S.red, fontSize: "28px", fontWeight: 700, fontFamily: mono }}>{fmtDlr(pnl24)}</div>
                   </div>
                   <div>
                     <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px", marginBottom: "4px" }}>VOLUMEN INVERTIDO 24H</div>
                     <div style={{ color: S.white, fontSize: "28px", fontWeight: 700, fontFamily: mono }}>${vol24.toFixed(2)}</div>
                   </div>
                   <div>
                     <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px", marginBottom: "4px" }}>TRADES CERRADOS 24H</div>
                     <div style={{ color: S.text, fontSize: "28px", fontWeight: 700, fontFamily: mono }}>{last24h.length}</div>
                   </div>
                   <div>
                     <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px", marginBottom: "4px" }}>EFECTIVIDAD 24H</div>
                     <div style={{ color: won24.length > lost24.length ? S.green : S.amber, fontSize: "28px", fontWeight: 700, fontFamily: mono }}>
                       {last24h.length > 0 ? ((won24.length / last24h.length) * 100).toFixed(0) : 0}%
                     </div>
                   </div>
                 </div>
              </div>

              {(bestTrade && worstTrade && closed.length > 0) && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginTop: "8px" }}>
                  <div style={{ background: `${S.green}11`, border: `1px solid ${S.green}33`, padding: "16px", borderRadius: "8px" }}>
                    <div style={{ color: S.green, fontSize: "9px", fontWeight: 700, letterSpacing: "1px", marginBottom: "8px" }}>🏆 MEJOR TRADE HISTÓRICO</div>
                    <div style={{ color: S.white, fontSize: "11px", marginBottom: "6px", lineHeight: 1.4 }}>{bestTrade.question}</div>
                    <div style={{ color: S.green, fontSize: "18px", fontWeight: 700, fontFamily: mono }}>+{bestTrade.pnl > 0 ? "$" : ""}{bestTrade.pnl.toFixed(2)} <span style={{fontSize: "10px", fontWeight: 400, color: S.text}}>(ROI: {((bestTrade.pnl/(bestTrade.cost||1))*100).toFixed(1)}%)</span></div>
                  </div>
                  
                  <div style={{ background: `${S.red}11`, border: `1px solid ${S.red}33`, padding: "16px", borderRadius: "8px" }}>
                    <div style={{ color: S.red, fontSize: "9px", fontWeight: 700, letterSpacing: "1px", marginBottom: "8px" }}>💔 PEOR TRADE HISTÓRICO</div>
                    <div style={{ color: S.white, fontSize: "11px", marginBottom: "6px", lineHeight: 1.4 }}>{worstTrade.question}</div>
                    <div style={{ color: S.red, fontSize: "18px", fontWeight: 700, fontFamily: mono }}>{worstTrade.pnl < 0 ? "-$" : "$"}{Math.abs(worstTrade.pnl).toFixed(2)} <span style={{fontSize: "10px", fontWeight: 400, color: S.text}}>(Perdida: {((worstTrade.pnl/(worstTrade.cost||1))*100).toFixed(1)}%)</span></div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ══════════ LOG TAB ══════════ */}
        {tab === "log" && (
          <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden" }}>
            <div style={{ padding: "8px 14px", borderBottom: `1px solid ${S.border2}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px" }}>
                LOG AUDITADO ({logEntries.length} entradas) · TRAZABILIDAD COMPLETA
              </span>
              <Btn label="LIMPIAR" color={S.red} sm onClick={() => { setLogEntries([]); persist("pb2_log", []); }} />
            </div>
            <div style={{ padding: "8px 14px", maxHeight: "calc(100vh - 220px)", overflowY: "auto" }}>
              {logEntries.length === 0 ? (
                <div style={{ color: S.muted, padding: "30px", textAlign: "center" }}>Sin actividad. Presiona ▶ SCAN TOTAL.</div>
              ) : (
                logEntries.map(e => (
                  <div key={e.id} style={{ display: "flex", gap: "8px", padding: "2px 0", fontSize: "9px", lineHeight: 1.7, borderBottom: `1px solid ${S.border}18` }}>
                    <span style={{ color: S.muted, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                      {new Date(e.ts).toLocaleTimeString("es-CO")}
                    </span>
                    <span style={{
                      background: `${logC[e.type] || S.text}18`,
                      border: `1px solid ${logC[e.type] || S.text}33`,
                      color: logC[e.type] || S.text,
                      padding: "0 5px", borderRadius: "2px",
                      fontSize: "7px", fontWeight: 700, letterSpacing: "1px",
                      flexShrink: 0, alignSelf: "center", whiteSpace: "nowrap",
                    }}>{e.type}</span>
                    <span style={{ color: logC[e.type] || S.text, wordBreak: "break-word" }}>{e.msg}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ══════════ CONFIG TAB ══════════ */}
        {tab === "config" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
            <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "16px" }}>
              <div style={{ color: S.cyan, fontFamily: heading, fontSize: "13px", letterSpacing: "2px", marginBottom: "16px" }}>🛡 RIESGO & FILTROS</div>
              {[
                { k: "maxTradePct", l: "Máx por Trade", u: "%", min: 0.5, max: 10, step: 0.5 },
                { k: "stopLoss", l: "Stop Loss", u: "%", min: 1, max: 30, step: 1 },
                { k: "takeProfit", l: "Take Profit", u: "%", min: 5, max: 60, step: 5 },
                { k: "dailyLossLimit", l: "Límite Pérdida Diaria", u: "%", min: 2, max: 25, step: 1 },
                { k: "minLiq", l: "Liquidez Mínima", u: "$", min: 100, max: 20000, step: 100 },
                { k: "minVol", l: "Volumen Mínimo", u: "$", min: 500, max: 200000, step: 500 },
                { k: "minScore", l: "Score Mínimo (pre-filtro)", u: "", min: 10, max: 80, step: 5 },
                { k: "aiTopN", l: "Top N para análisis IA", u: " mkt", min: 3, max: 20, step: 1 },
              ].map(f => (
                <div key={f.k} style={{ marginBottom: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span style={{ color: S.text, fontSize: "10px" }}>{f.l}</span>
                    <span style={{ color: S.amber, fontWeight: 700 }}>
                      {f.u === "$" ? `$${config[f.k].toLocaleString()}` : `${config[f.k]}${f.u}`}
                    </span>
                  </div>
                  <input type="range" min={f.min} max={f.max} step={f.step} value={config[f.k]}
                    onChange={e => setConfig(c => ({ ...c, [f.k]: parseFloat(e.target.value) }))}
                    style={{ width: "100%", accentColor: S.cyan }} />
                </div>
              ))}

              {/* Hora de cierre del día */}
              <div style={{ marginBottom: "14px", marginTop: "8px", borderTop: `1px solid ${S.border}`, paddingTop: "14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                  <span style={{ color: S.amber, fontSize: "10px", fontWeight: 700 }}>⏰ Hora de Cierre del Día</span>
                  <span style={{ color: S.cyan, fontWeight: 700 }}>{String(closeHour).padStart(2,"0")}:00 hs</span>
                </div>
                <input type="range" min={0} max={23} step={1} value={closeHour}
                  onChange={e => setCloseHour(parseInt(e.target.value))}
                  style={{ width: "100%", accentColor: S.amber }} />
                <div style={{ color: S.muted2, fontSize: "9px", marginTop: "4px" }}>
                  A esta hora se detienen las inversiones nuevas del día. Las posiciones abiertas siguen su rumbo sin forzar venta.
                  {goalReached && <span style={{ color: S.green, marginLeft: "8px" }}>✅ META HOY ALCANZADA · Sin nuevas inversiones</span>}
                </div>
              </div>

              {/* Botón desbloquear meta manualmente */}
              {goalReached && (
                <div style={{ background: `${S.green}11`, border: `1px solid ${S.green}33`, borderRadius: "6px", padding: "10px 14px", marginTop: "4px" }}>
                  <div style={{ color: S.green, fontSize: "10px", fontWeight: 700, marginBottom: "6px" }}>🏆 META DIARIA ALCANZADA — Autopilot Pausado</div>
                  <div style={{ color: S.muted2, fontSize: "9px", marginBottom: "8px" }}>El bot no ejecutará nuevas inversiones hoy. Se reactivará automáticamente mañana.</div>
                  <button onClick={() => { setGoalReached(false); addLog("🔓 Meta desbloqueada manualmente por el usuario.", "SYSTEM"); }}
                    style={{ background: `${S.amber}22`, border: `1px solid ${S.amber}`, color: S.amber, padding: "5px 14px", borderRadius: "4px", fontFamily: mono, fontSize: "10px", cursor: "pointer", fontWeight: 700, letterSpacing: "1px" }}>
                    DESBLOQUEAR MANUALMENTE
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {/* Portfolio summary */}
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "16px" }}>
                <div style={{ color: S.cyan, fontFamily: heading, fontSize: "13px", letterSpacing: "2px", marginBottom: "14px" }}>📊 ESTADÍSTICAS</div>
                {[
                  ["Capital Inicial", `$${INIT_CAPITAL.toLocaleString()}`, S.muted2],
                  ["Capital Libre", `$${capital.toFixed(2)}`, S.cyan],
                  ["Capital Invertido", `$${invested.toFixed(2)}`, S.text],
                  ["Valor Total", `$${totalValue.toFixed(2)}`, S.white],
                  ["P&L Total", `${totalPnl >= 0 ? "+" : ""}$${totalPnl} (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct}%)`, totalPnl >= 0 ? S.green : S.red],
                  ["P&L Realizado", `${realizedPnl >= 0 ? "+" : ""}$${realizedPnl}`, realizedPnl >= 0 ? S.green : S.red],
                  ["P&L Diario", `${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`, dailyPnl >= 0 ? S.green : S.red],
                  ["Mercados en DB", allMarkets.length, S.text],
                  ["Señales Activas", activeSignals.length, activeSignals.length > 0 ? S.amber : S.muted2],
                  ["Noticias en Cache", Object.keys(newsCache).length, "#ff9944"],
                  ["Trades Abiertos", openTrades.length, S.text],
                  ["Trades Cerrados", closedTrades.length, S.text],
                  ["Ganados / Perdidos", `${wins} / ${closedTrades.length - wins}`, S.text],
                  ["Win Rate", `${winRate}%`, parseFloat(winRate) >= 50 ? S.green : S.amber],
                  ["R/R Config", `1:${(config.takeProfit / config.stopLoss).toFixed(1)}`, S.cyan],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${S.border}55` }}>
                    <span style={{ color: S.muted2, fontSize: "9px" }}>{l}</span>
                    <span style={{ color: c, fontWeight: 600, fontSize: "10px" }}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Reset */}
              <div style={{ background: S.panel, border: `1px solid ${S.redD}44`, borderRadius: "6px", padding: "14px" }}>
                <div style={{ color: S.red, fontWeight: 700, marginBottom: "8px", fontSize: "10px", letterSpacing: "1px" }}>⚠ ZONA DE RESET</div>
                <div style={{ color: S.muted2, fontSize: "9px", marginBottom: "12px", lineHeight: 1.6 }}>
                  Borra todos los trades, señales, noticias y log. Restaura el capital a ${INIT_CAPITAL.toFixed(2)} (base inicial).
                </div>
                <Btn label="RESETEAR TODO" color={S.red} onClick={() => {
                  if (!window.confirm("¿Resetear completamente? Todos los datos se perderán.")) return;
                  setCapitalP(INIT_CAPITAL);
                  setTradesP([]);
                  setSignalsP([]);
                  setAllMarkets([]);
                  setMarketSnapshots({});
                  setNewsCache({});
                  setLogEntries([]);
                  setDailyPnl(0);
                  ["pb2_log","pb2_dpnl","pb2_markets","pb2_snap","pb2_news","pb2_daily_date"].forEach(k => { try { localStorage.removeItem(k) } catch {} });
                  addLog(`🔄 SISTEMA RESETEADO COMPLETAMENTE · Capital: $${INIT_CAPITAL.toFixed(2)} · Fecha: ${new Date().toLocaleDateString("es-CO")}`, "SYSTEM");
                }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
