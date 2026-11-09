import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { getBooleanEnv, getEnv, getNumberEnv, requireEnv } from './env.js';
import { computeExecutableBookWalk, computePolymarketTakerFeeUsd, getConditionalTokenSnapshot, getLiveWalletSnapshot, getMarketTradeFlow, getOrderBookSnapshot, getTokenExitQuote, getTokenFeeRateBps, getTokenSellPrice, getTradingWalletAddress, isRealTradingEnabled, transferUsdc } from './polymarketClient.js';
export { computeExecutableBookWalk, computePolymarketTakerFeeUsd };
import { executeBuyOrder, executeSellOrder } from './tradeExecutor.js';
import { REAL_TRADING_RULES, computeRealTradePlan, isSameAddress, sumOpenExposure } from './riskGuards.js';
import { createRuntimeOwner, withRuntimeLock } from './runtimeLocks.js';

dotenv.config();

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_KEY = requireEnv('SUPABASE_KEY');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const API_POLY = "https://gamma-api.polymarket.com/markets";
const API_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = getEnv("GROQ_MODEL", "openai/gpt-oss-120b");
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const API_CEREBRAS = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = getEnv("CEREBRAS_MODEL", "gpt-oss-120b");
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const LLM_PRIMARY_PROVIDER = getEnv("LLM_PRIMARY_PROVIDER", "AUTO").toUpperCase();
const API_TAVILY = "https://api.tavily.com/search";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
export const BASE_CAPITAL = getNumberEnv("BASE_CAPITAL", 15);
const DAILY_GOAL = getNumberEnv("DAILY_GOAL_USDC", 1.50);
const STOP_LOSS_PCT = getNumberEnv("STOP_LOSS_PCT", 6);
const TAKE_PROFIT_PCT = getNumberEnv("TAKE_PROFIT_PCT", 10);
const BREAK_EVEN_TRIGGER_PCT = getNumberEnv("BREAK_EVEN_TRIGGER_PCT", 4);
const BREAK_EVEN_BUFFER_PCT = getNumberEnv("BREAK_EVEN_BUFFER_PCT", 0.5);
const MAX_HOLD_HOURS = getNumberEnv("MAX_HOLD_HOURS", 24);
const MAX_MARKET_DAYS = getNumberEnv("MAX_MARKET_DAYS", 30);
const MAX_SPREAD_PCT = getNumberEnv("MAX_SPREAD_PCT", 4.0);
const MAX_SPREAD_CENTS = getNumberEnv("MAX_SPREAD_CENTS", 0.03);
const MIN_BOOK_DEPTH_USD = getNumberEnv("MIN_BOOK_DEPTH_USD", 15);
const MIN_AI_CONFIDENCE = getNumberEnv("MIN_AI_CONFIDENCE", 70);
const MIN_NET_EDGE_PCT = getNumberEnv("MIN_NET_EDGE_PCT", 4.5);
export const STRATEGY_VERSION = getEnv("STRATEGY_VERSION", "v3.1.0-crypto-oracle");
export const ALLOWED_TRADING_CATEGORIES = ["CRYPTO"];
const CRITICAL_LOOP_LOCK_TTL_SECONDS = Math.max(30, Math.floor(getNumberEnv("CRITICAL_LOOP_LOCK_TTL_SECONDS", 180)));
const DB_READINESS_TTL_MS = Math.max(30_000, Math.floor(getNumberEnv("DB_READINESS_TTL_MS", 300_000)));

const AUTO_WITHDRAW_ENABLED = getBooleanEnv("AUTO_WITHDRAW_ENABLED", true);
const WITHDRAWAL_TARGET_ADDRESS = getEnv("WITHDRAWAL_TARGET_ADDRESS", "");
const WITHDRAWAL_OPERATING_CAPITAL_USDC = getNumberEnv("WITHDRAWAL_OPERATING_CAPITAL_USDC", BASE_CAPITAL);
const WITHDRAWAL_MIN_EXCESS_USDC = getNumberEnv("WITHDRAWAL_MIN_EXCESS_USDC", 5);
const WITHDRAWAL_EXCESS_PCT_RAW = getNumberEnv("WITHDRAWAL_EXCESS_PCT", 60);
const WITHDRAWAL_COOLDOWN_HOURS = getNumberEnv("WITHDRAWAL_COOLDOWN_HOURS", 24);
const WITHDRAWAL_MIN_POL_BALANCE = getNumberEnv("WITHDRAWAL_MIN_POL_BALANCE", 2);
const WITHDRAWAL_MIN_TRANSFER_USDC = getNumberEnv("WITHDRAWAL_MIN_TRANSFER_USDC", 1);
const WITHDRAWAL_EXCESS_RATIO = Math.max(
  0,
  Math.min(1, WITHDRAWAL_EXCESS_PCT_RAW > 1 ? (WITHDRAWAL_EXCESS_PCT_RAW / 100) : WITHDRAWAL_EXCESS_PCT_RAW)
);
const WALLET_ACTIVITY_MAX = 200;

function getWithdrawalPolicySnapshot() {
  const tradingWalletAddress = getTradingWalletAddress();
  const sameAddressBlocked = isSameAddress(tradingWalletAddress, WITHDRAWAL_TARGET_ADDRESS);
  const blockers = [];

  if (!AUTO_WITHDRAW_ENABLED) {
    blockers.push("AUTO_WITHDRAW_ENABLED=false");
  }
  if (!WITHDRAWAL_TARGET_ADDRESS) {
    blockers.push("Falta WITHDRAWAL_TARGET_ADDRESS");
  }
  if (sameAddressBlocked) {
    blockers.push("La wallet destino no puede ser la misma wallet operativa");
  }

  return {
    enabled: AUTO_WITHDRAW_ENABLED,
    configured: !!WITHDRAWAL_TARGET_ADDRESS,
    targetAddress: WITHDRAWAL_TARGET_ADDRESS || null,
    operatingCapitalUsdc: WITHDRAWAL_OPERATING_CAPITAL_USDC,
    minExcessUsdc: WITHDRAWAL_MIN_EXCESS_USDC,
    excessRatio: WITHDRAWAL_EXCESS_RATIO,
    cooldownHours: WITHDRAWAL_COOLDOWN_HOURS,
    minPolBalance: WITHDRAWAL_MIN_POL_BALANCE,
    minTransferUsdc: WITHDRAWAL_MIN_TRANSFER_USDC,
    tradingWalletAddress: tradingWalletAddress || null,
    sameAddressBlocked,
    ready: blockers.length === 0,
    blockers,
  };
}

// â”€â”€ ESTADO DEL SISTEMA (En memoria del servidor) â”€â”€
export const botState = {
  strategyVersion: STRATEGY_VERSION,
  capital: BASE_CAPITAL,
  trades: [],
  signals: [],
  decisionLog: [],
  allMarkets: [],
  marketSnapshots: {},
  newsCache: {},
  logEntries: [],
  dailyPnl: 0,
  dailyDate: new Date().toISOString().slice(0, 10),
  goalReached: false,
  withdrawnTotal: 0,
  lastWithdrawalAt: null,
  walletActivity: [],
  walletSnapshot: null,
  dbReadiness: {
    checkedAt: null,
    autoTradeReady: !isRealTradingEnabled(),
    blockers: [],
    warnings: [],
    missingColumns: [],
    missingRpcs: [],
  },
  withdrawalPolicy: getWithdrawalPolicySnapshot(),
  scanStatus: { running: false, phase: "A la espera", progress: 0, total: 0, lastScan: null },
  config: {
    maxTradePct: 12, stopLoss: STOP_LOSS_PCT, takeProfit: TAKE_PROFIT_PCT,
    breakEvenTriggerPct: BREAK_EVEN_TRIGGER_PCT,
    breakEvenBufferPct: BREAK_EVEN_BUFFER_PCT,
    maxHoldHours: MAX_HOLD_HOURS,
    dailyLossLimit: 25, minLiq: 1500, minVol: 8000,
    minScore: 25, aiTopN: REAL_TRADING_RULES.aiTopN, autoTrade: true,
    closeHour: 15,
    autoInterval: 30,
    minTradeUsdc: REAL_TRADING_RULES.minTradeUsdc,
    maxTradeUsdc: REAL_TRADING_RULES.maxTradeUsdc,
    maxOpenTrades: REAL_TRADING_RULES.maxOpenTrades,
    maxExposurePct: REAL_TRADING_RULES.maxExposurePct,
    reserveUsdc: REAL_TRADING_RULES.reserveUsdc,
    minPolBalance: REAL_TRADING_RULES.minPolBalance,
  }
};

const runtimeLockOwners = {
  scan: createRuntimeOwner("scan"),
  sync: createRuntimeOwner("sync"),
};

const REQUIRED_REAL_AUTOTRADE_COLUMNS = [
  "stop_loss",
  "take_profit",
  "break_even_armed",
  "max_hold_at",
];

const REQUIRED_REAL_AUTOTRADE_RPCS = [
  {
    name: "try_acquire_runtime_lock",
    args: {
      p_lock_name: "polybot-readiness-check",
      p_owner: "polybot-readiness-check",
      p_ttl_seconds: 30,
    },
  },
  {
    name: "release_runtime_lock",
    args: {
      p_lock_name: "polybot-readiness-check",
      p_owner: "polybot-readiness-check",
    },
  },
];

const ACTIVE_TRADE_STATUSES = new Set(["OPEN", "PARTIAL", "PENDING_BUY", "PENDING_SELL"]);

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return parseFloat(asNumber(value, 0).toFixed(2));
}

function isActiveTradeStatus(status) {
  return ACTIVE_TRADE_STATUSES.has(String(status || "").trim().toUpperCase());
}

function isRealManagedTrade(trade) {
  return String(trade?.executionMode || trade?.execution_mode || "").trim().toUpperCase() === "REAL" && !!trade?.tokenId;
}

function shouldManageTrade(trade) {
  if (!isActiveTradeStatus(trade?.status)) return false;
  if (!isRealTradingEnabled()) return true;
  return isRealManagedTrade(trade);
}

function getOpenTrades(trades = botState.trades) {
  return trades.filter(t => shouldManageTrade(t));
}

async function probeColumnExists(table, column) {
  const { error } = await supabase.from(table).select(column).limit(1);
  return !error;
}

async function probeRpcExists(name, args) {
  const { error } = await supabase.rpc(name, args);
  return !error;
}

export async function refreshDbReadiness(force = false) {
  if (!isRealTradingEnabled()) {
    botState.dbReadiness = {
      checkedAt: new Date().toISOString(),
      autoTradeReady: true,
      blockers: [],
      warnings: [],
      missingColumns: [],
      missingRpcs: [],
    };
    return botState.dbReadiness;
  }

  const checkedAtMs = botState.dbReadiness?.checkedAt ? new Date(botState.dbReadiness.checkedAt).getTime() : 0;
  if (!force && checkedAtMs && (Date.now() - checkedAtMs) < DB_READINESS_TTL_MS) {
    return botState.dbReadiness;
  }

  const missingColumns = [];
  for (const column of REQUIRED_REAL_AUTOTRADE_COLUMNS) {
    const exists = await probeColumnExists("user_trades", column);
    if (!exists) missingColumns.push(column);
  }

  const missingRpcs = [];
  for (const rpc of REQUIRED_REAL_AUTOTRADE_RPCS) {
    const exists = await probeRpcExists(rpc.name, rpc.args);
    if (!exists) missingRpcs.push(rpc.name);
  }

  const blockers = [];
  if (missingColumns.length > 0) {
    blockers.push(`Faltan columnas críticas en user_trades: ${missingColumns.join(", ")}`);
  }
  if (missingRpcs.length > 0) {
    blockers.push(`Faltan funciones RPC críticas: ${missingRpcs.join(", ")}`);
  }

  const warnings = [];
  botState.withdrawalPolicy = getWithdrawalPolicySnapshot();
  if (Array.isArray(botState.withdrawalPolicy?.blockers) && botState.withdrawalPolicy.blockers.length > 0) {
    warnings.push(...botState.withdrawalPolicy.blockers.map(reason => `Retiro automático: ${reason}`));
  }

  botState.dbReadiness = {
    checkedAt: new Date().toISOString(),
    autoTradeReady: blockers.length === 0,
    blockers,
    warnings,
    missingColumns,
    missingRpcs,
  };
  return botState.dbReadiness;
}

function isRealAutoTradeReady() {
  return !isRealTradingEnabled() || !!botState.dbReadiness?.autoTradeReady;
}

async function refreshWalletSnapshot(force = false) {
  if (!isRealTradingEnabled()) return null;
  const snapshot = await getLiveWalletSnapshot({ force });
  botState.walletSnapshot = snapshot
    ? { ...snapshot, openExposure: sumOpenExposure(getOpenTrades()) }
    : null;
  botState.withdrawalPolicy = getWithdrawalPolicySnapshot();
  if (snapshot) {
    botState.capital = roundMoney(snapshot.usdcBalance);
  }
  return botState.walletSnapshot;
}

async function findPersistedOpenTradeForMarket(marketId, conditionId) {
  const keys = Array.from(new Set([marketId, conditionId].filter(Boolean).map(String)));
  if (keys.length === 0) return null;

  let query = supabase
    .from("user_trades")
    .select("trade_id, market_id, condition_id, side, status")
    .in("status", ["OPEN", "PENDING_BUY", "PENDING_SELL", "PARTIAL"])
    .order("executed_at", { ascending: false });

  if (isRealTradingEnabled()) {
    query = query.eq("execution_mode", "REAL");
  }

  const { data, error } = await query.limit(500);

  if (error || !Array.isArray(data)) return null;

  return data.find(row => {
    const marketKey = row?.market_id ? String(row.market_id) : null;
    const conditionKey = row?.condition_id ? String(row.condition_id) : null;
    return keys.includes(marketKey) || keys.includes(conditionKey);
  }) || null;
}

function isMarketInCooldown(marketId, conditionId, question) {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const mKey = String(marketId || "");
  const cKey = String(conditionId || "");
  const qKey = String(question || "").trim().toLowerCase();

  let tradesLast24h = 0;

  for (const t of botState.trades) {
    if (t.closeReason === "CLEANUP_SIMULATED") continue;
    const sameMarket =
      (mKey && String(t.marketId) === mKey) ||
      (cKey && String(t.conditionId) === cKey) ||
      (qKey && String(t.question || "").trim().toLowerCase() === qKey);
    if (!sameMarket) continue;

    if (shouldManageTrade(t)) {
      return { blocked: true, reason: "Ya existe posición activa en este mercado" };
    }

    const closedMs = t.closedAt ? new Date(t.closedAt).getTime() : (t.ts ? new Date(t.ts).getTime() : 0);
    if (Number.isFinite(closedMs) && closedMs > 0) {
      if ((now - closedMs) < SIX_HOURS_MS) {
        const minsLeft = Math.ceil((SIX_HOURS_MS - (now - closedMs)) / 60000);
        return { blocked: true, reason: `Cooldown anti-overtrading activo (${minsLeft} min restantes)` };
      }
      if ((now - closedMs) < DAY_MS) {
        tradesLast24h++;
      }
    }
  }

  if (tradesLast24h >= 2) {
    return { blocked: true, reason: "Límite de 2 operaciones por mercado en 24h alcanzado" };
  }

  return { blocked: false, reason: null };
}

async function buildTradePlan() {
  const openTrades = getOpenTrades();
  const openExposure = sumOpenExposure(openTrades);
  const maxOpenTrades = Math.max(1, asNumber(botState.config.maxOpenTrades, 3));

  if (!isRealTradingEnabled()) {
    if (openTrades.length >= maxOpenTrades) {
      return {
        allowed: false,
        amount: 0,
        reason: `Máximo de trades abiertos alcanzado (${openTrades.length}/${maxOpenTrades})`,
        freeUsdc: botState.capital,
        polBalance: 0,
        openExposure,
        walletSnapshot: null,
      };
    }

    const totalEquity = botState.capital + openExposure;
    const maxExposureUsdc = totalEquity * (asNumber(botState.config.maxExposurePct, 50) / 100);
    const remainingExposureCapacity = Math.max(0, maxExposureUsdc - openExposure);
    const simulatedAmount = roundMoney(Math.min(botState.config.maxTradeUsdc || 2.50, remainingExposureCapacity));
    const minTradeUsdc = asNumber(botState.config.minTradeUsdc, 1.50);

    if (simulatedAmount < minTradeUsdc) {
      return {
        allowed: false,
        amount: 0,
        reason: `Límite de exposición máxima (${botState.config.maxExposurePct}%) alcanzado`,
        freeUsdc: botState.capital,
        polBalance: 0,
        openExposure,
        walletSnapshot: null,
      };
    }

    return {
      allowed: botState.capital >= simulatedAmount,
      amount: simulatedAmount,
      reason: botState.capital >= simulatedAmount ? null : `Capital simulado insuficiente (${botState.capital.toFixed(2)})`,
      freeUsdc: botState.capital,
      polBalance: 0,
      openExposure,
      walletSnapshot: null,
    };
  }

  const snapshot = await refreshWalletSnapshot(true);
  if (!snapshot) {
    return {
      allowed: false,
      amount: 0,
      reason: "No se pudo leer el saldo real de la wallet",
      walletSnapshot: null,
    };
  }

  const rules = {
    ...REAL_TRADING_RULES,
    minTradeUsdc: botState.config.minTradeUsdc,
    maxTradeUsdc: botState.config.maxTradeUsdc,
    maxOpenTrades: botState.config.maxOpenTrades,
    maxExposurePct: botState.config.maxExposurePct,
    reserveUsdc: botState.config.reserveUsdc,
    minPolBalance: botState.config.minPolBalance,
  };

  const plan = computeRealTradePlan({
    walletSnapshot: snapshot,
    openTrades: getOpenTrades(),
    rules,
  });

  return {
    ...plan,
    walletSnapshot: snapshot,
  };
}

function hydrateCapitalFromLocalState() {
  if (isRealTradingEnabled()) return;
  const openExposure = sumOpenExposure(getOpenTrades());
  botState.capital = roundMoney(Math.max(0, botState.capital));
  botState.walletSnapshot = {
    address: null,
    usdcBalance: botState.capital,
    usdcBalanceClob: botState.capital,
    usdcAllowance: null,
    usdcAllowanceReady: true,
    polBalance: null,
    updatedAt: new Date().toISOString(),
    openExposure,
  };
}

function calcStopLoss(entryPrice, entryBid = null) {
  const pctStop = entryPrice * (1 - botState.config.stopLoss / 100);
  // Guarantee at least 3.5c below entryBid (or 4.0c below entryPrice) so normal 1c-2c CLOB spread bounce never triggers premature stop-outs
  const tickFloor = (Number.isFinite(entryBid) && entryBid > 0)
    ? (entryBid - 0.035)
    : (entryPrice - 0.040);
  const stop = Math.min(pctStop, tickFloor);
  return parseFloat(Math.max(0.02, stop).toFixed(4));
}

function calcTakeProfit(entryPrice, fairProb = null) {
  // Volatilidad binaria simétrica sigma_bin = sqrt(p*(1-p))
  // Evita que en precios altos (ej. 0.77) entryPrice * 1.12 pida +9.9¢ imposibles (caso T-MW921A3ZA6DH que llegó a +4.9¢ y se devolvió).
  const p = Math.max(0.05, Math.min(0.95, Number(entryPrice) || 0.5));
  const binarySigma = Math.sqrt(Math.max(0.04, p * (1 - p)));
  const sigmaTargetStep = Math.max(0.036, Math.min(0.052, 0.105 * binarySigma));
  let target = p + sigmaTargetStep;
  if (Number.isFinite(fairProb) && fairProb > p + 0.038) {
    target = Math.max(p + 0.036, Math.min(fairProb - 0.006, p + 0.058));
  }
  return parseFloat(Math.min(0.96, target).toFixed(4));
}

function calcMaxHoldAt(openTs) {
  const openMs = new Date(openTs).getTime();
  if (!Number.isFinite(openMs)) return null;
  const holdMs = Math.max(1, botState.config.maxHoldHours) * 60 * 60 * 1000;
  return new Date(openMs + holdMs).toISOString();
}

function inferExecutionMode(rawTrade) {
  if (rawTrade?.execution_mode) {
    return rawTrade.execution_mode;
  }

  return (
    rawTrade?.buy_order_id ||
    rawTrade?.buy_tx_hashes ||
    rawTrade?.sell_order_id ||
    rawTrade?.sell_tx_hashes ||
    rawTrade?.token_id
  ) ? "REAL" : "SIMULATED";
}

function buildTradeIntegrityPatch(rawTrade) {
  const patch = {};
  const entryPrice = asNumber(rawTrade?.entry_price, 0);
  const tradeTs = rawTrade?.executed_at || new Date().toISOString();
  const currentPrice = asNumber(rawTrade?.current_price, NaN);
  const stopLoss = asNumber(rawTrade?.stop_loss, NaN);
  const takeProfit = asNumber(rawTrade?.take_profit, NaN);

  if (!rawTrade?.condition_id && rawTrade?.market_id) {
    patch.condition_id = rawTrade.market_id;
  }

  if (!rawTrade?.execution_mode) {
    patch.execution_mode = inferExecutionMode(rawTrade);
  }

  if ((!Number.isFinite(currentPrice) || currentPrice <= 0) && entryPrice > 0) {
    patch.current_price = entryPrice;
  }

  if ((!Number.isFinite(stopLoss) || stopLoss <= 0) && entryPrice > 0) {
    patch.stop_loss = calcStopLoss(entryPrice);
  }

  if ((!Number.isFinite(takeProfit) || takeProfit <= 0) && entryPrice > 0) {
    patch.take_profit = calcTakeProfit(entryPrice);
  }

  if (!rawTrade?.max_hold_at) {
    patch.max_hold_at = calcMaxHoldAt(tradeTs);
  }

  if (rawTrade?.break_even_armed === null || rawTrade?.break_even_armed === undefined) {
    patch.break_even_armed = false;
  }

  return patch;
}

function normalizePersistedTrade(rawTrade) {
  const normalized = {
    shares: asNumber(rawTrade?.shares, 0),
    cost: asNumber(rawTrade?.cost, 0),
    currentPrice: asNumber(rawTrade?.current_price || rawTrade?.entry_price, 0),
    swapped: false,
  };

  // Legacy REAL-trade bug: shares and cost were persisted inverted on some fills.
  if (rawTrade?.execution_mode === "REAL" && normalized.shares > 0 && normalized.cost > 0) {
    const implied = normalized.cost / normalized.shares;
    const invertedImplied = normalized.shares / normalized.cost;
    const impliedLooksInvalid = !Number.isFinite(implied) || implied <= 0.01 || implied >= 0.99;
    const invertedLooksValid = Number.isFinite(invertedImplied) && invertedImplied > 0.01 && invertedImplied < 0.99;
    if (impliedLooksInvalid && invertedLooksValid) {
      const originalShares = normalized.shares;
      normalized.shares = normalized.cost;
      normalized.cost = originalShares;
      normalized.swapped = true;
    }
  }

  return normalized;
}

async function reconcileManagedTradesWithWallet() {
  if (!isRealTradingEnabled()) return;

  const managedTrades = getOpenTrades().filter(trade => isRealManagedTrade(trade));
  for (const trade of managedTrades) {
    try {
      const tokenSnapshot = await getConditionalTokenSnapshot(trade.tokenId);
      if (!tokenSnapshot) continue;

      const storedShares = asNumber(trade.shares, 0);
      const walletShares = asNumber(tokenSnapshot.balance, 0);
      if (storedShares <= 0) continue;
      if (walletShares >= (storedShares - 0.000001)) continue;

      const nextShares = parseFloat(Math.max(0, walletShares).toFixed(6));
      const nextCost = roundMoney(storedShares > 0 ? (asNumber(trade.cost, 0) * (nextShares / storedShares)) : 0);
      const nextStatus = nextShares > 0 ? "PARTIAL" : "ERROR";
      const tradeIdx = botState.trades.findIndex(row => row.id === trade.id);
      if (tradeIdx < 0) continue;

      botState.trades[tradeIdx].shares = nextShares;
      botState.trades[tradeIdx].cost = nextCost;
      botState.trades[tradeIdx].status = nextStatus;
      if (nextStatus === "ERROR") {
        botState.trades[tradeIdx].closeReason = botState.trades[tradeIdx].closeReason || "NO_WALLET_BALANCE";
      }

      await updateTradeSafe(
        trade.id,
        {
          shares: nextShares,
          cost: nextCost,
          status: nextStatus,
          close_reason: nextStatus === "ERROR" ? (trade.closeReason || "NO_WALLET_BALANCE") : (trade.closeReason || null),
        },
        {
          shares: nextShares,
          cost: nextCost,
          status: nextStatus,
        }
      );
      await recordOrderEventSafe(trade.id, "WALLET_POSITION_RECONCILED", {
        token_id: trade.tokenId,
        stored_shares: storedShares,
        wallet_shares: nextShares,
        next_cost: nextCost,
        next_status: nextStatus,
      });
      addLog(`🧭 [WALLET] Reconciliado ${trade.id}: DB ${storedShares.toFixed(6)} -> Wallet ${nextShares.toFixed(6)} (${nextStatus})`, "WARN");
    } catch (err) {
      addLog(`⚠️ [WALLET] No se pudo reconciliar ${trade.id}: ${err.message}`, "WARN");
    }
  }
}

let withdrawalConfigWarningPrinted = false;
let backgroundTradePatchPromise = null;

function appendWalletActivity(event) {
  if (!event) return;
  botState.walletActivity.unshift(event);
  if (botState.walletActivity.length > WALLET_ACTIVITY_MAX) {
    botState.walletActivity.length = WALLET_ACTIVITY_MAX;
  }
}

async function loadWithdrawalStateFromDB() {
  botState.withdrawnTotal = 0;
  botState.lastWithdrawalAt = null;
  botState.walletActivity = [];

  try {
    const { data, error } = await supabase
      .from('order_events')
      .select('event_type, payload_json, created_at')
      .eq('trade_id', 'SYSTEM')
      .in('event_type', ['AUTO_WITHDRAWAL', 'AUTO_WITHDRAWAL_ERROR'])
      .order('created_at', { ascending: false })
      .limit(500);

    if (error || !data || data.length === 0) {
      return;
    }

    const activity = data.map((row, idx) => {
      const payload = row?.payload_json || {};
      const ts = row.created_at || new Date().toISOString();
      return {
        id: `WE-${Date.parse(ts) || Date.now()}-${idx}`,
        ts,
        eventType: row.event_type,
        amountUsdc: asNumber(payload.amount_usdc, 0),
        txHash: payload.tx_hash || null,
        to: payload.to || null,
        from: payload.from || null,
        trigger: payload.trigger || null,
        error: payload.error || null,
      };
    });

    botState.walletActivity = activity.slice(0, WALLET_ACTIVITY_MAX);
    const latestSuccess = activity.find(e => e.eventType === "AUTO_WITHDRAWAL");
    botState.lastWithdrawalAt = latestSuccess?.ts || null;
    const withdrawnTotal = activity.reduce((sum, row) => {
      if (row.eventType !== "AUTO_WITHDRAWAL") return sum;
      return sum + asNumber(row.amountUsdc, 0);
    }, 0);
    botState.withdrawnTotal = parseFloat(withdrawnTotal.toFixed(2));
  } catch {
    // Best-effort restore. If this fails, autopilot still works with in-memory counters.
  }
}

