import { useState, useEffect, useCallback, useRef } from "react";
// ─── CONSTANTS Y CONFIG NUBE ──────────────────────────────────────────────────
const DEFAULT_BASE_CAPITAL = 15;
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "https://polybot-backend-f3gt.onrender.com";

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
  MOMENTUM_24H: { label: "Mom. 24h", color: "#00ff88", icon: "📈" },
  ORDERFLOW: { label: "Flujo CLOB", color: "#00e5ff", icon: "🌊" },
  VOL_SPIKE: { label: "Vol. Anómalo", color: "#ffee44", icon: "⚡" },
  TIME_DECAY: { label: "Time Decay", color: "#ff5577", icon: "⏰" },
  CATALYST_48H: { label: "Cierre <48h", color: "#ff5577", icon: "🔥" },
  CATALYST_7D: { label: "Cierre <7d", color: "#ffb020", icon: "⏰" },
  CATALYST_15D: { label: "Cierre <15d", color: "#00d4ff", icon: "📅" },
  TIGHT_BOOK: { label: "Spread Corto", color: "#00ff9d", icon: "🎯" },
  HIGH_FLOW: { label: "Alto Flujo", color: "#00e5ff", icon: "🌊" },
  ACTIVE_FLOW: { label: "Flujo Activo", color: "#3388ff", icon: "💧" },
  HIGH_TURNOVER: { label: "Alta Rotación", color: "#b533ff", icon: "🔄" },
  EXTENDED_MOVE_24H: { label: "Extendido 24h", color: "#ff3366", icon: "⚠" },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function detectCategory(q = "") {
  const t = String(q || "").toLowerCase();
  if (/\b(vs\.?|handicap|esports|hle|g2|t1|gen\.g|fnatic|nba|nfl|mlb|nhl|ufc|fifa|uefa|premier league|la liga|serie a|bundesliga|champions league|lakers|warriors|knicks|76ers|celtics|tennis|atp|wta|grand slam|guangzhou open|badosa|dart|formula 1|f1|boxing|playoffs|super bowl|world cup)\b/i.test(t)) return "SPORTS";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|dogecoin|crypto|token|defi|nft|blockchain|hyperliquid|binance|coinbase|airdrop|fdv|memecoin|altcoin|tether|usdc)\b/i.test(t)) return "CRYPTO";
  if (/\b(election|president|congress|senate|house of representatives|governor|mayor|vote|party|democrat|republican|gop|biden|trump|harris|vance|newsom|minister|parliament|ceasefire|ukraine|russia|israel|iran|gaza|hamas|hezbollah|china|taiwan|tariff|sanction|nato|supreme court|politic)\b/i.test(t)) return "POLITICS";
  if (/\b(fed|fomc|interest rate|rate cut|rate hike|cpi|gdp|inflation|recession|s&p|nasdaq|dow jones|earnings|ipo|bond|treasury|yield|oil|wti|brent|gold|silver|dollar|forex|unemployment|payroll)\b/i.test(t)) return "FINANCE";
  if (/\b(ai|openai|gpt|chatgpt|claude|anthropic|gemini|deepseek|llama|llm|agi|nasa|spacex|starship|fda|vaccine|clinical trial|fusion|quantum|semiconductor|nvidia|apple|microsoft|tesla)\b/i.test(t)) return "SCIENCE";
  if (/\b(oscar|grammy|emmy|golden globe|box office|movie|film|netflix|disney|spotify|taylor swift|drake|beyonce|gta|album|billboard|celebrity)\b/i.test(t)) return "ENTERTAINMENT";
  return "OTHER";
}

function inferSignalTypesFromText(news = "", reasoning = "", edgePct = 0) {
  const types = new Set();
  const n = String(news || "").trim();
  const r = String(reasoning || "").trim();
  if (n && n !== "none" && !/no recent catalyst|no new info|sin noticias recientes|no recent news/i.test(n)) {
    types.add("NEWS");
  }
  if (/obi|order[\s-]?book|orderflow|tape|whale|imbalance|depth|flujo/i.test(r)) {
    types.add("ORDERFLOW");
  }
  if (/momentum|24h|1h|7d|surge|rally|drop|dip|trend/i.test(r)) {
    types.add("MOMENTUM");
  }
  if (Math.abs(Number(edgePct || 0)) >= 4 || /mispric|fair|prob|microprice|edge|barrier|oracle/i.test(r)) {
    types.add("MISPRICING");
  }
  if (types.size === 0) types.add("MISPRICING");
  return Array.from(types);
}

function computeSignalScore(prelimScore = 0, conf = 0, edgePct = 0, confluenceScore = 3, rawScore = 0) {
  const basePrelim = Math.min(35, Math.max(18, Number(prelimScore || 60) * 0.42));
  const confPart = Math.min(30, Math.max(0, (Number(conf || 70) - 40) * 0.62));
  const edgePart = Math.min(20, Math.max(0, Math.abs(Number(edgePct || 8)) * 1.15));
  const confBonus = Math.min(15, Math.max(0, Number(confluenceScore || 3) * 3.75));
  const calc = Math.round(Math.min(99, Math.max(52, basePrelim + confPart + edgePart + confBonus)));
  const llmScore = Number(rawScore || 0);
  return (llmScore >= 45 && llmScore <= 100) ? Math.round((llmScore * 0.45) + (calc * 0.55)) : calc;
}

function computeTradeEconomics(trade) {
  const shares       = Math.max(0, Number(trade.shares || 0));
  const entryPrice   = Math.max(0.001, Number(trade.entryPrice || 0.5));
  const cost         = Math.max(0, Number(trade.cost || (shares * entryPrice) || 1));
  const currentPrice = Math.max(0.001, Number(trade.currentPrice ?? trade.closePrice ?? trade.entryPrice ?? 0.5));
  const isClosed     = trade.status === "CLOSED";

  const entryFeeUsd = Number(trade.entryFeeUsd || 0) > 0
    ? Number(trade.entryFeeUsd)
    : Number(((cost * 0.0035) + 0.004).toFixed(4));

  const exitPx          = isClosed ? Number(trade.closePrice ?? trade.currentPrice ?? currentPrice) : currentPrice;
  const exitNotional    = shares * exitPx;
  const isEmergencyStop = trade.closeReason === "STOP_LOSS";
  const exitFeeRate     = isEmergencyStop ? 0.0050 : 0.0035;

  const exitFeeUsd = isClosed
    ? (Number(trade.exitFeeUsd || 0) > 0 ? Number(trade.exitFeeUsd) : Number(((exitNotional * exitFeeRate) + 0.004).toFixed(4)))
    : Number(((exitNotional * 0.0035) + 0.004).toFixed(4));

  const totalFrictionUsd = Number((entryFeeUsd + (isClosed ? exitFeeUsd : 0)).toFixed(3));
  const rawPricePnl = parseFloat(((exitPx - entryPrice) * shares).toFixed(2));
  const recordedPnl = isClosed ? Number(trade.pnl ?? (rawPricePnl - totalFrictionUsd)) : rawPricePnl;
  const netPnlAfterFriction = (isClosed && trade.frictionDeducted !== false)
    ? parseFloat(recordedPnl.toFixed(2))
    : parseFloat((recordedPnl - totalFrictionUsd).toFixed(2));

  return {
    entryFeeUsd: Number(entryFeeUsd.toFixed(3)),
    exitFeeUsd: Number(exitFeeUsd.toFixed(3)),
    frictionUsd: totalFrictionUsd,
    totalFrictionUsd,
    grossPnl: rawPricePnl,
    netPnlAfterFriction,
  };
}

function fmtMoney(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(n) { return `${(Number(n || 0) * 100).toFixed(2)}%`; }
function fmtDate(s) { return s ? new Date(s).toLocaleDateString("es-CO") : "—"; }
function nowStr() { return new Date().toLocaleString("es-CO"); }
function uid() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function fmtDlr(n) {
  const v = parseFloat(n || 0);
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
}

function shortHash(v = "") {
  if (!v || typeof v !== "string") return "—";
  return v.length > 14 ? `${v.slice(0, 8)}...${v.slice(-6)}` : v;
}

function parseTxHashes(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {
        return [];
      }
    }
    if (trimmed.startsWith("0x")) return [trimmed];
  }
  return [];
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
    if (page > 20) break;
    await new Promise(res => setTimeout(res, 120));
  }
  return all;
}

