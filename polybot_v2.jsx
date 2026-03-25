import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const INIT_CAPITAL = 10000;
const API_POLY = "https://gamma-api.polymarket.com/markets";
const API_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_API_KEY = "";

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
  const yesP = parseFloat(m.outcomePrices?.[0] ?? 0.5);
  const noP = parseFloat(m.outcomePrices?.[1] ?? 0.5);
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

  // 6. Time decay (closes in <7 days but >1 day)
  if (m.endDateIso || m.endDate) {
    const closes = new Date(m.endDateIso || m.endDate);
    const daysLeft = (closes - Date.now()) / 86400000;
    if (daysLeft > 0 && daysLeft < 7) { signals.push("TIME_DECAY"); score += 15; }
    else if (daysLeft > 0 && daysLeft < 30) score += 5;
    if (daysLeft < 0) return { score: 0, signals: [], skip: true }; // closed
  }

  return { score, signals, yesP, noP, vol, liq, sum, skip: false };
}

// ─── DEEP AI ANALYSIS (Groq Llama 3) ──────────────────────────────────
async function deepAnalyze(m, prelim) {
  const { yesP, noP, vol, liq, sum } = prelim;

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a quantitative prediction market analyst specializing in Polymarket. 
Your job is to find a real edge based on logic, volume, prices, and math. 
Return ONLY raw JSON. No markdown. No backticks. No preamble.`
      },
      {
        role: "user",
        content: `Analyze this Polymarket prediction market for trading edge TODAY (${new Date().toISOString().slice(0, 10)}):

QUESTION: "${m.question}"
YES price: ${fmtPct(yesP)} | NO price: ${fmtPct(noP)}
YES+NO sum: ${fmtPct(sum)} ${Math.abs(sum - 1) > 0.03 ? "⚠️ ARB SIGNAL" : ""}
Total volume: ${fmtMoney(vol)} | Liquidity: ${fmtMoney(liq)}
Closes: ${fmtDate(m.endDateIso || m.endDate)}
Preliminary signals: ${prelim.signals.join(", ") || "none"}

INSTRUCTIONS:
1. Assess the mathematical and logical probabilities based strictly on the provided data.
2. Determine if the current YES/NO prices indicate a mispricing or momentum opportunity.
3. If the YES+NO sum deviates significantly from 100%, flag it as ARB.

Return this exact JSON format:
{
  "action": "BUY_YES" | "BUY_NO" | "SKIP",
  "confidence": <number 0-100>,
  "fair_value_yes": <number 0.00-1.00>,
  "edge_pct": <number>,
  "signal_types": ["MISPRICING","MOMENTUM","ARB","VOL_SPIKE","TIME_DECAY"],
  "news_found": "none",
  "news_source": "none",
  "reasoning": "<Detailed explanation of the math/logic edge identified>",
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "arb_detected": <boolean>,
  "liquidity_ok": <boolean>,
  "score": <number 0-100>
}`
      }
    ],
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  const r = await fetch(API_GROQ, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify(body),
  });
  
  if (!r.ok) {
    const err = await r.json();
    throw new Error(`Groq API error: ${err.error?.message || r.status}`);
  }
  
  const data = await r.json();
  const txt = data.choices[0]?.message?.content || "{}";

  const clean = txt.replace(/```[\w]*\n?|```/g, "").trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");
  return JSON.parse(jsonMatch[0]);
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  bg: "#08090b",
  panel: "#0d1117",
  panelB: "#131a22",
  border: "#1a2634",
  border2: "#243344",
  cyan: "#29d9ff",
  cyanD: "#0099bb",
  green: "#00f5a0",
  greenD: "#009960",
  red: "#ff3366",
  redD: "#991133",
  amber: "#ffb020",
  purple: "#cc88ff",
  blue: "#4488ff",
  text: "#7fa8c0",
  white: "#d8eaf5",
  muted: "#2e4a5e",
  muted2: "#4a7090",
  accent: "#29d9ff",
};

function Tag({ txt, color }) {
  return (
    <span style={{
      background: `${color}18`, border: `1px solid ${color}44`,
      color, padding: "1px 7px", borderRadius: "2px",
      fontSize: "8px", fontWeight: 800, letterSpacing: "1.5px",
      display: "inline-block", whiteSpace: "nowrap",
    }}>{txt}</span>
  );
}

function Btn({ label, color = S.cyan, onClick, disabled, filled, sm }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: filled ? color : "transparent",
      border: `1px solid ${disabled ? S.muted : color}`,
      color: filled ? S.bg : disabled ? S.muted : color,
      padding: sm ? "3px 9px" : "6px 14px",
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: sm ? "8px" : "9px",
      fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
      borderRadius: "3px", letterSpacing: "1px",
      transition: "all 0.15s", whiteSpace: "nowrap",
    }}>{label}</button>
  );
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{
      background: S.panel, border: `1px solid ${S.border2}`,
      padding: "8px 14px", borderRadius: "4px", minWidth: "100px",
    }}>
      <div style={{ color: S.muted2, fontSize: "8px", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: "3px" }}>{label}</div>
      <div style={{ color: color || S.white, fontSize: "14px", fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: S.muted2, fontSize: "8px", marginTop: "3px" }}>{sub}</div>}
    </div>
  );
}

const logC = { SYSTEM: S.cyan, AI: S.purple, OPPORTUNITY: S.amber, TRADE: S.green, WIN: S.green, LOSS: S.red, ERROR: S.red, RISK: S.red, NEWS: "#ff9944", SCAN: S.blue, INFO: S.text, FILTER: S.cyan };

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
  const [autoScan, setAutoScan] = useState(false);
  const [autoInterval, setAutoInterval] = useState(15);
  const [catFilter, setCatFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("score");
  const [newsCache, setNewsCache] = useState({});
  const [closeInputs, setCloseInputs] = useState({});
  const [dailyPnl, setDailyPnl] = useState(0);
  const [marketSearch, setMarketSearch] = useState("");
  const [config, setConfig] = useState({
    maxTradePct: 2, stopLoss: 6, takeProfit: 18,
    dailyLossLimit: 10, minLiq: 300, minVol: 1000,
    minScore: 40, aiTopN: 8,
  });
  const autoRef = useRef(null);
  const scanningRef = useRef(false);

  // ── Load persisted state ──
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Oswald:wght@600;700&display=swap";
    document.head.appendChild(link);

    (async () => {
      try {
        const keys = ["pb2_capital","pb2_trades","pb2_signals","pb2_log","pb2_snap","pb2_news","pb2_dpnl","pb2_markets"];
        const [cap, tr, sig, lg, snap, news, dpnl, mkt] = keys.map(k => {
          try { return localStorage.getItem(k); } catch { return null; }
        });
        if (cap) setCapital(parseFloat(cap));
        if (tr) setTrades(JSON.parse(tr));
        if (sig) setSignals(JSON.parse(sig));
        if (lg) setLogEntries(JSON.parse(lg));
        if (snap) setMarketSnapshots(JSON.parse(snap));
        if (news) setNewsCache(JSON.parse(news));
        if (dpnl) setDailyPnl(parseFloat(dpnl));
        if (mkt) setAllMarkets(JSON.parse(mkt));
      } catch {}
    })();
  }, []);

  // ── Persist helpers ──
  const persist = useCallback((key, val) => {
    try { localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val)); } catch {}
  }, []);

  const setCapitalP = v => { setCapital(v); persist("pb2_capital", String(v)); };
  const setTradesP = v => { setTrades(v); persist("pb2_trades", v); };
  const setSignalsP = v => { setSignals(v); persist("pb2_signals", v); };

  const addLog = useCallback((msg, type = "INFO") => {
    const e = { id: uid(), ts: new Date().toISOString(), msg, type };
    setLogEntries(prev => {
      const next = [e, ...prev].slice(0, 2000);
      persist("pb2_log", next);
      return next;
    });
  }, [persist]);

  // ── Auto-scan ──
  useEffect(() => {
    if (autoRef.current) clearInterval(autoRef.current);
    if (autoScan) {
      autoRef.current = setInterval(() => { if (!scanningRef.current) runFullScan(); }, autoInterval * 60 * 1000);
    }
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [autoScan, autoInterval]);

  // ── MAIN SCAN ──
  async function runFullScan() {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanStatus({ running: true, phase: "Conectando con Polymarket…", progress: 0, total: 0, lastScan: null });
    addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "SYSTEM");
    addLog(`🚀 ESCANEO COMPLETO INICIADO · ${nowStr()}`, "SYSTEM");
    addLog(`   Fuente: gamma-api.polymarket.com (TODOS los mercados activos)`, "SYSTEM");
    addLog(`   IA: Claude ${CLAUDE_MODEL} + Web Search (noticias reales)`, "SYSTEM");

    try {
      // ── FASE 1: Fetch ALL markets ──
      setScanStatus(s => ({ ...s, phase: "Descargando todos los mercados…" }));
      const raw = await fetchAllMarkets(msg => {
        setScanStatus(s => ({ ...s, phase: msg }));
        addLog(`   📡 ${msg}`, "SCAN");
      });

      addLog(`✅ DESCARGA COMPLETA: ${raw.length} mercados activos en Polymarket hoy`, "SCAN");
      setScanStatus(s => ({ ...s, total: raw.length }));

      // Enrich with category
      const enriched = raw.map(m => ({ ...m, _cat: detectCategory(m.question) }));
      setAllMarkets(enriched);
      persist("pb2_markets", enriched);

      // Category breakdown
      const catCount = {};
      enriched.forEach(m => { catCount[m._cat] = (catCount[m._cat] || 0) + 1; });
      addLog(`   📊 Categorías: ${Object.entries(catCount).map(([k,v]) => `${CATEGORIES[k]?.icon}${k}:${v}`).join(" · ")}`, "SCAN");

      // ── FASE 2: Preliminary scoring ──
      setScanStatus(s => ({ ...s, phase: "Scoring preliminar (sin IA)…" }));
      addLog(`🔢 FASE 2: Scoring preliminar (${enriched.length} mercados)…`, "SCAN");

      const prevSnap = marketSnapshots;
      const newSnap = {};
      const scored = [];

      for (const m of enriched) {
        const id = m.id || m.conditionId;
        const pre = preliminaryScore(m, prevSnap[id]);
        if (!pre.skip && pre.score >= config.minScore) {
          scored.push({ m, pre });
        }
        newSnap[id] = { yesP: pre.yesP, noP: pre.noP, ts: Date.now() };
      }

      setMarketSnapshots(newSnap);
      persist("pb2_snap", newSnap);

      // Filter by liquidity/volume config
      const viable = scored
        .filter(({ pre }) => pre.liq >= config.minLiq && pre.vol >= config.minVol)
        .sort((a, b) => b.pre.score - a.pre.score);

      addLog(`✅ SCORING: ${viable.length}/${enriched.length} mercados superan filtros (score≥${config.minScore}, liq≥${fmtMoney(config.minLiq)}, vol≥${fmtMoney(config.minVol)})`, "FILTER");

      // Log ARB findings
      const arbList = viable.filter(({ pre }) => pre.signals.includes("ARB"));
      if (arbList.length > 0) {
        addLog(`⚖ ARBITRAJE MATEMÁTICO: ${arbList.length} mercados con YES+NO≠100%`, "OPPORTUNITY");
        arbList.slice(0, 5).forEach(({ m, pre }) => {
          addLog(`   ↳ "${m.question?.slice(0, 60)}" | sum=${fmtPct(pre.sum)} | liq=${fmtMoney(pre.liq)}`, "OPPORTUNITY");
        });
      }

      // ── FASE 3: Deep AI analysis ──
      const topN = viable.slice(0, config.aiTopN);
      setScanStatus(s => ({ ...s, phase: `Análisis IA profundo (${topN.length} mercados top)…` }));
      addLog(`🤖 FASE 3: ANÁLISIS IA PROFUNDO con Web Search → ${topN.length} mercados top`, "AI");
      addLog(`   (busca noticias reales, polls, eventos actuales para cada mercado)`, "AI");

      const newSignals = [];

      for (let i = 0; i < topN.length; i++) {
        const { m, pre } = topN[i];
        setScanStatus(s => ({ ...s, phase: `IA ${i + 1}/${topN.length}: ${m.question?.slice(0, 45)}…`, progress: Math.round((i / topN.length) * 100) }));
        addLog(`   [${i + 1}/${topN.length}] 🔍 Buscando noticias + analizando: "${m.question?.slice(0, 65)}"`, "AI");

        try {
          const analysis = await deepAnalyze(m, pre);

          // Cache news
          if (analysis.news_found && analysis.news_found !== "none") {
            const nc = { ...newsCache };
            nc[m.id || m.conditionId] = { news: analysis.news_found, source: analysis.news_source, ts: Date.now() };
            setNewsCache(nc);
            persist("pb2_news", nc);
            addLog(`   📰 NOTICIA: ${analysis.news_found?.slice(0, 100)}`, "NEWS");
            if (analysis.news_source) addLog(`      Fuente: ${analysis.news_source}`, "NEWS");
          }

          if (analysis.action !== "SKIP" && analysis.score >= 40) {
            const sig = {
              id: uid(),
              detectedAt: new Date().toISOString(),
              market: m,
              prelim: pre,
              analysis,
              executed: false,
            };
            newSignals.push(sig);
            addLog(`   ✨ SEÑAL DETECTADA: [${analysis.action}] score:${analysis.score} conf:${analysis.confidence}% edge:${analysis.edge_pct?.toFixed(1)}% | ${analysis.signal_types?.join(",")}`, "OPPORTUNITY");
            addLog(`      💡 ${analysis.reasoning?.slice(0, 120)}`, "OPPORTUNITY");
          } else {
            addLog(`   ⏭ Sin ventaja clara: ${analysis.reasoning?.slice(0, 80)}`, "INFO");
          }
        } catch (e) {
          addLog(`   ❌ Error IA en "${m.question?.slice(0, 40)}": ${e.message}`, "ERROR");
        }

        await new Promise(res => setTimeout(res, 200));
      }

      // Merge with existing, deduplicate by marketId
      const existingIds = new Set(signals.filter(s => !s.executed).map(s => s.market?.id || s.market?.conditionId));
      const fresh = newSignals.filter(s => !existingIds.has(s.market?.id || s.market?.conditionId));
      const merged = [...fresh, ...signals].slice(0, 100);
      setSignalsP(merged);

      const ts = nowStr();
      setScanStatus({ running: false, phase: "Completado", progress: 100, total: raw.length, lastScan: ts });
      addLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "SYSTEM");
      addLog(`✅ ESCANEO COMPLETADO · ${ts}`, "SYSTEM");
      addLog(`   ${raw.length} mercados escaneados · ${viable.length} con potencial · ${newSignals.length} señales nuevas`, "SYSTEM");

      if (newSignals.length > 0) setTab("signals");
      else setTab("markets");

    } catch (e) {
      addLog(`❌ ERROR CRÍTICO DE ESCANEO: ${e.message}`, "ERROR");
      setScanStatus(s => ({ ...s, running: false, phase: `Error: ${e.message}` }));
    } finally {
      scanningRef.current = false;
    }
  }

  // ── Execute trade ──
  function executeTrade(sig) {
    const { analysis, market } = sig;
    if (dailyPnl < -(INIT_CAPITAL * config.dailyLossLimit / 100)) {
      addLog(`🛑 BLOQUEADO: Límite pérdida diaria (-${config.dailyLossLimit}%) alcanzado. Trade cancelado.`, "RISK");
      return;
    }
    const maxAmt = capital * (config.maxTradePct / 100);
    const confMult = Math.min((analysis.confidence || 60) / 100, 1);
    const amt = parseFloat((maxAmt * confMult).toFixed(2));
    if (amt < 0.5) { addLog("⚠ Capital insuficiente.", "RISK"); return; }

    const isYes = analysis.action === "BUY_YES";
    const yesP = parseFloat(market.outcomePrices?.[0] ?? 0.5);
    const noP = parseFloat(market.outcomePrices?.[1] ?? 0.5);
    const entry = isYes ? yesP : noP;
    const shares = parseFloat((amt / entry).toFixed(6));

    const t = {
      id: `T-${uid().toUpperCase()}`,
      ts: new Date().toISOString(),
      question: market.question,
      marketId: market.id || market.conditionId,
      category: market._cat || detectCategory(market.question),
      action: analysis.action,
      side: isYes ? "YES" : "NO",
      entryPrice: entry,
      currentPrice: entry,
      shares, cost: amt,
      confidence: analysis.confidence,
      edge_pct: analysis.edge_pct,
      risk: analysis.risk,
      signal_types: analysis.signal_types || [],
      reasoning: analysis.reasoning,
      news: analysis.news_found,
      newsSource: analysis.news_source,
      status: "OPEN", pnl: 0,
      stopLoss: parseFloat((entry * (1 - config.stopLoss / 100)).toFixed(4)),
      takeProfit: parseFloat((entry * (1 + config.takeProfit / 100)).toFixed(4)),
      yesAtEntry: yesP, noAtEntry: noP,
    };

    const newCap = parseFloat((capital - amt).toFixed(2));
    setCapitalP(newCap);
    setTradesP([t, ...trades]);
    setSignalsP(signals.map(s => s.id === sig.id ? { ...s, executed: true } : s));

    addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "TRADE");
    addLog(`✅ TRADE EJECUTADO · ${t.id} · ${nowStr()}`, "TRADE");
    addLog(`   MERCADO   : "${t.question?.slice(0, 80)}"`, "TRADE");
    addLog(`   CATEGORÍA : ${CATEGORIES[t.category]?.icon} ${CATEGORIES[t.category]?.label}`, "TRADE");
    addLog(`   ACCIÓN    : ${t.action} (${t.side})`, "TRADE");
    addLog(`   ENTRADA   : ${fmtPct(entry)} · SHARES: ${shares} · COSTO: $${amt}`, "TRADE");
    addLog(`   STOP LOSS : ${fmtPct(t.stopLoss)} (-${config.stopLoss}%) → pérd. máx: -$${(amt * config.stopLoss / 100).toFixed(2)}`, "TRADE");
    addLog(`   TAKE PROF : ${fmtPct(t.takeProfit)} (+${config.takeProfit}%) → ganancia obj: +$${(amt * config.takeProfit / 100).toFixed(2)}`, "TRADE");
    addLog(`   IA SCORE  : ${analysis.score}/100 · conf:${analysis.confidence}% · edge:${analysis.edge_pct?.toFixed(1)}% · riesgo:${analysis.risk}`, "TRADE");
    addLog(`   SEÑALES   : ${t.signal_types.join(" · ")}`, "TRADE");
    addLog(`   RAZÓN IA  : ${t.reasoning}`, "TRADE");
    if (t.news) addLog(`   NOTICIA   : ${t.news}`, "NEWS");
    if (t.newsSource) addLog(`   FUENTE    : ${t.newsSource}`, "NEWS");
    addLog(`   CAPITAL   : $${capital.toFixed(2)} → $${newCap.toFixed(2)} (invertido: $${(INIT_CAPITAL - newCap).toFixed(2)})`, "TRADE");
    setTab("portfolio");
  }

  // ── Close trade ──
  function closeTrade(id, closePrice) {
    const price = parseFloat(closePrice);
    if (isNaN(price) || price < 0 || price > 1) return;
    const t = trades.find(x => x.id === id);
    if (!t || t.status === "CLOSED") return;
    const pnl = parseFloat(((price - t.entryPrice) * t.shares).toFixed(2));
    const returned = parseFloat((t.cost + pnl).toFixed(2));
    const newCap = parseFloat((capital + returned).toFixed(2));
    const newDpnl = parseFloat((dailyPnl + pnl).toFixed(2));

    setCapitalP(newCap);
    setDailyPnl(newDpnl);
    persist("pb2_dpnl", String(newDpnl));
    setTradesP(trades.map(x => x.id === id ? { ...x, status: "CLOSED", currentPrice: price, pnl, closedAt: new Date().toISOString() } : x));
    setCloseInputs(p => { const n = { ...p }; delete n[id]; return n; });

    const type = pnl >= 0 ? "WIN" : "LOSS";
    const roi = ((pnl / t.cost) * 100).toFixed(1);
    addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", type);
    addLog(`${pnl >= 0 ? "🏆 WIN" : "💸 LOSS"} CERRADO · ${t.id} · ${nowStr()}`, type);
    addLog(`   MERCADO   : "${t.question?.slice(0, 80)}"`, type);
    addLog(`   ENTRADA   : ${fmtPct(t.entryPrice)} → SALIDA: ${fmtPct(price)}`, type);
    addLog(`   P&L       : ${pnl >= 0 ? "+" : ""}$${pnl} (ROI: ${roi}%)`, type);
    addLog(`   DURACIÓN  : ${t.ts ? Math.round((Date.now() - new Date(t.ts)) / 3600000 * 10) / 10 : "?"} horas`, type);
    addLog(`   CAPITAL   : $${capital.toFixed(2)} → $${newCap.toFixed(2)}`, type);
    addLog(`   P&L DIARIO: ${newDpnl >= 0 ? "+" : ""}$${newDpnl.toFixed(2)}`, type);
  }

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
    { id: "log", label: "📋 LOG" },
    { id: "config", label: "⚙ CONFIG" },
  ];

  const mono = "'IBM Plex Mono', monospace";
  const heading = "'Oswald', sans-serif";

  return (
    <div style={{ background: S.bg, color: S.text, minHeight: "100vh", fontFamily: mono, fontSize: "11px" }}>

      {/* ─── HEADER ─── */}
      <div style={{
        background: S.panel, borderBottom: `1px solid ${S.border2}`,
        padding: "8px 16px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
        boxShadow: `0 2px 30px #29d9ff08`,
      }}>
        <div style={{ marginRight: "4px" }}>
          <div style={{ fontFamily: heading, fontWeight: 700, fontSize: "20px", letterSpacing: "4px", color: S.cyan, textShadow: `0 0 30px ${S.cyan}55` }}>
            POLYBOT <span style={{ color: S.muted2, fontSize: "11px", fontFamily: mono, letterSpacing: "1px" }}>v2</span>
          </div>
          <div style={{ color: S.muted, fontSize: "7px", letterSpacing: "2px", marginTop: "1px" }}>PAPER TRADING · DATOS REALES · IA + NOTICIAS</div>
        </div>

        <div style={{ width: "1px", height: "40px", background: S.border2, margin: "0 4px" }} />

        <StatCard label="Capital Total" value={`$${totalValue.toFixed(2)}`} color={S.cyan} />
        <StatCard label="P&L Total" value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl}`} color={totalPnl >= 0 ? S.green : S.red} sub={`${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct}%`} />
        <StatCard label="P&L Realizado" value={`${realizedPnl >= 0 ? "+" : ""}$${realizedPnl}`} color={realizedPnl >= 0 ? S.green : S.red} />
        <StatCard label="P&L Hoy" value={`${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`} color={dailyPnl >= 0 ? S.green : S.red} />
        <StatCard label="Win Rate" value={`${winRate}%`} color={parseFloat(winRate) >= 50 ? S.green : parseFloat(winRate) > 0 ? S.amber : S.muted2} sub={`${wins}W / ${closedTrades.length - wins}L`} />
        <StatCard label="Mercados" value={allMarkets.length || "—"} color={S.white} sub={scanStatus.lastScan ? `Scan: ${scanStatus.lastScan?.slice(0, 8)}` : "Sin escaneo"} />
        <StatCard label="Señales" value={activeSignals.length} color={activeSignals.length > 0 ? S.amber : S.muted2} />

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
      <div style={{ display: "flex", background: S.panel, borderBottom: `1px solid ${S.border2}`, overflowX: "auto" }}>
        {TABS.map(t => (
          <div key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "8px 14px", cursor: "pointer", fontSize: "9px", fontWeight: tab === t.id ? 700 : 400,
            letterSpacing: "1.5px", color: tab === t.id ? S.cyan : S.muted2,
            borderBottom: `2px solid ${tab === t.id ? S.cyan : "transparent"}`,
            transition: "all 0.2s", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "5px",
          }}>
            {t.label}
            {t.badge > 0 && <Tag txt={t.badge} color={t.id === "signals" ? S.amber : t.id === "portfolio" ? S.green : S.cyan} />}
          </div>
        ))}
      </div>

      {/* ─── CONTENT ─── */}
      <div style={{ padding: "14px 16px", height: "calc(100vh - 120px)", overflowY: "auto" }}>

        {/* ══════════ SCAN TAB ══════════ */}
        {tab === "scan" && (
          <div style={{ maxWidth: "800px" }}>
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
                  ["🤖", `Análisis IA profundo en top ${config.aiTopN} mercados con Claude + Web Search en tiempo real`, S.purple],
                  ["📰", "Busca noticias actuales, polls, eventos que el mercado no haya descontado aún", "#ff9944"],
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
            <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden" }}>
              <div style={{ padding: "8px 14px", borderBottom: `1px solid ${S.border2}`, color: S.muted2, fontSize: "9px", letterSpacing: "1px" }}>
                LOG RECIENTE (últimas 20 entradas)
              </div>
              <div style={{ padding: "8px 14px", maxHeight: "300px", overflowY: "auto" }}>
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
                        ["YES actual", fmtPct(parseFloat(m.outcomePrices?.[0] ?? 0.5)), S.green],
                        ["NO actual", fmtPct(parseFloat(m.outcomePrices?.[1] ?? 0.5)), S.red],
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
              <div style={{ background: S.panel, border: `1px solid ${S.border2}`, borderRadius: "6px", overflow: "hidden" }}>
                <div style={{ padding: "8px 14px", borderBottom: `1px solid ${S.border2}`, color: S.muted2, fontSize: "9px", display: "flex", justifyContent: "space-between" }}>
                  <span>{filteredMarkets.length} mercados {catFilter !== "ALL" ? `en ${CATEGORIES[catFilter]?.label}` : "totales"} (mostrando top 200)</span>
                  <span>gamma-api.polymarket.com · {scanStatus.lastScan || "sin datos"}</span>
                </div>
                <div style={{ overflowX: "auto" }}>
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
                      ["ENTRADA", fmtPct(t.entryPrice), S.white],
                      ["COSTO", `$${t.cost}`, S.white],
                      ["SHARES", t.shares.toFixed(5), S.text],
                      ["SL", fmtPct(t.stopLoss), S.red],
                      ["TP", fmtPct(t.takeProfit), S.green],
                      ["CONF IA", `${t.confidence}%`, S.amber],
                      ["EDGE IA", `${t.edge_pct?.toFixed(1)}%`, S.amber],
                      ["RIESGO", t.risk, t.risk === "LOW" ? S.green : t.risk === "HIGH" ? S.red : S.amber],
                    ].map(([l, v, c]) => (
                      <div key={l} style={{ background: "#0005", border: `1px solid ${S.border}`, padding: "3px 8px", borderRadius: "3px" }}>
                        <span style={{ color: S.muted, fontSize: "7px" }}>{l} </span>
                        <span style={{ color: c, fontWeight: 600, fontSize: "10px" }}>{v}</span>
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
                  Borra todos los trades, señales, noticias y log. Restaura $10,000 paper money.
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
                  ["pb2_log","pb2_dpnl","pb2_markets","pb2_snap","pb2_news"].forEach(k => { try { localStorage.removeItem(k) } catch {} });
                  addLog("🔄 SISTEMA RESETEADO COMPLETAMENTE · Capital: $10,000", "SYSTEM");
                }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