function scheduleTradePatchNormalization(patches) {
  if (!Array.isArray(patches) || patches.length === 0) return;
  if (backgroundTradePatchPromise) return;

  backgroundTradePatchPromise = (async () => {
    console.log(`⚙️ Normalizando ${patches.length} trade(s) históricos en Supabase...`);
    for (const patch of patches) {
      const patchErr = await updateTradeRowResilient(patch.tradeId, patch.fields);
      if (patchErr) {
        console.warn(`⚠️ No se pudo corregir trade ${patch.tradeId}: ${patchErr.message}`);
      }
    }
    console.log("✅ Normalización histórica completada.");
  })()
    .catch(err => {
      console.warn(`⚠️ Normalización histórica falló: ${err.message}`);
    })
    .finally(() => {
      backgroundTradePatchPromise = null;
    });
}

// â”€â”€ RECONSTRUCCIÃ“N SÃ“LIDA DESDE SUPABASE â”€â”€
export async function initializeStateFromDB() {
  console.log("ðŸ”„ Cincronizando cerebro con Supabase (Base de Datos)...");
  try {
    // 1. Descargar trades y señales históricas en paralelo para cruzar metadatos completos
    const [tradesRes, signalsRes] = await Promise.all([
      supabase.from('user_trades').select('*').order('executed_at', { ascending: false }),
      supabase.from('ai_signals').select('*').order('detected_at', { ascending: false }).limit(250),
    ]);

    if (tradesRes.error) throw tradesRes.error;
    const tradesDb = tradesRes.data || [];
    const signalsDb = signalsRes.data || [];

    await loadWithdrawalStateFromDB();

    // Preservar señales SKIP en la base de datos para auditoría contra sesgo de selección (Fase 1)
    const corruptSignalIds = signalsDb
      .filter(s => !s.question || !s.action)
      .map(s => s.signal_id)
      .filter(Boolean);

    if (corruptSignalIds.length > 0) {
      supabase.from('ai_signals').delete().in('signal_id', corruptSignalIds).then(() => {}).catch(() => {});
    }

    // Indexar señales válidas para enriquecer trades y pestaña de Noticias
    const validSignalsDb = signalsDb.filter(
      s => (s.action === "BUY_YES" || s.action === "BUY_NO") && asNumber(s.confidence, 0) > 0
    );

    const signalById = new Map();
    const latestSignalByMarket = new Map();

    for (const s of validSignalsDb) {
      const mId = String(s.market_id || s.condition_id || "");
      const conf = asNumber(s.confidence, 70);
      const edge = asNumber(s.edge_pct, 8);
      const computedScore = computeSignalScore(asNumber(s.score, 70), conf, edge, 3, asNumber(s.score, 0));
      const sigTypes = inferSignalTypesFromText(s.news_found, s.reasoning, edge);
      const yesP = asNumber(s.yes_price, 0.5);
      const noP = asNumber(s.no_price, 0.5);
      const isYes = s.action === "BUY_YES";
      const sideAsk = isYes ? yesP : noP;
      const fairSideProb = Math.max(0.02, Math.min(0.98, sideAsk + (edge / 100)));
      const fairYesProb = isYes ? fairSideProb : (1 - fairSideProb);

      const enrichedSig = {
        id: s.signal_id,
        detectedAt: s.detected_at || new Date().toISOString(),
        market: {
          id: s.market_id,
          conditionId: s.condition_id || s.market_id,
          question: s.question,
          _cat: detectCategory(s.question || ""),
          _yesTokenId: s.yes_token_id || null,
          _noTokenId: s.no_token_id || null,
        },
        tokenIds: { yes: s.yes_token_id || null, no: s.no_token_id || null },
        prelim: {
          yesP,
          noP,
          sum: yesP + noP,
          score: computedScore,
          signals: sigTypes,
        },
        analysis: {
          action: s.action,
          score: computedScore,
          confidence: conf,
          edge_pct: edge,
          fair_prob: Number(fairSideProb.toFixed(4)),
          fair_value_yes: Number(fairYesProb.toFixed(4)),
          executable_ask: Number(sideAsk.toFixed(4)),
          news_found: s.news_found || "",
          news_source: "Google News RSS / Polymarket Intelligence",
          reasoning: s.reasoning || "",
          risk: conf >= 78 ? "LOW" : "MEDIUM",
          liquidity_ok: true,
          confluence_score: conf >= 75 ? 4 : 3,
          signal_types: sigTypes,
        },
        executed: false,
      };

      if (s.signal_id) signalById.set(String(s.signal_id), enrichedSig);
      if (mId && !latestSignalByMarket.has(mId)) {
        latestSignalByMarket.set(mId, enrichedSig);
      }

      const cleanNews = String(s.news_found || "").trim();
      if (
        mId &&
        cleanNews &&
        cleanNews !== "none" &&
        !cleanNews.startsWith("Image ") &&
        !/sin noticias recientes/i.test(cleanNews) &&
        !botState.newsCache[mId]
      ) {
        botState.newsCache[mId] = {
          ts: s.detected_at ? new Date(s.detected_at).getTime() : Date.now(),
          context: cleanNews,
          source: "Google News RSS / Web",
          snippet: cleanNews,
          hasFreshNews: !/no recent catalyst|older news/i.test(cleanNews),
          news: cleanNews,
          question: s.question,
          category: detectCategory(s.question || ""),
        };
      }
    }

    let totalPnl = 0;
    let todayPnl = 0;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const patches = [];
    const executedSignalIds = new Set();
    const tradedMarketIds = new Set();

    const loadedTrades = tradesDb.map(t => {
      const integrityPatch = buildTradeIntegrityPatch(t);
      const normalized = normalizePersistedTrade(t);
      if (normalized.swapped) {
        integrityPatch.shares = normalized.shares;
        integrityPatch.cost = normalized.cost;
      }

      if (Object.keys(integrityPatch).length > 0) {
        patches.push({
          tradeId: t.trade_id,
          fields: integrityPatch,
        });
      }

      const pnlVal = t.status === 'CLOSED' ? (t.pnl || 0) : 0;
      totalPnl += pnlVal;

      if (t.status === 'CLOSED' && t.closed_at && t.closed_at.startsWith(todayStr)) {
        todayPnl += pnlVal;
      }

      const entryPrice = asNumber(t.entry_price, 0);
      const tradeTs = t.executed_at || new Date().toISOString();
      const persistedStopLoss = asNumber(t.stop_loss ?? integrityPatch.stop_loss, 0);
      const persistedTakeProfit = asNumber(t.take_profit ?? integrityPatch.take_profit, 0);
      const persistedCurrentPrice = asNumber(t.current_price ?? integrityPatch.current_price ?? t.entry_price, 0);
      const executionMode = t.execution_mode || integrityPatch.execution_mode || inferExecutionMode(t);

      const mKey = String(t.market_id || t.condition_id || "");
      if (t.signal_id) executedSignalIds.add(String(t.signal_id));
      if (mKey && t.close_reason !== "CLEANUP_SIMULATED") tradedMarketIds.add(mKey);

      const linkedSig = (t.signal_id && signalById.get(String(t.signal_id))) || latestSignalByMarket.get(mKey) || null;
      const category = detectCategory(t.question || "");
      const conf = asNumber(linkedSig?.analysis?.confidence, 70);
      const edgePct = asNumber(linkedSig?.analysis?.edge_pct, 9.5);
      const reasoning = linkedSig?.analysis?.reasoning || `Entrada cuantitativa en ${t.side} @ ${(entryPrice * 100).toFixed(1)}¢ validada por libro de órdenes CLOB.`;
      const news = linkedSig?.analysis?.news_found || "";
      const signalTypes = linkedSig?.analysis?.signal_types || inferSignalTypesFromText(news, reasoning, edgePct);

      const baseTrade = {
        id: t.trade_id,
        signalId: t.signal_id || linkedSig?.id || null,
        ts: tradeTs,
        question: t.question,
        marketId: t.market_id,
        category,
        action: t.side === "YES" ? "BUY_YES" : "BUY_NO",
        side: t.side,
        entryPrice,
        conditionId: t.condition_id || integrityPatch.condition_id || t.market_id,
        tokenId: t.token_id || null,
        currentPrice: persistedCurrentPrice > 0 ? persistedCurrentPrice : normalized.currentPrice,
        shares: normalized.shares,
        cost: normalized.cost,
        confidence: conf,
        edge_pct: edgePct,
        score: asNumber(linkedSig?.analysis?.score, 75),
        risk: linkedSig?.analysis?.risk || "MEDIUM",
        signal_types: signalTypes,
        reasoning,
        news,
        status: t.status,
        pnl: pnlVal,
        closedAt: t.closed_at || null,
        executionMode,
        buyOrderId: t.buy_order_id || null,
        buyOrderStatus: t.buy_order_status || null,
        buyTxHashes: t.buy_tx_hashes || null,
        sellOrderId: t.sell_order_id || null,
        sellOrderStatus: t.sell_order_status || null,
        sellTxHashes: t.sell_tx_hashes || null,
        closeReason: t.close_reason || null,
        stopLoss: persistedStopLoss > 0 ? persistedStopLoss : calcStopLoss(entryPrice),
        takeProfit: persistedTakeProfit > 0 ? persistedTakeProfit : calcTakeProfit(entryPrice),
        breakEvenArmed: Boolean(t.break_even_armed ?? integrityPatch.break_even_armed),
        maxHoldAt: t.max_hold_at || integrityPatch.max_hold_at || calcMaxHoldAt(tradeTs),
        strategyVersion: t.strategy_version || "legacy-pre-v3",
        mfePrice: asNumber(t.mfe_price, Math.max(entryPrice, persistedCurrentPrice)),
        maePrice: asNumber(t.mae_price, Math.min(entryPrice, persistedCurrentPrice > 0 ? persistedCurrentPrice : entryPrice)),
        feeRateBps: asNumber(t.fee_rate_bps, 0),
        entryFeeUsd: asNumber(t.entry_fee_usd, 0),
        exitFeeUsd: asNumber(t.exit_fee_usd, 0),
        frictionDeducted: true,
      };

      const econ = computeTradeEconomics(baseTrade);
      return {
        ...baseTrade,
        ...econ,
      };
    });

    scheduleTradePatchNormalization(patches);

    botState.trades = loadedTrades;
    const activeSimulatedCost = loadedTrades
      .filter(t => isActiveTradeStatus(t.status) && t.executionMode !== "REAL")
      .reduce((sum, t) => sum + asNumber(t.cost, 0), 0);
    botState.capital = parseFloat((BASE_CAPITAL + totalPnl - activeSimulatedCost - botState.withdrawnTotal).toFixed(2));
    if (botState.capital < 0) botState.capital = 0;
    botState.dailyPnl = parseFloat(todayPnl.toFixed(2));
    botState.dailyDate = todayStr;

    if (botState.signals.length === 0 && signalById.size > 0) {
      botState.signals = Array.from(signalById.values()).map(sig => ({
        ...sig,
        executed: executedSignalIds.has(String(sig.id)) || tradedMarketIds.has(String(sig.market.id || sig.market.conditionId || "")),
      }));
    }

    if (botState.logEntries.length < 5) {
      const recentEvents = [];
      for (const t of loadedTrades.slice(0, 12)) {
        if (t.closeReason === "CLEANUP_SIMULATED") continue;
        if (t.status === "CLOSED") {
          recentEvents.push({
            id: `LOG-C-${t.id}`,
            ts: t.closedAt || t.ts,
            type: t.pnl >= 0 ? "WIN" : "LOSS",
            msg: `🤖 [HISTORIAL DB] Cierre ${t.id} (${t.closeReason || "AUTO"}) @ ${fmtPct(t.currentPrice)} | P&L: ${t.pnl >= 0 ? "+" : ""}$${Number(t.pnl).toFixed(2)} (Fricción Pool/Gas: -$${t.frictionUsd.toFixed(3)})`,
          });
        } else {
          recentEvents.push({
            id: `LOG-O-${t.id}`,
            ts: t.ts,
            type: "TRADE",
            msg: `🚀 [POSICIÓN ACTIVA] ${t.side} en "${(t.question || "").slice(0, 48)}..." | Entrada: ${fmtPct(t.entryPrice)} | Bid: ${fmtPct(t.currentPrice)} | SL: ${fmtPct(t.stopLoss)} | TP: ${fmtPct(t.takeProfit)}`,
          });
        }
      }
      recentEvents.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
      botState.logEntries.push(...recentEvents);
    }
    
    if (botState.dailyPnl >= DAILY_GOAL) {
      botState.goalReached = true;
    }

    if (isRealTradingEnabled()) {
      await refreshWalletSnapshot(true);
      await reconcileManagedTradesWithWallet();
      await refreshWalletSnapshot(true);
      await refreshDbReadiness(true);
    } else {
      hydrateCapitalFromLocalState();
      await refreshDbReadiness(true);
    }

    console.log(`âœ… Base de datos sincronizada. Capital vivo: $${botState.capital} | P&L Hoy: $${botState.dailyPnl}`);
    console.log(`[RISK] TP=${botState.config.takeProfit}% | SL=${botState.config.stopLoss}% | BreakEven@${botState.config.breakEvenTriggerPct}% | MaxHold=${botState.config.maxHoldHours}h | DailyGoal=$${DAILY_GOAL.toFixed(2)}`);
    if (!botState.dbReadiness.autoTradeReady) {
      console.warn(`[READINESS] Auto-trading real bloqueado: ${botState.dbReadiness.blockers.join(" | ")}`);
    }
    if (isWithdrawalAutopilotConfigured()) {
      console.log(`[WITHDRAW] enabled -> target=${WITHDRAWAL_TARGET_ADDRESS} floor=${WITHDRAWAL_OPERATING_CAPITAL_USDC} minExcess=${WITHDRAWAL_MIN_EXCESS_USDC} ratio=${(WITHDRAWAL_EXCESS_RATIO * 100).toFixed(0)}% cooldown=${WITHDRAWAL_COOLDOWN_HOURS}h`);
    } else {
      console.log("[WITHDRAW] disabled or missing target address.");
    }
  } catch (err) {
    console.error("âŒ FALLO AL SINCRONIZAR SUPABASE:", err.message);
    console.log("âš ï¸ Iniciando con valores por defecto... cuidado.");
  }
}

// â”€â”€ AYUDANTES â”€â”€
function uid() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function parseTokenIds(m = {}) {
  let clobTokenIds = m.clobTokenIds;

  if (typeof clobTokenIds === "string") {
    try {
      clobTokenIds = JSON.parse(clobTokenIds);
    } catch {
      clobTokenIds = [];
    }
  }

  if (Array.isArray(clobTokenIds) && clobTokenIds.length >= 2) {
    return { yesTokenId: String(clobTokenIds[0]), noTokenId: String(clobTokenIds[1]) };
  }

  if (Array.isArray(m.tokens) && m.tokens.length >= 2) {
    const byOutcome = {};
    for (const token of m.tokens) {
      const key = String(token?.outcome || "").trim().toUpperCase();
      if (key) byOutcome[key] = String(token?.token_id || token?.id || "");
    }
    if (byOutcome.YES && byOutcome.NO) {
      return { yesTokenId: byOutcome.YES, noTokenId: byOutcome.NO };
    }
  }

  return { yesTokenId: null, noTokenId: null };
}
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
  if (Math.abs(asNumber(edgePct, 0)) >= 4 || /mispric|fair|prob|microprice|edge|barrier|oracle/i.test(r)) {
    types.add("MISPRICING");
  }
  if (types.size === 0) types.add("MISPRICING");
  return Array.from(types);
}

function computeSignalScore(prelimScore = 0, conf = 0, edgePct = 0, confluenceScore = 3, rawScore = 0) {
  const basePrelim = Math.min(35, Math.max(18, asNumber(prelimScore, 60) * 0.42));
  const confPart = Math.min(30, Math.max(0, (asNumber(conf, 70) - 40) * 0.62));
  const edgePart = Math.min(20, Math.max(0, Math.abs(asNumber(edgePct, 8)) * 1.15));
  const confBonus = Math.min(15, Math.max(0, asNumber(confluenceScore, 3) * 3.75));
  const calc = Math.round(Math.min(99, Math.max(52, basePrelim + confPart + edgePart + confBonus)));
  const llmScore = asNumber(rawScore, 0);
  return (llmScore >= 45 && llmScore <= 100) ? Math.round((llmScore * 0.45) + (calc * 0.55)) : calc;
}

export function isCryptoTargetPriceMarket(question = "") {
  const q = String(question || "");
  const hasSupportedSpotAsset = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge)\b/i.test(q);
  const hasExplicitDollarTarget = /\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k)?\b/i.test(q);
  const isUpOrDownNoTarget = /\bup or down\b/i.test(q) && !hasExplicitDollarTarget;
  return hasSupportedSpotAsset && hasExplicitDollarTarget && !isUpOrDownNoTarget;
}

function computeTradeEconomics(trade) {
  const shares       = Math.max(0, asNumber(trade.shares, 0));
  const entryPrice   = Math.max(0.001, asNumber(trade.entryPrice, 0.5));
  const cost         = Math.max(0, asNumber(trade.cost, shares * entryPrice));
  const currentPrice = Math.max(0.001, asNumber(trade.currentPrice ?? trade.closePrice ?? trade.entryPrice, entryPrice));
  const isClosed     = trade.status === "CLOSED";
  const feeRateBps   = Math.max(0, asNumber(trade.feeRateBps, 0));

  // 1. Entry Fee (v3.1.0 Maker-First): entradas Limit pasivas pagan 0% fee CLOB ($0.004 gas); si el trade persistió entryFeeUsd explícito, se respeta
  const isMakerEntry = trade.executionStyle === "MAKER_LIMIT" || (!isRealTradingEnabled() && asNumber(trade.entryFeeUsd, -1) === 0.004);
  const entryFeeUsd = asNumber(trade.entryFeeUsd, -1) >= 0
    ? asNumber(trade.entryFeeUsd, 0)
    : (isMakerEntry
        ? 0.004
        : computePolymarketTakerFeeUsd({
            shares: shares > 0 ? shares : (cost / entryPrice),
            price: entryPrice,
            feeRateBps,
            minSimRate: 0.0035,
            gasUsd: 0.004,
          }));

  // 2. Exit Fee: En TAKE_PROFIT / TIME_DECAY_PROFIT_HARVEST (orden Limit Maker pasiva) el fee CLOB es 0% ($0.004 gas).
  // En STOP_LOSS / THESIS_INVALIDATED / cierres Taker al bid se aplica la fórmula cuadrática oficial de Polymarket CLOB.
  const exitPx          = isClosed ? asNumber(trade.closePrice ?? trade.currentPrice, currentPrice) : currentPrice;
  const isPassiveMakerExit = trade.closeReason === "TAKE_PROFIT" || trade.closeReason === "TIME_DECAY_PROFIT_HARVEST";
  const isEmergencyStop = trade.closeReason === "STOP_LOSS" || trade.closeReason === "THESIS_INVALIDATED";
  const exitFeeRate     = isEmergencyStop ? 0.0050 : 0.0035;

  const exitFeeUsd = isClosed
    ? (asNumber(trade.exitFeeUsd, -1) >= 0
        ? asNumber(trade.exitFeeUsd, 0)
        : (isPassiveMakerExit
            ? 0.004
            : computePolymarketTakerFeeUsd({
                shares,
                price: exitPx,
                feeRateBps,
                minSimRate: exitFeeRate,
                gasUsd: 0.004,
              })))
    : 0.004;

  const totalFrictionUsd = Number((entryFeeUsd + (isClosed ? exitFeeUsd : 0)).toFixed(3));

  // 3. Cálculo único y transparente de PnL (Sin doble resta de comisiones)
  const rawPricePnl = roundMoney((exitPx - entryPrice) * shares);
  const recordedPnl = isClosed ? asNumber(trade.pnl, rawPricePnl - totalFrictionUsd) : rawPricePnl;
  const netPnl      = (isClosed && trade.frictionDeducted !== false)
    ? roundMoney(recordedPnl)
    : roundMoney(recordedPnl - totalFrictionUsd);

  return {
    entryFeeUsd: Number(entryFeeUsd.toFixed(3)),
    exitFeeUsd: Number(exitFeeUsd.toFixed(3)),
    frictionUsd: totalFrictionUsd,
    totalFrictionUsd,
    grossPnl: rawPricePnl,
    pnl: isClosed ? netPnl : asNumber(trade.pnl, 0),
    netPnlAfterFriction: netPnl,
    frictionDeducted: true,
  };
}

function fmtPct(n) { return `${(n * 100).toFixed(2)}%`; }

export function addLog(msg, type = "INFO") {
  const e = { id: uid(), ts: new Date().toISOString(), msg, type };
  botState.logEntries.unshift(e);
  if (botState.logEntries.length > 2000) botState.logEntries.length = 2000;
  console.log(`[${type}] ${msg}`);
}

async function insertDecisionLogSafe(m, pre, analysis) {
  const yesBook = pre?.yesBook || pre?.clob?.yes || null;
  const noBook  = pre?.noBook || pre?.clob?.no || null;
  const entry = {
    decision_id: `DEC-${uid().toUpperCase()}`,
    market_id: String(m?.id || m?.conditionId || ""),
    condition_id: String(m?.conditionId || m?.condition_id || m?.id || ""),
    question: m?.question || "",
    category: m?._cat || detectCategory(m?.question || ""),
    strategy_version: STRATEGY_VERSION,
    action: analysis?.action || "SKIP",
    considered_side: analysis?.considered_side || null,
    skip_reason: analysis?.skip_reason || null,
    yes_bid: yesBook?.bestBid ?? null,
    yes_ask: yesBook?.bestAsk ?? pre?.yesP ?? null,
    no_bid: noBook?.bestBid ?? null,
    no_ask: noBook?.bestAsk ?? pre?.noP ?? null,
    spread_pct: analysis?.spread_pct ?? yesBook?.spreadPct ?? noBook?.spreadPct ?? null,
    w_obi: analysis?.obi ?? yesBook?.wObi ?? null,
    eti_imbalance: analysis?.tape_imbalance ?? pre?.tradeFlow?.tapeImbalance ?? null,
    spot_price: analysis?.spot_price ?? null,
    target_price: analysis?.target_price ?? null,
    math_yes_prob: analysis?.math_yes_prob ?? null,
    fair_prob: analysis?.fair_prob ?? null,
    net_edge_pct: analysis?.edge_pct ?? 0,
    fee_rate_bps: analysis?.fee_rate_bps ?? yesBook?.feeRateBps ?? noBook?.feeRateBps ?? 0,
    confidence: analysis?.confidence ?? 0,
    evaluated_at: new Date().toISOString(),
  };

  botState.decisionLog.unshift(entry);
  if (botState.decisionLog.length > 500) botState.decisionLog.length = 500;

  try {
    await supabase.from('decision_log').insert(entry);
  } catch {
    // Non-blocking if decision_log migration has not been applied yet
  }
}

async function insertAiSignalSafe(sig, m, pre, analysis) {
  try {
    const payload = {
      signal_id: sig.id,
      market_id: m.id || m.conditionId,
      condition_id: m.conditionId || m.condition_id || m.id,
      yes_token_id: m._yesTokenId || null,
      no_token_id: m._noTokenId || null,
      question: m.question,
      action: analysis.action,
      score: analysis.score,
      confidence: analysis.confidence,
      edge_pct: analysis.edge_pct,
      yes_price: pre.yesP,
      no_price: pre.noP,
      news_found: analysis.news_found,
      reasoning: `[${STRATEGY_VERSION}] ${analysis.reasoning || ""}`.trim(),
      strategy_version: STRATEGY_VERSION,
      detected_at: sig.detectedAt,
    };

    const { error } = await supabase.from('ai_signals').insert(payload);
    if (!error) return;

    const fallback = {
      signal_id: sig.id,
      market_id: m.id || m.conditionId,
      question: m.question,
      action: analysis.action,
      score: analysis.score,
      confidence: analysis.confidence,
      edge_pct: analysis.edge_pct,
      yes_price: pre.yesP,
      no_price: pre.noP,
      news_found: analysis.news_found,
      reasoning: analysis.reasoning,
      detected_at: sig.detectedAt,
    };
    await supabase.from('ai_signals').insert(fallback);
  } catch (err) {
    addLog(`âš ï¸ Error guardando ai_signal: ${err.message}`, "WARN");
  }
}

async function insertTradeSafe(t, signalId) {
  try {
    const payload = {
      trade_id: t.id,
      signal_id: signalId,
      market_id: t.marketId,
      condition_id: t.conditionId || t.marketId,
      token_id: t.tokenId || null,
      question: t.question,
      side: t.side,
      entry_price: t.entryPrice,
      current_price: t.currentPrice,
      shares: t.shares,
      cost: t.cost,
      status: t.status,
      execution_mode: t.executionMode || "SIMULATED",
      stop_loss: t.stopLoss ?? null,
      take_profit: t.takeProfit ?? null,
      break_even_armed: Boolean(t.breakEvenArmed),
      max_hold_at: t.maxHoldAt || null,
      strategy_version: t.strategyVersion || STRATEGY_VERSION,
      mfe_price: t.mfePrice ?? t.currentPrice ?? t.entryPrice,
      mae_price: t.maePrice ?? t.currentPrice ?? t.entryPrice,
      entry_fee_usd: t.entryFeeUsd ?? null,
      fee_rate_bps: t.feeRateBps ?? 0,
      buy_order_id: t.buyOrderId || null,
      buy_order_status: t.buyOrderStatus || null,
      buy_tx_hashes: t.buyTxHashes || null,
      executed_at: t.ts,
    };

    const { error } = await supabase.from('user_trades').insert(payload);
    if (!error) return;

    const fallbackWithSlTp = {
      trade_id: t.id,
      signal_id: signalId,
      market_id: t.marketId,
      condition_id: t.conditionId || t.marketId,
      token_id: t.tokenId || null,
      question: t.question,
      side: t.side,
      entry_price: t.entryPrice,
      current_price: t.currentPrice,
      shares: t.shares,
      cost: t.cost,
      status: t.status,
      execution_mode: t.executionMode || "SIMULATED",
      stop_loss: t.stopLoss ?? null,
      take_profit: t.takeProfit ?? null,
      break_even_armed: Boolean(t.breakEvenArmed),
      max_hold_at: t.maxHoldAt || null,
      buy_order_id: t.buyOrderId || null,
      buy_order_status: t.buyOrderStatus || null,
      buy_tx_hashes: t.buyTxHashes || null,
      executed_at: t.ts,
    };
    const { error: err2 } = await supabase.from('user_trades').insert(fallbackWithSlTp);
    if (!err2) return;

    const fallback = {
      trade_id: t.id,
      signal_id: signalId,
      market_id: t.marketId,
      question: t.question,
      side: t.side,
      entry_price: t.entryPrice,
      shares: t.shares,
      cost: t.cost,
      status: t.status,
      executed_at: t.ts,
    };
    await supabase.from('user_trades').insert(fallback);
  } catch (err) {
    addLog(`âš ï¸ Error guardando trade ${t.id}: ${err.message}`, "WARN");
  }
}

