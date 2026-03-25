import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const API_POLY = "https://gamma-api.polymarket.com/markets";
const API_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const API_TAVILY = "https://api.tavily.com/search";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// ── ESTADO DEL SISTEMA (En memoria del servidor) ──
export const botState = {
  capital: 100,
  trades: [],
  signals: [],
  allMarkets: [],
  marketSnapshots: {},
  newsCache: {},
  logEntries: [],
  dailyPnl: 0,
  dailyDate: new Date().toISOString().slice(0, 10),
  goalReached: false,
  scanStatus: { running: false, phase: "A la espera", progress: 0, total: 0, lastScan: null },
  config: {
    maxTradePct: 12, stopLoss: 6, takeProfit: 18,
    dailyLossLimit: 25, minLiq: 1500, minVol: 8000,
    minScore: 25, aiTopN: 2, autoTrade: true,
    closeHour: 15,
    autoInterval: 30
  }
};

const DAILY_GOAL = 1.50;

// ── RECONSTRUCCIÓN SÓLIDA DESDE SUPABASE ──
export async function initializeStateFromDB() {
  console.log("🔄 Cincronizando cerebro con Supabase (Base de Datos)...");
  try {
    // 1. Descargar todos los trades del usuario
    const { data: tradesDb, error } = await supabase
      .from('user_trades')
      .select('*')
      .order('executed_at', { ascending: false });

    if (error) throw error;
    
    let totalPnl = 0;
    let todayPnl = 0;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const loadedTrades = (tradesDb || []).map(t => {
      // Re-estructurar al formato del bot
      const pnlVal = t.status === 'CLOSED' ? (t.pnl || 0) : 0;
      totalPnl += pnlVal;
      
      if (t.status === 'CLOSED' && t.closed_at && t.closed_at.startsWith(todayStr)) {
        todayPnl += pnlVal;
      }
      
      return {
        id: t.trade_id, ts: t.executed_at, question: t.question,
        marketId: t.market_id, side: t.side, entryPrice: t.entry_price,
        currentPrice: t.current_price || t.entry_price,
        shares: t.shares, cost: t.cost, status: t.status,
        pnl: pnlVal, closedAt: t.closed_at || null,
        stopLoss: parseFloat((t.entry_price * (1 - botState.config.stopLoss / 100)).toFixed(4)),
        takeProfit: parseFloat((t.entry_price * (1 + botState.config.takeProfit / 100)).toFixed(4)),
      };
    });

    botState.trades = loadedTrades;
    botState.capital = parseFloat((100 + totalPnl).toFixed(2)); // $100 base simulada + histórico
    botState.dailyPnl = parseFloat(todayPnl.toFixed(2));
    botState.dailyDate = todayStr;
    
    if (botState.dailyPnl >= DAILY_GOAL) {
      botState.goalReached = true;
    }

    console.log(`✅ Base de datos sincronizada. Capital vivo: $${botState.capital} | P&L Hoy: $${botState.dailyPnl}`);
  } catch (err) {
    console.error("❌ FALLO AL SINCRONIZAR SUPABASE:", err.message);
    console.log("⚠️ Iniciando con valores por defecto... cuidado.");
  }
}

// ── AYUDANTES ──
function uid() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
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
function fmtPct(n) { return `${(n * 100).toFixed(2)}%`; }

export function addLog(msg, type = "INFO") {
  const e = { id: uid(), ts: new Date().toISOString(), msg, type };
  botState.logEntries.unshift(e);
  if (botState.logEntries.length > 2000) botState.logEntries.length = 2000;
  console.log(`[${type}] ${msg}`);
}

// ── POLYMARKET API ──
async function fetchAllMarkets(onProgress) {
  const all = [];
  let offset = 0;
  const limit = 100;
  let page = 1;

  while (true) {
    if(onProgress) onProgress(`Descargando página ${page} (offset ${offset})…`);
    const r = await fetch(`${API_POLY}?limit=${limit}&offset=${offset}&active=true&closed=false`, {
      method: 'GET',
      headers: { 
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      },
    });
    if (!r.ok) throw new Error(`Polymarket API error: ${r.status}`);
    const batch = await r.json();
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    page++;
    if (page > 20) break; // safety cap
    await new Promise(res => setTimeout(res, 200)); // Rate limit respetado para la nube
  }
  return all;
}