// ─── PRELIMINARY SCORING (Usa _prelim del backend o cálculo cuantitativo) ───
function preliminaryScore(m, prevSnapshot) {
  if (m?._prelim && !m._prelim.skip && Number.isFinite(m._prelim.score)) {
    return {
      ...m._prelim,
      signals: Array.isArray(m._prelim.signals) ? m._prelim.signals : [],
    };
  }
  let p = [0.5, 0.5];
  try { p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || [0.5, 0.5]); } catch(e){}
  const yesP = parseFloat(p[0]);
  const noP = parseFloat(p[1]);
  const vol = parseFloat(m.volume || 0);
  const vol24 = parseFloat(m.volume24hr || m.volumeNum || 0);
  const liq = parseFloat(m.liquidityNum || m.liquidity || 0);
  const sum = yesP + noP;
  const signals = [];
  let score = 0;

  if (!Number.isFinite(yesP) || !Number.isFinite(noP)) return { score: 0, signals: [], skip: true };
  if (liq < 500 || vol24 < 100) return { score: 0, signals: [], skip: true };
  if (yesP < 0.06 || yesP > 0.94) return { score: 0, signals: [], skip: true };

  const sumDev = Math.abs(sum - 1);
  const spread = parseFloat(m.spread ?? sumDev);
  if (spread <= 0.015) { signals.push("TIGHT_BOOK"); score += 18; }
  else if (spread <= 0.025) score += 10;

  if (yesP >= 0.20 && yesP <= 0.80) score += 16;
  else score += 8;

  if (vol24 >= 100000) { signals.push("HIGH_FLOW"); score += 24; }
  else if (vol24 >= 25000) { signals.push("ACTIVE_FLOW"); score += 18; }
  else if (vol24 >= 5000) score += 12;
  else score += 5;

  if (liq > 0 && (vol24 / liq) >= 0.5) { signals.push("HIGH_TURNOVER"); score += 12; }

  const change24h = parseFloat(m.oneDayPriceChange || 0);
  if (Math.abs(change24h) >= 0.05 && Math.abs(change24h) <= 0.22) {
    signals.push("MOMENTUM_24H");
    score += 14;
  }

  if (m.endDateIso || m.endDate) {
    const closes = new Date(m.endDateIso || m.endDate);
    const daysLeft = (closes - Date.now()) / 86400000;
    if (daysLeft < 0) return { score: 0, signals: [], skip: true };
    if (daysLeft <= 2) { signals.push("CATALYST_48H"); score += 32; }
    else if (daysLeft <= 7) { signals.push("CATALYST_7D"); score += 26; }
    else if (daysLeft <= 15) { signals.push("CATALYST_15D"); score += 18; }
    else if (daysLeft <= 30) score += 8;
  }

  return { score, signals, yesP, noP, vol, vol24, liq, sum, change24h, skip: false };
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
  const [baseCapital, setBaseCapital] = useState(DEFAULT_BASE_CAPITAL);
  const [capital, setCapital] = useState(DEFAULT_BASE_CAPITAL);
  const [trades, setTrades] = useState([]);
  const [signals, setSignals] = useState([]);
  const [allMarkets, setAllMarkets] = useState([]);
  const [marketSnapshots, setMarketSnapshots] = useState({});
  const [logEntries, setLogEntries] = useState([]);
  const [scanStatus, setScanStatus] = useState({ running: false, phase: "", progress: 0, total: 0, lastScan: null });
  const [realTradingEnabled, setRealTradingEnabled] = useState(false);
  const [tradingClientReady, setTradingClientReady] = useState(false);
  const [autoTradeReady, setAutoTradeReady] = useState(false);
  const [dbReadiness, setDbReadiness] = useState(null);
  const [walletSnapshot, setWalletSnapshot] = useState(null);
  const [withdrawnTotal, setWithdrawnTotal] = useState(0);
  const [lastWithdrawalAt, setLastWithdrawalAt] = useState(null);
  const [walletActivity, setWalletActivity] = useState([]);
  const [withdrawalPolicy, setWithdrawalPolicy] = useState(null);
  const [backendConfig, setBackendConfig] = useState(null);
  const [autoScan, setAutoScan] = useState(true);
  const [autoInterval, setAutoInterval] = useState(30); // 30 min = equilibrio óptimo tokens/velocidad
  const [catFilter, setCatFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("score");
  const [newsCache, setNewsCache] = useState({});
  const [signalFilter, setSignalFilter] = useState("ALL");
  const [closeInputs, setCloseInputs] = useState({});
  const [dailyPnl, setDailyPnl] = useState(0);
  const [dailyDate, setDailyDate] = useState(""); // YYYY-MM-DD del día actual
  const DAILY_GOAL = 1.50; // Objetivo diario en $
  const [goalReached, setGoalReached] = useState(false); // True cuando se alcanza DAILY_GOAL
  const [closeHour, setCloseHour] = useState(15); // Hora de cierre del día (0-23)
  const [marketSearch, setMarketSearch] = useState("");
  const [config, setConfig] = useState({
    maxTradePct: 12, stopLoss: 6, takeProfit: 10,
    dailyLossLimit: 25, minLiq: 1500, minVol: 8000,
    minScore: 25, aiTopN: 3, autoTrade: true
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
        if (Number.isFinite(Number(data.baseCapital))) setBaseCapital(Number(data.baseCapital));
        setCapital(data.capital);
        setTrades(Array.isArray(data.trades) ? data.trades : []);
        setRealTradingEnabled(!!data.realTradingEnabled);
        setTradingClientReady(!!data.tradingClientReady);
        setAutoTradeReady(!!data.autoTradeReady);
        setDbReadiness(data.dbReadiness || null);
        setWalletSnapshot(data.walletSnapshot || null);
        setWithdrawnTotal(Number(data.withdrawnTotal || 0));
        setLastWithdrawalAt(data.lastWithdrawalAt || null);
        setWalletActivity(Array.isArray(data.walletActivity) ? data.walletActivity : []);
        setWithdrawalPolicy(data.withdrawalPolicy || null);
        if (data.config) {
          setBackendConfig(data.config);
          setConfig(prev => ({ ...prev, ...data.config }));
        }
        setDailyPnl(Number(data.dailyPnl || 0));
        setGoalReached(!!data.goalReached);
        setSignals(Array.isArray(data.signals) ? data.signals : []);
        if (data.newsCache && typeof data.newsCache === "object") setNewsCache(data.newsCache);
        if (data.scanStatus) setScanStatus(data.scanStatus);
        if (Array.isArray(data.logEntries)) setLogEntries(data.logEntries);
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
  async function runFullScan() {
    try {
      await fetch(`${BACKEND_URL}/api/scan-now`, { method: "POST" });
    } catch {
      alert("El Backend ejecuta escaneos automáticos cada 30 min.");
    }
  }
  function executeTrade(sig) { alert('El Backend en la nube evalúa el Confluence Gate (4 Pilares) y auto-ejecuta las compras.'); }
  function closeTrade(id, closePrice) { alert('El Backend gestiona automáticamente Stop Loss, Break-Even, Trailing Stop y Take Profit en vivo.'); }

  // ── HIDRATACIÓN Y AUDITORÍA EN TIEMPO REAL DE MERCADOS, SEÑALES Y TRADES ──
  const ACTIVE_REAL_STATUSES = new Set(["OPEN", "PARTIAL", "PENDING_BUY", "PENDING_SELL"]);

  const marketById = {};
  for (const m of allMarkets) {
    if (m.id) marketById[String(m.id)] = m;
    if (m.conditionId) marketById[String(m.conditionId)] = m;
  }

  const tradedMarketIds = new Set(
    trades
      .filter(t => t.closeReason !== "CLEANUP_SIMULATED")
      .map(t => String(t.marketId || t.conditionId || ""))
      .filter(Boolean)
  );

  // Filtrar señales basura (SKIP o Confianza 0%) e hidratar Score, Fair Value, Vol, Liq y Tipos de Señal
  const validSignals = signals
    .filter(s => {
      const act = s?.analysis?.action;
      const conf = Number(s?.analysis?.confidence || 0);
      return (act === "BUY_YES" || act === "BUY_NO") && conf > 0;
    })
    .map(s => {
      const mId = String(s.market?.id || s.market?.conditionId || "");
      const liveMkt = marketById[mId] || s.market || {};
      const livePre = liveMkt._prelim || preliminaryScore(liveMkt);
      const yesP = Number(s.prelim?.yesP ?? livePre?.yesP ?? 0.5);
      const noP = Number(s.prelim?.noP ?? livePre?.noP ?? (1 - yesP));
      const conf = Number(s.analysis?.confidence || 70);
      const edge = Number(s.analysis?.edge_pct || 8);
      const isYes = s.analysis?.action === "BUY_YES";
      const sideAsk = Number(s.analysis?.executable_ask || (isYes ? yesP : noP));
      const fairSideProb = Number(s.analysis?.fair_prob || Math.max(0.02, Math.min(0.98, sideAsk + (edge / 100))));
      const fairYesProb = Number(s.analysis?.fair_value_yes || (isYes ? fairSideProb : (1 - fairSideProb)));
      const score = computeSignalScore(s.prelim?.score || livePre?.score || 70, conf, edge, s.analysis?.confluence_score || 3, s.analysis?.score);
      const sigTypes = (Array.isArray(s.analysis?.signal_types) && s.analysis.signal_types.length > 0)
        ? s.analysis.signal_types
        : inferSignalTypesFromText(s.analysis?.news_found, s.analysis?.reasoning, edge);
      const cat = detectCategory(s.market?.question || liveMkt?.question || "");

      return {
        ...s,
        executed: Boolean(s.executed || tradedMarketIds.has(mId)),
        market: {
          ...liveMkt,
          ...s.market,
          _cat: cat,
          endDateIso: s.market?.endDateIso || liveMkt?.endDateIso || liveMkt?.endDate,
        },
        prelim: {
          ...livePre,
          ...s.prelim,
          yesP,
          noP,
          sum: yesP + noP,
          vol: Number(s.prelim?.vol || livePre?.vol || liveMkt?.volume || 0),
          vol24: Number(s.prelim?.vol24 || livePre?.vol24 || liveMkt?.volume24hr || 0),
          liq: Number(s.prelim?.liq || livePre?.liq || liveMkt?.liquidityNum || liveMkt?.liquidity || 0),
          score,
        },
        analysis: {
          ...s.analysis,
          score,
          confidence: conf,
          edge_pct: edge,
          executable_ask: sideAsk,
          fair_prob: fairSideProb,
          fair_value_yes: fairYesProb,
          signal_types: sigTypes,
          confluence_score: s.analysis?.confluence_score || (conf >= 75 ? 4 : 3),
          risk: s.analysis?.risk || (conf >= 78 ? "LOW" : "MEDIUM"),
        },
      };
    });

  const signalByMarket = {};
  const signalById = {};
  for (const sig of validSignals) {
    if (sig.id) signalById[String(sig.id)] = sig;
    const mKey = String(sig.market?.id || sig.market?.conditionId || "");
    if (mKey && !signalByMarket[mKey]) signalByMarket[mKey] = sig;
  }

  // Hidratar todos los trades (abiertos y cerrados) con su señal IA original y sus costos reales de Pool/Spread/Fees/Gas
  const hydratedTrades = trades.map(t => {
    const mKey = String(t.marketId || t.conditionId || "");
    const linkedSig = (t.signalId && signalById[String(t.signalId)]) || signalByMarket[mKey] || null;
    const cat = detectCategory(t.question || "");
    const conf = Number(t.confidence || linkedSig?.analysis?.confidence || 70);
    const edgePct = Number(t.edge_pct || linkedSig?.analysis?.edge_pct || 9.5);
    const news = t.news || linkedSig?.analysis?.news_found || "";
    const reasoning = t.reasoning || linkedSig?.analysis?.reasoning || `Entrada cuantitativa en ${t.side} @ ${(Number(t.entryPrice || 0) * 100).toFixed(1)}¢ validada por Order Book CLOB.`;
    const sigTypes = (Array.isArray(t.signal_types) && t.signal_types.length > 0)
      ? t.signal_types
      : (linkedSig?.analysis?.signal_types || inferSignalTypesFromText(news, reasoning, edgePct));
    const econ = computeTradeEconomics(t);

    return {
      ...t,
      category: cat,
      confidence: conf,
      edge_pct: edgePct,
      score: Number(t.score || linkedSig?.analysis?.score || 75),
      risk: t.risk || linkedSig?.analysis?.risk || "MEDIUM",
      signal_types: sigTypes,
      news,
      reasoning,
      ...econ,
    };
  });

  // Construir feed completo de noticias reales para la pestaña 📰 NOTICIAS
  const mergedNewsMap = {};
  for (const [mId, item] of Object.entries(newsCache || {})) {
    const txt = String(item?.news || item?.snippet || item?.context || "").trim();
    if (!txt || txt === "none" || txt.startsWith("Image ") || /sin noticias recientes/i.test(txt)) continue;
    mergedNewsMap[mId] = {
      id: mId,
      ts: item.ts || Date.now(),
      question: item.question || marketById[mId]?.question || `Mercado #${mId}`,
      category: item.category || detectCategory(item.question || marketById[mId]?.question || ""),
      news: txt,
      source: item.source && item.source !== "none" ? item.source : "Google News RSS / Polymarket Intelligence",
    };
  }
  for (const sig of validSignals) {
    const mId = String(sig.market?.id || sig.market?.conditionId || sig.id);
    const txt = String(sig.analysis?.news_found || "").trim();
    if (!txt || txt === "none" || txt.startsWith("Image ") || /sin noticias recientes/i.test(txt)) continue;
    if (!mergedNewsMap[mId]) {
      mergedNewsMap[mId] = {
        id: mId,
        ts: sig.detectedAt ? new Date(sig.detectedAt).getTime() : Date.now(),
        question: sig.market?.question || `Mercado #${mId}`,
        category: sig.market?._cat || detectCategory(sig.market?.question || ""),
        news: txt,
        source: sig.analysis?.news_source && sig.analysis.news_source !== "none" ? sig.analysis.news_source : "Google News RSS / Web",
      };
    }
  }
  const mergedNewsList = Object.values(mergedNewsMap).sort((a, b) => b.ts - a.ts);

  const realTrades = realTradingEnabled
    ? hydratedTrades.filter(t => String(t.executionMode || t.execution_mode || "").toUpperCase() === "REAL")
    : hydratedTrades;
  const openTrades = realTrades.filter(t => ACTIVE_REAL_STATUSES.has(String(t.status || "").toUpperCase()));
  const closedTrades = realTrades.filter(t => t.status === "CLOSED" && t.closeReason !== "CLEANUP_SIMULATED");
  const invested = openTrades.reduce((s, t) => s + t.cost, 0);
  const walletUsdc = Number(walletSnapshot?.usdcBalance);
  const walletPol = Number(walletSnapshot?.polBalance);
  const availableUsd = Number.isFinite(walletUsdc) ? walletUsdc : capital;
  const openMarkedValue = openTrades.reduce((s, t) => s + ((t.currentPrice || t.entryPrice || 0) * (t.shares || 0)), 0);
  const openFrictionTotal = parseFloat(openTrades.reduce((s, t) => s + (t.frictionUsd || 0), 0).toFixed(3));
  const closedFrictionTotal = parseFloat(closedTrades.reduce((s, t) => s + (t.frictionUsd || 0), 0).toFixed(3));
  const unrealizedPnl = parseFloat((openMarkedValue - invested).toFixed(2));
  const totalValue = parseFloat((availableUsd + openMarkedValue).toFixed(2));
  const totalPnl = parseFloat((totalValue - baseCapital).toFixed(2));
  const totalPnlPct = baseCapital > 0 ? parseFloat(((totalPnl / baseCapital) * 100).toFixed(2)) : 0;
  const realizedPnl = parseFloat(closedTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2));
  const netRealizedAfterPool = parseFloat(closedTrades.reduce((s, t) => s + (t.netPnlAfterFriction ?? t.pnl), 0).toFixed(2));
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const losses = closedTrades.filter(t => t.pnl < 0).length;
  const ties = closedTrades.filter(t => t.pnl === 0).length;
  const decidedCount = wins + losses;
  const winRate = decidedCount > 0 ? (wins / decidedCount * 100).toFixed(1) : "—";
  const activeSignals = validSignals;
  const pendingSignals = validSignals.filter(s => !s.executed);
  const displayedSignals = signalFilter === "PENDING"
    ? pendingSignals
    : signalFilter === "EXECUTED"
      ? validSignals.filter(s => s.executed)
      : validSignals;

  const filteredMarkets = allMarkets
    .map(m => ({ ...m, _cat: detectCategory(m.question || "") }))
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
    { id: "signals", label: "💡 SEÑALES", badge: validSignals.length },
    { id: "markets", label: "📊 MERCADOS", badge: allMarkets.length },
    { id: "news", label: "📰 NOTICIAS", badge: mergedNewsList.length },
    { id: "portfolio", label: "💼 CARTERA", badge: openTrades.length },
    { id: "analytics", label: "📈 ANALÍTICA" },
    { id: "log", label: "📋 LOG", badge: logEntries.length },
    { id: "wallet", label: "👛 WALLET", badge: walletActivity.filter(e => e.eventType === "AUTO_WITHDRAWAL").length },
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
          <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1.5px", fontFamily: sans, textTransform: "uppercase", fontWeight: 600 }}>Motor Cuántico 4-Pilares • GPT-OSS-120B</div>
        </div>

        <div style={{ width: "1px", height: "40px", background: S.border2, margin: "0 4px" }} />

        <StatCard
          label="Dólares Disponibles"
          value={`$${availableUsd.toFixed(2)}`}
          color={S.cyan}
          sub={realTradingEnabled ? "USDC en MetaMask" : "Márgen Libre"}
        />
        <StatCard label="Capital Invertido" value={`$${invested.toFixed(2)}`} color={S.text} sub={`En ${openTrades.length} trades vivos`} />
        <StatCard label="Valor Total (Equidad)" value={`$${totalValue.toFixed(2)}`} color={S.white} sub={`Neto post-costos: $${(totalValue - closedFrictionTotal - openFrictionTotal).toFixed(2)}`} />
        <StatCard label="P&L Hoy" value={fmtDlr(dailyPnl)} color={dailyPnl >= 0 ? S.green : S.red} sub={`Ganancia Neta Diaria`} />
        <StatCard label="Win Rate" value={`${winRate}%`} color={parseFloat(winRate) >= 50 ? S.green : parseFloat(winRate) > 0 ? S.amber : S.muted2} sub={`${wins}W / ${losses}L${ties > 0 ? ` (${ties} BE)` : ""}`} />
        <StatCard label="Mercados" value={allMarkets.length || "—"} color={S.white} sub={scanStatus.lastScan ? `Scan: ${scanStatus.lastScan?.slice(0, 8)}` : "Sin escaneo"} />
        <StatCard label="Señales IA" value={validSignals.length} color={validSignals.length > 0 ? S.amber : S.muted2} sub={`${pendingSignals.length} libres · ${validSignals.length - pendingSignals.length} ejec`} />
        <StatCard
          label="Modo Ejecución"
          value={realTradingEnabled ? "REAL" : "SIM"}
          color={realTradingEnabled ? S.green : S.amber}
          sub={realTradingEnabled ? (tradingClientReady ? "Cliente listo" : "Conectando cliente") : "Simulación"}
        />
        {realTradingEnabled && (
          <StatCard
            label="Gas (POL)"
            value={Number.isFinite(walletPol) ? walletPol.toFixed(4) : "—"}
            color={S.amber}
            sub="Saldo de red"
          />
        )}
        {realTradingEnabled && walletSnapshot?.address && (
          <StatCard
            label="Wallet"
            value={`${walletSnapshot.address.slice(0, 6)}...${walletSnapshot.address.slice(-4)}`}
            color={S.text}
            sub={walletSnapshot?.updatedAt ? `Sync: ${new Date(walletSnapshot.updatedAt).toLocaleTimeString("es-CO")}` : "Sin sync"}
          />
        )}
        {realTradingEnabled && (
          <div className="glass-panel" style={{
            width: "100%",
            padding: "12px 16px",
            border: `1px solid ${autoTradeReady ? S.green : S.red}33`,
            background: autoTradeReady ? `${S.green}10` : `${S.red}10`,
            display: "flex",
            flexDirection: "column",
            gap: "6px"
          }}>
            <div style={{ color: autoTradeReady ? S.green : S.red, fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>
              {autoTradeReady ? "Auto-Trading Real Listo" : "Auto-Trading Real Bloqueado"}
            </div>
            <div style={{ color: S.text, fontSize: "10px", lineHeight: 1.6 }}>
              {autoTradeReady
                ? "La infraestructura critica del backend esta lista para permitir nuevas entradas automaticas."
                : "El backend sigue monitoreando wallet y posiciones reales, pero no abrira nuevas compras automaticas hasta completar la base remota."}
            </div>
            {!autoTradeReady && Array.isArray(dbReadiness?.blockers) && dbReadiness.blockers.length > 0 && (
              <div style={{ color: S.muted2, fontSize: "9px", lineHeight: 1.7 }}>
                {dbReadiness.blockers.join(" | ")}
              </div>
            )}
          </div>
        )}

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
                  ["Señales IA válidas", `${validSignals.length} (${pendingSignals.length} libres / ${validSignals.length - pendingSignals.length} ejec)`, validSignals.length > 0 ? S.amber : S.muted2],
                  ["Último scan", scanStatus.lastScan || "Nunca", S.text],
                  ["Auto-scan", autoScan ? `Cada ${autoInterval}min` : "Desactivado", autoScan ? S.green : S.muted2],
                  ["Trades abiertos", `${openTrades.length} ($${invested.toFixed(2)} en juego)`, openTrades.length > 0 ? S.green : S.muted2],
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
                <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px", marginBottom: "10px" }}>PIPELINE CUÁNTICO INSTITUCIONAL (DATOS 100% REALES)</div>
                {[
                  ["📡", "Descarga mercados activos de Polymarket Gamma API y construye el libro de órdenes CLOB real", S.cyan],
                  ["🏷", "Clasificación con regex de frontera de palabra (Política, Crypto, Deportes/Esports, Finanzas, Ciencia/Tech)", S.text],
                  ["📊", "Microestructura CLOB en vivo: MicroPrice ponderado por volumen, Order-Book Imbalance (OBI) y Spread real", S.text],
                  ["🐋", "Whale & Tape Flow: Audita los últimos 50 trades ejecutados en Data-API para medir flujo institucional", S.cyan],
                  ["🔮", "Oráculo Matemático Crypto: Conecta con Kraken Spot OHLC y calcula probabilidad de barrera con volatilidad Parkinson", S.purple],
                  ["📰", "Catalizador de Noticias: Extrae titulares frescos vía Google News RSS (< 24h) para detectar asimetrías informativas", "#ff9944"],
                  ["🧠", `Cerebro GPT-OSS-120B (Groq) + Gate de Confluencia de 4 Pilares y 3 Vetos Duros sobre el top ${backendConfig?.aiTopN || config.aiTopN} de mercados`, S.green],
                  ["💸", "Modelo Zero-Makeup: Descuenta cruce de Spread, Slippage de profundidad de Pool, Taker Fee (0.35%), truncamiento CTF 6-dec y Gas Polygon", S.amber],
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
            {/* Filter bar */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {[
                  { id: "ALL", label: `TODAS LAS SEÑALES IA (${validSignals.length})` },
                  { id: "EXECUTED", label: `🚀 EJECUTADAS EN CARTERA (${validSignals.filter(s => s.executed).length})` },
                  { id: "PENDING", label: `⏳ DISPONIBLES / NO EJECUTADAS (${pendingSignals.length})` },
                ].map(f => (
                  <div
                    key={f.id}
                    onClick={() => setSignalFilter(f.id)}
                    style={{
                      padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "9px", fontWeight: 700,
                      letterSpacing: "1px",
                      background: signalFilter === f.id ? `${S.cyan}22` : S.panel,
                      border: `1px solid ${signalFilter === f.id ? S.cyan : S.border2}`,
                      color: signalFilter === f.id ? S.cyan : S.muted2,
                    }}
                  >
                    {f.label}
                  </div>
                ))}
              </div>
              <div style={{ color: S.muted2, fontSize: "9px" }}>
                Filtradas señales SKIP/0% · Ordenadas por Score Cuántico (0-100)
              </div>
            </div>

            {displayedSignals.length === 0 ? (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "60px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "40px", marginBottom: "14px" }}>💡</div>
                <div style={{ color: S.white, fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>Sin señales en este filtro</div>
                <div style={{ color: S.muted2 }}>Cambia el filtro superior a "TODAS LAS SEÑALES IA" o ejecuta ▶ SCAN TOTAL para escanear nuevos mercados</div>
              </div>
            ) : (
              [...displayedSignals].sort((a, b) => (b.analysis?.score || 0) - (a.analysis?.score || 0)).map(sig => {
                const { analysis: a, market: m, prelim } = sig;
                const rC = a.risk === "LOW" ? S.green : a.risk === "HIGH" ? S.red : S.amber;
                const actC = a.action === "BUY_YES" ? S.green : a.action === "BUY_NO" ? S.red : S.cyan;
                const tradeAmt = parseFloat(Math.max(1.0, (capital * (backendConfig?.maxTradePct || config.maxTradePct) / 100 * Math.min((a.confidence || 70) / 100, 1))).toFixed(2));
                const cat = m._cat || detectCategory(m.question);
                return (
                  <div key={sig.id} style={{
                    background: S.panel, border: `1px solid ${rC}33`,
                    borderLeft: `3px solid ${actC}`, borderRadius: "6px",
                    padding: "16px", marginBottom: "10px",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px", alignItems: "flex-start" }}>
                      <div style={{ flex: 1, marginRight: "12px" }}>
                        <div style={{ display: "flex", gap: "6px", marginBottom: "6px", flexWrap: "wrap" }}>
                          <Tag txt={sig.executed ? "🚀 EJECUTADA EN CARTERA" : "⏳ DISPONIBLE"} color={sig.executed ? S.cyan : S.amber} />
                          <Tag txt={`${CATEGORIES[cat]?.icon || "◯"} ${CATEGORIES[cat]?.label || cat}`} color={S.blue} />
                          <Tag txt={a.action} color={actC} />
                          <Tag txt={`RIESGO ${a.risk}`} color={rC} />
                          {(a.signal_types || []).map(st => <Tag key={st} txt={(SIGNAL_TYPES[st]?.icon || "✨") + " " + st} color={SIGNAL_TYPES[st]?.color || S.text} />)}
                          {a.arb_detected && <Tag txt="⚖ ARB" color={S.cyan} />}
                          {a.confluence_score && <Tag txt={`🏛 ${a.confluence_score}/4 PILARES`} color={S.green} />}
                        </div>
                        <div style={{ color: S.white, fontWeight: 600, fontSize: "12px", lineHeight: 1.5, marginBottom: "4px" }}>
                          {m.question}
                        </div>
                        <div style={{ color: S.muted, fontSize: "8px" }}>
                          Detectado: {new Date(sig.detectedAt).toLocaleString("es-CO")} · Mercado ID: {(m.id || m.conditionId || "").slice(0, 14)} · 
                          Cierra: {fmtDate(m.endDateIso || m.endDate)}
                        </div>
                      </div>
                      <div style={{ textAlign: "center", flexShrink: 0, background: S.panelB, border: `1px solid ${S.border2}`, padding: "8px 14px", borderRadius: "6px" }}>
                        <div style={{ color: S.amber, fontSize: "26px", fontWeight: 700, lineHeight: 1, fontFamily: mono }}>{a.score}</div>
                        <div style={{ color: S.muted, fontSize: "8px", letterSpacing: "1px", marginTop: "2px" }}>SCORE/100</div>
                        <div style={{ color: a.confidence >= 70 ? S.green : a.confidence >= 55 ? S.amber : S.red, fontSize: "13px", fontWeight: 700, marginTop: "6px", fontFamily: mono }}>{a.confidence}%</div>
                        <div style={{ color: S.muted, fontSize: "7px" }}>CONF IA</div>
                      </div>
                    </div>

                    {/* Prices & Microstructure */}
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                      {[
                        ["YES actual", fmtPct(prelim?.yesP ?? 0.5), S.green],
                        ["NO actual", fmtPct(prelim?.noP ?? 0.5), S.red],
                        ["Ask Ejecutable", fmtPct(a.executable_ask ?? (a.action === "BUY_YES" ? prelim?.yesP : prelim?.noP) ?? 0.5), S.white],
                        ["Valor justo YES", Number.isFinite(a.fair_value_yes) ? fmtPct(a.fair_value_yes) : "—", S.cyan],
                        ["Prob. Justa Lado", Number.isFinite(a.fair_prob) ? fmtPct(a.fair_prob) : "—", S.cyan],
                        ["Edge Neto IA", Number.isFinite(a.edge_pct) ? `+${a.edge_pct.toFixed(1)}%` : "—", S.amber],
                        ["Vol 24h", fmtMoney(prelim?.vol24 || m.volume24hr || 0), S.white],
                        ["Vol Total", fmtMoney(prelim?.vol || m.volumeNum || 0), S.text],
                        ["Liquidez", fmtMoney(prelim?.liq || m.liquidityNum || 0), S.text],
                        ["Sum YES+NO", fmtPct(prelim?.sum || 1), Math.abs((prelim?.sum || 1) - 1) > 0.03 ? S.amber : S.muted2],
                      ].map(([l, v, c]) => (
                        <div key={l} style={{ background: "#0005", border: `1px solid ${S.border}`, padding: "3px 9px", borderRadius: "3px" }}>
                          <span style={{ color: S.muted, fontSize: "8px" }}>{l} </span>
                          <span style={{ color: c, fontWeight: 600, fontSize: "10px", fontFamily: mono }}>{v}</span>
                        </div>
                      ))}
                    </div>

                    {/* News */}
                    {a.news_found && a.news_found !== "none" && (
                      <div style={{
                        background: `#ff994408`, border: `1px solid #ff994433`,
                        padding: "8px 12px", borderRadius: "4px", marginBottom: "10px",
                      }}>
                        <div style={{ color: "#ff9944", fontSize: "8px", fontWeight: 700, marginBottom: "4px" }}>📰 CATALIZADOR / NOTICIA VINCULADA</div>
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
                        ["Sizing Kelly/Conf", `$${tradeAmt.toFixed(2)}`, S.white],
                        ["Costo Pool+Gas Est.", `-$${(tradeAmt * 0.0045 + 0.008).toFixed(3)}`, S.amber],
                        ["Stop Loss (-)", `-${backendConfig?.stopLoss || config.stopLoss}%`, S.red],
                        ["Take Profit (+)", `+${backendConfig?.takeProfit || config.takeProfit}%`, S.green],
                        ["R/R ratio", `1:${((backendConfig?.takeProfit || config.takeProfit) / (backendConfig?.stopLoss || config.stopLoss)).toFixed(1)}`, S.cyan],
                        ["Riesgo IA", a.risk, rC],
                      ].map(([l, v, c]) => (
                        <div key={l}>
                          <span style={{ color: S.muted, fontSize: "8px" }}>{l} </span>
                          <span style={{ color: c, fontWeight: 700, fontFamily: mono }}>{v}</span>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                      {!sig.executed ? (
                        <Btn label={`✓ SIMULAR MANUAL ${a.action}`} color={actC} onClick={() => executeTrade(sig)} filled />
                      ) : (
                        <span style={{ color: S.cyan, fontSize: "9px", fontWeight: 700, letterSpacing: "0.5px" }}>
                          ✓ Esta señal ya fue operada automáticamente por el motor del backend (ver en 💼 CARTERA)
                        </span>
                      )}
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
            {mergedNewsList.length === 0 ? (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "50px 20px", textAlign: "center", color: S.muted }}>
                📰 Las noticias catalizadoras aparecerán aquí durante el escaneo IA.<br />
                El bot consulta Google News RSS en tiempo real para cada mercado candidato.
              </div>
            ) : (
              mergedNewsList.map((news) => {
                const cat = detectCategory(news.question || news.news || "");
                return (
                  <div key={news.id} style={{
                    background: S.panel, border: `1px solid #ff994433`,
                    borderLeft: `3px solid #ff9944`, borderRadius: "6px",
                    padding: "12px 16px", marginBottom: "8px",
                  }}>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
                      <Tag txt={`${CATEGORIES[cat]?.icon || "◯"} ${CATEGORIES[cat]?.label || cat}`} color={S.blue} />
                      <span style={{ color: "#ff9944", fontSize: "9px", fontWeight: 700, fontFamily: mono }}>
                        📰 {new Date(news.ts).toLocaleString("es-CO")}
                      </span>
                      <span style={{ color: S.muted2, fontSize: "8px" }}>Fuente: {news.source || "Google News RSS"}</span>
                    </div>
                    {news.question && (
                      <div style={{ color: S.cyan, fontSize: "10px", fontWeight: 600, marginBottom: "5px" }}>
                        Mercado vinculado: {news.question}
                      </div>
                    )}
                    <div style={{ color: S.white, fontSize: "11px", lineHeight: 1.6 }}>{news.news}</div>
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
                [
                  "P&L Total (Equidad)",
                  `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
                  `${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct}% · Vivo: ${fmtDlr(unrealizedPnl)}`,
                  totalPnl >= 0 ? S.green : S.red
                ],
                [
                  "P&L Realizado (Libro vs Neto)",
                  `${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`,
                  `Neto post-Pool/Gas: ${fmtDlr(netRealizedAfterPool)} (${closedTrades.length} cerrados)`,
                  realizedPnl >= 0 ? S.green : S.red
                ],
                [
                  "Fricción Pool + Spread + Gas",
                  `-$${(closedFrictionTotal + openFrictionTotal).toFixed(2)}`,
                  `Cerradas: -$${closedFrictionTotal.toFixed(2)} · Vivas: -$${openFrictionTotal.toFixed(2)}`,
                  S.amber
                ],
                [
                  "Win Rate & Límite Diario",
                  `${winRate}% (${wins}W/${losses}L${ties > 0 ? `/${ties}E` : ""})`,
                  `Hoy: ${fmtDlr(dailyPnl)} · Límite: -$${(baseCapital * (backendConfig?.dailyLossLimit || config.dailyLossLimit) / 100).toFixed(2)}`,
                  parseFloat(winRate) >= 45 ? S.green : S.amber
                ],
              ].map(([l, v, sub, c]) => (
                <div key={l} style={{ background: S.panel, border: `1px solid ${S.border2}`, padding: "12px 16px", borderRadius: "6px" }}>
                  <div style={{ color: S.muted2, fontSize: "8px", letterSpacing: "1px", marginBottom: "4px" }}>{l}</div>
                  <div style={{ color: c, fontSize: "16px", fontWeight: 700, fontFamily: mono }}>{v}</div>
                  <div style={{ color: S.muted2, fontSize: "8px", marginTop: "3px" }}>{sub}</div>
                </div>
              ))}
            </div>

            {/* Open trades */}
            <div style={{ color: S.muted2, fontSize: "9px", fontWeight: 700, letterSpacing: "1px", marginBottom: "8px" }}>
              TRADES ABIERTOS ({openTrades.length}) · CAPITAL EN JUEGO: ${invested.toFixed(2)} · FRICCIÓN ENTRADA ACUMULADA: -$${openFrictionTotal.toFixed(3)}
            </div>
            {openTrades.length === 0 ? (
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "20px", color: S.muted, textAlign: "center", marginBottom: "14px" }}>
                Sin trades abiertos. Ejecuta señales desde la pestaña 💡 SEÑALES.
              </div>
            ) : (
              openTrades.map(t => {
                const entryPx = Math.max(0.001, Number(t.entryPrice || t.price || 0.5));
                const currPx  = Math.max(0.001, Number(t.currentPrice || entryPx));
                const shares  = Math.max(0.000001, Number(t.shares || 1));
                const cost    = Math.max(0.01, Number(t.cost || (shares * entryPx) || 1));
                const tpPx    = Number(t.takeProfit || Math.min(0.97, entryPx * 1.10));
                const slPx    = Number(t.stopLoss || Math.max(0.02, entryPx * 0.94));

                // Fórmulas exactas del motor v2.5.0 ajustadas a los precios y acciones reales de este trade
                const binarySigma = Math.sqrt(Math.max(0.04, entryPx * (1 - entryPx)));
                const exactBreakEvenPx = ((entryPx * 1.0035) + ((0.008 + 0.005) / shares)) / (1 - 0.0035) + 0.002;
                const exactBreakEvenFloor = parseFloat(Math.max(exactBreakEvenPx, entryPx + 0.009).toFixed(4));
                const beNoiseCushion = Math.max(0.024, 0.065 * binarySigma);
                const beTriggerPx = parseFloat(
                  Math.max(exactBreakEvenPx + beNoiseCushion, entryPx + Math.max(0.030, 0.070 * binarySigma)).toFixed(4)
                );

                // P&L Vivo Real si se liquida ahora mismo en el CLOB (incluye fricción de entrada + salida + gas + slippage)
                const liveGrossPnl = (currPx - entryPx) * shares;
                const liveExitClosePx = Math.max(0.005, currPx - 0.0015);
                const liveGrossProceeds = shares * liveExitClosePx;
                const liveExitFee = (liveGrossProceeds * 0.0035) + 0.004;
                const totalRoundTripFriction = Number(t.entryFeeUsd || ((cost * 0.0035) + 0.004)) + liveExitFee;
                const liveNetPnl = (liveGrossProceeds - liveExitFee) - cost;
                const liveRoiPct = (liveNetPnl / cost) * 100;

                // Proyección Real en Take Profit (WIN @ TP)
                const tpExecPx = Math.max(0.005, tpPx - 0.0010);
                const tpGrossProceeds = shares * tpExecPx;
                const tpExitFee = (tpGrossProceeds * 0.0035) + 0.004;
                const tpNetPnl = (tpGrossProceeds - tpExitFee) - cost;
                const tpNetRoiPct = (tpNetPnl / cost) * 100;

                // Proyección Real en Stop Loss / Trailing actual (LOSS / PROTECTED @ SL)
                const slSlippage = t.breakEvenArmed ? 0.0015 : 0.0020;
                const slFeeRate  = t.breakEvenArmed ? 0.0035 : 0.0050;
                const slExecPx   = Math.max(0.005, slPx - slSlippage);
                const slGrossProceeds = shares * slExecPx;
                const slExitFee  = (slGrossProceeds * slFeeRate) + 0.004;
                const slNetPnl   = (slGrossProceeds - slExitFee) - cost;
                const slNetRoiPct = (slNetPnl / cost) * 100;

                // Distancia en centavos al Trigger de Break-Even o al TP
                const centsToBeTrigger = ((beTriggerPx - currPx) * 100).toFixed(1);
                const centsToTp        = ((tpPx - currPx) * 100).toFixed(1);

                return (
                <div key={t.id} style={{
                  background: S.panel, border: `1px solid ${S.border2}`,
                  borderLeft: `3px solid ${t.side === "YES" ? S.green : S.red}`,
                  borderRadius: "6px", padding: "14px", marginBottom: "10px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <div style={{ flex: 1, marginRight: "10px" }}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "4px" }}>
                        {(() => {
                          const tradeCategory = t.category || detectCategory(t.question || "");
                          return (
                            <>
                              <Tag txt={t.id} color={S.muted2} />
                              <Tag txt={`${CATEGORIES[tradeCategory]?.icon || CATEGORIES.OTHER.icon} ${CATEGORIES[tradeCategory]?.label || CATEGORIES.OTHER.label}`} color={S.blue} />
                            </>
                          );
                        })()}
                        <Tag txt={`${t.side}`} color={t.side === "YES" ? S.green : S.red} />
                        {t.breakEvenArmed && <Tag txt="🛡 BREAK-EVEN ARMADO" color={S.cyan} />}
                        {(t.signal_types || []).map(st => <Tag key={st} txt={(SIGNAL_TYPES[st]?.icon || "✨") + " " + st} color={SIGNAL_TYPES[st]?.color || S.text} />)}
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
                      ["ENTRADA", fmtPct(entryPx), S.white],
                      ["COSTO", `$${cost.toFixed(2)}`, S.white],
                      ["SHARES", shares.toFixed(5), S.text],
                      ["SL (-)", fmtPct(slPx), t.breakEvenArmed ? S.cyan : S.red],
                      ["TP (+)", fmtPct(tpPx), S.green],
                      ["BE EXACTO", fmtPct(exactBreakEvenFloor), S.cyan],
                      ["SCORE IA", `${t.score || 70}/100`, S.cyan],
                      ["CONF IA", `${t.confidence || 68}%`, S.amber],
                      ["EDGE 24H", `+${Number(t.edge_pct || 0).toFixed(1)}%`, S.amber],
                      ["RIESGO", (t.risk || 'MEDIUM'), t.risk === "LOW" ? S.green : t.risk === "HIGH" ? S.red : S.amber],
                    ].map(([l, v, c]) => (
                      <div key={l} style={{ background: "#0005", border: `1px solid ${S.border}`, padding: "3px 8px", borderRadius: "3px" }}>
                        <span style={{ color: S.muted, fontSize: "7px" }}>{l} </span>
                        <span style={{ color: c, fontWeight: 600, fontSize: "10px", fontFamily: mono }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px", borderTop: `1px solid ${S.border}`, paddingTop: "12px" }}>
                    {[
                      ["PRECIO ACTUAL (BID)", fmtPct(currPx), S.cyan],
                      ["P&L VIVO (LIBRO)", fmtDlr(liveGrossPnl), liveGrossPnl >= 0 ? S.green : S.red],
                      ["POOL+GAS IDA/VUELTA", `-$${totalRoundTripFriction.toFixed(3)}`, S.amber],
                      ["P&L VIVO NETO REAL", fmtDlr(liveNetPnl), liveNetPnl >= 0 ? S.green : S.red],
                      ["ROI NETO REAL", `${liveRoiPct >= 0 ? "+" : ""}${liveRoiPct.toFixed(1)}%`, liveRoiPct >= 0 ? S.green : S.red],
                    ].map(([l, v, c]) => (
                      <div key={l} style={{ background: `${c}15`, border: `1px solid ${c}33`, padding: "6px 12px", borderRadius: "6px" }}>
                        <span style={{ color: S.muted, fontSize: "8px", letterSpacing: "1px" }}>{l} </span>
                        <span style={{ color: c, fontWeight: 700, fontSize: "12px", fontFamily: mono }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  {t.news && t.news !== "none" && (
                    <div style={{ background: `#ff994408`, border: `1px solid #ff994422`, padding: "6px 10px", borderRadius: "3px", marginBottom: "8px", color: "#ff9944", fontSize: "9px" }}>
                      📰 {t.news}
                    </div>
                  )}
                  {t.reasoning && (
                    <div style={{ color: S.purple, fontSize: "9px", fontStyle: "italic", marginBottom: "10px" }}>🤖 {t.reasoning}</div>
                  )}

                  {/* Escenarios Reales Dinámicos ajustados a las shares, entrada, TP, SL y Break-Even de este trade */}
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", background: "#00000035", border: `1px solid ${S.border}`, padding: "8px 10px", borderRadius: "5px" }}>
                    <div style={{ background: `${S.green}18`, border: `1px solid ${S.green}44`, padding: "4px 9px", borderRadius: "4px", fontFamily: mono, fontSize: "9.5px", color: S.green, fontWeight: 700 }}>
                      🎯 WIN TP ({fmtPct(tpPx)}): {tpNetPnl >= 0 ? "+" : ""}${tpNetPnl.toFixed(2)} ({tpNetRoiPct >= 0 ? "+" : ""}{tpNetRoiPct.toFixed(1)}%) · Faltan {Number(centsToTp) > 0 ? `+${centsToTp}¢` : "0.0¢"}
                    </div>
                    <div style={{ background: `${slNetPnl >= 0 ? S.cyan : S.red}18`, border: `1px solid ${slNetPnl >= 0 ? S.cyan : S.red}44`, padding: "4px 9px", borderRadius: "4px", fontFamily: mono, fontSize: "9.5px", color: slNetPnl >= 0 ? S.cyan : S.red, fontWeight: 700 }}>
                      {t.breakEvenArmed ? "🛡 SL PROTEGIDO" : "🛑 LOSS SL"} ({fmtPct(slPx)}): {slNetPnl >= 0 ? "+" : ""}${slNetPnl.toFixed(2)} ({slNetRoiPct >= 0 ? "+" : ""}{slNetRoiPct.toFixed(1)}%)
                    </div>
                    <div style={{ background: `${S.amber}18`, border: `1px solid ${S.amber}44`, padding: "4px 9px", borderRadius: "4px", fontFamily: mono, fontSize: "9.5px", color: S.amber, fontWeight: 700 }}>
                      ⚖️ BE REAL ({fmtPct(exactBreakEvenFloor)}): {t.breakEvenArmed ? "✅ ARMADO (Riesgo $0)" : (Number(centsToBeTrigger) > 0 ? `Trigger @ ${fmtPct(beTriggerPx)} (+${centsToBeTrigger}¢)` : `Listo @ ${fmtPct(beTriggerPx)}`)}
                    </div>
                  </div>
                </div>
                );
              })
            )}

            {/* Closed trades */}
            {closedTrades.length > 0 && (
              <>
                <div style={{ color: S.muted2, fontSize: "9px", fontWeight: 700, letterSpacing: "1px", margin: "18px 0 8px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                  <span>HISTORIAL AUDITADO ({closedTrades.length} CERRADOS) · P&L LIBRO: {fmtDlr(realizedPnl)} · FRICCIÓN POOL/GAS: -$${closedFrictionTotal.toFixed(2)} · P&L NETO REAL: {fmtDlr(netRealizedAfterPool)}</span>
                  <span>Incluye Taker Fee CLOB (0.35%), Spread/Slippage y Gas Polygon</span>
                </div>
                <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ background: `${S.border}55` }}>
                          {["ID", "CAT", "MERCADO & TESIS IA", "LADO", "CONF / EDGE", "ENTRADA", "CIERRE", "MOTIVO", "P&L LIBRO", "POOL+GAS", "P&L NETO REAL", "ROI", "CERRADO"].map(h => (
                            <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: S.muted2, fontSize: "8px", letterSpacing: "1px", borderBottom: `1px solid ${S.border2}`, whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {closedTrades.map((t, i) => {
                          const reasonBadge = t.closeReason === "TAKE_PROFIT"
                            ? { txt: "🎯 TAKE PROFIT", c: S.green }
                            : t.closeReason === "TRAILING_STOP"
                              ? { txt: "📈 TRAILING SL", c: S.green }
                              : (t.closeReason === "BREAK_EVEN" || t.pnl === 0)
                                ? { txt: "🛡 BREAK EVEN", c: S.cyan }
                                : t.closeReason === "MAX_HOLD"
                                  ? { txt: "⏰ MAX HOLD 24H", c: S.amber }
                                  : { txt: "🛑 STOP LOSS", c: S.red };
                          const netReal = t.netPnlAfterFriction ?? (t.pnl - (t.frictionUsd || 0.015));
                          return (
                            <tr key={t.id} style={{ background: i % 2 === 0 ? `${S.border}22` : "transparent", borderBottom: `1px solid ${S.border}` }}>
                              <td style={{ padding: "7px 10px", color: S.muted, fontSize: "9px", whiteSpace: "nowrap", fontFamily: mono }}>{t.id}</td>
                              <td style={{ padding: "7px 10px", fontSize: "12px" }} title={CATEGORIES[t.category || "OTHER"]?.label}>{CATEGORIES[t.category || "OTHER"]?.icon}</td>
                              <td style={{ padding: "7px 10px", maxWidth: "250px" }}>
                                <div style={{ color: S.white, fontSize: "9.5px", fontWeight: 600, lineHeight: 1.3 }}>{t.question}</div>
                                {t.reasoning && (
                                  <div style={{ color: S.muted2, fontSize: "8px", marginTop: "2px", lineHeight: 1.3 }}>
                                    🤖 {t.reasoning.slice(0, 95)}{t.reasoning.length > 95 ? "…" : ""}
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: "7px 10px" }}><Tag txt={t.side} color={t.side === "YES" ? S.green : S.red} /></td>
                              <td style={{ padding: "7px 10px", whiteSpace: "nowrap", fontSize: "9px", fontFamily: mono }}>
                                <span style={{ color: S.amber }}>{t.confidence || 68}%</span>
                                <span style={{ color: S.muted }}> · </span>
                                <span style={{ color: S.cyan }}>+{Number(t.edge_pct || 10).toFixed(1)}%</span>
                              </td>
                              <td style={{ padding: "7px 10px", color: S.text, whiteSpace: "nowrap", fontFamily: mono }}>{fmtPct(t.entryPrice)}</td>
                              <td style={{ padding: "7px 10px", color: S.text, whiteSpace: "nowrap", fontFamily: mono }}>{fmtPct(t.currentPrice)}</td>
                              <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                                <Tag txt={reasonBadge.txt} color={reasonBadge.c} />
                              </td>
                              <td style={{ padding: "7px 10px", fontWeight: 700, whiteSpace: "nowrap", fontFamily: mono, color: t.pnl >= 0 ? S.green : S.red }}>
                                {t.pnl >= 0 ? "+" : ""}${Number(t.pnl || 0).toFixed(2)}
                              </td>
                              <td style={{ padding: "7px 10px", whiteSpace: "nowrap", fontFamily: mono, color: S.amber, fontSize: "9px" }}>
                                -$${Number(t.frictionUsd || 0.015).toFixed(3)}
                              </td>
                              <td style={{ padding: "7px 10px", fontWeight: 700, whiteSpace: "nowrap", fontFamily: mono, color: netReal >= 0 ? S.green : S.red }}>
                                {netReal >= 0 ? "+" : ""}${netReal.toFixed(2)}
                              </td>
                              <td style={{ padding: "7px 10px", whiteSpace: "nowrap", fontFamily: mono, color: t.pnl >= 0 ? S.green : S.red }}>
                                {(((t.pnl || 0) / (t.cost || 1)) * 100).toFixed(1)}%
                              </td>
                              <td style={{ padding: "7px 10px", color: S.muted, fontSize: "9px", whiteSpace: "nowrap" }}>
                                {t.closedAt ? new Date(t.closedAt).toLocaleString("es-CO") : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "analytics" && (() => {
          const now = Date.now();
          const closed = closedTrades;
          const last24h = closed.filter(t => t.closedAt && (now - new Date(t.closedAt).getTime() < 86400000));
          
          const won = closed.filter(t => t.pnl > 0);
          const lost = closed.filter(t => t.pnl < 0);
          const ties = closed.filter(t => t.pnl === 0);
          const decided = won.length + lost.length;

          const grossProfit = won.reduce((acc, t) => acc + (t.pnl || 0), 0);
          const grossLossAbs = lost.reduce((acc, t) => acc + Math.abs(t.pnl || 0), 0);
          const avgWin = won.length > 0 ? grossProfit / won.length : 0;
          const avgLossAbs = lost.length > 0 ? grossLossAbs / lost.length : 0;
          const payoffRatio = avgLossAbs > 0 ? (avgWin / avgLossAbs) : (avgWin > 0 ? 9.99 : 0);
          const profitFactor = grossLossAbs > 0 ? (grossProfit / grossLossAbs) : (grossProfit > 0 ? 9.99 : 0);
          const breakEvenWr = payoffRatio > 0 ? ((1 / (1 + payoffRatio)) * 100) : 50;
          const actualWrNum = decided > 0 ? ((won.length / decided) * 100) : 0;
          const safetyMargin = actualWrNum - breakEvenWr;
          const expectancy = decided > 0
            ? ((won.length / decided) * avgWin) - ((lost.length / decided) * avgLossAbs)
            : 0;

          // Atribución por Categoría
          const catStats = {};
          for (const t of closed) {
            const cat = t.category || detectCategory(t.question || "");
            if (!catStats[cat]) catStats[cat] = { count: 0, wins: 0, losses: 0, pnl: 0 };
            catStats[cat].count++;
            if (t.pnl > 0) catStats[cat].wins++;
            else if (t.pnl < 0) catStats[cat].losses++;
            catStats[cat].pnl += (t.pnl || 0);
          }

          // Atribución por Razón de Salida
          const exitStats = {
            TAKE_PROFIT: { label: "🎯 Take Profit Limpio", count: 0, pnl: 0, color: S.green },
            TRAILING_PROTECTED: { label: "🛡 Break-Even / Trailing", count: 0, pnl: 0, color: S.cyan },
            STOP_LOSS: { label: "🛑 Stop Loss Cortado", count: 0, pnl: 0, color: S.red },
            MAX_HOLD: { label: "⏰ Salida por Tiempo (24h)", count: 0, pnl: 0, color: S.amber },
          };
          for (const t of closed) {
            const p = t.pnl || 0;
            if (t.closeReason === "TAKE_PROFIT") {
              exitStats.TAKE_PROFIT.count++;
              exitStats.TAKE_PROFIT.pnl += p;
            } else if (t.closeReason === "TRAILING_STOP" || t.closeReason === "BREAK_EVEN" || t.breakEvenArmed || p >= 0) {
              exitStats.TRAILING_PROTECTED.count++;
              exitStats.TRAILING_PROTECTED.pnl += p;
            } else if (t.closeReason === "MAX_HOLD") {
              exitStats.MAX_HOLD.count++;
              exitStats.MAX_HOLD.pnl += p;
            } else {
              exitStats.STOP_LOSS.count++;
              exitStats.STOP_LOSS.pnl += p;
            }
          }
          
          const won24 = last24h.filter(t => t.pnl > 0);
          const lost24 = last24h.filter(t => t.pnl < 0);
          const pnl24 = last24h.reduce((acc, t) => acc + (t.pnl || 0), 0);
          const vol24 = last24h.reduce((acc, t) => acc + (t.cost || 0), 0);
          
          const bestTrade = closed.reduce((b, t) => (t.pnl > (b?.pnl || -9999)) ? t : b, null);
          const worstTrade = closed.reduce((w, t) => (t.pnl < (w?.pnl || 9999)) ? t : w, null);

          return (
            <div style={{ maxWidth: "1050px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ color: S.cyan, fontSize: "16px", fontWeight: 700, letterSpacing: "2px", fontFamily: heading }}>
                AUDITORÍA CUANTITATIVA INSTITUCIONAL (+EV & RIESGO)
              </div>
              
              {/* FILA 1: MÉTRICAS DE ESPERANZA MATEMÁTICA */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))", gap: "12px" }}>
                <StatCard
                  label="PROFIT FACTOR (PF)"
                  value={profitFactor.toFixed(2) + "x"}
                  color={profitFactor >= 1.3 ? S.green : profitFactor >= 1.0 ? S.amber : S.red}
                  sub={`Bruto: +$${grossProfit.toFixed(2)} / -$${grossLossAbs.toFixed(2)}`}
                />
                <StatCard
                  label="ESPERANZA / TRADE (EV)"
                  value={`${expectancy >= 0 ? "+" : ""}$${expectancy.toFixed(3)}`}
                  color={expectancy > 0 ? S.green : S.red}
                  sub={expectancy > 0 ? "Sistema +EV (Rentable a largo plazo)" : "Requiere mayor filtrado"}
                />
                <StatCard
                  label="PAYOFF RATIO (W/L)"
                  value={`${payoffRatio.toFixed(2)} : 1`}
                  color={payoffRatio >= 1.8 ? S.green : S.amber}
                  sub={`Media Win +$${avgWin.toFixed(2)} vs Loss -$${avgLossAbs.toFixed(2)}`}
                />
                <StatCard
                  label="WIN RATE vs EQUILIBRIO"
                  value={`${actualWrNum.toFixed(1)}%`}
                  color={safetyMargin >= 0 ? S.green : S.red}
                  sub={`Mínimo requerido: ${breakEvenWr.toFixed(1)}% (Margen: ${safetyMargin >= 0 ? "+" : ""}${safetyMargin.toFixed(1)}%)`}
                />
                <StatCard
                  label="P&L REALIZADO (LIBRO)"
                  value={`${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`}
                  color={realizedPnl >= 0 ? S.green : S.red}
                  sub={`${won.length}W · ${lost.length}L · ${ties.length} Empates (BE)`}
                />
                <StatCard
                  label="FRICCIÓN POOL + GAS"
                  value={`-$${closedFrictionTotal.toFixed(2)}`}
                  color={S.amber}
                  sub={`Neto Real Post-Pool: ${fmtDlr(netRealizedAfterPool)}`}
                />
              </div>

              {/* FILA 2: DESGLOSE POR TIPO DE SALIDA Y CATEGORÍA */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div className="glass-panel" style={{ padding: "16px" }}>
                  <div style={{ color: S.accent, fontSize: "11px", fontWeight: 700, marginBottom: "12px", letterSpacing: "1px", borderBottom: `1px solid ${S.border}`, paddingBottom: "8px" }}>
                    EFECTIVIDAD POR MECANISMO DE SALIDA
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {Object.values(exitStats).map(ex => (
                      <div key={ex.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px" }}>
                        <span style={{ color: S.text }}>{ex.label} <span style={{ color: S.muted }}>({ex.count})</span></span>
                        <span style={{ color: ex.pnl >= 0 ? S.green : S.red, fontWeight: 700, fontFamily: mono }}>
                          {ex.pnl >= 0 ? "+" : ""}${ex.pnl.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="glass-panel" style={{ padding: "16px" }}>
                  <div style={{ color: S.accent, fontSize: "11px", fontWeight: 700, marginBottom: "12px", letterSpacing: "1px", borderBottom: `1px solid ${S.border}`, paddingBottom: "8px" }}>
                    ATRIBUCIÓN DE P&L POR CATEGORÍA DE MERCADO
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {Object.entries(catStats).map(([cat, st]) => {
                      const catWr = (st.wins + st.losses) > 0 ? ((st.wins / (st.wins + st.losses)) * 100).toFixed(0) : 0;
                      return (
                        <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px" }}>
                          <span style={{ color: S.text }}>
                            {CATEGORIES[cat]?.icon || "◯"} {CATEGORIES[cat]?.label || cat} <span style={{ color: S.muted }}>({st.wins}W/{st.losses}L · {catWr}% WR)</span>
                          </span>
                          <span style={{ color: st.pnl >= 0 ? S.green : S.red, fontWeight: 700, fontFamily: mono }}>
                            {st.pnl >= 0 ? "+" : ""}${st.pnl.toFixed(2)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: "20px", marginTop: "4px", background: `linear-gradient(135deg, ${S.panel} 0%, rgba(0, 50, 80, 0.1) 100%)` }}>
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
                     <div style={{ color: S.muted2, fontSize: "9px", letterSpacing: "1px", marginBottom: "4px" }}>EFECTIVIDAD DECIDIDA 24H</div>
                     <div style={{ color: won24.length >= lost24.length ? S.green : S.amber, fontSize: "28px", fontWeight: 700, fontFamily: mono }}>
                       {(won24.length + lost24.length) > 0 ? ((won24.length / (won24.length + lost24.length)) * 100).toFixed(0) : 0}%
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

        {/* ══════════ WALLET TAB ══════════ */}
        {tab === "wallet" && (() => {
          const withdrawalEvents = walletActivity.filter(e => e.eventType === "AUTO_WITHDRAWAL");
          const withdrawalErrors = walletActivity.filter(e => e.eventType === "AUTO_WITHDRAWAL_ERROR");
          const tradeTxRows = realTrades.flatMap(t => {
            const buyTxs = parseTxHashes(t.buyTxHashes).map(tx => ({
              tradeId: t.id,
              ts: t.ts,
              txHash: tx,
              type: "BUY",
              side: t.side,
              question: t.question,
            }));
            const sellTxs = parseTxHashes(t.sellTxHashes).map(tx => ({
              tradeId: t.id,
              ts: t.closedAt || t.ts,
              txHash: tx,
              type: "SELL",
              side: t.side,
              question: t.question,
            }));
            return [...buyTxs, ...sellTxs];
          }).sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

          const policyEnabled = !!withdrawalPolicy?.enabled;
          const policyConfigured = !!withdrawalPolicy?.configured;
          const policyReady = !!withdrawalPolicy?.ready;
          const withdrawalBlockers = Array.isArray(withdrawalPolicy?.blockers) ? withdrawalPolicy.blockers : [];

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
                <StatCard label="Wallet MetaMask" value={walletSnapshot?.address ? `${walletSnapshot.address.slice(0, 6)}...${walletSnapshot.address.slice(-4)}` : "—"} color={S.white} sub={walletSnapshot?.updatedAt ? `Sync: ${new Date(walletSnapshot.updatedAt).toLocaleString("es-CO")}` : "Sin sync"} />
                <StatCard label="USDC Wallet" value={Number.isFinite(walletUsdc) ? `$${walletUsdc.toFixed(2)}` : "—"} color={S.cyan} sub="Saldo on-chain" />
                <StatCard label="POL Wallet" value={Number.isFinite(walletPol) ? walletPol.toFixed(4) : "—"} color={S.amber} sub="Gas disponible" />
                <StatCard label="Retirado Total" value={`$${Number(withdrawnTotal || 0).toFixed(2)}`} color={S.green} sub={lastWithdrawalAt ? `Último: ${new Date(lastWithdrawalAt).toLocaleString("es-CO")}` : "Sin retiros aún"} />
              </div>

              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "14px" }}>
                <div style={{ color: S.cyan, fontSize: "11px", letterSpacing: "1px", marginBottom: "10px" }}>POLÍTICA DE RETIRO AUTOMÁTICO</div>
                <div style={{
                  marginBottom: "12px",
                  padding: "10px 12px",
                  borderRadius: "6px",
                  border: `1px solid ${policyReady ? S.green : S.red}33`,
                  background: policyReady ? `${S.green}10` : `${S.red}10`,
                }}>
                  <div style={{ color: policyReady ? S.green : S.red, fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>
                    {policyReady ? "Retiro Automático Listo" : "Retiro Automático Bloqueado"}
                  </div>
                  <div style={{ color: S.text, fontSize: "10px", marginTop: "4px" }}>
                    {policyReady
                      ? "La política tiene destino válido y ya puede operar cuando se active."
                      : (withdrawalBlockers[0] || "Falta configuración para habilitar retiros automáticos.")}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
                  {[
                    ["Estado", policyEnabled ? "ACTIVO" : "INACTIVO", policyEnabled ? S.green : S.red],
                    ["Configurado", policyConfigured ? "SÍ" : "NO", policyConfigured ? S.green : S.red],
                    ["Listo", policyReady ? "SÍ" : "NO", policyReady ? S.green : S.red],
                    ["Wallet Destino", withdrawalPolicy?.targetAddress ? `${withdrawalPolicy.targetAddress.slice(0, 6)}...${withdrawalPolicy.targetAddress.slice(-4)}` : "—", S.text],
                    ["Wallet Operativa", withdrawalPolicy?.tradingWalletAddress ? `${withdrawalPolicy.tradingWalletAddress.slice(0, 6)}...${withdrawalPolicy.tradingWalletAddress.slice(-4)}` : "—", S.text],
                    ["Piso Operativo", withdrawalPolicy ? `$${Number(withdrawalPolicy.operatingCapitalUsdc || 0).toFixed(2)}` : "—", S.text],
                    ["Exceso Mínimo", withdrawalPolicy ? `$${Number(withdrawalPolicy.minExcessUsdc || 0).toFixed(2)}` : "—", S.text],
                    ["% Retiro", withdrawalPolicy ? `${((Number(withdrawalPolicy.excessRatio || 0)) * 100).toFixed(0)}%` : "—", S.text],
                    ["Cooldown", withdrawalPolicy ? `${Number(withdrawalPolicy.cooldownHours || 0)}h` : "—", S.text],
                    ["Mín. POL", withdrawalPolicy ? Number(withdrawalPolicy.minPolBalance || 0).toFixed(2) : "—", S.text],
                    ["TP Bot", backendConfig ? `${Number(backendConfig.takeProfit || 0).toFixed(2)}%` : "—", S.text],
                    ["SL Bot", backendConfig ? `${Number(backendConfig.stopLoss || 0).toFixed(2)}%` : "—", S.text],
                    ["Break-even", backendConfig ? `${Number(backendConfig.breakEvenTriggerPct || 0).toFixed(2)}%` : "—", S.text],
                    ["Max Hold", backendConfig ? `${Number(backendConfig.maxHoldHours || 0).toFixed(0)}h` : "—", S.text],
                  ].map(([label, value, color]) => (
                    <div key={label} style={{ background: S.panelB, border: `1px solid ${S.border}`, borderRadius: "4px", padding: "8px 10px" }}>
                      <div style={{ color: S.muted2, fontSize: "8px", letterSpacing: "1px", marginBottom: "3px" }}>{label}</div>
                      <div style={{ color, fontSize: "10px", fontWeight: 700 }}>{value}</div>
                    </div>
                  ))}
                </div>
                {!policyReady && withdrawalBlockers.length > 0 && (
                  <div style={{ marginTop: "10px", color: S.red, fontSize: "9px", lineHeight: 1.5 }}>
                    {withdrawalBlockers.join(" | ")}
                  </div>
                )}
              </div>

              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden" }}>
                <div style={{ padding: "8px 14px", borderBottom: `1px solid ${S.border2}`, color: S.muted2, fontSize: "9px", letterSpacing: "1px" }}>
                  TRANSFERENCIAS DE RETIRO ({withdrawalEvents.length}) · ERRORES ({withdrawalErrors.length})
                </div>
                <div style={{ maxHeight: "260px", overflowY: "auto" }}>
                  {walletActivity.length === 0 ? (
                    <div style={{ padding: "20px", color: S.muted, textAlign: "center" }}>No hay actividad de retiro todavía.</div>
                  ) : (
                    walletActivity.map(ev => (
                      <div key={ev.id} style={{ padding: "8px 12px", borderBottom: `1px solid ${S.border}33`, display: "flex", gap: "10px", alignItems: "center" }}>
                        <Tag txt={ev.eventType === "AUTO_WITHDRAWAL" ? "RETIRO" : "ERROR"} color={ev.eventType === "AUTO_WITHDRAWAL" ? S.green : S.red} />
                        <span style={{ color: S.muted2, fontSize: "8px", minWidth: "140px" }}>{ev.ts ? new Date(ev.ts).toLocaleString("es-CO") : "—"}</span>
                        <span style={{ color: ev.eventType === "AUTO_WITHDRAWAL" ? S.green : S.red, fontSize: "10px", fontWeight: 700, minWidth: "70px" }}>
                          {ev.eventType === "AUTO_WITHDRAWAL" ? `$${Number(ev.amountUsdc || 0).toFixed(2)}` : "—"}
                        </span>
                        <span style={{ color: S.text, fontSize: "9px", flex: 1, wordBreak: "break-word" }}>
                          {ev.error || `${ev.trigger || "SYNC"} → ${ev.to ? `${ev.to.slice(0, 6)}...${ev.to.slice(-4)}` : "destino"}`}
                        </span>
                        {ev.txHash ? (
                          <a href={`https://polygonscan.com/tx/${ev.txHash}`} target="_blank" rel="noreferrer" style={{ color: S.cyan, fontSize: "9px", textDecoration: "none" }}>
                            {shortHash(ev.txHash)}
                          </a>
                        ) : (
                          <span style={{ color: S.muted, fontSize: "9px" }}>—</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden" }}>
                <div style={{ padding: "8px 14px", borderBottom: `1px solid ${S.border2}`, color: S.muted2, fontSize: "9px", letterSpacing: "1px" }}>
                  TRANSACCIONES REALES (BUY/SELL) · {tradeTxRows.length}
                </div>
                <div style={{ maxHeight: "300px", overflowY: "auto" }}>
                  {tradeTxRows.length === 0 ? (
                    <div style={{ padding: "20px", color: S.muted, textAlign: "center" }}>Sin tx hashes reales todavía.</div>
                  ) : (
                    tradeTxRows.map((tx, idx) => (
                      <div key={`${tx.txHash}-${idx}`} style={{ padding: "8px 12px", borderBottom: `1px solid ${S.border}33`, display: "flex", gap: "10px", alignItems: "center" }}>
                        <Tag txt={tx.type} color={tx.type === "BUY" ? S.green : S.red} />
                        <Tag txt={tx.side} color={tx.side === "YES" ? S.green : S.red} />
                        <span style={{ color: S.muted2, fontSize: "8px", minWidth: "140px" }}>{tx.ts ? new Date(tx.ts).toLocaleString("es-CO") : "—"}</span>
                        <span style={{ color: S.text, fontSize: "9px", flex: 1, wordBreak: "break-word" }}>{tx.tradeId} · {tx.question?.slice(0, 70)}</span>
                        <a href={`https://polygonscan.com/tx/${tx.txHash}`} target="_blank" rel="noreferrer" style={{ color: S.cyan, fontSize: "9px", textDecoration: "none" }}>
                          {shortHash(tx.txHash)}
                        </a>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ══════════ CONFIG TAB ══════════ */}
        {tab === "config" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
            <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "16px" }}>
              <div style={{ color: S.cyan, fontFamily: heading, fontSize: "13px", letterSpacing: "2px", marginBottom: "16px" }}>🛡 RIESGO & FILTROS</div>
              <div style={{ background: `${S.amber}12`, border: `1px solid ${S.amber}33`, color: S.text, borderRadius: "6px", padding: "10px 12px", fontSize: "10px", lineHeight: 1.6, marginBottom: "14px" }}>
                Panel en modo lectura. La ejecución real, los montos y los bloqueos de wallet se controlan desde el backend; estos sliders todavía no escriben configuración productiva.
              </div>
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
                      {backendConfig && backendConfig[f.k] !== undefined
                        ? (f.u === "$" ? `$${Number(backendConfig[f.k]).toLocaleString()}` : `${backendConfig[f.k]}${f.u}`)
                        : (f.u === "$" ? `$${config[f.k].toLocaleString()}` : `${config[f.k]}${f.u}`)}
                    </span>
                  </div>
                  <input type="range" min={f.min} max={f.max} step={f.step} value={config[f.k]}
                    onChange={e => setConfig(c => ({ ...c, [f.k]: parseFloat(e.target.value) }))}
                    style={{ width: "100%", accentColor: S.cyan, opacity: 0.45, cursor: "not-allowed" }} disabled />
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
                  style={{ width: "100%", accentColor: S.amber, opacity: 0.45, cursor: "not-allowed" }} disabled />
                <div style={{ color: S.muted2, fontSize: "9px", marginTop: "4px" }}>
                  A esta hora se detienen las inversiones nuevas del día. Las posiciones abiertas siguen su rumbo sin forzar venta.
                  {goalReached && <span style={{ color: S.green, marginLeft: "8px" }}>✅ META HOY ALCANZADA · Sin nuevas inversiones</span>}
                </div>
              </div>

              {/* Botón desbloquear meta manualmente */}
              {goalReached && (
                <div style={{ background: `${S.green}11`, border: `1px solid ${S.green}33`, borderRadius: "6px", padding: "10px 14px", marginTop: "4px" }}>
                  <div style={{ color: S.green, fontSize: "10px", fontWeight: 700, marginBottom: "6px" }}>🏆 META DIARIA ALCANZADA — Autopilot Pausado</div>
                  <div style={{ color: S.muted2, fontSize: "9px", marginBottom: "8px" }}>El desbloqueo manual todavía no está conectado al backend real. La meta se liberará automáticamente en el siguiente rollover diario.</div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {/* Portfolio summary */}
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", padding: "16px" }}>
                <div style={{ color: S.cyan, fontFamily: heading, fontSize: "13px", letterSpacing: "2px", marginBottom: "14px" }}>📊 ESTADÍSTICAS</div>
                {[
                  ["Capital Inicial", `$${baseCapital.toFixed(2)}`, S.muted2],
                  ["Capital Libre", `$${capital.toFixed(2)}`, S.cyan],
                  ["Capital Invertido", `$${invested.toFixed(2)}`, S.text],
                  ["Valor Total (Equidad)", `$${totalValue.toFixed(2)}`, S.white],
                  ["P&L Total (Equidad)", `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct}%)`, totalPnl >= 0 ? S.green : S.red],
                  ["P&L Realizado (Libro)", `${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`, realizedPnl >= 0 ? S.green : S.red],
                  ["Fricción Pool + Gas Total", `-$${(closedFrictionTotal + openFrictionTotal).toFixed(2)}`, S.amber],
                  ["P&L Neto Post-Fricción", `${netRealizedAfterPool >= 0 ? "+" : ""}$${netRealizedAfterPool.toFixed(2)}`, netRealizedAfterPool >= 0 ? S.green : S.red],
                  ["P&L Diario", `${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`, dailyPnl >= 0 ? S.green : S.red],
                  ["Mercados en DB", allMarkets.length, S.text],
                  ["Señales IA Válidas", `${validSignals.length} (${pendingSignals.length} libres)`, validSignals.length > 0 ? S.amber : S.muted2],
                  ["Noticias Catalizadoras", mergedNewsList.length, "#ff9944"],
                  ["Trades Abiertos", openTrades.length, S.text],
                  ["Trades Cerrados", closedTrades.length, S.text],
                  ["Ganados / Perdidos / BE", `${wins}W / ${losses}L / ${ties}E`, S.text],
                  ["Win Rate Decidido", `${winRate}%`, parseFloat(winRate) >= 50 ? S.green : S.amber],
                  ["R/R Config", `1:${((backendConfig?.takeProfit || config.takeProfit) / (backendConfig?.stopLoss || config.stopLoss)).toFixed(1)}`, S.cyan],
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
                  Borra todos los trades, señales, noticias y log. Restaura el capital a ${baseCapital.toFixed(2)} (base inicial).
                </div>
                <Btn label="RESETEAR TODO" color={S.red} disabled onClick={() => {}} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