function stripUnsupportedColumn(fields, errorMessage) {
  const match = /Could not find the '([^']+)' column/i.exec(String(errorMessage || ""));
  if (!match) return null;

  const column = match[1];
  if (!(column in (fields || {}))) return null;

  const nextFields = { ...(fields || {}) };
  delete nextFields[column];
  return Object.keys(nextFields).length > 0 ? nextFields : {};
}

async function updateTradeRowResilient(tradeId, fields) {
  let nextFields = { ...(fields || {}) };
  let lastError = null;

  while (nextFields && Object.keys(nextFields).length > 0) {
    const { error } = await supabase.from('user_trades').update(nextFields).match({ trade_id: tradeId });
    if (!error) return null;

    lastError = error;
    const stripped = stripUnsupportedColumn(nextFields, error.message);
    if (stripped === null) {
      break;
    }
    if (Object.keys(stripped).length === 0) {
      return null;
    }
    nextFields = stripped;
  }

  return lastError;
}

async function updateTradeSafe(tradeId, fields, fallbackFields = null) {
  try {
    const error = await updateTradeRowResilient(tradeId, fields);
    if (!error || !fallbackFields) return;

    const fallbackError = await updateTradeRowResilient(tradeId, fallbackFields);
    if (fallbackError) {
      throw fallbackError;
    }
  } catch (err) {
    addLog(`âš ï¸ Error actualizando trade ${tradeId}: ${err.message}`, "WARN");
  }
}

async function recordOrderEventSafe(tradeId, eventType, payload) {
  try {
    const { error } = await supabase.from('order_events').insert({
      trade_id: tradeId,
      event_type: eventType,
      payload_json: payload,
      created_at: new Date().toISOString(),
    });
    if (error) return;
  } catch (err) {
    // Best-effort audit log.
  }
}

function isWithdrawalAutopilotConfigured() {
  return isRealTradingEnabled() && AUTO_WITHDRAW_ENABLED && !!WITHDRAWAL_TARGET_ADDRESS;
}

export async function runWithdrawalAutopilot(trigger = "SYNC") {
  if (!isRealTradingEnabled() || !AUTO_WITHDRAW_ENABLED) return;

  if (!WITHDRAWAL_TARGET_ADDRESS) {
    if (!withdrawalConfigWarningPrinted) {
      withdrawalConfigWarningPrinted = true;
      addLog("⚠️ [RETIRO AUTO] Falta WITHDRAWAL_TARGET_ADDRESS. Autopilot de retiro pausado.", "WARN");
    }
    return;
  }

  const cooldownMs = Math.max(0, WITHDRAWAL_COOLDOWN_HOURS) * 60 * 60 * 1000;
  const lastTs = botState.lastWithdrawalAt ? new Date(botState.lastWithdrawalAt).getTime() : 0;
  if (cooldownMs > 0 && Number.isFinite(lastTs) && (Date.now() - lastTs) < cooldownMs) {
    return;
  }

  try {
    const snapshot = await refreshWalletSnapshot(true);
    if (!snapshot) return;

    if (isSameAddress(snapshot.address, WITHDRAWAL_TARGET_ADDRESS)) {
      addLog("⚠️ [RETIRO AUTO] Wallet destino coincide con la wallet operativa. Retiro cancelado.", "WARN");
      return;
    }

    const freeUsdc = asNumber(snapshot.usdcBalance, 0);
    const polBalance = asNumber(snapshot.polBalance, 0);
    if (polBalance < WITHDRAWAL_MIN_POL_BALANCE) return;

    const openExposure = sumOpenExposure(getOpenTrades());
    const reserveFloor = Math.max(
      WITHDRAWAL_OPERATING_CAPITAL_USDC,
      asNumber(botState.config.reserveUsdc, 0)
    );
    const excessUsdc = freeUsdc - reserveFloor;
    if (excessUsdc < WITHDRAWAL_MIN_EXCESS_USDC) return;

    let withdrawAmount = parseFloat((excessUsdc * WITHDRAWAL_EXCESS_RATIO).toFixed(6));
    withdrawAmount = Math.min(withdrawAmount, parseFloat(excessUsdc.toFixed(6)));
    if (withdrawAmount < WITHDRAWAL_MIN_TRANSFER_USDC) return;

    const transfer = await transferUsdc({
      to: WITHDRAWAL_TARGET_ADDRESS,
      amountUsdc: withdrawAmount,
    });

    const nowIso = new Date().toISOString();
    botState.lastWithdrawalAt = nowIso;
    botState.withdrawnTotal = parseFloat((botState.withdrawnTotal + withdrawAmount).toFixed(2));
    await refreshWalletSnapshot(true);

    addLog(
      `💸 [RETIRO AUTO] ${withdrawAmount.toFixed(2)} USDC -> ${WITHDRAWAL_TARGET_ADDRESS.slice(0, 6)}...${WITHDRAWAL_TARGET_ADDRESS.slice(-4)} | tx: ${transfer.txHash} | trigger: ${trigger}`,
      "SYSTEM"
    );
    appendWalletActivity({
      id: `WE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: nowIso,
      eventType: "AUTO_WITHDRAWAL",
      amountUsdc: withdrawAmount,
      txHash: transfer.txHash,
      to: WITHDRAWAL_TARGET_ADDRESS,
      from: transfer.from,
      trigger,
      error: null,
    });

    await recordOrderEventSafe("SYSTEM", "AUTO_WITHDRAWAL", {
      amount_usdc: withdrawAmount,
      tx_hash: transfer.txHash,
      to: WITHDRAWAL_TARGET_ADDRESS,
      from: transfer.from,
      trigger,
      free_usdc_before: freeUsdc,
      open_exposure_usdc: openExposure,
      operating_floor_usdc: reserveFloor,
      excess_ratio: WITHDRAWAL_EXCESS_RATIO,
      created_at: nowIso,
    });
  } catch (err) {
    addLog(`❌ [RETIRO AUTO] Falló retiro: ${err.message}`, "ERROR");
    appendWalletActivity({
      id: `WE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
      eventType: "AUTO_WITHDRAWAL_ERROR",
      amountUsdc: 0,
      txHash: null,
      to: WITHDRAWAL_TARGET_ADDRESS || null,
      from: null,
      trigger,
      error: err.message,
    });
    await recordOrderEventSafe("SYSTEM", "AUTO_WITHDRAWAL_ERROR", {
      error: err.message,
      target: WITHDRAWAL_TARGET_ADDRESS || null,
      trigger,
      created_at: new Date().toISOString(),
    });
  }
}

// ── POLYMARKET API ──
async function fetchAllMarkets(onProgress) {
  const all = [];
  let offset = 0;
  const limit = 100;
  let page = 1;

  while (true) {
    if (onProgress) onProgress(`Descargando página ${page} (offset ${offset})…`);
    const url = `${API_POLY}?limit=${limit}&offset=${offset}&active=true&closed=false&order=volume24hr&ascending=false`;
    const r = await fetch(url, {
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
    if (page > 12) break; // Top 1,200 mercados ordenados por volumen 24h real
    await new Promise(res => setTimeout(res, 180));
  }
  return all;
}

// ── SCORING PRELIMINAR CUANTITATIVO ──
export function preliminaryScore(m, prevSnapshot) {
  // 0. ESTRATEGIA v3.0.0-crypto-oracle (Fase 0 y Fase 3A):
  // Bloquear categorías sin ventaja cuantitativa (POLITICS, SPORTS, ENTERTAINMENT, OTHER, etc.)
  // y restringir únicamente a mercados CRYPTO con precio objetivo explícito ($ target) verificable en oráculo Spot Kraken.
  const cat = m._cat || detectCategory(m.question || "");
  if (!ALLOWED_TRADING_CATEGORIES.includes(cat) || !isCryptoTargetPriceMarket(m.question || "")) {
    return { score: 0, signals: [], skip: true, skipReason: "NON_CRYPTO_TARGET_MARKET" };
  }

  // 1. Validar que el mercado tenga Order Book activo en CLOB
  if (m.enableOrderBook === false || m.acceptingOrders === false) {
    return { score: 0, signals: [], skip: true };
  }

  let p = [0.5, 0.5];
  try { p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || [0.5, 0.5]); } catch (e) {}

  const yesP = parseFloat(p[0]);
  const noP = parseFloat(p[1]);
  if (!Number.isFinite(yesP) || !Number.isFinite(noP)) {
    return { score: 0, signals: [], skip: true };
  }

  // 2. Descartar precios extremos donde el payoff asimétrico o el costo de cruzar el spread destruye el EV
  if (yesP < 0.07 || yesP > 0.93 || noP < 0.07 || noP > 0.93) {
    return { score: 0, signals: [], skip: true };
  }

  // 3. Validar tokens CLOB existentes
  const { yesTokenId, noTokenId } = parseTokenIds(m);
  if (!yesTokenId && !noTokenId) {
    return { score: 0, signals: [], skip: true };
  }

  const vol = parseFloat(m.volume || 0);
  const vol24 = parseFloat(m.volume24hr || m.volumeNum || 0);
  const liq = parseFloat(m.liquidityNum || m.liquidity || 0);
  const sum = yesP + noP;
  const signals = [];
  let score = 0;

  if (liq < botState.config.minLiq) return { score: 0, signals: [], skip: true };
  if (vol24 < 500) return { score: 0, signals: [], skip: true }; // Evitar mercados muertos sin flujo diario

  // 4. Filtro estricto de horizonte temporal Fase 3A (entre 18 horas y 7.5 días):
  // Usa primero m.endDate (ISO con hora exacta) antes que m.endDateIso (solo fecha) y bloquea mercados del mismo día (< 0.75d = 18h)
  // donde la gamma intradía y las mechas cortas barren posiciones.
  let daysLeft = null;
  if (m.endDate || m.endDateIso) {
    const closes = new Date(m.endDate || m.endDateIso);
    daysLeft = (closes - Date.now()) / 86400000;
    if (!Number.isFinite(daysLeft) || daysLeft < 0.75) {
      // Menos de 18 horas o ya expirado: evitar mercados del mismo día con gamma extrema y Taker fee cuadrático alto
      return { score: 0, signals: [], skip: true };
    }
    if (daysLeft > Math.min(7.5, MAX_MARKET_DAYS)) {
      // Bloquear mercados a >7.5 días (universo Fase 3A: 1 a 7 días)
      return { score: 0, signals: [], skip: true };
    }

    if (daysLeft <= 2) { signals.push("CATALYST_48H"); score += 32; }
    else if (daysLeft <= 7) { signals.push("CATALYST_7D"); score += 26; }
    else if (daysLeft <= 15) { signals.push("CATALYST_15D"); score += 18; }
    else { score += 8; }
  } else {
    // Si no tiene fecha de cierre clara, no podemos modelar rotación de capital
    return { score: 0, signals: [], skip: true };
  }

  // 5. Penalizar libros rotos (cuando sum != 1 en Gamma suele ser spread gigante, NO arbitraje)
  const sumDev = Math.abs(sum - 1);
  const gammaSpread = parseFloat(m.spread ?? sumDev);
  if (gammaSpread > 0.06 || sumDev > 0.06) {
    return { score: 0, signals: [], skip: true };
  }
  if (gammaSpread <= 0.015) {
    signals.push("TIGHT_BOOK");
    score += 18;
  } else if (gammaSpread <= 0.025) {
    score += 10;
  }

  // 6. Zona de máxima sensibilidad informacional (20c - 80c)
  if (yesP >= 0.20 && yesP <= 0.80) score += 16;
  else if (yesP >= 0.12 && yesP <= 0.88) score += 8;

  // 7. Flujo de dinero real (Volumen 24h y rotación Vol24h / Liquidez)
  if (vol24 >= 100000) { signals.push("HIGH_FLOW"); score += 24; }
  else if (vol24 >= 25000) { signals.push("ACTIVE_FLOW"); score += 18; }
  else if (vol24 >= 5000) { score += 12; }
  else { score += 5; }

  const turnover = liq > 0 ? (vol24 / liq) : 0;
  if (turnover >= 0.5) { signals.push("HIGH_TURNOVER"); score += 12; }

  // 8. Acción de precio multi-temporal gratis (1h, 24h, 7d) desde Gamma
  const change1h = parseFloat(m.oneHourPriceChange || 0);
  const change24h = parseFloat(m.oneDayPriceChange || 0);
  const change7d = parseFloat(m.oneWeekPriceChange || 0);
  const priceChange1d = Math.abs(change24h);

  if (prevSnapshot) {
    const prevY = parseFloat(prevSnapshot.yesP ?? yesP);
    const delta = Math.abs(yesP - prevY);
    if (delta >= 0.04) { signals.push("MOMENTUM"); score += 20; }
    else if (delta >= 0.02) { signals.push("MOMENTUM"); score += 10; }
  } else if (priceChange1d >= 0.05 && priceChange1d <= 0.22) {
    signals.push("MOMENTUM_24H");
    score += 14;
  } else if (priceChange1d > 0.30) {
    // Alerta de posible movimiento ya descontado (FOMO / Priced-In)
    signals.push("EXTENDED_MOVE_24H");
  }

  const eventSlug = String(m.events?.[0]?.slug || m.groupItemTitle || m.slug || m.id || "");

  return {
    score,
    signals,
    yesP,
    noP,
    vol,
    vol24,
    liq,
    sum,
    daysLeft,
    change1h,
    change24h,
    change7d,
    eventSlug,
    yesTokenId,
    noTokenId,
    skip: false,
  };
}

function isSideMicrostructureTradable(book) {
  if (!book || !book.isValid) return false;
  // Universo Fase 3A: Banda Operativa estricta [0.20, 0.80] y Spread máximo de 2.0¢ (0.02)
  if (book.bestAsk < 0.20 || book.bestAsk > 0.80) return false;
  if (book.spreadPct > MAX_SPREAD_PCT || book.spreadAbs > Math.min(0.02, MAX_SPREAD_CENTS)) return false;
  if (book.askDepthUsd < MIN_BOOK_DEPTH_USD || book.bidDepthUsd < MIN_BOOK_DEPTH_USD) return false;
  // Evitar comprar contra un muro institucional de venta (Order Book Imbalance < -0.65)
  if (Number.isFinite(book.obi) && book.obi < -0.65) return false;
  // Veto H (Book-Walk): verificar que el primer +1.0¢ del libro tenga liquidez real >= 1.35x del trade objetivo
  if (Array.isArray(book.asks) && book.asks.length > 0) {
    const refTradeUsdc = Math.max(1.00, (asNumber(botState.config?.minTradeUsdc, 1.00) + asNumber(botState.config?.maxTradeUsdc, 1.00)) / 2);
    const walk = computeExecutableBookWalk({
      bids: book.bids || [],
      asks: book.asks,
      targetBuyUsdc: refTradeUsdc,
      targetSellShares: refTradeUsdc / Math.max(0.15, book.bestAsk),
    });
    if (!walk.isBuyFullyExecutable) return false;
  }
  return true;
}

async function selectOrderBookVerifiedCandidates(scoredMarkets, targetCount) {
  const verified = [];
  const seenEvents = new Set();
  const maxProbes = Math.min(scoredMarkets.length, Math.max(targetCount * 4, 24));

  const poolSize = Math.max(targetCount, targetCount * 2);

  for (let i = 0; i < maxProbes && verified.length < poolSize; i++) {
    const item = scoredMarkets[i];
    const m = item.m || item.market;
    const pre = item.pre || item.prelim;
    if (!m || !pre) continue;

    // Diversificación de eventos y Cooldown Anti-Overtrading (6h tras cierre / máx 2 trades en 24h)
    const eventKey = pre.eventSlug || m.id;
    if (eventKey && seenEvents.has(eventKey)) continue;

    // Guardia Anti-Correlación Temática (v2.6.0): no analizar mercados correlacionados con posiciones ya abiertas
    if (hasCorrelatedOpenPosition(m, botState.trades)) continue;

    // v2.7.0: tampoco gastar llamadas a Groq en candidatos correlacionados entre sí dentro del mismo lote
    if (hasCorrelatedOpenPosition(m, verified.map(v => ({ status: "OPEN", question: v.m.question, eventId: v.m?.events?.[0]?.id })))) continue;

    const cooldownCheck = isMarketInCooldown(m.id, m.conditionId, m.question);
    if (cooldownCheck.blocked) continue;

    const condId = m.conditionId || m.condition_id || null;
    const [yesBook, noBook, tradeFlow] = await Promise.all([
      pre.yesTokenId ? getOrderBookSnapshot(pre.yesTokenId) : Promise.resolve({ isValid: false, reason: 'NO_YES_TOKEN' }),
      pre.noTokenId ? getOrderBookSnapshot(pre.noTokenId) : Promise.resolve({ isValid: false, reason: 'NO_NO_TOKEN' }),
      condId ? getMarketTradeFlow(condId) : Promise.resolve(null),
    ]);

    const yesTradable = isSideMicrostructureTradable(yesBook);
    const noTradable = isSideMicrostructureTradable(noBook);

    if (!yesTradable && !noTradable) {
      continue;
    }

    pre.yesBook = yesBook;
    pre.noBook = noBook;
    pre.clob = { yes: yesBook, no: noBook };
    pre.tradeFlow = tradeFlow;
    pre.yesTradable = yesTradable;
    pre.noTradable = noTradable;

    const bestSpreadPct = Math.min(
      yesTradable ? yesBook.spreadPct : 999,
      noTradable ? noBook.spreadPct : 999
    );
    if (bestSpreadPct <= 1.5 && !pre.signals.includes("ULTRA_TIGHT_SPREAD")) {
      pre.signals.push("ULTRA_TIGHT_SPREAD");
      pre.score += 10;
    }

    if ((yesTradable && yesBook.obi >= 0.25) || (noTradable && noBook.obi >= 0.25)) {
      if (!pre.signals.includes("BOOK_ACCUMULATION")) {
        pre.signals.push("BOOK_ACCUMULATION");
        pre.score += 8;
      }
    }

    if (tradeFlow && (tradeFlow.whaleYesCount > 0 || tradeFlow.whaleNoCount > 0)) {
      if (!pre.signals.includes("WHALE_ACTIVITY")) {
        pre.signals.push("WHALE_ACTIVITY");
        pre.score += 10;
      }
    }

    if (eventKey) seenEvents.add(eventKey);

    // v2.7.0: puntuación de asimetría microestructural pre-Groq (S_pre) sobre los libros tradables
    pre.alphaScore = computePreGroqAlphaScore({
      yesBook: yesTradable ? yesBook : null,
      noBook: noTradable ? noBook : null,
      tradeFlow,
      liquidity: asNumber(m.liquidityNum ?? m.liquidity ?? pre.liq, 0),
    });
    verified.push({ m, pre });
  }

  // v2.7.0: Groq analiza primero los libros con mayor huella de dinero informado (no los más eficientes/líquidos)
  verified.sort((a, b) => (b.pre.alphaScore || 0) - (a.pre.alphaScore || 0));
  const selected = verified.slice(0, targetCount);
  if (selected.length > 0) {
    addLog(`🎯 [ALPHA PRE-GROQ] Ranking S_pre: ${selected.map(v => `${v.pre.alphaScore.toFixed(2)}`).join(" > ")} (pool ${verified.length})`, "FILTER");
  }
  return selected;
}

// ═══════════════════════════════════════════════════════════════════════════
// POLYBOT v2.5.0 — MOTOR DE REFINAMIENTO PREDICTIVO Y ANTI-SELECCIÓN ADVERSA
// ═══════════════════════════════════════════════════════════════════════════

let cryptoTickerCache = { ts: 0, data: null };

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/**
 * 1. WOBI (Weighted Order Book Imbalance) Anti-Spoofing
 * Pondera exponencialmente los niveles del libro L2 para que los muros falsos
 * colocados a 1.5¢ - 2.0¢ del spread no manipulen la lectura de presión real.
 */
export function computeWeightedBookMetrics(bids = [], asks = []) {
  if (!bids.length || !asks.length) {
    return { bestBid: 0, bestAsk: 1, spreadAbs: 1, wObi: 0, pMicroWeighted: 0.5, topLiquidityUsd: 0 };
  }

  const bestBid = Number(bids[0].price);
  const bestAsk = Number(asks[0].price);
  const spreadAbs = Math.max(0.001, bestAsk - bestBid);

  // Constante de decaimiento gamma = 115:
  // A 0.0¢ -> peso 1.00 | A 1.0¢ -> peso 0.316 | A 2.0¢ -> peso 0.100
  const GAMMA = 115.0;

  let weightedBidVol = 0;
  let weightedAskVol = 0;

  for (const b of bids) {
    const px = Number(b.price);
    const sz = Number(b.size);
    const dist = bestBid - px;
    if (dist <= 0.025 && px > 0 && sz > 0) {
      const weight = Math.exp(-GAMMA * Math.max(0, dist));
      weightedBidVol += (px * sz) * weight;
    }
  }

  for (const a of asks) {
    const px = Number(a.price);
    const sz = Number(a.size);
    const dist = px - bestAsk;
    if (dist <= 0.025 && px > 0 && sz > 0) {
      const weight = Math.exp(-GAMMA * Math.max(0, dist));
      weightedAskVol += (px * sz) * weight;
    }
  }

  const totalWeightedVol = weightedBidVol + weightedAskVol;
  const wObi = totalWeightedVol > 0
    ? (weightedBidVol - weightedAskVol) / totalWeightedVol
    : 0;

  // MicroPrice ponderado por liquidez de tope de libro (inmune a spoofing profundo)
  const pMicroWeighted = totalWeightedVol > 0
    ? (bestBid * weightedAskVol + bestAsk * weightedBidVol) / totalWeightedVol
    : (bestBid + bestAsk) / 2;

  return {
    bestBid,
    bestAsk,
    spreadAbs,
    wObi: Number(wObi.toFixed(4)),
    pMicroWeighted: Number(pMicroWeighted.toFixed(4)),
    topLiquidityUsd: Number(totalWeightedVol.toFixed(2)),
  };
}

/**
 * 2. ETI (Exponential Time-Decayed & Kyle-Impact Tape Imbalance)
 * Pondera los últimos 50 trades dando prioridad exponencial a la última hora (half-life = 1.5h)
 * y multiplicando el peso de los trades que desplazaron el precio (flujo informado real).
 */
export function computeTimeDecayedTapeMetrics(trades = [], targetSide = "YES") {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { etiImbalance: 0, informedWhalesCount: 0, priceVelocity6h: 0, oldestPrice6h: null };
  }

  const nowMs = Date.now();
  const HALF_LIFE_HOURS = 1.5;
  const LAMBDA_TIME = Math.LN2 / HALF_LIFE_HOURS;

  const parseTsMs = (tr) => {
    const raw = tr?.timestamp ?? tr?.match_time ?? tr?.created_at;
    if (raw === null || raw === undefined) return nowMs;
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) return num < 1e12 ? num * 1000 : num;
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : nowMs;
  };

  let bullWeight = 0;
  let bearWeight = 0;
  let informedWhalesCount = 0;

  // Ordenar cronológicamente (más antiguo a más reciente) para medir impacto de precio e impulso 6h
  const sorted = [...trades].sort((a, b) => parseTsMs(a) - parseTsMs(b));

  const toTargetSidePrice = (tr) => {
    const rawPx = Number(tr?.price || 0.5);
    const out = String(tr?.outcome || "YES").toUpperCase();
    return out === targetSide ? rawPx : (1 - rawPx);
  };

  let prevPrice = toTargetSidePrice(sorted[0]);
  let oldestPriceWithin6h = null;
  const latestPrice = toTargetSidePrice(sorted[sorted.length - 1]);

  for (const tr of sorted) {
    const px = Number(tr.price || 0.5);
    const sidePx = toTargetSidePrice(tr);
    const sizeShares = Number(tr.size || tr.amount || 0);
    const notionalUsd = px * sizeShares;
    if (notionalUsd <= 0) continue;

    const tradeTimeMs = parseTsMs(tr);
    const ageHours = Math.max(0, (nowMs - tradeTimeMs) / 3600_000);

    if (ageHours <= 6.0 && oldestPriceWithin6h === null) {
      oldestPriceWithin6h = sidePx;
    }

    // Factor de decaimiento temporal exponencial
    const timeWeight = Math.exp(-LAMBDA_TIME * ageHours);

    // Impacto de Kyle: los trades que mueven el precio >= 0.5¢ reciben hasta 2.5x más peso
    const priceDelta = Math.abs(sidePx - prevPrice);
    const kyleImpactMultiplier = 1.0 + Math.min(1.5, priceDelta * 50.0);
    prevPrice = sidePx;

    const effectiveWeight = notionalUsd * timeWeight * kyleImpactMultiplier;

    // Determinar si el trade apoya nuestro lado (targetSide)
    const isBuySide = String(tr.side || "BUY").toUpperCase() === "BUY";
    const tradeOutcome = String(tr.outcome || "YES").toUpperCase();
    const supportsTarget =
      (tradeOutcome === targetSide && isBuySide) ||
      (tradeOutcome !== targetSide && !isBuySide);

    if (supportsTarget) {
      bullWeight += effectiveWeight;
      if (notionalUsd >= 150 && ageHours <= 4.0) {
        informedWhalesCount += 1;
      }
    } else {
      bearWeight += effectiveWeight;
    }
  }

  const totalWeight = bullWeight + bearWeight;
  const etiImbalance = totalWeight > 0 ? (bullWeight - bearWeight) / totalWeight : 0;
  const priceVelocity6h = oldestPriceWithin6h !== null ? (latestPrice - oldestPriceWithin6h) : 0;

  return {
    etiImbalance: Number(etiImbalance.toFixed(4)),
    informedWhalesCount,
    priceVelocity6h: Number(priceVelocity6h.toFixed(4)),
    oldestPrice6h: oldestPriceWithin6h,
  };
}