// ── SCORING PRELIMINAR ──
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

  const arbDev = Math.abs(sum - 1);
  if (arbDev > 0.05) { signals.push("ARB"); score += 40; }
  else if (arbDev > 0.03) { signals.push("ARB"); score += 20; }

  if (liq < botState.config.minLiq) return { score: 0, signals: [], skip: true };

  const edge = Math.max(yesP, noP);
  if (edge > 0.15 && edge < 0.85) score += 15;
  if (edge > 0.25 && edge < 0.75) score += 10;

  if (vol > 500000) score += 20;
  else if (vol > 50000) score += 12;
  else if (vol > 5000) score += 6;

  if (prevSnapshot) {
    const prevY = parseFloat(prevSnapshot.yesP ?? 0.5);
    const delta = Math.abs(yesP - prevY);
    if (delta > 0.05) { signals.push("MOMENTUM"); score += 25; }
    else if (delta > 0.02) { signals.push("MOMENTUM"); score += 10; }
  }

  if (m.endDateIso || m.endDate) {
    const closes = new Date(m.endDateIso || m.endDate);
    const daysLeft = (closes - Date.now()) / 86400000;
    if (daysLeft < 0) return { score: 0, signals: [], skip: true };
    if (daysLeft <= 1) { signals.push("CRITICO_HOY"); score += 35; }
    else if (daysLeft > 1 && daysLeft <= 15) { signals.push("15_DIAS"); score += 25; }
    else if (daysLeft > 15 && daysLeft < 30) score += 5;
  }

  return { score, signals, yesP, noP, vol, liq, sum, skip: false };
}

// ── IA PROFUNDA (Groq + Tavily) ──
async function deepAnalyze(m, prelim) {
  const { yesP, noP, vol, liq, sum } = prelim;
  const marketId = m.id || m.conditionId;
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  let newsContext = "Sin noticias recientes.";
  let topSource = "none";
  let topSnippet = "none";
  let usedCache = false;

  const cachedNews = botState.newsCache[marketId];
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
          botState.newsCache[marketId] = { ts: Date.now(), context: newsContext, source: topSource, snippet: topSnippet, news: newsContext };
        }
      }
    } catch (e) { console.warn("Tavily fallido:", e.message); }
  }

  const daysLeft = (m.endDateIso || m.endDate)
    ? Math.max(0, (new Date(m.endDateIso || m.endDate) - Date.now()) / 86400000).toFixed(1) : "?";

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
YES=${fmtPct(yesP)} NO=${fmtPct(noP)} SUM=${fmtPct(sum)}${Math.abs(sum-1)>0.03?" ⚠ARB":""} VOL=${vol} LIQ=${liq}
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
  if (!r.ok) throw new Error(`Groq error: ${r.status}`);
  const data = await r.json();
  const txt = data.choices[0]?.message?.content || "{}";
  const clean = txt.replace(/```[\w]*\n?|```/g, "").trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");
  const result = JSON.parse(jsonMatch[0]);
  result._newsCached = usedCache;
  return result;
}