/**
 * 1. Consistencia Combinatoria Segura en Eventos Multi-Resultado (Normalización de Kolmogorov v2.5.1)
 * - Verifica estrictamente negRisk === true y excluye escaleras acumulativas (above/below/by/before)
 * - Filtra contratos polvo (< 2.5¢) contaminados por el piso de tick de 1¢
 * - Descuenta el overround tanto en BUY_YES como en BUY_NO
 */
export function computeSiblingNormalizedMicro({
  market,
  selectedSide,
  rawMarketMicro,
  siblingMarkets = [],
}) {
  const isNegRiskGroup = Boolean(
    market?.negRisk === true ||
    market?.enableNegRisk === true ||
    market?.neg_risk === true ||
    market?.neg_risk_market_id
  );

  // Excluir escaleras de precios acumulativas ("above $X", "reach $Y", "by [Date]")
  const qText = (market?.question || market?.groupItemTitle || "").toLowerCase();
  const isCumulativeLadder = /\b(above|below|over|under|reach|hit|touch|dip|by\s+\w+\s+\d+|before)\b/i.test(qText);

  if (!isNegRiskGroup || isCumulativeLadder || !Array.isArray(siblingMarkets) || siblingMarkets.length < 2) {
    return rawMarketMicro;
  }

  // Filtrar contratos "polvo" (< 2.5¢) cuyo tick floor distorsiona la suma de Kolmogorov
  const activeSiblings = siblingMarkets.filter((sib) => {
    const sibYesPx = Number(sib?.microPrice ?? sib?.bestAsk ?? sib?._prelim?.yesP ?? sib?.yesPrice ?? 0);
    return Number.isFinite(sibYesPx) && sibYesPx >= 0.025 && sibYesPx <= 0.975;
  });

  if (activeSiblings.length < 2) return rawMarketMicro;

  const activeYesSum = activeSiblings.reduce((acc, sib) => {
    return acc + Number(sib?.microPrice ?? sib?.bestAsk ?? sib?._prelim?.yesP ?? sib?.yesPrice ?? 0);
  }, 0);

  // Solo normalizar cuando la suma de activos principales muestra un overround real (1.03 < Suma <= 1.25)
  if (activeYesSum <= 1.03 || activeYesSum > 1.25) {
    return rawMarketMicro;
  }

  const rawImpliedYes = selectedSide === "YES" ? rawMarketMicro : (1.0 - rawMarketMicro);
  const normalizedYes = Math.min(0.99, Math.max(0.01, rawImpliedYes / activeYesSum));
  const normalizedSideMicro = selectedSide === "YES" ? normalizedYes : (1.0 - normalizedYes);

  // Mezcla conservadora: 70% microprecio normalizado + 30% microprecio local directo
  return Number(((0.70 * normalizedSideMicro) + (0.30 * rawMarketMicro)).toFixed(4));
}

/**
 * 2. Reconciliador Bayesiano Tetlock + Escudo Anti-Cuchillo Cayendo + PAR Simétrico (v2.5.1)
 * - Elimina el doble conteo de LR: retrae el logit posterior hacia la tasa base según la vejez de la noticia
 * - Corrige el signo direccional de change1h / change24h para BUY_NO
 * - Bloquea compras a ciegas cuando el precio colapsa en vivo (Veto F) o cuando Groq diverge >24¢ sin noticia fresca (Veto G)
 */
export function evaluateTetlockAndCatalystGuard({
  selectedSide,
  baseRateYesProb,
  estimatedYesProb,
  declaredLikelihoodRatio = 1.0,
  hasFreshNews,
  newsAgeHours = 12.0,
  marketMicro,
  gammaChange1h = 0,
  gammaChange24h = 0,
  tapeVelocity6h = 0,
  wObi = 0,
  etiImbalance = 0,
}) {
  const clampP = (p) => Math.max(0.01, Math.min(0.99, Number(p)));
  const logit = (p) => Math.log(clampP(p) / (1.0 - clampP(p)));
  const sigmoid = (z) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, z))));

  // ── A. Orientación Direccional Simétrica (YES vs NO) ──
  const dirSign = selectedSide === "YES" ? 1.0 : -1.0;
  const sideChange1h  = dirSign * Number(gammaChange1h || 0);
  const sideChange24h = dirSign * Number(gammaChange24h || 0);

  // Avance favorable reciente (para detectar Catalizador Ya Descontado - PAR)
  const directionalMoveUp = Math.max(
    0,
    Number(tapeVelocity6h || 0),
    sideChange1h,
    sideChange24h * 0.65
  );

  // Caída adversa reciente (para detectar "Falling Knife" / Noticia en vivo no indexada en RSS)
  const directionalMoveDown = Math.min(
    0,
    Number(tapeVelocity6h || 0),
    sideChange1h,
    sideChange24h * 0.75
  );

  // ── B. Reconciliación Bayesiana en Log-Odds SIN Doble Conteo ──
  const p0Side = clampP(selectedSide === "YES" ? baseRateYesProb : (1.0 - baseRateYesProb));
  const p1Side = clampP(selectedSide === "YES" ? estimatedYesProb : (1.0 - estimatedYesProb));

  const logitP0 = logit(p0Side);
  const logitP1 = logit(p1Side);
  const impliedUpdate = logitP1 - logitP0;

  // Acotar el salto máximo permitido por coherencia con el LR declarado por el modelo
  const rawLr = Math.max(0.25, Math.min(4.0, Number(declaredLikelihoodRatio) || 1.0));
  const declaredLrLog = Math.abs(Math.log(rawLr));
  const boundedUpdate = Math.sign(impliedUpdate) * Math.min(
    Math.abs(impliedUpdate),
    Math.max(0.15, declaredLrLog * 1.25)
  );

  // Factor de frescura temporal de la noticia (decae exponencialmente después de 30 min)
  const freshnessFactor = hasFreshNews
    ? Math.exp(-0.18 * Math.max(0, newsAgeHours - 0.5))
    : 0.25;

  // Probabilidad ciega reconciliada (antes de penalizar por PAR)
  const preParLogit = logitP0 + (boundedUpdate * freshnessFactor);
  const preParSideProb = clampP(sigmoid(preParLogit));

  // ── C. Cálculo Simétrico del Price Absorption Ratio (PAR) ──
  const projectedRemainingMove = Math.max(0.005, preParSideProb - marketMicro);
  const par = directionalMoveUp > 0.015
    ? directionalMoveUp / (directionalMoveUp + projectedRemainingMove)
    : 0.0;

  // Si el precio ya subió por la noticia, retraemos proporcionalmente el impulso informativo
  const finalNewsRetention = freshnessFactor * (1.0 - 0.65 * par);
  const reconciledBlindLogit = logitP0 + (boundedUpdate * finalNewsRetention);
  const blindSideProb = clampP(sigmoid(reconciledBlindLogit));

  // ── D. Vetos de Segundo Orden (Blindaje de Producción) ──
  // Veto D: Catalizador Ya Descontado (Chasing Top)
  const vetoD_PricedIn =
    (hasFreshNews && newsAgeHours > 1.5 && par >= 0.65) ||
    directionalMoveUp >= 0.11;

  // Veto F: "Falling Knife" / Flujo Informado Adverso (El contrato se desploma >= 6.5¢ en contra y el libro no absorbe)
  const vetoF_FallingKnife =
    directionalMoveDown <= -0.065 &&
    (wObi < 0.22 || etiImbalance < 0.18);

  // Veto G: Alucinación de Valor Ciego (Groq a ciegas diverge >= 24¢ del CLOB sin noticia de última hora <= 3h)
  const blindDivergenceAbs = Math.abs(blindSideProb - marketMicro);
  const vetoG_BlindHallucination =
    blindDivergenceAbs >= 0.24 &&
    (!hasFreshNews || newsAgeHours > 3.0);

  return {
    blindSideProb: Number(blindSideProb.toFixed(4)),
    par: Number(par.toFixed(3)),
    directionalMoveUp: Number(directionalMoveUp.toFixed(4)),
    directionalMoveDown: Number(directionalMoveDown.toFixed(4)),
    blindDivergenceAbs: Number(blindDivergenceAbs.toFixed(4)),
    vetoD_PricedIn,
    vetoF_FallingKnife,
    vetoG_BlindHallucination,
  };
}

/**
 * 3. Detector de Catalizador Ya Descontado ("Priced-In Veto" - Alias de compatibilidad)
 */
export function evaluateCatalystPricedIn({
  hasFreshNews,
  newsAgeHours = 6.0,
  marketMicro,
  rawSideProb,
  priceVelocity6h = 0,
}) {
  const projectedRemainingMove = Math.max(0.001, rawSideProb - marketMicro);
  if (priceVelocity6h > 0.02) {
    const totalImpliedMoveFromBase = priceVelocity6h + projectedRemainingMove;
    const priceAbsorptionRatio = priceVelocity6h / totalImpliedMoveFromBase;
    const isAlreadyPricedIn =
      (hasFreshNews && newsAgeHours > 1.5 && priceAbsorptionRatio >= 0.65) ||
      priceVelocity6h >= 0.11;
    const freshnessDecay = hasFreshNews
      ? Math.exp(-0.18 * Math.max(0, newsAgeHours - 0.5)) * (1.0 - 0.60 * priceAbsorptionRatio)
      : 0.0;
    return {
      isAlreadyPricedIn,
      priceAbsorptionRatio: Number(priceAbsorptionRatio.toFixed(3)),
      effectiveCatalystWeightBoost: Number((0.12 * Math.max(0, freshnessDecay)).toFixed(4)),
    };
  }
  const freshnessDecay = hasFreshNews ? Math.exp(-0.15 * Math.max(0, newsAgeHours - 0.5)) : 0.0;
  return {
    isAlreadyPricedIn: false,
    priceAbsorptionRatio: 0,
    effectiveCatalystWeightBoost: Number((0.12 * freshnessDecay).toFixed(4)),
  };
}

/**
 * 4. Clasificador y Oráculo Cripto Dual:
 * Distingue entre Barrera Americana ("reach / hit / touch / dip") -> Inverse Gaussian Touch
 * y Contrato Digital Europeo ("be above / be below / on [Date]") -> Black-Scholes N(d2)
 */
export function computeDualCryptoOracleProb({
  questionText = "",
  spotPrice,
  barrierPrice,
  sigmaDaily,
  daysToExpiry,
  itoDriftDaily = 0,
  normalCDFFn = normCdf,
}) {
  if (!spotPrice || !barrierPrice || !sigmaDaily || daysToExpiry <= 0) return null;

  const qLower = questionText.toLowerCase();
  const isTouchBarrier = /\b(reach|hit|touch|dip|drop|fall|cross|before)\b/i.test(qLower) &&
                         !/\b(be above|be below|close above|close below|price on|be over|be under)\b/i.test(qLower);

  const sigmaT = Math.max(0.005, sigmaDaily * Math.sqrt(daysToExpiry));
  const b = Math.log(barrierPrice / spotPrice);
  const absB = Math.abs(b);
  const direction = b >= 0 ? 1.0 : -1.0;

  if (!isTouchBarrier) {
    // CONTRATO DIGITAL EUROPEO AL VENCIMIENTO: P(S_T >= B) o P(S_T <= B) — SIN multiplicar por 2
    const isBelowExpiry = /\b(below|under|less than|lower than)\b/i.test(qLower);
    const signedLogDist = isBelowExpiry
      ? Math.log(barrierPrice / spotPrice) - (itoDriftDaily * daysToExpiry)
      : Math.log(spotPrice / barrierPrice) + (itoDriftDaily * daysToExpiry);
    const d2 = signedLogDist / sigmaT;
    const probTerminal = Math.min(0.99, Math.max(0.01, normalCDFFn(d2)));
    return {
      contractType: "EUROPEAN_DIGITAL_EXPIRY",
      pMath: Number(probTerminal.toFixed(4)),
    };
  }

  // CONTRATO DE BARRERA AMERICANA (ONE-TOUCH): P(max/min S_t >= B en t <= T)
  const d1 = (-absB + direction * itoDriftDaily * daysToExpiry) / sigmaT;
  const d2 = (-absB - direction * itoDriftDaily * daysToExpiry) / sigmaT;
  const expArg = Math.min(40.0, (2.0 * direction * absB * itoDriftDaily) / (sigmaDaily ** 2));
  const probTouch = Math.min(
    0.99,
    Math.max(0.01, normalCDFFn(d1) + Math.exp(expArg) * normalCDFFn(d2))
  );

  return {
    contractType: "AMERICAN_BARRIER_TOUCH",
    pMath: Number(probTouch.toFixed(4)),
  };
}

/**
 * Detecta la polaridad de Theta de un mercado de evento discreto (v2.6.1).
 *  +1 → YES es el salto disruptivo ("¿Ocurrirá X antes de T?"): el tiempo sin evento erosiona YES y favorece NO.
 *  -1 → YES es la retención del status-quo o la negación ("remain / stay / hold / not strike"):
 *       el tiempo sin evento FAVORECE a YES y erosiona NO.
 */
export function detectHazardPolarity(questionText = "") {
  const q = String(questionText).toLowerCase();
  const isStatusQuoRetention =
    /\b(remain|remains|remaining|stay|stays|staying|keep|keeps|retain|retains|survive|survives|maintain|maintains|still|continue|continues|continuing|ongoing|extend|extends|extension|intact|unbroken)\b/.test(q) ||
    /\b(will not|won't|wont|not\s+(?:strike|invade|attack|resign|raise|cut|cross|fall|drop|announce|launch|fire|hit|reach|default|end|collapse)|no\s+(?:new|more|further)|fail to|without)\b/.test(q) ||
    /\b(ceasefire|cease-fire|truce|peace|deal|agreement|treaty|ban|lockdown)\b[^?]*\b(hold|holds|last|lasts|survive|survives|remain|remains|continue|continues|continuing|ongoing|extend|extends|stand|stands)\b/.test(q);
  return isStatusQuoRetention ? -1 : 1;
}

/**
 * 5. Deriva Estocástica de Supervivencia (Poisson Theta Adjustment — v2.6.0 / polaridad v2.6.1)
 * Penaliza compras del lado disruptivo en mercados tipo "¿Ocurrirá X antes de T?" donde cada hora
 * sin evento erosiona el precio, y bonifica compras del lado pasivo que cobran ese decaimiento.
 */
export function computeThetaAdjustedFairProb24h({
  questionText = "",
  selectedSide = "YES",
  marketMicro,
  calibratedFairProb,
  kappa24h,
  hoursToResolution = 72,
  hasFreshNews = false,
}) {
  const clampProb = (p) => Math.max(0.01, Math.min(0.99, Number(p)));
  const baseReachable = marketMicro + kappa24h * (calibratedFairProb - marketMicro);
  const qLower = String(questionText).toLowerCase();

  // Detectar mercados de ocurrencia de evento discreto (Hazard-Rate Markets) o de retención de status-quo
  const isDiscreteHazardMarket =
    /\b(before|by |through|until|will .* strike|will .* invade|will .* resign|will .* fire|will .* announce|will .* reach|will .* hit|will .* remain|will .* stay|in [a-z]+ 2026)\b/i.test(qLower) &&
    !/\b(vs\.?|win the|match|election winner)\b/i.test(qLower);

  if (!isDiscreteHazardMarket || hoursToResolution > 336) {
    return Number(clampProb(baseReachable).toFixed(4));
  }

  // Tasa de erosión en 24h cuando no ocurre el evento discreto
  const timeFraction24h = Math.min(0.50, 24.0 / Math.max(24.0, hoursToResolution));
  const sideMicro = selectedSide === "YES" ? marketMicro : (1.0 - marketMicro);

  // Si hay noticia fresca hoy, el decaimiento pasivo se reduce a la mitad
  const hazardDecayRate = hasFreshNews ? 0.06 : 0.14;
  const thetaShiftMag = Math.min(0.028, sideMicro * (1.0 - sideMicro) * timeFraction24h * hazardDecayRate * 4.0);

  // Polaridad: en mercados estándar (+1) el paso del tiempo sin evento resta a YES y suma a NO.
  // En mercados de status-quo/negación (-1) la física se invierte: suma a YES y resta a NO.
  const polarity = detectHazardPolarity(questionText);
  const yesTheta = -polarity * thetaShiftMag;
  const directionalTheta = selectedSide === "YES" ? yesTheta : -yesTheta;

  return Number(clampProb(baseReachable + directionalTheta).toFixed(4));
}

/**
 * Mapa de conceptos temáticos (v2.6.1): sinónimos macro / cripto / geopolíticos que Jaccard literal no detecta.
 * Dos mercados que comparten un concepto se consideran la misma apuesta subyacente.
 */
const THEMATIC_CONCEPTS = [
  ["FED_RATES", /\b(fed|federal reserve|fomc|powell|jerome powell|interest rates?|rate (?:cut|cuts|hike|hikes|reduction|decision|increase)|rates? (?:cut|cuts|hike|hikes|reduction)|\d+\s?bps|basis points?)\b/i],
  ["CRYPTO_MAJOR", /\b(bitcoin|btc|ethereum|eth|ether|solana|sol|xrp|ripple|dogecoin|doge|crypto|cryptocurrency)\b/i],
  ["TARIFFS_TRADE", /\b(tariffs?|trade war|trade deal|duties|customs)\b/i],
  ["MIDDLE_EAST_CONFLICT", /\b(israel|iran|gaza|hamas|hezbollah|houthis?|lebanon|tehran|netanyahu|ceasefire|cease-fire)\b/i],
  ["RUSSIA_UKRAINE", /\b(russia|ukraine|putin|zelensky|zelenskyy|kyiv|kremlin)\b/i],
];

export function extractThematicConcepts(text = "") {
  const found = new Set();
  const s = String(text || "");
  for (const [concept, rx] of THEMATIC_CONCEPTS) {
    if (rx.test(s)) found.add(concept);
  }
  return found;
}

/**
 * 6. Bloqueo de Concentración Temática entre las 3 Posiciones Abiertas (v2.6.0 / sinónimos v2.6.1)
 * Impide abrir dos trades del mismo evento, mismo concepto temático (Fed, cripto, aranceles, Medio Oriente...)
 * o alta superposición léxica (Jaccard >= 0.34).
 */
export function hasCorrelatedOpenPosition(candidateMarket, openTrades = []) {
  if (!Array.isArray(openTrades) || openTrades.length === 0) return false;

  const tokenize = (str) => {
    const stopWords = new Set([
      "will", "the", "be", "in", "on", "of", "to", "by", "before", "after",
      "above", "below", "reach", "hit", "win", "2026", "2025", "yes", "no", "and", "or"
    ]);
    return new Set(
      String(str || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stopWords.has(w))
    );
  };

  const candEventId =
    candidateMarket?.eventId ||
    candidateMarket?.event_id ||
    candidateMarket?.groupSlug ||
    candidateMarket?.events?.[0]?.id ||
    candidateMarket?.events?.[0]?.slug;
  const candTokens = tokenize(candidateMarket?.question);
  const candConcepts = extractThematicConcepts(candidateMarket?.question);

  for (const trade of openTrades) {
    if (trade.status !== "OPEN" && trade.status !== "PARTIAL") continue;

    // 1. Mismo evento padre o groupSlug
    const openEventId = trade.eventId || trade.event_id || trade.groupSlug;
    if (candEventId && openEventId && String(candEventId) === String(openEventId)) {
      return true;
    }

    // 2. Mismo concepto temático (sinónimos: Fed/Powell/FOMC/rate cut; BTC/ETH/SOL; Israel/Iran...)
    if (candConcepts.size > 0) {
      const openConcepts = extractThematicConcepts(trade.question);
      for (const c of candConcepts) {
        if (openConcepts.has(c)) return true;
      }
    }

    // 3. Superposición léxica de Jaccard >= 0.34
    const openTokens = tokenize(trade.question);
    if (candTokens.size > 0 && openTokens.size > 0) {
      let intersection = 0;
      for (const t of candTokens) {
        if (openTokens.has(t)) intersection += 1;
      }
      const union = candTokens.size + openTokens.size - intersection;
      const jaccardSim = union > 0 ? intersection / union : 0;
      if (jaccardSim >= 0.34) {
        return true;
      }
    }
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// POLYBOT v2.7.0 — RANKING PRE-GROQ, TORNEO DE CAPITAL Y AUTOCALIBRACIÓN EMPÍRICA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 7. Puntuación de Asimetría Microestructural Pre-Groq (S_pre)
 * S_pre = 0.35·|WOBI| + 0.35·|ETI| + 0.20·exp(-60·S_abs) + 0.10·1[Liq ∈ [2500, 45000]]
 * Prioriza enviar a Groq los libros donde el dinero informado ya deja huella microestructural.
 */
export function computePreGroqAlphaScore({ yesBook = null, noBook = null, tradeFlow = null, liquidity = 0 } = {}) {
  const books = [yesBook, noBook].filter(b => b && b.isValid);
  if (books.length === 0) return 0;

  const absWobi = Math.max(...books.map(b => Math.abs(Number(b.wObi ?? b.obi ?? 0)) || 0));
  const minSpread = Math.min(...books.map(b => Number.isFinite(Number(b.spreadAbs)) ? Number(b.spreadAbs) : 0.05));

  let absEti = 0;
  if (Array.isArray(tradeFlow?.rawTrades) && tradeFlow.rawTrades.length > 0) {
    absEti = Math.abs(computeTimeDecayedTapeMetrics(tradeFlow.rawTrades, "YES").etiImbalance || 0);
  } else if (tradeFlow) {
    absEti = Math.abs(Number(tradeFlow.tapeImbalance) || 0);
  }

  const liq = Number(liquidity) || 0;
  const liqBand = (liq >= 2500 && liq <= 45000) ? 1 : 0;

  const score =
    0.35 * Math.min(1, absWobi) +
    0.35 * Math.min(1, absEti) +
    0.20 * Math.exp(-60 * Math.max(0, minSpread)) +
    0.10 * liqBand;
  return Number(score.toFixed(4));
}

/**
 * 8. Utilidad Binaria de la Señal (Torneo Kelly-Sharpe)
 * U = NetEdge¢ / sqrt(P_ask·(1 − P_ask)) × (Confianza / 100)
 */
export function computeSignalUtility(analysis = {}) {
  const netEdgeCents = Number(analysis.edge_pct) || 0;
  const ask = Math.max(0.05, Math.min(0.95, Number(analysis.executable_ask) || 0.5));
  const conf = Math.max(0, Math.min(100, Number(analysis.confidence) || 0));
  return Number(((netEdgeCents / Math.sqrt(ask * (1 - ask))) * (conf / 100)).toFixed(4));
}

/**
 * 9. Selección de Posición Estancada para Rotación (OPPORTUNITY_COST_SWAP)
 * Zombie = >= 6h en cartera, precio estancado (|px − entrada| <= 0.8¢), sin Break-Even armado,
 * y la señal nueva supera su NetEdge en >= +4.5¢. Devuelve el zombie con mayor brecha o null.
 */
export function findZombieTradeForSwap(openTrades = [], candidateNetEdgeCents = 0, nowMs = Date.now()) {
  let best = null;
  let bestGap = -Infinity;
  for (const t of openTrades) {
    if (t.status !== "OPEN" && t.status !== "PARTIAL") continue;
    if (t.breakEvenArmed || t.forceCloseReason) continue;
    const openedRaw = t.ts || t.openedAt;
    const openedMs = openedRaw ? new Date(openedRaw).getTime() : NaN;
    if (!Number.isFinite(openedMs)) continue;
    const hoursHeld = (nowMs - openedMs) / 3600_000;
    if (hoursHeld < 6.0) continue;
    const px = Number(t.currentPrice);
    const entry = Number(t.entryPrice);
    if (!Number.isFinite(px) || !Number.isFinite(entry) || Math.abs(px - entry) > 0.008) continue;
    const gap = Number(candidateNetEdgeCents) - (Number(t.edge_pct) || 0);
    if (gap >= 4.5 && gap > bestGap) {
      best = t;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * 10. Autocalibración Bayesiana en Vivo (ψ_emp ∈ [0.68, 0.92])
 * ψ = clamp(0.68, 0.92, 0.82 + 0.35·(Ȳ_realizado − P̄_predicho)), con medias ponderadas por decaimiento
 * exponencial (vida media 15 trades) sobre los últimos 40 cierres. Exige >= 10 cierres; si hay >= 8 del
 * mismo lado usa la muestra del lado. Sin muestra suficiente devuelve el valor base 0.82.
 */
export function computeEmpiricalCalibrationFeedback(trades = [], side = null) {
  const BASE_PSI = 0.82;
  const closed = (Array.isArray(trades) ? trades : [])
    .filter(t => String(t?.status || "").toUpperCase() === "CLOSED")
    .sort((a, b) => new Date(b.closedAt || b.ts || 0).getTime() - new Date(a.closedAt || a.ts || 0).getTime())
    .slice(0, 40);

  if (closed.length < 10) return { psi: BASE_PSI, n: closed.length, yBar: null, pBar: null, scope: "INSUFFICIENT" };

  const stats = (sample) => {
    let wSum = 0, ySum = 0, pSum = 0;
    sample.forEach((t, idx) => {
      const w = Math.exp(-Math.LN2 * idx / 15);
      const net = Number(t.netPnlAfterFriction ?? t.pnl ?? 0);
      const y = net > 0.005 ? 1 : 0;
      const entry = Number(t.entryPrice);
      const fallbackP = Number.isFinite(entry) ? entry + (Number(t.edge_pct) || 0) / 100 : 0.5;
      const p = Math.max(0.02, Math.min(0.98, Number(t.predictedProb ?? fallbackP)));
      wSum += w; ySum += w * y; pSum += w * p;
    });
    return wSum > 0 ? { yBar: ySum / wSum, pBar: pSum / wSum } : null;
  };

  const sideSample = side ? closed.filter(t => String(t.side || "").toUpperCase() === String(side).toUpperCase()) : [];
  const useSide = sideSample.length >= 8;
  const s = stats(useSide ? sideSample : closed);
  if (!s) return { psi: BASE_PSI, n: closed.length, yBar: null, pBar: null, scope: "INSUFFICIENT" };

  const psi = Math.max(0.68, Math.min(0.92, BASE_PSI + 0.35 * (s.yBar - s.pBar)));
  return {
    psi: Number(psi.toFixed(4)),
    n: useSide ? sideSample.length : closed.length,
    yBar: Number(s.yBar.toFixed(3)),
    pBar: Number(s.pBar.toFixed(3)),
    scope: useSide ? `SIDE_${String(side).toUpperCase()}` : "GLOBAL",
  };
}

const krakenHourlyVolCache = new Map();
const KRAKEN_OHLC_TTL_MS = 15 * 60 * 1000;

async function fetchKrakenHourlyRealizedVol(ohlcPair) {
  if (!ohlcPair) return null;
  const now = Date.now();
  const cached = krakenHourlyVolCache.get(ohlcPair);
  if (cached && (now - cached.ts) < KRAKEN_OHLC_TTL_MS) {
    return cached.dailyRealizedVol;
  }

  try {
    const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(ohlcPair)}&interval=60`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return cached ? cached.dailyRealizedVol : null;
    const json = await res.json();
    const resultObj = json?.result || {};
    const candleKey = Object.keys(resultObj).find(k => k !== "last" && Array.isArray(resultObj[k]));
    const candles = candleKey ? resultObj[candleKey] : [];
    // Tomar las últimas 48 velas de 1 hora (2 días de muestra horaria realizada)
    const recent = candles.slice(-49);
    if (recent.length < 12) return cached ? cached.dailyRealizedVol : null;

    const logReturns = [];
    for (let i = 1; i < recent.length; i++) {
      const prevClose = parseFloat(recent[i - 1]?.[4]);
      const currClose = parseFloat(recent[i]?.[4]);
      if (Number.isFinite(prevClose) && Number.isFinite(currClose) && prevClose > 0 && currClose > 0) {
        logReturns.push(Math.log(currClose / prevClose));
      }
    }
    if (logReturns.length < 10) return cached ? cached.dailyRealizedVol : null;

    const mean = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
    const variance = logReturns.reduce((s, x) => s + ((x - mean) ** 2), 0) / (logReturns.length - 1);
    const hourlySigma = Math.sqrt(Math.max(0, variance));
    const dailyRealizedVol = hourlySigma * Math.sqrt(24);
    krakenHourlyVolCache.set(ohlcPair, { ts: now, dailyRealizedVol });
    return dailyRealizedVol;
  } catch {
    return cached ? cached.dailyRealizedVol : null;
  }
}

export async function getCryptoSpotContext(question, daysLeft) {
  const q = String(question || "");
  let assetKey = null;
  let ohlcPair = null;
  let assetName = null;

  if (/\b(bitcoin|btc)\b/i.test(q)) { assetKey = "XXBTZUSD"; ohlcPair = "XBTUSD"; assetName = "BTC"; }
  else if (/\b(ethereum|eth)\b/i.test(q)) { assetKey = "XETHZUSD"; ohlcPair = "ETHUSD"; assetName = "ETH"; }
  else if (/\b(solana|sol)\b/i.test(q)) { assetKey = "SOLUSD"; ohlcPair = "SOLUSD"; assetName = "SOL"; }
  else if (/\b(xrp|ripple)\b/i.test(q)) { assetKey = "XXRPZUSD"; ohlcPair = "XRPUSD"; assetName = "XRP"; }
  else if (/\b(dogecoin|doge)\b/i.test(q)) { assetKey = "XDGUSD"; ohlcPair = "DOGEUSD"; assetName = "DOGE"; }

  if (!assetKey) return null;

  try {
    if (!cryptoTickerCache.data || (Date.now() - cryptoTickerCache.ts) > 60000) {
      try {
        const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,XRPUSD,DOGEUSD", {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const json = await res.json();
          if (json?.result) {
            cryptoTickerCache = { ts: Date.now(), data: json.result };
          }
        }
      } catch (fetchErr) {
        // Si el fetch falla pero la caché es menor a 5 min, tolerar; de lo contrario abortar
        if (!cryptoTickerCache.data || (Date.now() - cryptoTickerCache.ts) > 300000) {
          return null;
        }
      }
    }

    const ticker = cryptoTickerCache.data?.[assetKey];
    if (!ticker) return null;

    const spot = parseFloat(ticker?.c?.[0]);
    const high24h = parseFloat(ticker?.h?.[1] || ticker?.h?.[0]);
    const low24h = parseFloat(ticker?.l?.[1] || ticker?.l?.[0]);
    if (!Number.isFinite(spot) || spot <= 0) return null;

    // Estimador de Volatilidad Diaria Amortiguada (v2.7.0):
    // El estimador puro de Parkinson de 24h asume difusión browniana continua sin saltos. Durante caídas
    // o mechas abruptas, el rango 24h infla la volatilidad hasta 2.7x (tratando un shock puntual como régimen persistente).
    // Para calibrarlo cuantitativamente:
    // 1) Asignamos volatilidad de régimen estacionario por activo (BTC ~2.2%, ETH ~2.8%, SOL ~3.8%, etc.).
    // 2) Amortiguamos la volatilidad con mezcla 50/50 entre el Parkinson observado y el baseline estacionario.
    // 3) Imponemos un techo superior realista (BTC max 4.0%, ETH max 5.0%, otros max 6.5%) para evitar
    //    sobreestimar probabilidades de toque en horizontes de varios días.
    const assetBaselineVol = {
      BTC: 0.022,
      ETH: 0.028,
      SOL: 0.038,
      XRP: 0.032,
      DOGE: 0.042,
    }[assetName] || 0.028;

    const rawParkinson = (Number.isFinite(high24h) && Number.isFinite(low24h) && high24h > low24h && low24h > 0)
      ? Math.log(high24h / low24h) / (2 * Math.sqrt(Math.LN2))
      : assetBaselineVol;

    const maxVolCap = assetName === "BTC" ? 0.045 : (assetName === "ETH" ? 0.055 : 0.070);
    const minVolFloor = 0.018;
    const realized1hDailyVol = await fetchKrakenHourlyRealizedVol(ohlcPair);
    const observedActiveVol = Number.isFinite(realized1hDailyVol) && realized1hDailyVol > 0
      ? Math.max(realized1hDailyVol, rawParkinson * 0.85)
      : rawParkinson;
    const blendedVol = (0.65 * observedActiveVol) + (0.35 * assetBaselineVol);
    const dailyVol = Math.max(minVolFloor, Math.min(maxVolCap, blendedVol));

    // Detectar precio objetivo ($78,000 o $85k) en la pregunta
    const priceMatch = q.match(/\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k)?/i);
    let targetPrice = null;
    if (priceMatch) {
      const baseNum = parseFloat(priceMatch[1].replace(/,/g, ""));
      const isK = Boolean(priceMatch[2]);
      if (Number.isFinite(baseNum) && baseNum > 0) {
        targetPrice = isK ? baseNum * 1000 : baseNum;
      }
    }

    let mathYesProb = null;
    let modelType = "SPOT_ONLY";
    const tDays = Math.max(0.25, Number.isFinite(daysLeft) ? daysLeft : 3);
    const itoDriftDaily = -0.5 * (dailyVol ** 2);

    if (targetPrice && targetPrice > spot * 0.2 && targetPrice < spot * 3.0) {
      // En barreras americanas de toque ("reach", "dip") aplicamos factor 1.12x por colas pesadas intradía (kurtosis cripto)
      const isTouchQuestion = /\b(reach|hit|touch|dip|drop|fall|cross|before)\b/i.test(q) &&
                              !/\b(be above|be below|close above|close below|price on|be over|be under)\b/i.test(q);
      const effectiveSigmaDaily = isTouchQuestion ? Math.min(maxVolCap, dailyVol * 1.12) : dailyVol;
      const dualOracle = computeDualCryptoOracleProb({
        questionText: q,
        spotPrice: spot,
        barrierPrice: targetPrice,
        sigmaDaily: effectiveSigmaDaily,
        daysToExpiry: tDays,
        itoDriftDaily,
        normalCDFFn: normCdf,
      });
      if (dualOracle) {
        modelType = dualOracle.contractType;
        mathYesProb = dualOracle.pMath;
      }
    }

    const signedDistPct = targetPrice ? (((targetPrice - spot) / spot) * 100) : null;
    const absDistPct = signedDistPct !== null ? Math.abs(signedDistPct) : null;
    const distPct = signedDistPct !== null ? signedDistPct.toFixed(2) : null;
    const mathNoProb = mathYesProb !== null ? Number((1 - mathYesProb).toFixed(4)) : null;
    const summary = targetPrice
      ? `${assetName} LIVE_SPOT=$${spot.toLocaleString("en-US", { maximumFractionDigits: 2 })} | 24h_Range=[$${low24h.toFixed(0)}-$${high24h.toFixed(0)}] | DailyVol=${(dailyVol * 100).toFixed(2)}% | Target=$${targetPrice.toLocaleString("en-US")} (${distPct}% from spot) | Math_${modelType}_YES_Prob=${mathYesProb !== null ? (mathYesProb * 100).toFixed(1) + "%" : "N/A"} | Math_${modelType}_NO_Prob=${mathNoProb !== null ? (mathNoProb * 100).toFixed(1) + "%" : "N/A"}`
      : `${assetName} LIVE_SPOT=$${spot.toLocaleString("en-US", { maximumFractionDigits: 2 })} | 24h_Range=[$${low24h.toFixed(0)}-$${high24h.toFixed(0)}] | DailyVol=${(dailyVol * 100).toFixed(2)}%`;

    return {
      assetName,
      spot,
      high24h,
      low24h,
      dailyVol,
      targetPrice,
      absDistPct,
      modelType,
      mathYesProb,
      mathNoProb,
      summary,
    };
  } catch {
    return null;
  }
}

// Estado de enfriamiento en memoria para failover automático entre Cerebras y Groq
const llmProviderState = {
  CEREBRAS: { cooldownUntilMs: 0, lastError: null, callsOk: 0 },
  GROQ: { cooldownUntilMs: 0, lastError: null, callsOk: 0 },
  activeProvider: null,
};

export function getLlmProviderStatus() {
  const now = Date.now();
  return {
    activeProvider: llmProviderState.activeProvider || (getEnv("CEREBRAS_API_KEY") ? "CEREBRAS" : "GROQ"),
    cerebrasConfigured: Boolean(getEnv("CEREBRAS_API_KEY")),
    groqConfigured: Boolean(getEnv("GROQ_API_KEY")),
    cerebrasReady: Boolean(getEnv("CEREBRAS_API_KEY")) && now >= llmProviderState.CEREBRAS.cooldownUntilMs,
    groqReady: Boolean(getEnv("GROQ_API_KEY")) && now >= llmProviderState.GROQ.cooldownUntilMs,
    cerebrasCallsOk: llmProviderState.CEREBRAS.callsOk,
    groqCallsOk: llmProviderState.GROQ.callsOk,
  };
}

async function tryProviderCompletion(provider, baseBody) {
  const isCerebras = provider === "CEREBRAS";
  const apiKey = isCerebras ? getEnv("CEREBRAS_API_KEY") : getEnv("GROQ_API_KEY");
  if (!apiKey) {
    return { ok: false, skipped: true, reason: `${provider}_NO_KEY` };
  }

  const endpoint = isCerebras ? API_CEREBRAS : API_GROQ;
  const primaryModel = isCerebras
    ? getEnv("CEREBRAS_MODEL", CEREBRAS_MODEL)
    : getEnv("GROQ_MODEL", GROQ_MODEL);
  const backupModel = isCerebras ? "qwen-3.8-27b" : "openai/gpt-oss-20b";

  // Intento 1: Modelo primario (120B) con json_object y 2048 tokens
  const primaryPayload = { ...baseBody, model: primaryModel, max_tokens: 2048 };
  let r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(primaryPayload),
  });

  if (r.ok) {
    const json = await r.json();
    json._provider = provider;
    json._model = primaryModel;
    return { ok: true, data: json };
  }

  // Intento 2: Si devuelve 400 o 422 (ej. json_validate_failed por bloques de razonamiento), reintentar sin response_format estricto
  if (r.status === 400 || r.status === 422) {
    const fallbackPayload = { ...primaryPayload };
    delete fallbackPayload.response_format;
    r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(fallbackPayload),
    });
    if (r.ok) {
      const json = await r.json();
      json._provider = provider;
      json._model = primaryModel;
      return { ok: true, data: json };
    }
  }

  const errText = await r.text().catch(() => "");
  const isDailyOrCreditExhausted =
    r.status === 402 ||
    /tokens per day|tpd|daily|insufficient_quota|credit|exceeded your current quota|balance/i.test(errText);

  // Intento 3: Si es un 429 por modelo o 404/503 en el modelo 120B (y no es falta total de saldo de cuenta), probar modelo secundario del mismo proveedor
  if ((r.status === 429 || r.status === 404 || r.status >= 500) && r.status !== 402) {
    const backupPayload = { ...primaryPayload, model: backupModel };
    delete backupPayload.response_format;
    const rBackup = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(backupPayload),
    });
    if (rBackup.ok) {
      const json = await rBackup.json();
      json._provider = provider;
      json._model = backupModel;
      return { ok: true, data: json };
    }
  }

  return {
    ok: false,
    status: r.status,
    errText: errText.slice(0, 220),
    isDailyOrCreditExhausted,
  };
}

async function callGroqResilient(body) {
  const hasCerebras = Boolean(getEnv("CEREBRAS_API_KEY"));
  const hasGroq = Boolean(getEnv("GROQ_API_KEY"));

  // Orden de prioridad: si CEREBRAS_API_KEY está configurada (y LLM_PRIMARY_PROVIDER !== "GROQ"),
  // Cerebras va primero (aprovechando tus $5 de crédito + 1M tokens/día gratis en gpt-oss-120b) y Groq actúa como respaldo automático (y viceversa).
  let providerOrder = [];
  if (LLM_PRIMARY_PROVIDER === "GROQ") {
    providerOrder = ["GROQ", "CEREBRAS"];
  } else if (LLM_PRIMARY_PROVIDER === "CEREBRAS") {
    providerOrder = ["CEREBRAS", "GROQ"];
  } else {
    providerOrder = hasCerebras ? ["CEREBRAS", "GROQ"] : ["GROQ", "CEREBRAS"];
  }

  // Colocar al principio los proveedores que NO estén en enfriamiento por cuota agotada
  const now = Date.now();
  const activeFirst = [
    ...providerOrder.filter(p => now >= llmProviderState[p].cooldownUntilMs),
    ...providerOrder.filter(p => now < llmProviderState[p].cooldownUntilMs),
  ];

  const errors = [];

  for (const provider of activeFirst) {
    const attempt = await tryProviderCompletion(provider, body);
    if (attempt.skipped) continue;

    if (attempt.ok) {
      const prevProvider = llmProviderState.activeProvider;
      llmProviderState.activeProvider = provider;
      llmProviderState[provider].callsOk += 1;
      llmProviderState[provider].cooldownUntilMs = 0;
      botState.activeLlmProvider = `${provider} (${attempt.data._model})`;
      if (prevProvider && prevProvider !== provider) {
        addLog(`🧠 [LLM ROUTER] Motor activo conmutado a ${provider} (${attempt.data._model})`, "SYSTEM");
      }
      return attempt.data;
    }

    // Si falló por límite de cuota (429 / 402), poner este proveedor en pausa temporal y saltar de inmediato al otro
    if (attempt.status === 429 || attempt.status === 402 || attempt.isDailyOrCreditExhausted) {
      const cooldownMinutes = attempt.isDailyOrCreditExhausted ? 90 : 10;
      llmProviderState[provider].cooldownUntilMs = Date.now() + cooldownMinutes * 60_000;
      llmProviderState[provider].lastError = `HTTP ${attempt.status}`;
      addLog(
        `⚡ [LLM FAILOVER] ${provider} alcanzó límite (HTTP ${attempt.status}) -> pausado ${cooldownMinutes}m. Conmutando al motor de respaldo...`,
        "WARN"
      );
    }

    errors.push(`${provider}: HTTP ${attempt.status} ${attempt.errText || ""}`);
  }

  if (!hasCerebras && !hasGroq) {
    throw new Error("Ninguna API Key de IA configurada (define CEREBRAS_API_KEY o GROQ_API_KEY en .env)");
  }

  throw new Error(`LLM failover agotado (${errors.join(" | ")})`);
}

// ── MOTOR GRATUITO E ILIMITADO DE NOTICIAS EN TIEMPO REAL (Google News RSS) ──
async function fetchGoogleNewsRss(question) {
  try {
    const cleanQuery = String(question || "")
      .replace(/[?"'’“”]/g, " ")
      .replace(/\b(Will|the|be|in|on|at|by|before|after|of|to|a|an)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);
    if (!cleanQuery) return [];

    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanQuery + " when:7d")}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(rssUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml",
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const articles = [];
    let match;

    while ((match = itemRegex.exec(xml)) !== null && articles.length < 4) {
      const block = match[1];
      const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
      const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
      const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

      const rawTitle = (titleMatch?.[1] || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      if (!rawTitle) continue;

      const sourceName = (sourceMatch?.[1] || "News").trim();
      const pubDate = pubDateMatch?.[1] ? new Date(pubDateMatch[1]) : null;
      const ageHours = (pubDate && Number.isFinite(pubDate.getTime()))
        ? Math.max(0.1, (Date.now() - pubDate.getTime()) / 3600000).toFixed(1)
        : "?";

      articles.push({
        title: rawTitle,
        source: sourceName,
        url: (linkMatch?.[1] || "").trim(),
        ageHours,
      });
    }
    return articles;
  } catch {
    return [];
  }
}

function computeQuantPositionSize(maxAllowedAmount, analysis, sideBook) {
  // Fase 3A: Tamaño fijo de $1.00 USDC en paper (respeta estrictamente MIN_TRADE_USDC / MAX_TRADE_USDC de .env)
  const minUsdc = Math.max(0.50, asNumber(botState.config.minTradeUsdc, 1.00));
  const maxUsdc = Math.max(
    minUsdc,
    Math.min(asNumber(maxAllowedAmount, minUsdc), asNumber(botState.config.maxTradeUsdc, 1.00))
  );
  if (maxUsdc <= minUsdc) return roundMoney(maxUsdc);

  const ask  = Math.max(0.20, Math.min(0.82, asNumber(sideBook?.bestAsk ?? analysis?.executable_ask, 0.5)));
  const conf = asNumber(analysis?.confidence, 70);
  const obi  = asNumber(sideBook?.obi, 0);

  // 1. Kelly Binario Exacto sobre Retorno Porcentual por Dólar Invertido: f_kelly = netEdgeDec / (1 - ask)
  const payoffComplement = Math.max(0.08, 1 - ask);
  const netEdgeDec       = Math.max(0, asNumber(analysis?.edge_pct, 0) / 100);
  const fullKellyFrac    = netEdgeDec / payoffComplement;

  // Quarter-Kelly real (0.25x), eliminando el antiguo multiplicador 2.2x
  const quarterKellyFrac = 0.25 * fullKellyFrac;

  // 2. Moduladores suaves de convicción y microestructura
  const confScalar = Math.max(0.75, Math.min(1.15, 0.75 + ((conf - 70) / 30) * 0.40));
  const obiScalar  = obi >= 0.20 ? 1.10 : (obi <= -0.15 ? 0.85 : 1.0);

  // 3. Normalización por Riesgo de Precio (Volatility / Share-Count Parity)
  // Comprar a ask=0.20 adquiere 2.5x más acciones por dólar que a ask=0.50; normalizamos la exposición al SL en centavos
  const priceRiskNormalizer = Math.min(1.15, Math.sqrt(ask / 0.50));

  // 4. Dimensionamiento referido al capital operativo (escalado para operar en el rango [$1.50, $2.50] o crecer con la banca libre)
  const freeBalance       = asNumber(botState.walletSnapshot?.usdcBalance ?? botState.capital, BASE_CAPITAL);
  const referenceBankroll = Math.max(45.0, freeBalance);
  const optimalKellyUsdc  = referenceBankroll * quarterKellyFrac * confScalar * obiScalar * priceRiskNormalizer;

  const sized = Math.max(minUsdc, Math.min(maxUsdc, optimalKellyUsdc));
  return roundMoney(sized);
}

// ── IA PROFUNDA CUANTITATIVA (Groq + Google News RSS + Tavily + CLOB Flow + Crypto Spot Oracle + Bayesian Calibration) ──
export async function deepAnalyze(m, prelim) {
  const { yesP, noP, vol, vol24, liq, daysLeft, change1h, change24h, change7d, yesBook, noBook, tradeFlow, yesTradable, noTradable } = prelim;
  const marketId = m.id || m.conditionId;
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  let newsContext = "Sin noticias recientes.";
  let topSource = "none";
  let topSnippet = "none";
  let usedCache = false;
  let hasFreshNews = false;
  let minNewsAgeHours = 8.0;

  const [cryptoQuant, cachedNews] = await Promise.all([
    getCryptoSpotContext(m.question, daysLeft),
    Promise.resolve(botState.newsCache[marketId]),
  ]);

  if (cachedNews && (Date.now() - cachedNews.ts) < SIX_HOURS) {
    newsContext = cachedNews.context;
    topSource = cachedNews.source;
    topSnippet = cachedNews.snippet;
    hasFreshNews = Boolean(cachedNews.hasFreshNews);
    minNewsAgeHours = asNumber(cachedNews.minAgeHours, 6.0);
    usedCache = true;
  } else {
    const combinedLines = [];
    let bestAge = 24.0;

    // 1. Fuente Primaria Gratuita e Ilimitada: Google News RSS (con antigüedad exacta en horas)
    const rssArticles = await fetchGoogleNewsRss(m.question);
    for (const art of rssArticles) {
      const ageNum = parseFloat(art.ageHours);
      if (Number.isFinite(ageNum)) {
        if (ageNum < bestAge) bestAge = ageNum;
        if (ageNum <= 12) hasFreshNews = true;
      }
      combinedLines.push(`[RSS ${art.ageHours}h ago | ${art.source}] ${art.title}`);
      if (topSource === "none" && art.url) topSource = art.url;
      if (topSnippet === "none") topSnippet = `[${art.source}] ${art.title.slice(0, 140)}`;
    }

    // 2. Fuente Secundaria Profunda: Tavily (con caché de 6h para proteger los 1,000 créditos/mes gratis)
    if (TAVILY_API_KEY) {
      try {
        const tRes = await fetch(API_TAVILY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query: `${m.question} latest news`,
            search_depth: "basic",
            days: 7,
            include_answers: false,
            max_results: 3,
          })
        });
        if (tRes.ok) {
          const tData = await tRes.json();
          if (tData.results && tData.results.length > 0) {
            for (const r of tData.results) {
              if (r.published_date) {
                const pubMs = new Date(r.published_date).getTime();
                if (Number.isFinite(pubMs) && pubMs > 0) {
                  const ageH = Math.max(0.1, (Date.now() - pubMs) / 3600000);
                  if (ageH < bestAge) bestAge = ageH;
                  if (ageH <= 12) hasFreshNews = true;
                }
              }
              combinedLines.push(`[WEB ${r.url}] ${(r.content || '').replace(/\s+/g, ' ').slice(0, 240)}`);
            }
            topSource = tData.results[0].url || topSource;
            topSnippet = (tData.results[0].content || '').replace(/\s+/g, ' ').slice(0, 160) + "...";
          }
        }
      } catch (e) {
        console.warn("Tavily fallido (usando respaldo RSS gratuito):", e.message);
      }
    }

    minNewsAgeHours = bestAge;
    if (combinedLines.length > 0) {
      newsContext = combinedLines.slice(0, 7).join("\n");
      botState.newsCache[marketId] = {
        ts: Date.now(),
        context: newsContext,
        source: topSource,
        snippet: topSnippet,
        hasFreshNews,
        minAgeHours: minNewsAgeHours,
        news: newsContext,
      };
    }
  }

  const daysLeftStr = Number.isFinite(daysLeft) ? daysLeft.toFixed(1) : "?";
  const resolutionRules = (m.description || "Estándar Polymarket").replace(/\s+/g, " ").slice(0, 420);
  const fmtDelta = (v) => `${v >= 0 ? "+" : ""}${(asNumber(v, 0) * 100).toFixed(1)}%`;
  const priceActionStr = `1h=${fmtDelta(change1h)} | 24h=${fmtDelta(change24h)} | 7d=${fmtDelta(change7d)}`;

  // ARQUITECTURA v3.1.0-crypto-oracle (Maker-First 0% Fee + Barrera Segura >= 3.0% + Prompt Simétrico YES/NO):
  // 1. Pre-evaluamos la dirección y ventaja del Oráculo Cripto ANTES de llamar al LLM para informarle explícitamente qué lado auditar
  //    y evitar que el LLM descarte BUY_NO mirando solo YES o alucine una comisión plana del 10% por ver FeeBps=1000.
  let oracleAction = "SKIP";
  let consideredSide = null;
  let oracleSkipReason = null;
  let oracleGrossEdge = 0;
  let estYesProb = (cryptoQuant && Number.isFinite(cryptoQuant.mathYesProb)) ? cryptoQuant.mathYesProb : null;

  if (cryptoQuant && Number.isFinite(cryptoQuant.mathYesProb)) {
    const mathYes = cryptoQuant.mathYesProb;
    const yesOracleEdge = (yesTradable && yesBook?.isValid) ? (mathYes - yesBook.bestAsk) : -1;
    const noOracleEdge  = (noTradable && noBook?.isValid) ? ((1 - mathYes) - noBook.bestAsk) : -1;

    if (yesOracleEdge >= 0.04 && yesOracleEdge >= noOracleEdge) {
      oracleAction = "BUY_YES";
      consideredSide = "YES";
      oracleGrossEdge = yesOracleEdge;
    } else if (noOracleEdge >= 0.04 && noOracleEdge > yesOracleEdge) {
      consideredSide = "NO";
      oracleGrossEdge = noOracleEdge;
      // Veto Cuantitativo de Barrera Cercana (v3.1.0): Prohibido vender volatilidad (BUY_NO) en barreras de toque ("reach"/"dip")
      // cuando el Spot está a menos de 3.0% de la barrera (evita los casos T-MW73AZ4VI5AU a 1.59% y T-MW958Z3H2FXP a 1.29%).
      if (
        cryptoQuant.modelType === "AMERICAN_BARRIER_TOUCH" &&
        Number.isFinite(cryptoQuant.absDistPct) &&
        cryptoQuant.absDistPct < 3.0
      ) {
        oracleAction = "SKIP";
        oracleSkipReason = `VETO_BARRIER_TOO_CLOSE_FOR_NO (Barrera de toque a solo ${cryptoQuant.absDistPct.toFixed(2)}% del Spot < 3.00% mínimo para comprar NO)`;
      } else {
        oracleAction = "BUY_NO";
      }
    } else {
      consideredSide = mathYes >= 0.5 ? "YES" : "NO";
      oracleSkipReason = "Oráculo Cripto sin ventaja bruta mínima (>= 4.0¢ sobre BestAsk)";
    }
  } else {
    oracleSkipReason = "Oráculo Cripto sin precio objetivo válido o sin datos Spot en Kraken";
  }

  const yesBookStructureStr = yesBook?.isValid
    ? `BestBid=${(asNumber(yesBook.bestBid, 0) * 100).toFixed(1)}c BestAsk=${(asNumber(yesBook.bestAsk, 0) * 100).toFixed(1)}c Spread=${asNumber(yesBook.spreadPct, 0).toFixed(2)}% TopDepth=$${(yesBook.topLiquidityUsd ?? (asNumber(yesBook.bidDepthUsd, 0) + asNumber(yesBook.askDepthUsd, 0))).toFixed(0)} WOBI=${asNumber(yesBook.obi, 0) >= 0 ? "+" : ""}${asNumber(yesBook.obi, 0).toFixed(2)} ExecutionMode=MAKER_LIMIT_0_FEE Tradable=${yesTradable ? "YES" : "NO"}`
    : "UNAVAILABLE";
  const noBookStructureStr = noBook?.isValid
    ? `BestBid=${(asNumber(noBook.bestBid, 0) * 100).toFixed(1)}c BestAsk=${(asNumber(noBook.bestAsk, 0) * 100).toFixed(1)}c Spread=${asNumber(noBook.spreadPct, 0).toFixed(2)}% TopDepth=$${(noBook.topLiquidityUsd ?? (asNumber(noBook.bidDepthUsd, 0) + asNumber(noBook.askDepthUsd, 0))).toFixed(0)} WOBI=${asNumber(noBook.obi, 0) >= 0 ? "+" : ""}${asNumber(noBook.obi, 0).toFixed(2)} ExecutionMode=MAKER_LIMIT_0_FEE Tradable=${noTradable ? "YES" : "NO"}`
    : "UNAVAILABLE";

  const tapeFlowStr = tradeFlow
    ? `Last_${tradeFlow.sampleCount}_Trades: BullishYES=$${tradeFlow.yesBullUsd.toFixed(0)} (Whales=${tradeFlow.whaleYesCount}) | BullishNO=$${tradeFlow.noBullUsd.toFixed(0)} (Whales=${tradeFlow.whaleNoCount}) | ETI_TapeImbalance=${tradeFlow.tapeImbalance >= 0 ? "+" : ""}${tradeFlow.tapeImbalance.toFixed(2)}`
    : "UNAVAILABLE";

  const isBearishYesQuestion = /\b(dip|drop|fall|below|under|less than|lower than|crash)\b/i.test(m.question || "");
  const polarityLine = isBearishYesQuestion
    ? `\nSEMANTIC_POLARITY_ALERT: This is a DOWNWARD/BEARISH target question ("dip/drop/below"). If crypto price is falling or news is bearish, that FAVORS YES (evidence_likelihood_ratio > 1.00) and CONTRADICTS BUY_NO! Never say "bearish momentum supports NO" on a dip/below question.`
    : `\nSEMANTIC_POLARITY_ALERT: This is an UPWARD/BULLISH target question ("reach/above"). Bullish crypto news/momentum favors YES (evidence_likelihood_ratio > 1.00), while bearish news/momentum favors NO (evidence_likelihood_ratio < 1.00).`;

  const cryptoLine = cryptoQuant
    ? `\nLIVE_CRYPTO_ORACLE: ${cryptoQuant.summary} | ORACLE_CANDIDATE_ACTION=${oracleAction}${oracleAction !== "SKIP" ? ` (CandidateSide=${consideredSide}, GrossOracleEdge=+${(oracleGrossEdge * 100).toFixed(1)}c)` : ""}${polarityLine}`
    : polarityLine;

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a quantitative risk & catalyst auditor for a Crypto-Oracle trading desk on Polymarket CLOB (${STRATEGY_VERSION}).
Orders are executed passively as Maker Limit orders (0% CLOB fee). The deterministic math engine has already computed LIVE_CRYPTO_ORACLE probabilities for both YES and NO and selected ORACLE_CANDIDATE_ACTION:
1. base_rate_prob (0.01 to 0.99): The quantitative barrier probability of YES from LIVE_CRYPTO_ORACLE.
2. evidence_likelihood_ratio (0.50 to 2.00): The diagnostic direction of RECENT_NEWS & CLOB orderflow (1.00 = neutral/no fresh catalyst; >1.00 = favors YES; <1.00 = favors NO).
3. estimated_yes_prob (0.01 to 0.99): Your final calibrated probability of the YES outcome.
CRITICAL RULES:
1. Never recommend a side marked Tradable=NO.
2. SYMMETRIC ORACLE AUDIT: Look at ORACLE_CANDIDATE_ACTION in LIVE_CRYPTO_ORACLE. If ORACLE_CANDIDATE_ACTION="BUY_NO", evaluate whether Math_NO_Prob exceeds NO BestAsk (do NOT reject BUY_NO just because Math_YES_Prob < YES BestAsk!). If ORACLE_CANDIDATE_ACTION="BUY_YES", evaluate whether Math_YES_Prob exceeds YES BestAsk.
3. Confirm action=ORACLE_CANDIDATE_ACTION unless RECENT_NEWS or strong orderflow directly contradicts that side (e.g., bullish breakout news contradicting BUY_NO, or bearish crash news contradicting BUY_YES), in which case return action="SKIP". If ORACLE_CANDIDATE_ACTION="SKIP", return action="SKIP".
Return ONLY raw valid JSON.`
      },
      {
        role: "user",
        content: `TODAY: ${new Date().toISOString().slice(0, 10)} | CLOSES_IN: ${daysLeftStr} days
QUESTION: "${m.question}"
RESOLUTION_RULES: "${resolutionRules}"
MARKET_ACTIVITY: VOL_24H=$${Math.round(vol24)} | LIQ=$${Math.round(liq)}
PRICE_MOMENTUM_YES: ${priceActionStr}
CLOB_YES_STRUCTURE: ${yesBookStructureStr}
CLOB_NO_STRUCTURE: ${noBookStructureStr}
CLOB_TAPE_FLOW: ${tapeFlowStr}${cryptoLine}
QUANT_SIGNALS: ${prelim.signals.join(",") || "none"}
RECENT_NEWS ${usedCache ? "(cached)" : "(live RSS + Web)"}:
${newsContext.slice(0, 1200)}

Return JSON with this exact schema:
{"action":"BUY_YES"|"BUY_NO"|"SKIP","base_rate_prob":0.01-0.99,"evidence_likelihood_ratio":0.50-2.00,"estimated_yes_prob":0.01-0.99,"confidence":0-100,"edge_pct":number,"signal_types":["NEWS"|"MOMENTUM"|"MISPRICING"|"ORDERFLOW"],"news_found":"short summary of key catalyst","news_source":"url or none","reasoning":"concise quantitative rationale citing oracle math prob vs CLOB ask and orderflow","risk":"LOW"|"MEDIUM"|"HIGH","score":0-100}`
      }
    ],
    temperature: 0.1,
    max_tokens: 2048,
    response_format: { type: "json_object" }
  };

  const data = await callGroqResilient(body);
  const txt = data.choices[0]?.message?.content || "{}";
  const clean = txt.replace(/```[\w]*\n?|```/g, "").trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");
  const result = JSON.parse(jsonMatch[0]);

  // Capturar la intención cruda del LLM como auditor/veto (Fase 2.2: el LLM solo puede vetar, NUNCA proponer un trade sin el Oráculo)
  const rawLlmAction = String(result.action || "SKIP").toUpperCase();
  result.raw_action = rawLlmAction;

  // Poblar siempre telemetría del Oráculo Cripto antes de cualquier SKIP para que decision_log nunca tenga nulls
  const defaultFeeRateBps = Math.max(
    asNumber(m.takerBaseFee, 0),
    asNumber(yesBook?.feeRateBps, 0),
    asNumber(noBook?.feeRateBps, 0)
  );
  result.spot_price = cryptoQuant?.spot ?? null;
  result.target_price = cryptoQuant?.targetPrice ?? null;
  result.math_yes_prob = cryptoQuant?.mathYesProb ?? null;
  result.fee_rate_bps = defaultFeeRateBps;
  result.strategy_version = STRATEGY_VERSION;

  const normalizeProb = (v) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 && n <= 100 ? n / 100 : n;
  };

  const llmEstYesProb = normalizeProb(result.estimated_yes_prob);
  const rawLikelihoodRatio = Math.max(0.25, Math.min(4.0, asNumber(result.evidence_likelihood_ratio, 1.0)));
  const baseRateYes = estYesProb ?? normalizeProb(result.base_rate_prob) ?? llmEstYesProb;

  // El LLM actúa únicamente como VETO (no puede crear compras donde oracleAction === "SKIP" ni invertir el lado del oráculo)
  let llmVetoReason = null;
  if (oracleAction === "SKIP") {
    result.action = "SKIP";
    result.skip_reason = oracleSkipReason || "Oráculo Cripto sin ventaja bruta mínima (>= 4.0¢ sobre BestAsk)";
  } else if (rawLlmAction === "SKIP") {
    result.action = "SKIP";
    llmVetoReason = "VETO_LLM_AUDITOR_SKIP";
    result.skip_reason = `VETO_LLM_AUDITOR_SKIP (${result.reasoning ? result.reasoning.slice(0, 90) : "Catalizador/regla adversa"})`;
  } else if (rawLlmAction !== oracleAction) {
    result.action = "SKIP";
    llmVetoReason = `VETO_LLM_CONTRADICTS_ORACLE (Oráculo=${oracleAction} vs IA=${rawLlmAction})`;
    result.skip_reason = llmVetoReason;
  } else {
    result.action = oracleAction;
  }
  result.considered_side = consideredSide;

  let selectedBook = null;
  let rawSideProb = null;
  let isYesSide = false;

  if (result.action === "BUY_YES") {
    isYesSide = true;
    if (!yesTradable || !yesBook?.isValid) {
      result.action = "SKIP";
      result.skip_reason = `[FILTRO CLOB] Lado YES bloqueado por spread (${yesBook?.spreadPct ? yesBook.spreadPct.toFixed(1) + "%" : "alto"}) o liquidez`;
      result.reasoning = `${result.skip_reason}. ${result.reasoning || ""}`;
    } else {
      selectedBook = yesBook;
      rawSideProb = estYesProb;
    }
  } else if (result.action === "BUY_NO") {
    isYesSide = false;
    if (!noTradable || !noBook?.isValid) {
      result.action = "SKIP";
      result.skip_reason = `[FILTRO CLOB] Lado NO bloqueado por spread (${noBook?.spreadPct ? noBook.spreadPct.toFixed(1) + "%" : "alto"}) o liquidez`;
      result.reasoning = `${result.skip_reason}. ${result.reasoning || ""}`;
    } else {
      selectedBook = noBook;
      rawSideProb = Number.isFinite(estYesProb) ? (1 - estYesProb) : null;
    }
  }

  if (selectedBook && Number.isFinite(rawSideProb) && (result.action === "BUY_YES" || result.action === "BUY_NO")) {
    rawSideProb = Math.max(0.01, Math.min(0.99, rawSideProb));
    const executableAsk = selectedBook.bestAsk;
    const selectedSide  = isYesSide ? "YES" : "NO";

    // 1. Microestructura del Order Book (WOBI y ETI)
    const wBook = (Array.isArray(selectedBook.bids) && selectedBook.bids.length > 0 && Array.isArray(selectedBook.asks) && selectedBook.asks.length > 0)
      ? computeWeightedBookMetrics(selectedBook.bids, selectedBook.asks)
      : {
          bestBid: selectedBook.bestBid,
          bestAsk: selectedBook.bestAsk,
          spreadAbs: selectedBook.spreadAbs,
          wObi: asNumber(selectedBook.wObi ?? selectedBook.obi, 0),
          pMicroWeighted: asNumber(selectedBook.pMicroWeighted ?? selectedBook.microPrice ?? selectedBook.midPrice, executableAsk),
          topLiquidityUsd: asNumber(selectedBook.bidDepthUsd, 0) + asNumber(selectedBook.askDepthUsd, 0),
        };

    const eTape = computeTimeDecayedTapeMetrics(tradeFlow?.rawTrades || [], selectedSide);
    const effectiveObi = wBook.wObi;
    const sideTapeImbalance = (Array.isArray(tradeFlow?.rawTrades) && tradeFlow.rawTrades.length > 0)
      ? eTape.etiImbalance
      : (tradeFlow ? (isYesSide ? tradeFlow.tapeImbalance : -tradeFlow.tapeImbalance) : 0);

    const marketMicro = wBook.pMicroWeighted;

    const isSportsMatch = false;
    const lacksCatalyst = /no recent catalyst|no fresh catalyst|no new info|older news|no recent news|no fresh news|without fresh|oldest \d+|sin noticias recientes|sin catalizador/i.test(
      `${result.news_found || ""} ${result.reasoning || ""}`
    );

    // 2. Fase 2.2: Sin distorsión de Tetlock, sin Platt y sin Theta de Poisson.
    // La probabilidad justa proviene directamente del Oráculo Cripto con un ajuste microestructural acotado (±1.5¢ máx).
    const orderflowMicroAdj = Math.max(-0.015, Math.min(0.015, 0.01 * ((0.5 * effectiveObi) + (0.5 * sideTapeImbalance))));
    const calibratedFairProb = Math.max(0.02, Math.min(0.98, rawSideProb + orderflowMicroAdj));
    const reachableFairProb24h = calibratedFairProb;

    const endDateRaw = m?.endDate || m?.endDateIso;
    const endDateMs  = endDateRaw ? new Date(endDateRaw).getTime() : (Date.now() + 7 * 86400_000);
    const hoursToResolution = Math.max(1, (endDateMs - Date.now()) / 3600_000);
    const daysToResolution  = hoursToResolution / 24;
    const kappa24h          = 1.0;
    const tetlockGuard      = { par: 0, vetoD_PricedIn: false, vetoF_FallingKnife: (effectiveObi <= -0.35 && sideTapeImbalance <= -0.25), vetoG_BlindHallucination: false, directionalMoveDown: 0, directionalMoveUp: 0, blindDivergenceAbs: 0 };
    const calibFeedback     = { psi: 1.0, scope: "ORACLE_DIRECT" };

    // 6. Descuento de Fricción Exacto Maker-First (v3.1.0 — Cumplimiento Gate 0):
    // En Polymarket CLOB, las órdenes Limit pasivas (Maker) de entrada y de Take-Profit pagan 0% fee ($0.004 gas).
    // Solo cuando salta el Stop-Loss de emergencia se cruza el spread como Taker pagando el fee cuadrático (feeRateBps).
    const bestBidPx      = asNumber(selectedBook.bestBid, executableAsk - selectedBook.spreadAbs);
    const exitHalfSpread = Math.max(0.002, marketMicro - bestBidPx);

    const takerBaseFeeBps  = Math.max(asNumber(m.takerBaseFee, 0), asNumber(selectedBook.feeRateBps, 0));
    const exitQuadraticFee = takerBaseFeeBps > 0 ? (reachableFairProb24h * (1 - reachableFairProb24h) * (takerBaseFeeBps / 10000)) : 0;
    const emergencyTakerExitFeePerShare = Math.max(reachableFairProb24h * 0.0035, exitQuadraticFee);

    // Impacto de gas ($0.004 entrada + $0.004 salida) + slippage esperado en caso de Stop-Loss (probabilidad de cola ~28%)
    const refTradeUsdc = Math.max(1.00, (asNumber(botState.config.minTradeUsdc, 1.00) + asNumber(botState.config.maxTradeUsdc, 1.00)) / 2);
    const gasPerShare  = (0.004 * executableAsk) / refTradeUsdc;
    const hasL2Asks    = Array.isArray(selectedBook.asks) && selectedBook.asks.length > 0;
    const hasL2Bids    = Array.isArray(selectedBook.bids) && selectedBook.bids.length > 0;
    const bookWalk     = computeExecutableBookWalk({
      bids: hasL2Bids ? selectedBook.bids : [],
      asks: hasL2Asks ? selectedBook.asks : [],
      targetBuyUsdc: refTradeUsdc,
      targetSellShares: refTradeUsdc / Math.max(0.15, executableAsk),
    });

    const exitSlippageExpected = hasL2Bids
      ? Math.max(0.0015, bookWalk.realSellSlippage)
      : 0.0015;

    // Entrada Maker Limit pasiva (0% fee CLOB, solo gas) + salida ponderada (72% Maker TP/Expiry 0% fee vs 28% Taker SL)
    const probTakerEmergencyExit = 0.28;
    const totalEntryFriction = gasPerShare;
    const totalExitFriction  = ((1 - probTakerEmergencyExit) * gasPerShare) +
      (probTakerEmergencyExit * (exitHalfSpread + emergencyTakerExitFeePerShare + gasPerShare + exitSlippageExpected));

    // Penalización exponencial continua para longshots (< 22¢)
    const longshotPenalty = executableAsk < 0.22 ? (0.022 * Math.exp(-10 * executableAsk)) : 0;

    const rawEdgePct = (rawSideProb - executableAsk) * 100;
    const netEdgePct = (reachableFairProb24h - executableAsk - totalEntryFriction - totalExitFriction - longshotPenalty) * 100;

    // 7. SISTEMA INSTITUCIONAL DE CONFLUENCIA DE 4 PILARES (Confluence Gate)
    const conf = parseFloat(result.confidence || 0);
    const risk = String(result.risk || "MEDIUM").toUpperCase();
    const whaleSideCount = Math.max(
      eTape.informedWhalesCount || 0,
      tradeFlow ? (isYesSide ? tradeFlow.whaleYesCount : tradeFlow.whaleNoCount) : 0
    );
    const estStopLoss   = calcStopLoss(executableAsk, selectedBook.bestBid);
    const estTakeProfit = calcTakeProfit(executableAsk, reachableFairProb24h);
    const rewardToRisk  = (executableAsk - estStopLoss) > 0
      ? (estTakeProfit - executableAsk) / (executableAsk - estStopLoss)
      : 0;

    const pillars = {
      bookQuality: selectedBook.spreadPct <= 3.5 && selectedBook.spreadAbs <= 0.025 && effectiveObi >= -0.05 && (!hasL2Asks || bookWalk.isBuyFullyExecutable),
      orderflowAlignment: (effectiveObi + sideTapeImbalance) >= 0.10 || (whaleSideCount >= 1 && sideTapeImbalance >= 0),
      catalystOrMath: (hasFreshNews && !lacksCatalyst && !tetlockGuard.vetoD_PricedIn) || (effectiveObi >= 0.35 && sideTapeImbalance >= 0.20),
      positiveExpectancy: netEdgePct >= MIN_NET_EDGE_PCT && conf >= 70 && rewardToRisk >= 1.75,
    };

    const hardVetoes = [];

    // Veto Estratégico 0 (v3.0.0-crypto-oracle): Restricción estricta a contratos Cripto con Precio Objetivo ($)
    const marketCategory = m._cat || detectCategory(m.question || "");
    if (!ALLOWED_TRADING_CATEGORIES.includes(marketCategory) || !isCryptoTargetPriceMarket(m.question || "")) {
      hardVetoes.push(`VETO_CATEGORY_NOT_CRYPTO_TARGET (Categoría=${marketCategory}, se requiere Cripto con precio objetivo $)`);
    }

    // Veto Estratégico 0b (v3.0.0-crypto-oracle): Prohibido operar contra la dirección de la evidencia (Likelihood Ratio)
    if (isYesSide && rawLikelihoodRatio < 0.98) {
      hardVetoes.push(`VETO_LR_CONTRADICTS_SIDE (LR=${rawLikelihoodRatio.toFixed(2)} < 1.00 contradice BUY_YES)`);
    } else if (!isYesSide && rawLikelihoodRatio > 1.02) {
      hardVetoes.push(`VETO_LR_CONTRADICTS_SIDE (LR=${rawLikelihoodRatio.toFixed(2)} > 1.00 contradice BUY_NO)`);
    }

    // Veto Estratégico 1: Banda Operativa Taker [20¢ - 80¢]
    if (executableAsk < 0.20 || executableAsk > 0.80) {
      hardVetoes.push(`Precio fuera de banda operativa [20¢-80¢] (Ask=${(executableAsk * 100).toFixed(1)}¢)`);
    }

    // Veto Estratégico 2: Filtro de Decaimiento Temporal (>14 días sin catalizador fresco del día)
    if (daysToResolution > 14 && (!hasFreshNews || lacksCatalyst)) {
      hardVetoes.push(`Horizonte > 14d (${daysToResolution.toFixed(1)}d) sin catalizador fresco del día`);
    }

    // Veto Duro A: Prohibido comprar contra el flujo del Order Book (WOBI) y de la Cinta (ETI) simultáneamente
    if (effectiveObi < -0.05 && sideTapeImbalance <= 0.05) {
      hardVetoes.push(`Flujo en contra (WOBI=${effectiveObi.toFixed(2)}, ETI=${sideTapeImbalance.toFixed(2)})`);
    }

    // Veto Duro B0 (v2.7.1): En contratos cripto con precio objetivo, si Kraken falla o está desconectado, pausar por seguridad
    const isCryptoTargetMarket =
      /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge)\b/i.test(m.question || "") &&
      /\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k)?/i.test(m.question || "");

    if (isCryptoTargetMarket && (!cryptoQuant || !Number.isFinite(cryptoQuant.spot) || !Number.isFinite(cryptoQuant.mathYesProb))) {
      hardVetoes.push("Oráculo Cripto desconectado (sin datos spot o cálculo de barrera en Kraken): operativa pausada por seguridad");
    }

    // Veto Duro B (v2.7.0): En Cripto con Oráculo Dual (Digital Europeo vs Barrera Americana)
    // 1. La probabilidad estocástica no puede contradecir la compra (MathProb < Ask).
    // 2. Escudo Anti-Divergencia / "Demasiado bueno para ser verdad":
    //    Si el modelo estocástico supera el Ask por >= 22¢ sin un catalizador fresco (<= 3h),
    //    se trata de una trampa de volatilidad de difusión continua vs soporte/resistencia real en el libro de órdenes.
    if (cryptoQuant && Number.isFinite(cryptoQuant.mathYesProb)) {
      const mathSideProb = isYesSide ? cryptoQuant.mathYesProb : (1 - cryptoQuant.mathYesProb);
      pillars.catalystOrMath = mathSideProb >= (executableAsk + 0.03);
      if (mathSideProb < executableAsk) {
        hardVetoes.push(`Oráculo Cripto (${cryptoQuant.modelType}) contradice compra (MathProb=${(mathSideProb * 100).toFixed(1)}% < Ask=${(executableAsk * 100).toFixed(1)}%)`);
      } else if (!hasFreshNews && (mathSideProb - executableAsk) >= 0.22) {
        hardVetoes.push(`VETO_B2_IMPLAUSIBLE_CRYPTO_DIVERGENCE (MathProb=${(mathSideProb * 100).toFixed(1)}% supera Ask=${(executableAsk * 100).toFixed(1)}% por +${((mathSideProb - executableAsk) * 100).toFixed(0)}¢ sin catalizador nuevo)`);
      }
    }

    // Veto Duro C: En Deportes/Esports exigir confluencia extrema
    if (isSportsMatch) {
      if (conf < 80 || lacksCatalyst || !hasFreshNews || effectiveObi < 0.20 || sideTapeImbalance < 0.15) {
        hardVetoes.push(`Deportes bloqueado sin catalizador + flujo institucional unánime`);
      }
    }

    // Veto Duro D (v2.5.1): Catalizador Ya Descontado / Chasing Veto (PAR >= 65% o salto >= +11¢ en 6h)
    if (tetlockGuard.vetoD_PricedIn) {
      hardVetoes.push(`VETO_D_CATALYST_ALREADY_PRICED_IN (PAR=${(tetlockGuard.par * 100).toFixed(0)}%, MoveUp=+${(tetlockGuard.directionalMoveUp * 100).toFixed(1)}¢, NewsAge=${minNewsAgeHours.toFixed(1)}h)`);
    }

    // Veto Duro E (v2.5.0): Latencia Deportiva In-Play (<= 3.5h para resolución)
    if (isSportsMatch && hoursToResolution <= 3.5) {
      hardVetoes.push(`VETO_E_SPORTS_LIVE_LATENCY_RISK (${hoursToResolution.toFixed(1)}h <= 3.5h)`);
    }

    // Veto Duro F (v2.5.1): Escudo Anti-Cuchillo Cayendo ("Falling Knife" / Flujo Informado Adverso no indexado en RSS)
    if (tetlockGuard.vetoF_FallingKnife) {
      hardVetoes.push(`VETO_F_INFORMED_ADVERSE_DUMP (Move=${(tetlockGuard.directionalMoveDown * 100).toFixed(1)}¢, WOBI=${effectiveObi.toFixed(2)}, ETI=${sideTapeImbalance.toFixed(2)})`);
    }

    // Veto Duro G (v2.5.1): Divergencia Ciega Extrema sin Noticia de Última Hora (<= 3h)
    if (tetlockGuard.vetoG_BlindHallucination) {
      hardVetoes.push(`VETO_G_BLIND_LLM_DIVERGENCE (Diff=${(tetlockGuard.blindDivergenceAbs * 100).toFixed(1)}¢ sin noticia <=3h)`);
    }

    // Veto Duro H (NUEVO v2.6.0): Profundidad Ejecutable en Tope de Libro (+1.0¢) Insuficiente para FAK completo
    if (hasL2Asks && !bookWalk.isBuyFullyExecutable) {
      hardVetoes.push(`VETO_H_INSUFFICIENT_TOP_BOOK_DEPTH (Depth1c=$${bookWalk.depthWithin1CentUsdc} < $${(refTradeUsdc * 1.35).toFixed(2)})`);
    }

    const confluenceScore = Object.values(pillars).filter(Boolean).length;
    const computedScore = computeSignalScore(prelim.score, conf, netEdgePct, confluenceScore, result.score);
    const fairYesProb = isYesSide ? calibratedFairProb : (1 - calibratedFairProb);

    result.score = computedScore;
    result.confidence = Math.round(conf);
    result.raw_fair_prob = Number(rawSideProb.toFixed(4));
    result.fair_prob = Number(calibratedFairProb.toFixed(4));
    result.reachable_fair_prob_24h = Number(reachableFairProb24h.toFixed(4));
    result.kappa_24h = Number(kappa24h.toFixed(3));
    result.price_absorption_ratio = tetlockGuard.par;
    result.platt_psi = calibFeedback.psi;
    result.platt_psi_scope = calibFeedback.scope;
    result.fair_value_yes = Number(fairYesProb.toFixed(4));
    result.executable_ask = Number(executableAsk.toFixed(4));
    result.vwap_ask = bookWalk.vwapAsk;
    result.real_buy_slippage = bookWalk.realBuySlippage;
    result.depth_1c_usd = bookWalk.depthWithin1CentUsdc;
    result.executable_bid = Number(selectedBook.bestBid.toFixed(4));
    result.micro_price = Number(marketMicro.toFixed(4));
    result.obi = Number(effectiveObi.toFixed(3));
    result.tape_imbalance = Number(sideTapeImbalance.toFixed(3));
    result.spread_pct = Number(selectedBook.spreadPct.toFixed(2));
    result.reward_to_risk = Number(rewardToRisk.toFixed(2));
    result.confluence_score = confluenceScore;
    result.confluence_pillars = pillars;
    result.raw_edge_pct = Number(rawEdgePct.toFixed(2));
    result.edge_pct = Number(netEdgePct.toFixed(2));
    result.fee_rate_bps = takerBaseFeeBps;
    result.spot_price = cryptoQuant?.spot ?? null;
    result.target_price = cryptoQuant?.targetPrice ?? null;
    result.math_yes_prob = cryptoQuant?.mathYesProb ?? null;
    result.strategy_version = STRATEGY_VERSION;
    if (!Array.isArray(result.signal_types) || result.signal_types.length === 0) {
      result.signal_types = inferSignalTypesFromText(result.news_found, result.reasoning, netEdgePct);
    }

    if (
      hardVetoes.length > 0 ||
      confluenceScore < 3 ||
      netEdgePct < MIN_NET_EDGE_PCT ||
      conf < MIN_AI_CONFIDENCE ||
      risk === "HIGH"
    ) {
      result.action = "SKIP";
      result.considered_side = selectedSide;
      const reasons = [];
      if (hardVetoes.length > 0) reasons.push(hardVetoes[0]);
      if (netEdgePct < MIN_NET_EDGE_PCT) reasons.push(`Edge ${netEdgePct.toFixed(1)}% < min ${MIN_NET_EDGE_PCT}%`);
      if (conf < MIN_AI_CONFIDENCE) reasons.push(`Conf ${conf}% < min ${MIN_AI_CONFIDENCE}%`);
      if (confluenceScore < 3) reasons.push(`Pilares ${confluenceScore}/4 < 3`);
      if (risk === "HIGH") reasons.push(`Riesgo ALTO`);
      result.skip_reason = reasons.join(" · ");
      const vetoDetail = hardVetoes.length > 0 ? `Veto: ${hardVetoes.join("; ")} | ` : "";
      result.reasoning = `[CONFLUENCE GATE: ${confluenceScore}/4 pilares | ${vetoDetail}Edge Calibrado ${netEdgePct.toFixed(1)}%, R:R ${rewardToRisk.toFixed(2)}x, Conf ${conf}%] ${result.reasoning || ""}`;
    }
  } else {
    result.action = "SKIP";
    result.considered_side = result.considered_side || (Number.isFinite(estYesProb) ? (estYesProb >= 0.5 ? "YES" : "NO") : null);
    result.skip_reason = result.skip_reason || "La IA evaluó que no hay ventaja estadística (SKIP)";
    result.score = asNumber(result.score, 0);
    result.confidence = asNumber(result.confidence, 0);
    result.edge_pct = Number(parseFloat(result.edge_pct || 0).toFixed(2));
  }

  if (!result.news_source || result.news_source === "url" || result.news_source === "none") {
    result.news_source = topSource;
  }
  if (!result.news_found && topSnippet !== "none") {
    result.news_found = topSnippet;
  }
  if (botState.newsCache[marketId]) {
    botState.newsCache[marketId].question = m.question;
    botState.newsCache[marketId].category = m._cat || detectCategory(m.question);
  }

  result._newsCached = usedCache;
  return result;
}