// ── CICLO MAESTRO DE ESCANEO ──
export async function runFullScan() {
  if (botState.scanStatus.running) return;
  botState.scanStatus.running = true;
  botState.scanStatus.phase = "Iniciando...";
  botState.scanStatus.progress = 0;
  
  addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "SYSTEM");
  addLog(`[BACKEND] 🚀 ESCANEO COMPLETO INICIADO`, "SYSTEM");

  try {
    const raw = await fetchAllMarkets(msg => {
      botState.scanStatus.phase = msg;
    });
    
    botState.scanStatus.total = raw.length;
    const enriched = raw.map(m => ({ ...m, _cat: detectCategory(m.question) }));
    botState.allMarkets = enriched;

    const prevSnap = botState.marketSnapshots;
    const newSnap = {};
    const scored = [];

    for (const m of enriched) {
      const id = m.id || m.conditionId;
      const pre = preliminaryScore(m, prevSnap[id]);
      if (!pre.skip && pre.score >= botState.config.minScore) {
        scored.push({ m, pre });
      }
      newSnap[id] = { yesP: pre.yesP, noP: pre.noP, ts: Date.now() };
    }
    botState.marketSnapshots = newSnap;

    const viable = scored.sort((a, b) => b.pre.score - a.pre.score).slice(0, botState.config.aiTopN);
    addLog(`✅ Filtros superados: ${viable.length} mercados a IA Profunda`, "FILTER");

    for (let i = 0; i < viable.length; i++) {
      const { m, pre } = viable[i];
      botState.scanStatus.phase = `IA Analizando: ${m.question.slice(0,30)}...`;
      botState.scanStatus.progress = Math.round((i / viable.length) * 100);
      
      try {
        const analysis = await deepAnalyze(m, pre);
        
        if (analysis.action !== "SKIP" && analysis.score >= botState.config.minScore) {
          const sig = {
            id: uid(), detectedAt: new Date().toISOString(),
            market: m, prelim: pre, analysis, executed: false,
          };
          botState.signals.push(sig);
          addLog(`✨ [SEÑAL IA] ${analysis.action} | Confianza: ${analysis.confidence}% | Edge: ${analysis.edge_pct}% | Merc: ${m.question.slice(0, 50)}`, "AI");
          
          supabase.from('ai_signals').insert({
            signal_id: sig.id, market_id: m.id || m.conditionId, question: m.question, action: analysis.action,
            score: analysis.score, confidence: analysis.confidence, edge_pct: analysis.edge_pct,
            yes_price: pre.yesP, no_price: pre.noP, news_found: analysis.news_found, reasoning: analysis.reasoning,
            detected_at: sig.detectedAt
          }).then(()=>{});

          // EJECUCIÓN 
          if (botState.goalReached) {
             addLog(`🛑 META DIARIA ALCANZADA: Inversión en espera.`, "SYSTEM");
          } else if (botState.config.autoTrade && botState.capital > 1) {
            const kellyFactor = ((analysis.confidence || 50) / 100) * (1 + ((analysis.edge_pct || 0)/100)); 
            const dynamicRiskPct = Math.min(botState.config.maxTradePct, (botState.config.maxTradePct * kellyFactor));
            const amt = parseFloat((botState.capital * (dynamicRiskPct / 100)).toFixed(2));
            
            if (amt >= 0.5) {
              const isYes = analysis.action === "BUY_YES";
              const entry = isYes ? pre.yesP : pre.noP;
              const shares = parseFloat((amt / entry).toFixed(6));
              
              const t = {
                id: `T-${uid().toUpperCase()}`, ts: new Date().toISOString(), question: m.question,
                marketId: m.id || m.conditionId, category: m._cat, action: analysis.action, side: isYes ? "YES" : "NO",
                entryPrice: entry, currentPrice: entry, shares, cost: amt, confidence: analysis.confidence,
                edge_pct: analysis.edge_pct, risk: analysis.risk, signal_types: analysis.signal_types || [],
                reasoning: analysis.reasoning, news: analysis.news_found, status: "OPEN", pnl: 0,
                stopLoss: parseFloat((entry * (1 - botState.config.stopLoss / 100)).toFixed(4)),
                takeProfit: parseFloat((entry * (1 + botState.config.takeProfit / 100)).toFixed(4)),
              };
              botState.capital = parseFloat((botState.capital - amt).toFixed(2));
              botState.trades.unshift(t);
              sig.executed = true;

              addLog(`🚀 [BACKEND COMPRA] ${t.side} | Inversión: $${amt} | Entrada: ${fmtPct(entry)} | Merc: ${t.question.slice(0,50)}`, "TRADE");
              
              supabase.from('user_trades').insert({
                  trade_id: t.id, signal_id: sig.id, market_id: t.marketId, question: t.question,
                  side: t.side, entry_price: t.entryPrice, shares: t.shares, cost: t.cost, status: 'OPEN', executed_at: t.ts
              }).then(()=>{});
            }
          }
        }
      } catch (e) { console.error("IA Err:", e.message); }
      await new Promise(res => setTimeout(res, 200));
    }

  } catch (err) {
    addLog(`❌ Error Crítico Scanner Backend: ${err.message}`, "ERROR");
  } finally {
    botState.scanStatus.running = false;
    botState.scanStatus.progress = 100;
    botState.scanStatus.phase = "Completado";
    botState.scanStatus.lastScan = new Date().toLocaleString("es-CO");
  }
}

// ── FAST SYNC AUTOPILOT (Monitoreo de P&L de abiertas) ──
export async function fastSyncTrades() {
  const openTrades = botState.trades.filter(t => t.status === "OPEN");
  if (openTrades.length === 0) return;
  try {
    const raw = await fetchAllMarkets();
    let modified = false;
    openTrades.forEach(t => {
      const m = raw.find(x => x.id === t.marketId || x.conditionId === t.marketId);
      if (!m || !m.outcomePrices) return;
      let p = [0.5, 0.5];
      try { p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices; } catch(e){}
      const livePx = t.side === "YES" ? parseFloat(p[0]) : parseFloat(p[1]);
      if (isNaN(livePx) || livePx <= 0.001 || livePx >= 0.999) return; 

      const tIdx = botState.trades.findIndex(x => x.id === t.id);
      botState.trades[tIdx].currentPrice = livePx;

      if (livePx >= t.takeProfit || livePx <= t.stopLoss) {
        const pnl = parseFloat(((livePx - (t.entryPrice || 0)) * t.shares).toFixed(2));
        const returned = parseFloat(((t.cost || 0) + pnl).toFixed(2));
        
        botState.trades[tIdx].status = "CLOSED";
        botState.trades[tIdx].closedAt = new Date().toISOString();
        botState.trades[tIdx].pnl = pnl;
        botState.capital = parseFloat((botState.capital + returned).toFixed(2));
        botState.dailyPnl = parseFloat((botState.dailyPnl + pnl).toFixed(2));
        
        addLog(`🤖 [BACKEND AUTOPILOT] Cierre ${t.id} @ ${fmtPct(livePx)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`, pnl>=0?"WIN":"LOSS");
        supabase.from('user_trades').update({ status: 'CLOSED' }).match({ trade_id: t.id }).then(()=>{});
        
        if (botState.dailyPnl >= DAILY_GOAL && !botState.goalReached) {
            botState.goalReached = true;
            addLog(`🏆 ¡META DIARIA ALCANZADA! P&L = +$${botState.dailyPnl.toFixed(2)} ≥ $${DAILY_GOAL.toFixed(2)}`, "WIN");
        }
      }
    });
  } catch (e) {
    console.error("Fast Sync Error:", e.message);
  }
}

// ── CHEQUEO DE MEDIANOCHE Y JORNADA ──
export function checkDayRollover() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getHours();
  const min = now.getMinutes();

  if (botState.dailyDate !== today) {
     botState.dailyPnl = 0;
     botState.goalReached = false;
     botState.dailyDate = today;
     addLog(`🌅 [BACKEND] NUEVO DÍA: Meta desbloqueada — ${today}`, "SYSTEM");
  }

  if (hour === botState.config.closeHour && min === 0 && !botState.dayClosedToday) {
     botState.goalReached = true;
     botState.dayClosedToday = true;
     addLog(`⏰ [BACKEND] CIERRE DE JORNADA (${hour}:00). Se detienen nuevas entradas.`, "SYSTEM");
  } else if (hour !== botState.config.closeHour) {
     botState.dayClosedToday = false; 
  }
}