// ── CICLO MAESTRO DE ESCANEO ──
export async function runFullScan() {
  const { acquired } = await withRuntimeLock(
    {
      supabase,
      lockName: "scan",
      owner: runtimeLockOwners.scan,
      ttlSeconds: CRITICAL_LOOP_LOCK_TTL_SECONDS,
    },
    async () => {
      if (botState.scanStatus.running) return;
      botState.scanStatus.running = true;
      botState.scanStatus.phase = "Iniciando...";
      botState.scanStatus.progress = 0;

      addLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "SYSTEM");
      addLog("[BACKEND] ESCANEO CUANTITATIVO INICIADO", "SYSTEM");

      try {
        const raw = await fetchAllMarkets(msg => {
          botState.scanStatus.phase = msg;
        });

        botState.scanStatus.total = raw.length;
        const prevSnap = botState.marketSnapshots;
        const newSnap = {};
        const scored = [];
        const enriched = [];

        for (const rawMarket of raw) {
          const tokenIds = parseTokenIds(rawMarket);
          const m = {
            ...rawMarket,
            _cat: detectCategory(rawMarket.question),
            _yesTokenId: tokenIds.yesTokenId,
            _noTokenId: tokenIds.noTokenId,
          };
          const id = m.id || m.conditionId;
          const pre = preliminaryScore(m, prevSnap[id]);
          m._prelim = {
            score: pre.score,
            signals: pre.signals,
            yesP: pre.yesP,
            noP: pre.noP,
            vol: pre.vol,
            vol24: pre.vol24,
            liq: pre.liq,
            sum: pre.sum,
            daysLeft: pre.daysLeft,
            change1h: pre.change1h,
            change24h: pre.change24h,
            change7d: pre.change7d,
            skip: pre.skip,
          };
          enriched.push(m);

          if (!pre.skip && pre.score >= botState.config.minScore) {
            scored.push({ m, pre });
          }
          if (Number.isFinite(pre.yesP) && Number.isFinite(pre.noP)) {
            newSnap[id] = { yesP: pre.yesP, noP: pre.noP, ts: Date.now() };
          }
        }
        botState.allMarkets = enriched;
        botState.marketSnapshots = newSnap;

        scored.sort((a, b) => b.pre.score - a.pre.score);
        botState.scanStatus.phase = `Verificando Order Books CLOB (${scored.length} candidatos)...`;
        const targetAiCount = Math.max(3, botState.config.aiTopN || 3);
        const viable = await selectOrderBookVerifiedCandidates(scored, targetAiCount);
        addLog(`✅ Filtros + OrderBook CLOB superados: ${viable.length}/${scored.length} mercados pasan a IA Profunda`, "FILTER");

        const approvedQueue = [];
        for (let i = 0; i < viable.length; i++) {
          const { m, pre } = viable[i];
          botState.scanStatus.phase = `IA Analizando: ${m.question.slice(0, 30)}...`;
          botState.scanStatus.progress = Math.round((i / viable.length) * 100);

          try {
            const analysis = await deepAnalyze(m, pre);
            await insertDecisionLogSafe(m, pre, analysis);

            const isValidAction = analysis.action === "BUY_YES" || analysis.action === "BUY_NO";
            const scoreNum = asNumber(analysis.score, 0);
            const confNum = asNumber(analysis.confidence, 0);

            if (!isValidAction || scoreNum < botState.config.minScore || confNum <= 0) {
              const sideTag = analysis.considered_side ? `[Lado: ${analysis.considered_side}]` : `[Sin lado claro]`;
              const skipWhy = analysis.skip_reason || (analysis.reasoning ? analysis.reasoning.slice(0, 110) : "Sin ventaja estadística");
              addLog(`⏭️ [IA SKIP] ${sideTag} ${m.question.slice(0, 48)}... | Edge: ${analysis.edge_pct ?? 0}% | Conf: ${confNum}% | Motivo: ${skipWhy}`, "INFO");
              continue;
            }

            const sig = {
              id: uid(),
              detectedAt: new Date().toISOString(),
              market: m,
              tokenIds: { yes: m._yesTokenId, no: m._noTokenId },
              prelim: pre,
              analysis,
              executed: false,
            };
            botState.signals.unshift(sig);
            if (botState.signals.length > 300) botState.signals.length = 300;
            addLog(`✨ [SEÑAL IA] ${analysis.action} | Score: ${scoreNum}/100 | Conf: ${confNum}% | Edge Neto: ${analysis.edge_pct}% | Merc: ${m.question.slice(0, 50)}`, "AI");

            await insertAiSignalSafe(sig, m, pre, analysis);
            approvedQueue.push({ m, pre, analysis, sig, scoreNum, confNum });
          } catch (error) {
            addLog(`❌ [SCAN] Error analizando mercado: ${error.message}`, "ERROR");
          }

          await new Promise(res => setTimeout(res, 200));
        }

        // ── FASE 2.2 y 3A (v3.0.0-crypto-oracle): ORDENAMIENTO SIMPLE POR EDGE DEL ORÁCULO ──
        // Se eliminan el Torneo complejo y el Zombie Trade Swap (que cerraba posiciones pagando doble spread).
        approvedQueue.sort((a, b) => asNumber(b.analysis?.edge_pct, 0) - asNumber(a.analysis?.edge_pct, 0));

        for (const { m, pre, analysis, sig } of approvedQueue) {
          try {
            if (botState.goalReached) {
              addLog("🛑 META DIARIA ALCANZADA: inversión en espera.", "SYSTEM");
              continue;
            }

            if (!botState.config.autoTrade) continue;

            // Strict Quantitative Gate before risking capital
            const conf = asNumber(analysis.confidence, 0);
            const netEdge = asNumber(analysis.edge_pct, 0);
            const riskLevel = String(analysis.risk || "MEDIUM").toUpperCase();

            if (conf < MIN_AI_CONFIDENCE || netEdge < MIN_NET_EDGE_PCT || riskLevel === "HIGH") {
              addLog(
                `🛡 [QUANT GATE] Señal filtrada (Conf=${conf}% vs min ${MIN_AI_CONFIDENCE}%, EdgeNeto=${netEdge}% vs min ${MIN_NET_EDGE_PCT}%, Risk=${riskLevel})`,
                "FILTER"
              );
              continue;
            }

            const marketId = String(m.id || m.conditionId || "");
            const conditionId = String(m.conditionId || m.condition_id || m.id || "");
            const isYes = analysis.action === "BUY_YES";
            const tokenId = isYes ? m._yesTokenId : m._noTokenId;
            if (!tokenId) {
              addLog(`⚠️ [TRADE BLOQUEADO] Sin tokenID para ${analysis.action}: ${m.question.slice(0, 70)}`, "WARN");
              continue;
            }

            const inMemoryDuplicate = botState.trades.some(
              trade => shouldManageTrade(trade) && (
                String(trade.marketId) === marketId ||
                String(trade.conditionId) === conditionId
              )
            );
            if (inMemoryDuplicate) {
              addLog(`⚠️ [TRADE BLOQUEADO] Ya existe posición abierta en memoria para: ${m.question.slice(0, 60)}`, "WARN");
              continue;
            }

            if (hasCorrelatedOpenPosition(m, botState.trades)) {
              addLog(`🛡 [CORRELATION GUARD] Bloqueado por concentración temática con otra posición abierta: ${m.question.slice(0, 60)}`, "FILTER");
              continue;
            }

            const persistedDuplicate = await findPersistedOpenTradeForMarket(marketId, conditionId);
            if (persistedDuplicate) {
              addLog(`⚠️ [TRADE BLOQUEADO] Ya existe posición persistida (${persistedDuplicate.trade_id}) para: ${m.question.slice(0, 60)}`, "WARN");
              continue;
            }

            if (isRealTradingEnabled()) {
              const readiness = await refreshDbReadiness();
              if (!readiness.autoTradeReady) {
                addLog(`⛔ [AUTO-TRADE BLOQUEADO] Infraestructura no lista: ${readiness.blockers.join(" | ")}`, "WARN");
                continue;
              }
            }

            let tradePlan = await buildTradePlan();

            if (!tradePlan.allowed) {
              addLog(`⛔ [TRADE BLOQUEADO] ${tradePlan.reason}`, "WARN");
              continue;
            }

            const sideBook = isYes ? pre.clob?.yes : pre.clob?.no;
            const amt = computeQuantPositionSize(tradePlan.amount, analysis, sideBook);
            const rawAsk = sideBook?.bestAsk ?? (isYes ? pre.yesP : pre.noP);
            const entryBid = sideBook?.bestBid ?? parseFloat(Math.max(0.01, rawAsk - 0.01).toFixed(4));

            // Modelo de Ejecución Maker-First v3.1.0 (Cumplimiento Gate 0: Orden Limit Pasiva con 0% Maker Fee en CLOB + $0.004 Gas Polygon)
            // En lugar de cruzar el libro como Taker pagando 1000 bps (~5.9% de entrada), entramos con orden Limit al precio límite sin slippage de barrido.
            const effectiveSimEntry = parseFloat(Math.min(0.98, rawAsk).toFixed(4));
            const feeRateBps = Math.max(asNumber(m.takerBaseFee, 0), asNumber(sideBook?.feeRateBps, 0));
            const entryFeeUsd = 0.004; // 0% Maker fee en Polymarket CLOB + $0.004 gas Polygon
            const netEntryCapital = Math.max(0.05, amt - entryFeeUsd);
            // CTFExchange trunca shares hacia abajo a 6 decimales
            const simulatedShares = Math.floor((netEntryCapital / effectiveSimEntry) * 1e6) / 1e6;

            let executedAmount = amt;
            let executedEntry = effectiveSimEntry;
            let initialMarkPrice = entryBid;
            let executedShares = simulatedShares;
            let buyOrderId = null;
            let buyOrderStatus = "SIMULATED";
            let buyTxHashes = null;
            let executionMode = "SIMULATED";

            if (isRealTradingEnabled()) {
              const realOrder = await executeBuyOrder({
                market: m,
                analysis,
                pre: { ...pre, yesP: pre.clob?.yes?.bestAsk ?? pre.yesP, noP: pre.clob?.no?.bestAsk ?? pre.noP },
                amountUsdc: amt,
              });
              executedAmount = realOrder.amountUsdc;
              executedEntry = realOrder.entryPrice;
              initialMarkPrice = entryBid > 0 ? entryBid : executedEntry;
              executedShares = realOrder.shares;
              buyOrderId = realOrder.orderId;
              buyOrderStatus = realOrder.orderStatus || "matched";
              buyTxHashes = JSON.stringify(realOrder.txHashes || []);
              executionMode = "REAL";
            }

            const openedAt = new Date().toISOString();
            const baseTrade = {
              id: `T-${uid().toUpperCase()}`,
              signalId: sig.id,
              ts: openedAt,
              openedAt,
              question: m.question,
              marketId,
              eventId: m?.events?.[0]?.id || m?.eventId || null,
              groupSlug: m?.events?.[0]?.slug || pre?.eventSlug || null,
              category: m._cat,
              action: analysis.action,
              side: isYes ? "YES" : "NO",
              conditionId,
              tokenId,
              entryPrice: executedEntry,
              currentPrice: initialMarkPrice,
              shares: executedShares,
              cost: executedAmount,
              entryFeeUsd,
              feeRateBps,
              strategyVersion: STRATEGY_VERSION,
              mfePrice: initialMarkPrice,
              maePrice: initialMarkPrice,
              frictionDeducted: true,
              confidence: analysis.confidence,
              edge_pct: analysis.edge_pct,
              predictedProb: Number.isFinite(Number(analysis.fair_prob)) ? Number(analysis.fair_prob) : null,
              score: analysis.score,
              risk: analysis.risk,
              signal_types: analysis.signal_types || [],
              reasoning: analysis.reasoning,
              news: analysis.news_found,
              status: "OPEN",
              pnl: 0,
              executionMode,
              buyOrderId,
              buyOrderStatus,
              buyTxHashes,
              stopLoss: calcStopLoss(executedEntry, entryBid),
              takeProfit: calcTakeProfit(executedEntry, analysis.reachable_fair_prob_24h ?? analysis.fair_prob),
              breakEvenArmed: false,
              trailingActive: false,
              maxHoldAt: calcMaxHoldAt(openedAt),
            };
            const trade = {
              ...baseTrade,
              ...computeTradeEconomics(baseTrade),
            };

            if (executionMode === "REAL") {
              await refreshWalletSnapshot(true);
              addLog(`🚀 [BACKEND COMPRA REAL] ${trade.side} | $${executedAmount.toFixed(2)} | Ask: ${fmtPct(executedEntry)} | Bid: ${fmtPct(entryBid)} | OrderID: ${buyOrderId || "N/A"}`, "TRADE");
              await recordOrderEventSafe(trade.id, "BUY_ORDER_CREATED", {
                order_id: buyOrderId,
                order_status: buyOrderStatus,
                tx_hashes: buyTxHashes,
                token_id: trade.tokenId,
                side: trade.side,
                amount: executedAmount,
                shares: executedShares,
              });
            } else {
              botState.capital = roundMoney(botState.capital - executedAmount);
              hydrateCapitalFromLocalState();
              addLog(`🚀 [BACKEND COMPRA SIM] ${trade.side} | Inversión: $${executedAmount.toFixed(2)} (Fee/Pool: -$${entryFeeUsd.toFixed(3)}) | Ask Efectivo: ${fmtPct(executedEntry)} | Bid: ${fmtPct(entryBid)} | SL: ${fmtPct(trade.stopLoss)} | TP: ${fmtPct(trade.takeProfit)}`, "TRADE");
            }

            botState.trades.unshift(trade);
            sig.executed = true;
            await insertTradeSafe(trade, sig.id);
          } catch (error) {
            addLog(`❌ [SCAN] Error procesando mercado: ${error.message}`, "ERROR");
          }

          await new Promise(res => setTimeout(res, 200));
        }
      } catch (err) {
        const causeMsg = err?.cause?.message ? ` (${err.cause.message})` : "";
        addLog(`❌ Error Crítico Scanner Backend: ${err.message}${causeMsg}`, "ERROR");
      } finally {
        botState.scanStatus.running = false;
        botState.scanStatus.progress = 100;
        botState.scanStatus.phase = "Completado";
        botState.scanStatus.lastScan = new Date().toLocaleString("es-CO");
      }
    }
  );

  if (!acquired) {
    addLog("⏭️ [LOCK] Escaneo omitido porque otra instancia ya lo está ejecutando.", "WARN");
  }
}

// â”€â”€ FAST SYNC AUTOPILOT (Monitoreo de P&L de abiertas) â”€â”€
export async function fastSyncTrades() {
  const { acquired } = await withRuntimeLock(
    {
      supabase,
      lockName: "sync",
      owner: runtimeLockOwners.sync,
      ttlSeconds: CRITICAL_LOOP_LOCK_TTL_SECONDS,
    },
    async () => {
      await reconcileManagedTradesWithWallet();
      const openTrades = getOpenTrades();
      if (openTrades.length === 0) {
        await runWithdrawalAutopilot("SYNC_IDLE");
        return;
      }

      try {
        for (const trade of openTrades) {
          let livePx = null;

          // Cotización dual (v2.6.1): bestBid = precio de GATILLO (SL/BE/Trailing/TP); vwapBid = precio de LIQUIDACIÓN / PnL
          let exitVwapBid = null;
          if (trade.tokenId) {
            const exitQuote = await getTokenExitQuote(trade.tokenId, asNumber(trade.shares, 1));
            livePx = exitQuote.bestBid;
            exitVwapBid = exitQuote.vwapBid;
          }

          if ((!Number.isFinite(livePx) || livePx <= 0.001 || livePx >= 0.999) && Number.isFinite(trade.currentPrice)) {
            livePx = trade.currentPrice;
          }

          if (!Number.isFinite(livePx) || livePx <= 0.001 || livePx >= 0.999) {
            continue;
          }

          const tradeIdx = botState.trades.findIndex(x => x.id === trade.id);
          if (tradeIdx < 0) continue;

          const prevPx = asNumber(botState.trades[tradeIdx].currentPrice, 0);
          botState.trades[tradeIdx].currentPrice = livePx;
          const prevMfe = asNumber(botState.trades[tradeIdx].mfePrice, livePx);
          const prevMae = asNumber(botState.trades[tradeIdx].maePrice, livePx);
          botState.trades[tradeIdx].mfePrice = Math.max(prevMfe, livePx);
          botState.trades[tradeIdx].maePrice = Math.min(prevMae > 0 ? prevMae : livePx, livePx);
          Object.assign(botState.trades[tradeIdx], computeTradeEconomics(botState.trades[tradeIdx]));

          // Persist mark-to-market price updates + MFE/MAE excursions when price moves by >= 0.3 cents
          if (Math.abs(livePx - prevPx) >= 0.003) {
            await updateTradeSafe(
              trade.id,
              {
                current_price: livePx,
                mfe_price: botState.trades[tradeIdx].mfePrice,
                mae_price: botState.trades[tradeIdx].maePrice,
              },
              { current_price: livePx }
            );
          }

          const openTrade = botState.trades[tradeIdx];
          const entryPrice = asNumber(openTrade.entryPrice, 0.5);
          const shares     = Math.max(0.000001, asNumber(openTrade.shares, 1));

          // ─── Parámetros de Volatilidad Binaria Simétrica σ_bin = sqrt(p*(1-p)) ─
          // Reemplaza la distorsión de entryPrice * 1.08 que asfixiaba precios altos
          const binarySigma = Math.sqrt(Math.max(0.04, entryPrice * (1 - entryPrice)));

          // ─── Envejecimiento de la Posición (Fracción de las 24h consumidas — v2.6.0) ──
          const openedRaw   = openTrade.ts || openTrade.openedAt;
          const openedAtMs  = openedRaw ? new Date(openedRaw).getTime() : Date.now();
          const hoursHeld   = Math.max(0, (Date.now() - openedAtMs) / 3600_000);
          const maxHoldHrs  = Math.max(6, asNumber(botState.config.maxHoldHours, 24));
          const lifeRatio   = Math.min(1.0, hoursHeld / maxHoldHrs); // tau en [0, 1]

          // ─── 1. Break-Even Exacto Real Libre de Pérdidas (v3.1.0 — Usa Costo Base Real cost/shares + Fee Taker Real de Salida) ─
          // En la vida real, cuando el precio cae hacia un Stop (STOP_LOSS, BREAK_EVEN o TRAILING_STOP), la orden vende contra el bestBid
          // como Taker (pagando feeRateBps cuadrático + gas + slippage). Sumamos estExitQuadraticFeePerShare a exactBreakEvenPx
          // para que un cierre en BREAK_EVEN o TRAILING_STOP sea 100% rentable en Neto tanto en Simulación como en Dinero Real.
          const trueCostBasisPerShare = asNumber(openTrade.cost, entryPrice * shares) / shares;
          const tradeFeeBps = Math.max(0, asNumber(openTrade.feeRateBps, 0));
          const estExitQuadraticFeePerShare = tradeFeeBps > 0
            ? (tradeFeeBps / 10000) * entryPrice * (1 - entryPrice)
            : (entryPrice * 0.0035);
          const beExitFrictionPerShare = estExitQuadraticFeePerShare + (0.004 / shares) + 0.0015 + (0.005 / shares);
          const exactBreakEvenPx = trueCostBasisPerShare + beExitFrictionPerShare;
          const exactBreakEvenFloor = parseFloat(Math.max(exactBreakEvenPx, entryPrice + 0.015).toFixed(4));

          // Si el trade supera las 12h (lifeRatio >= 0.50), reducir el colchón exigido para armar el Break-Even hasta en un 35%
          const timeDecayBeFactor = lifeRatio >= 0.50 ? (1.0 - 0.35 * ((lifeRatio - 0.50) / 0.50)) : 1.0;
          const beNoiseCushion    = Math.max(0.006, 0.020 * binarySigma * timeDecayBeFactor);
          const triggerPrice      = Math.max(
            exactBreakEvenFloor + beNoiseCushion,
            entryPrice + Math.max(0.024, 0.050 * binarySigma * timeDecayBeFactor)
          );

          if (!openTrade.breakEvenArmed && entryPrice > 0 && botState.config.breakEvenTriggerPct > 0 && livePx >= triggerPrice) {
            if (exactBreakEvenFloor > asNumber(openTrade.stopLoss, 0)) {
              openTrade.stopLoss = exactBreakEvenFloor;
              openTrade.breakEvenArmed = true;
              await updateTradeSafe(trade.id, { stop_loss: exactBreakEvenFloor, break_even_armed: true, current_price: livePx });
              addLog(`🛡 [RISK] Break-even exacto activado en ${trade.id}. Nuevo SL libre de pérdidas: ${fmtPct(exactBreakEvenFloor)}`, "RISK");
            }
          }

          // ─── 2. Trailing Stop Adaptativo por Volatilidad Binaria (v3.1.0: Captura excursiones de +2.8¢ a +5.0¢) ──
          // Se activa desde +2.8¢ sobre la entrada con distancia estrecha de ~1.2¢-1.5¢ para amarrar ganancias reales
          const trailActivationPx = entryPrice + Math.max(0.026, 0.058 * binarySigma);
          const dynamicTrailDist  = Math.max(0.012, 0.032 * binarySigma);

          if (openTrade.breakEvenArmed && entryPrice > 0 && livePx >= trailActivationPx) {
            const trailedStop = parseFloat(Math.max(exactBreakEvenFloor, livePx - dynamicTrailDist).toFixed(4));
            if (trailedStop > asNumber(openTrade.stopLoss, 0) + 0.003) {
              openTrade.stopLoss = trailedStop;
              openTrade.trailingActive = true;
              await updateTradeSafe(trade.id, { stop_loss: trailedStop, current_price: livePx });
              addLog(`📈 [TRAILING SL] Stop Loss adaptativo (σ_bin=${binarySigma.toFixed(2)}) subido en ${trade.id} a ${fmtPct(trailedStop)} (Bid actual: ${fmtPct(livePx)})`, "RISK");
            }
          }

          const stopLoss = asNumber(openTrade.stopLoss, 0);
          const staticTakeProfit = asNumber(openTrade.takeProfit, 0.98);
          const minHarvestTarget = Math.min(staticTakeProfit, exactBreakEvenPx + 0.012);

          // ─── 2b. Curva de Compresión Continua de Take-Profit TP(tau) (v2.6.0) ──
          // A partir del 35% de vida (8.4h), el TP baja progresivamente hacia (exactBreakEvenPx + 1.2¢)
          const effectiveTakeProfit = lifeRatio < 0.35
            ? staticTakeProfit
            : Number(
                (
                  minHarvestTarget +
                  (staticTakeProfit - minHarvestTarget) *
                    Math.pow(1.0 - (lifeRatio - 0.35) / 0.65, 1.35)
                ).toFixed(4)
              );

          openTrade.effectiveTakeProfit = effectiveTakeProfit;
          openTrade.lifeRatio = Number(lifeRatio.toFixed(3));

          const maxHoldAtMs = openTrade.maxHoldAt ? new Date(openTrade.maxHoldAt).getTime() : NaN;
          const maxHoldReached = Number.isFinite(maxHoldAtMs) && Date.now() >= maxHoldAtMs;

          // ─── 3. Decisión de Cierre (Con compresión de TP, separación de estados y filtro anti-mecha) ─
          let closeReason = null;
          if (effectiveTakeProfit > 0 && livePx >= effectiveTakeProfit) {
            closeReason = (lifeRatio >= 0.55 && livePx < staticTakeProfit)
              ? "TIME_DECAY_PROFIT_HARVEST"
              : "TAKE_PROFIT";
          } else if (stopLoss > 0 && livePx <= stopLoss) {
            // Anti-Wick en polling de 3 min: esperar 1.5s y verificar segundo snapshot rápido del CLOB
            if (trade.tokenId) {
              await new Promise(res => setTimeout(res, 1500));
              const secondQuote = await getTokenExitQuote(trade.tokenId, shares);
              const secondCheckPx = secondQuote.bestBid;
              if (Number.isFinite(secondCheckPx) && secondCheckPx > 0.001 && secondCheckPx < 0.999) {
                livePx = secondCheckPx;
                exitVwapBid = secondQuote.vwapBid;
                openTrade.currentPrice = livePx;
              }
            }
            if (livePx <= stopLoss) {
              const isTrailingStop = Boolean(
                openTrade.trailingActive ||
                (openTrade.breakEvenArmed && stopLoss > (exactBreakEvenFloor + 0.002))
              );
              closeReason = isTrailingStop
                ? "TRAILING_STOP"
                : (openTrade.breakEvenArmed ? "BREAK_EVEN" : "STOP_LOSS");
            }
          } else if (maxHoldReached) {
            closeReason = "MAX_HOLD";
          }

          // ─── 3a. Cierre forzado por rotación de capital (v2.7.0 OPPORTUNITY_COST_SWAP) ──
          if (!closeReason && openTrade.forceCloseReason) {
            closeReason = openTrade.forceCloseReason;
          }

          // ─── 3b. Salida Anticipada por Invalidación de Microestructura (v2.5.1) ──
          // Si la operación lleva >= 15 min abierta, está en pérdida >= 1.0¢ y aún no tocó SL,
          // verificamos si el Order Book colapsó en nuestra contra (WOBI <= -0.32).
          // Si hay pared de venta institucional encima, cortamos antes de regalar el Stop Loss completo.
          if (!closeReason && !openTrade.breakEvenArmed && openTrade.tokenId) {
            const openedRaw = openTrade.ts || openTrade.openedAt;
            const openedAtMs = openedRaw ? new Date(openedRaw).getTime() : NaN;
            const minutesHeld = Number.isFinite(openedAtMs) ? (Date.now() - openedAtMs) / 60000 : 0;
            const currentLossCents = entryPrice - livePx;

            if (minutesHeld >= 15 && currentLossCents >= 0.010) {
              const liveBookSnap = await getOrderBookSnapshot(openTrade.tokenId).catch(() => null);
              if (
                liveBookSnap &&
                Number.isFinite(liveBookSnap.wObi) &&
                liveBookSnap.wObi <= -0.32 &&
                liveBookSnap.pMicroWeighted < livePx
              ) {
                closeReason = "THESIS_INVALIDATED";
                addLog(
                  `⚡ [THESIS INVALIDATED] Salida anticipada en ${trade.id}: libro volcado en contra (WOBI=${liveBookSnap.wObi.toFixed(2)}, Pérdida=-${(currentLossCents * 100).toFixed(1)}¢). Cortando antes del SL.`,
                  "RISK"
                );
              }
            }
          }

          if (!closeReason) {
            Object.assign(botState.trades[tradeIdx], computeTradeEconomics(botState.trades[tradeIdx]));
            continue;
          }

          const shouldRealSell = isRealTradingEnabled() && openTrade.executionMode === "REAL" && !!openTrade.tokenId;
          const closeTs = new Date().toISOString();
          let pnl = 0;
          let returned = 0;
          let closePrice = livePx;
          let sellOrderId = null;
          let sellOrderStatus = null;
          let sellTxHashes = null;

          if (shouldRealSell) {
            try {
              const originalShares = asNumber(openTrade.shares, 0);
              const originalCost = asNumber(openTrade.cost, 0);
              // Garantiza al menos 2 ticks (2.0¢) o 4% de colchón para evitar rechazo FAK en precios < 0.50
              const safeFakLimitPrice = parseFloat(
                Math.max(0.01, Math.min(livePx - 0.02, livePx * 0.96)).toFixed(4)
              );
              const sell = await executeSellOrder({
                tokenId: openTrade.tokenId,
                shares: originalShares,
                expectedPrice: livePx,
                minAcceptablePrice: safeFakLimitPrice,
              });
              sellOrderId = sell.orderId;
              sellOrderStatus = sell.orderStatus || "matched";
              sellTxHashes = JSON.stringify(sell.txHashes || []);
              closePrice = sell.exitPrice || livePx;
              const soldShares = Math.min(originalShares, asNumber(sell.soldShares, 0));
              returned = roundMoney(sell.proceedsUsdc || (soldShares * closePrice));
              const realizedCost = originalShares > 0
                ? roundMoney(originalCost * (soldShares / originalShares))
                : 0;
              pnl = roundMoney(returned - realizedCost);

              await recordOrderEventSafe(openTrade.id, "SELL_ORDER_CREATED", {
                order_id: sellOrderId,
                order_status: sellOrderStatus,
                tx_hashes: sellTxHashes,
                token_id: openTrade.tokenId,
                side: openTrade.side,
                sold_shares: soldShares,
                proceeds: returned,
                close_reason: closeReason,
              });

              if (soldShares > 0 && soldShares < (originalShares - 0.000001)) {
                const remainingShares = parseFloat((originalShares - soldShares).toFixed(6));
                const remainingCost = roundMoney(Math.max(0, originalCost - realizedCost));
                const cumulativePnl = roundMoney(asNumber(openTrade.pnl, 0) + pnl);

                botState.trades[tradeIdx].status = "PARTIAL";
                botState.trades[tradeIdx].shares = remainingShares;
                botState.trades[tradeIdx].cost = remainingCost;
                botState.trades[tradeIdx].pnl = cumulativePnl;
                botState.trades[tradeIdx].currentPrice = closePrice;
                botState.trades[tradeIdx].sellOrderId = sellOrderId;
                botState.trades[tradeIdx].sellOrderStatus = sellOrderStatus;
                botState.trades[tradeIdx].sellTxHashes = sellTxHashes;
                botState.trades[tradeIdx].closeReason = closeReason;
                botState.dailyPnl = roundMoney(botState.dailyPnl + pnl);

                await refreshWalletSnapshot(true);
                addLog(`🪓 [BACKEND AUTOPILOT] Venta parcial ${openTrade.id} (${closeReason}) | Vendidas ${soldShares.toFixed(6)} | Restan ${remainingShares.toFixed(6)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`, pnl >= 0 ? "WIN" : "LOSS");
                await updateTradeSafe(
                  openTrade.id,
                  {
                    status: "PARTIAL",
                    shares: remainingShares,
                    cost: remainingCost,
                    pnl: cumulativePnl,
                    current_price: closePrice,
                    close_reason: closeReason,
                    sell_order_id: sellOrderId,
                    sell_order_status: sellOrderStatus,
                    sell_tx_hashes: sellTxHashes,
                    stop_loss: botState.trades[tradeIdx].stopLoss,
                    take_profit: botState.trades[tradeIdx].takeProfit,
                    break_even_armed: Boolean(botState.trades[tradeIdx].breakEvenArmed),
                  },
                  {
                    status: "PARTIAL",
                    shares: remainingShares,
                    cost: remainingCost,
                    pnl: cumulativePnl,
                    current_price: closePrice,
                  }
                );
                continue;
              }
            } catch (sellErr) {
              addLog(`❌ [BACKEND SELL REAL] Error cerrando ${openTrade.id}: ${sellErr.message}`, "ERROR");
              await recordOrderEventSafe(openTrade.id, "SELL_ORDER_ERROR", {
                error: sellErr.message,
                token_id: openTrade.tokenId,
                target_price: livePx,
                close_reason: closeReason,
              });
              continue;
            }
          } else {
            // Simulación Realista v3.1.0 (Física Exacta de Libro de Órdenes):
            // - TAKE_PROFIT / TIME_DECAY_PROFIT_HARVEST descansan pasivamente como órdenes Limit Maker arriba del precio (0% fee CLOB + $0.004 gas).
            // - STOP_LOSS / BREAK_EVEN / TRAILING_STOP / THESIS_INVALIDATED / MAX_HOLD venden contra el bestBid existente como Taker (FAK),
            //   pagando el fee cuadrático oficial (feeRateBps) + slippage L2 (y como exactBreakEvenFloor ya incluye estExitQuadraticFeePerShare,
            //   cualquier cierre en BREAK_EVEN o TRAILING_STOP queda en ganancia neta real después de comisión).
            const isMakerLimitClose =
              closeReason === "TAKE_PROFIT" ||
              closeReason === "TIME_DECAY_PROFIT_HARVEST";
            const exitSlippage = closeReason === "STOP_LOSS"
              ? 0.0020
              : (closeReason === "TRAILING_STOP" || closeReason === "BREAK_EVEN" ? 0.0010 : 0.0000);
            const latencyFloorPx = livePx - exitSlippage;
            const executableExitPx = (!isMakerLimitClose && Number.isFinite(exitVwapBid) && exitVwapBid > 0.001)
              ? Math.min(exitVwapBid, latencyFloorPx)
              : latencyFloorPx;
            if (closeReason === "BREAK_EVEN" || closeReason === "TRAILING_STOP") {
              closePrice = parseFloat(Math.max(exactBreakEvenFloor, executableExitPx).toFixed(4));
            } else {
              closePrice = parseFloat(Math.max(0.005, executableExitPx).toFixed(4));
            }
            const grossProceeds = asNumber(openTrade.shares, 0) * closePrice;
            const exitFeeRate = closeReason === "STOP_LOSS" ? 0.0050 : 0.0035;
            const exitFeeUsd = isMakerLimitClose
              ? 0.004 // 0% Maker fee en Polymarket CLOB + $0.004 gas Polygon
              : computePolymarketTakerFeeUsd({
                  shares: asNumber(openTrade.shares, 0),
                  price: closePrice,
                  feeRateBps: asNumber(openTrade.feeRateBps, 0),
                  minSimRate: exitFeeRate,
                  gasUsd: 0.004,
                });
            returned = roundMoney(Math.max(0, grossProceeds - exitFeeUsd));
            pnl = roundMoney(returned - asNumber(openTrade.cost, 0));
            botState.trades[tradeIdx].exitFeeUsd = exitFeeUsd;
            botState.trades[tradeIdx].closePrice = closePrice;
            botState.trades[tradeIdx].frictionDeducted = true;
            botState.capital = roundMoney(botState.capital + returned);
            hydrateCapitalFromLocalState();
          }

          if (shouldRealSell) {
            await refreshWalletSnapshot(true);
          }

          const cumulativeClosedPnl = roundMoney(asNumber(openTrade.pnl, 0) + pnl);

          botState.trades[tradeIdx].status = "CLOSED";
          botState.trades[tradeIdx].closedAt = closeTs;
          botState.trades[tradeIdx].pnl = cumulativeClosedPnl;
          botState.trades[tradeIdx].currentPrice = closePrice;
          botState.trades[tradeIdx].sellOrderId = sellOrderId;
          botState.trades[tradeIdx].sellOrderStatus = sellOrderStatus;
          botState.trades[tradeIdx].sellTxHashes = sellTxHashes;
          botState.trades[tradeIdx].closeReason = closeReason;
          Object.assign(botState.trades[tradeIdx], computeTradeEconomics(botState.trades[tradeIdx]));
          botState.dailyPnl = roundMoney(botState.dailyPnl + pnl);

          addLog(`🤖 [BACKEND AUTOPILOT] Cierre ${openTrade.id} (${closeReason}) @ ${fmtPct(closePrice)} | P&L Neto: ${pnl >= 0 ? "+" : ""}$${pnl} (Fricción Pool/Gas: -$${botState.trades[tradeIdx].frictionUsd.toFixed(3)})`, pnl >= 0 ? "WIN" : "LOSS");
          await updateTradeSafe(
            openTrade.id,
            {
              status: "CLOSED",
              closed_at: closeTs,
              pnl: cumulativeClosedPnl,
              current_price: closePrice,
              close_reason: closeReason,
              sell_order_id: sellOrderId,
              sell_order_status: sellOrderStatus,
              sell_tx_hashes: sellTxHashes,
              stop_loss: botState.trades[tradeIdx].stopLoss,
              take_profit: botState.trades[tradeIdx].takeProfit,
              break_even_armed: Boolean(botState.trades[tradeIdx].breakEvenArmed),
              strategy_version: botState.trades[tradeIdx].strategyVersion || STRATEGY_VERSION,
              mfe_price: botState.trades[tradeIdx].mfePrice ?? closePrice,
              mae_price: botState.trades[tradeIdx].maePrice ?? closePrice,
              exit_fee_usd: botState.trades[tradeIdx].exitFeeUsd ?? null,
            },
            { status: "CLOSED", closed_at: closeTs, pnl: cumulativeClosedPnl, current_price: closePrice }
          );

          if (botState.dailyPnl >= DAILY_GOAL && !botState.goalReached) {
            botState.goalReached = true;
            addLog(`🏆 ¡META DIARIA ALCANZADA! P&L = +$${botState.dailyPnl.toFixed(2)} ≥ $${DAILY_GOAL.toFixed(2)}`, "WIN");
          }
        }
      } catch (error) {
        console.error("Fast Sync Error:", error.message);
      } finally {
        await updateCounterfactualDecisions().catch(() => {});
        await runWithdrawalAutopilot("FAST_SYNC");
      }
    }
  );

  if (!acquired) {
    addLog("⏭️ [LOCK] Fast sync omitido porque otra instancia ya lo está ejecutando.", "WARN");
  }
}

async function updateCounterfactualDecisions() {
  if (!Array.isArray(botState.decisionLog) || botState.decisionLog.length === 0) return;
  const nowMs = Date.now();
  let probes = 0;

  for (const dec of botState.decisionLog) {
    if (probes >= 3) break;
    const evalMs = dec.evaluated_at ? new Date(dec.evaluated_at).getTime() : NaN;
    if (!Number.isFinite(evalMs)) continue;
    const ageMin = (nowMs - evalMs) / 60000;
    if (ageMin < 30 || dec.counterfactual_checked_at) continue;

    const m = botState.allMarkets.find(
      cand => String(cand.id || cand.conditionId) === String(dec.market_id || dec.condition_id)
    );
    if (!m) continue;
    const side = dec.considered_side || "YES";
    const tokenId = side === "YES" ? m._yesTokenId : m._noTokenId;
    const entryRefAsk = side === "YES" ? asNumber(dec.yes_ask, 0) : asNumber(dec.no_ask, 0);
    if (!tokenId || entryRefAsk <= 0) continue;

    probes++;
    const quote = await getTokenExitQuote(tokenId, 2);
    if (quote && Number.isFinite(quote.bestBid) && quote.bestBid > 0) {
      dec.counterfactual_bid = quote.bestBid;
      dec.counterfactual_edge_cents = Number(((quote.bestBid - entryRefAsk) * 100).toFixed(2));
      dec.counterfactual_checked_at = new Date().toISOString();
    }
  }
}

function computeBootstrapExpectancyCi95(pnlValues = []) {
  const n = pnlValues.length;
  if (n < 5) return { lower: null, upper: null, iterations: 0 };

  const ITERS = 1000;
  const means = new Array(ITERS);
  // Generador determinístico LCG para reproducibilidad exacta en auditorías
  let seed = 1337 + n;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let b = 0; b < ITERS; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(nextRand() * n);
      sum += pnlValues[idx];
    }
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  return {
    lower: Number(means[Math.floor(ITERS * 0.025)].toFixed(4)),
    upper: Number(means[Math.floor(ITERS * 0.975)].toFixed(4)),
    iterations: ITERS,
  };
}

// â”€â”€ CHEQUEO DE MEDIANOCHE Y JORNADA â”€â”€
export function checkDayRollover() {
  const today = new Date().toISOString().slice(0, 10);

  if (botState.dailyDate !== today) {
     botState.dailyPnl = 0;
     botState.goalReached = false;
     botState.dailyDate = today;
     addLog(`ðŸŒ… [BACKEND] NUEVO DÃA: Meta desbloqueada â€” ${today}`, "SYSTEM");
  }
  // El bot SOLO se detiene al llegar a la meta diaria real (P&L >= DAILY_GOAL).
  // Ya no se cierra por hora del reloj.
}

// ── MOTOR INSTITUCIONAL DE AUDITORÍA Y MÉTRICAS CUANTITATIVAS (+EV / Profit Factor / Payoff / Attribution) ──
export function computeQuantMetrics() {
  const validClosed = botState.trades.filter(
    t => t.status === "CLOSED" && t.closeReason !== "CLEANUP_SIMULATED"
  );
  const wins = validClosed.filter(t => asNumber(t.pnl, 0) > 0);
  const losses = validClosed.filter(t => asNumber(t.pnl, 0) < 0);
  const ties = validClosed.filter(t => asNumber(t.pnl, 0) === 0);

  const grossProfit = wins.reduce((s, t) => s + asNumber(t.pnl, 0), 0);
  const grossLossAbs = losses.reduce((s, t) => s + Math.abs(asNumber(t.pnl, 0)), 0);
  const netRealizedPnl = roundMoney(grossProfit - grossLossAbs);

  const decidedCount = wins.length + losses.length;
  const winRatePct = decidedCount > 0 ? roundMoney((wins.length / decidedCount) * 100) : 0;
  const avgWin = wins.length > 0 ? roundMoney(grossProfit / wins.length) : 0;
  const avgLossAbs = losses.length > 0 ? roundMoney(grossLossAbs / losses.length) : 0;
  const payoffRatio = avgLossAbs > 0 ? roundMoney(avgWin / avgLossAbs) : (avgWin > 0 ? 9.99 : 0);
  const profitFactor = grossLossAbs > 0 ? roundMoney(grossProfit / grossLossAbs) : (grossProfit > 0 ? 9.99 : 0);

  const breakEvenWinRatePct = payoffRatio > 0
    ? roundMoney((1 / (1 + payoffRatio)) * 100)
    : 50;
  const safetyMarginPct = roundMoney(winRatePct - breakEvenWinRatePct);

  const winProb = decidedCount > 0 ? (wins.length / decidedCount) : 0;
  const lossProb = decidedCount > 0 ? (losses.length / decidedCount) : 0;
  const expectancyPerTrade = decidedCount > 0
    ? Number(((winProb * avgWin) - (lossProb * avgLossAbs)).toFixed(3))
    : 0;

  const byCategory = {};
  const byStrategyVersion = {};
  for (const t of validClosed) {
    const cat = t.category || detectCategory(t.question || "");
    if (!byCategory[cat]) {
      byCategory[cat] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    }
    byCategory[cat].count++;
    const p = asNumber(t.pnl, 0);
    if (p > 0) byCategory[cat].wins++;
    else if (p < 0) byCategory[cat].losses++;
    byCategory[cat].pnl = roundMoney(byCategory[cat].pnl + p);

    const ver = t.strategyVersion || "legacy-pre-v3";
    if (!byStrategyVersion[ver]) {
      byStrategyVersion[ver] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    }
    byStrategyVersion[ver].count++;
    if (p > 0) byStrategyVersion[ver].wins++;
    else if (p < 0) byStrategyVersion[ver].losses++;
    byStrategyVersion[ver].pnl = roundMoney(byStrategyVersion[ver].pnl + p);
  }

  const byExitReason = {
    TAKE_PROFIT: { count: 0, pnl: 0 },
    TRAILING_PROTECTED: { count: 0, pnl: 0 },
    STOP_LOSS: { count: 0, pnl: 0 },
    MAX_HOLD: { count: 0, pnl: 0 },
  };
  for (const t of validClosed) {
    const p = asNumber(t.pnl, 0);
    if (t.closeReason === "TAKE_PROFIT") {
      byExitReason.TAKE_PROFIT.count++;
      byExitReason.TAKE_PROFIT.pnl = roundMoney(byExitReason.TAKE_PROFIT.pnl + p);
    } else if (t.closeReason === "TRAILING_STOP" || t.closeReason === "BREAK_EVEN" || t.breakEvenArmed || p >= 0) {
      byExitReason.TRAILING_PROTECTED.count++;
      byExitReason.TRAILING_PROTECTED.pnl = roundMoney(byExitReason.TRAILING_PROTECTED.pnl + p);
    } else if (t.closeReason === "MAX_HOLD") {
      byExitReason.MAX_HOLD.count++;
      byExitReason.MAX_HOLD.pnl = roundMoney(byExitReason.MAX_HOLD.pnl + p);
    } else {
      byExitReason.STOP_LOSS.count++;
      byExitReason.STOP_LOSS.pnl = roundMoney(byExitReason.STOP_LOSS.pnl + p);
    }
  }

  let healthScore = 50;
  if (profitFactor >= 1.5) healthScore += 25;
  else if (profitFactor >= 1.15) healthScore += 15;
  else if (profitFactor < 1.0 && decidedCount >= 5) healthScore -= 20;

  if (payoffRatio >= 2.0) healthScore += 15;
  else if (payoffRatio >= 1.4) healthScore += 8;

  if (safetyMarginPct >= 10) healthScore += 10;
  else if (safetyMarginPct < 0 && decidedCount >= 5) healthScore -= 15;
  healthScore = Math.max(0, Math.min(100, healthScore));

  const totalFrictionUsd = Number(
    validClosed.reduce((s, t) => s + asNumber(t.frictionUsd ?? computeTradeEconomics(t).frictionUsd, 0.015), 0).toFixed(3)
  );
  const netPnlAfterAllCosts = roundMoney(
    validClosed.reduce((s, t) => s + asNumber(t.netPnlAfterFriction ?? computeTradeEconomics(t).netPnlAfterFriction, asNumber(t.pnl, 0)), 0)
  );

  // ── GATE ESTADÍSTICO PRE-REGISTRADO FASE 3 -> FASE 4 (Exclusivo para versión activa v3.0.0-crypto-oracle) ──
  const v3Closed = validClosed
    .filter(t => (t.strategyVersion || "legacy-pre-v3") === STRATEGY_VERSION)
    .sort((a, b) => new Date(a.closedAt || a.ts || 0).getTime() - new Date(b.closedAt || b.ts || 0).getTime());
  const v3Pnls = v3Closed.map(t => asNumber(t.pnl, 0));
  const v3Wins = v3Closed.filter(t => asNumber(t.pnl, 0) > 0);
  const v3Losses = v3Closed.filter(t => asNumber(t.pnl, 0) < 0);
  const v3GrossWin = v3Wins.reduce((s, t) => s + asNumber(t.pnl, 0), 0);
  const v3GrossLoss = v3Losses.reduce((s, t) => s + Math.abs(asNumber(t.pnl, 0)), 0);
  const v3Pf = v3GrossLoss > 0 ? roundMoney(v3GrossWin / v3GrossLoss) : (v3GrossWin > 0 ? 9.99 : 0);
  const v3Expectancy = v3Pnls.length > 0
    ? Number((v3Pnls.reduce((s, x) => s + x, 0) / v3Pnls.length).toFixed(4))
    : 0;
  const v3BootstrapCi95 = computeBootstrapExpectancyCi95(v3Pnls);

  // Cálculo de Drawdown Máximo en Paper sobre BASE_CAPITAL para v3
  let peakEquity = BASE_CAPITAL;
  let runningEquity = BASE_CAPITAL;
  let maxDrawdownPct = 0;
  for (const p of v3Pnls) {
    runningEquity += p;
    if (runningEquity > peakEquity) peakEquity = runningEquity;
    const ddPct = peakEquity > 0 ? ((peakEquity - runningEquity) / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }
  maxDrawdownPct = roundMoney(maxDrawdownPct);

  const gatePassed =
    v3Closed.length >= 100 &&
    v3Pf >= 1.30 &&
    v3Expectancy > 0 &&
    v3BootstrapCi95.lower !== null &&
    v3BootstrapCi95.lower > 0 &&
    maxDrawdownPct <= 20;

  const gateFailedAbandon = v3Closed.length >= 100 && v3Pf < 1.0;

  const v3Gate = {
    strategyVersion: STRATEGY_VERSION,
    tradesClosed: v3Closed.length,
    targetTrades: 100,
    profitFactor: v3Pf,
    minProfitFactor: 1.30,
    expectancyPerTrade: v3Expectancy,
    expectancyCi95Lower: v3BootstrapCi95.lower,
    expectancyCi95Upper: v3BootstrapCi95.upper,
    maxDrawdownPct,
    maxAllowedDrawdownPct: 20.0,
    status: gatePassed
      ? "PASSED_READY_FOR_PHASE_4"
      : (gateFailedAbandon ? "FAILED_ABANDON_STRATEGY" : "COLLECTING_PAPER_SAMPLE"),
  };

  return {
    totalClosed: validClosed.length,
    decidedCount,
    winsCount: wins.length,
    lossesCount: losses.length,
    tiesCount: ties.length,
    grossProfit: roundMoney(grossProfit),
    grossLossAbs: roundMoney(grossLossAbs),
    netRealizedPnl,
    totalFrictionUsd,
    netPnlAfterAllCosts,
    winRatePct,
    avgWin,
    avgLossAbs,
    payoffRatio,
    profitFactor,
    breakEvenWinRatePct,
    safetyMarginPct,
    expectancyPerTrade,
    healthScore,
    strategyVersion: STRATEGY_VERSION,
    v3Gate,
    byCategory,
    byStrategyVersion,
    byExitReason,
  };
}


