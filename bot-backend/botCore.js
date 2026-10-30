import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { getBooleanEnv, getEnv, getNumberEnv, requireEnv } from './env.js';
import { getConditionalTokenSnapshot, getLiveWalletSnapshot, getMarketTradeFlow, getOrderBookSnapshot, getTokenSellPrice, getTradingWalletAddress, isRealTradingEnabled, transferUsdc } from './polymarketClient.js';
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
const MIN_AI_CONFIDENCE = getNumberEnv("MIN_AI_CONFIDENCE", 68);
const MIN_NET_EDGE_PCT = getNumberEnv("MIN_NET_EDGE_PCT", 6.0);
const CRITICAL_LOOP_LOCK_TTL_SECONDS = Math.max(30, Math.floor(getNumberEnv("CRITICAL_LOOP_LOCK_TTL_SECONDS", 180)));
const DB_READINESS_TTL_MS = Math.max(30_000, Math.floor(getNumberEnv("DB_READINESS_TTL_MS", 300_000)));

const AUTO_WITHDRAW_ENABLED = getBooleanEnv("AUTO_WITHDRAW_ENABLED", true);
const WITHDRAWAL_TARGET_ADDRESS = getEnv("WITHDRAWAL_TARGET_ADDRESS", "");
const WITHDRAWAL_OPERATING_CAPITAL_USDC = getNumberEnv("WITHDRAWAL_OPERATING_CAPITAL_USDC", BASE_CAPITAL);
const WITHDRAWAL_MIN_EXCESS_USDC = getNumberEnv("WITHDRAWAL_MIN_EXCESS_USDC", 3);
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
  capital: BASE_CAPITAL,
  trades: [],
  signals: [],
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
    const maxExposureUsdc = totalEquity * (asNumber(botState.config.maxExposurePct, 30) / 100);
    const remainingExposureCapacity = Math.max(0, maxExposureUsdc - openExposure);
    const simulatedAmount = roundMoney(Math.min(botState.config.maxTradeUsdc || 1, remainingExposureCapacity));
    const minTradeUsdc = asNumber(botState.config.minTradeUsdc, 1);

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
  // Guarantee at least 2.5c below entryBid (or 3c below entryPrice) so normal 1c tick/spread noise never causes instant stop-outs
  const tickFloor = (Number.isFinite(entryBid) && entryBid > 0)
    ? (entryBid - 0.025)
    : (entryPrice - 0.03);
  const stop = Math.min(pctStop, tickFloor);
  return parseFloat(Math.max(0.02, stop).toFixed(4));
}

function calcTakeProfit(entryPrice, fairProb = null) {
  const pctTarget = entryPrice * (1 + botState.config.takeProfit / 100);
  // Guarantee at least 3.5c above entryPrice to comfortably beat spread and fees
  let target = Math.max(pctTarget, entryPrice + 0.035);
  if (Number.isFinite(fairProb) && fairProb > entryPrice + 0.04) {
    target = Math.max(target, Math.min(fairProb - 0.01, entryPrice * 1.18));
  }
  return parseFloat(Math.min(0.97, target).toFixed(4));
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
    // 1. Descargar todos los trades del usuario
    const { data: tradesDb, error } = await supabase
      .from('user_trades')
      .select('*')
      .order('executed_at', { ascending: false });

    if (error) throw error;
    
    await loadWithdrawalStateFromDB();

    let totalPnl = 0;
    let todayPnl = 0;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const patches = [];
    const loadedTrades = (tradesDb || []).map(t => {
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

      // Re-estructurar al formato del bot
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

      return {
        id: t.trade_id, ts: tradeTs, question: t.question,
        marketId: t.market_id, side: t.side, entryPrice,
        conditionId: t.condition_id || integrityPatch.condition_id || t.market_id,
        tokenId: t.token_id || null,
        currentPrice: persistedCurrentPrice > 0 ? persistedCurrentPrice : normalized.currentPrice,
        shares: normalized.shares, cost: normalized.cost, status: t.status,
        pnl: pnlVal, closedAt: t.closed_at || null,
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

    // Cargar últimas señales de IA desde Supabase para no perder visibilidad tras reinicios
    try {
      const { data: signalsDb } = await supabase
        .from('ai_signals')
        .select('*')
        .order('detected_at', { ascending: false })
        .limit(50);

      if (Array.isArray(signalsDb) && signalsDb.length > 0 && botState.signals.length === 0) {
        const executedSignalIds = new Set(loadedTrades.map(t => t.id));
        const openMarketIds = new Set(loadedTrades.map(t => String(t.marketId || t.conditionId || "")));
        botState.signals = signalsDb.map(s => ({
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
            yesP: asNumber(s.yes_price, 0.5),
            noP: asNumber(s.no_price, 0.5),
            sum: asNumber(s.yes_price, 0.5) + asNumber(s.no_price, 0.5),
            score: asNumber(s.score, 0),
            signals: [],
          },
          analysis: {
            action: s.action || "SKIP",
            score: asNumber(s.score, 0),
            confidence: asNumber(s.confidence, 0),
            edge_pct: asNumber(s.edge_pct, 0),
            news_found: s.news_found || "",
            reasoning: s.reasoning || "",
            risk: "MEDIUM",
            liquidity_ok: true,
            signal_types: [],
          },
          executed: executedSignalIds.has(s.signal_id) || openMarketIds.has(String(s.market_id || s.condition_id || "")),
        }));
      }
    } catch {
      // Best-effort restore of historical AI signals
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
      reasoning: analysis.reasoning,
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
      buy_order_id: t.buyOrderId || null,
      buy_order_status: t.buyOrderStatus || null,
      buy_tx_hashes: t.buyTxHashes || null,
      executed_at: t.ts,
    };

    const { error } = await supabase.from('user_trades').insert(payload);
    if (!error) return;

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
function preliminaryScore(m, prevSnapshot) {
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

  // 4. Filtro estricto de horizonte temporal (Catalizador cercano <= 30 días)
  let daysLeft = null;
  if (m.endDateIso || m.endDate) {
    const closes = new Date(m.endDateIso || m.endDate);
    daysLeft = (closes - Date.now()) / 86400000;
    if (!Number.isFinite(daysLeft) || daysLeft <= 0.08) {
      // Menos de ~2 horas o ya expirado: alto riesgo de latencia de oráculo
      return { score: 0, signals: [], skip: true };
    }
    if (daysLeft > MAX_MARKET_DAYS) {
      // Bloquear mercados a meses/años vista (ej. Senado Nov 2026) que atrapan capital y mueren por MAX_HOLD
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
  if (book.bestAsk < 0.07 || book.bestAsk > 0.92) return false;
  if (book.spreadPct > MAX_SPREAD_PCT || book.spreadAbs > MAX_SPREAD_CENTS) return false;
  if (book.askDepthUsd < MIN_BOOK_DEPTH_USD || book.bidDepthUsd < MIN_BOOK_DEPTH_USD) return false;
  // Evitar comprar contra un muro institucional de venta (Order Book Imbalance < -0.65)
  if (Number.isFinite(book.obi) && book.obi < -0.65) return false;
  return true;
}

async function selectOrderBookVerifiedCandidates(scoredMarkets, targetCount) {
  const verified = [];
  const seenEvents = new Set();
  const maxProbes = Math.min(scoredMarkets.length, Math.max(targetCount * 4, 24));

  for (let i = 0; i < maxProbes && verified.length < targetCount; i++) {
    const item = scoredMarkets[i];
    const m = item.m || item.market;
    const pre = item.pre || item.prelim;
    if (!m || !pre) continue;

    // Diversificación de eventos y Cooldown Anti-Overtrading (6h tras cierre / máx 2 trades en 24h)
    const eventKey = pre.eventSlug || m.id;
    if (eventKey && seenEvents.has(eventKey)) continue;

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
    verified.push({ m, pre });
  }

  return verified;
}

// ── ORÁCULO CRIPTO GRATUITO EN TIEMPO REAL + MODELO DE BARRERA BROWNIANA (Parkinson Vol) ──
let cryptoTickerCache = { ts: 0, data: null };

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

async function getCryptoSpotContext(question, daysLeft) {
  const q = String(question || "");
  let assetKey = null;
  let assetName = null;

  if (/\b(bitcoin|btc)\b/i.test(q)) { assetKey = "XXBTZUSD"; assetName = "BTC"; }
  else if (/\b(ethereum|eth)\b/i.test(q)) { assetKey = "XETHZUSD"; assetName = "ETH"; }
  else if (/\b(solana|sol)\b/i.test(q)) { assetKey = "SOLUSD"; assetName = "SOL"; }
  else if (/\b(xrp|ripple)\b/i.test(q)) { assetKey = "XXRPZUSD"; assetName = "XRP"; }
  else if (/\b(dogecoin|doge)\b/i.test(q)) { assetKey = "XDGUSD"; assetName = "DOGE"; }

  if (!assetKey) return null;

  try {
    if (!cryptoTickerCache.data || (Date.now() - cryptoTickerCache.ts) > 60000) {
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
    }

    const ticker = cryptoTickerCache.data?.[assetKey];
    if (!ticker) return null;

    const spot = parseFloat(ticker?.c?.[0]);
    const high24h = parseFloat(ticker?.h?.[1] || ticker?.h?.[0]);
    const low24h = parseFloat(ticker?.l?.[1] || ticker?.l?.[0]);
    if (!Number.isFinite(spot) || spot <= 0) return null;

    // Estimador de Volatilidad Diaria de Parkinson usando el rango High/Low de 24h
    const rawParkinson = (Number.isFinite(high24h) && Number.isFinite(low24h) && high24h > low24h && low24h > 0)
      ? Math.log(high24h / low24h) / (2 * Math.sqrt(Math.LN2))
      : 0.032;
    const dailyVol = Math.max(0.018, Math.min(0.12, rawParkinson));

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
    const tDays = Math.max(0.15, Number.isFinite(daysLeft) ? daysLeft : 3);
    const periodStd = dailyVol * Math.sqrt(tDays);

    if (targetPrice && targetPrice > spot * 0.2 && targetPrice < spot * 3.0) {
      const isDipTouch = /\b(dip|drop|fall|low|touch|reach|hit)\b/i.test(q) && targetPrice < spot;
      const isRallyTouch = /\b(reach|hit|touch|high|surge|pump)\b/i.test(q) && targetPrice > spot;
      const isBelowTerminal = /\b(below|under|less than)\b/i.test(q);
      const isAboveTerminal = /\b(above|over|greater than|higher than)\b/i.test(q);

      const logDist = Math.abs(Math.log(targetPrice / spot));
      const z = logDist / periodStd;

      if (isDipTouch || isRallyTouch) {
        modelType = "BARRIER_TOUCH";
        // Principio de reflexión para movimiento browniano sin deriva
        mathYesProb = Math.max(0.02, Math.min(0.96, 2 * normCdf(-z)));
      } else if (isAboveTerminal) {
        modelType = "TERMINAL_ABOVE";
        const zSigned = Math.log(spot / targetPrice) / periodStd;
        mathYesProb = Math.max(0.02, Math.min(0.96, normCdf(zSigned)));
      } else if (isBelowTerminal) {
        modelType = "TERMINAL_BELOW";
        const zSigned = Math.log(targetPrice / spot) / periodStd;
        mathYesProb = Math.max(0.02, Math.min(0.96, normCdf(zSigned)));
      }
    }

    const distPct = targetPrice ? (((targetPrice - spot) / spot) * 100).toFixed(2) : null;
    const summary = targetPrice
      ? `${assetName} LIVE_SPOT=$${spot.toLocaleString("en-US", { maximumFractionDigits: 2 })} | 24h_Range=[$${low24h.toFixed(0)}-$${high24h.toFixed(0)}] | ParkinsonDailyVol=${(dailyVol * 100).toFixed(2)}% | Target=$${targetPrice.toLocaleString("en-US")} (${distPct}% from spot) | Math_${modelType}_YES_Prob=${mathYesProb !== null ? (mathYesProb * 100).toFixed(1) + "%" : "N/A"}`
      : `${assetName} LIVE_SPOT=$${spot.toLocaleString("en-US", { maximumFractionDigits: 2 })} | 24h_Range=[$${low24h.toFixed(0)}-$${high24h.toFixed(0)}] | ParkinsonDailyVol=${(dailyVol * 100).toFixed(2)}%`;

    return {
      assetName,
      spot,
      high24h,
      low24h,
      dailyVol,
      targetPrice,
      modelType,
      mathYesProb,
      summary,
    };
  } catch {
    return null;
  }
}

async function callGroqResilient(body) {
  // Intento 1: Modelo primario con json_object y 2048 tokens (para que el razonamiento nunca se trunque con 400)
  const primaryBody = { ...body, max_tokens: 2048 };
  let r = await fetch(API_GROQ, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify(primaryBody),
  });

  if (r.ok) {
    return await r.json();
  }

  // Intento 2: Si Groq devuelve 400 (json_validate_failed por reasoning), reintentar sin response_format estricto
  if (r.status === 400) {
    const fallbackBody = { ...primaryBody };
    delete fallbackBody.response_format;
    r = await fetch(API_GROQ, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify(fallbackBody),
    });
    if (r.ok) {
      return await r.json();
    }
  }

  // Intento 3: Modelo rápido de respaldo (openai/gpt-oss-20b)
  const backupBody = { ...primaryBody, model: "openai/gpt-oss-20b" };
  delete backupBody.response_format;
  r = await fetch(API_GROQ, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify(backupBody),
  });
  if (!r.ok) throw new Error(`Groq error: ${r.status}`);
  return await r.json();
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
  const minUsdc = Math.max(1, asNumber(botState.config.minTradeUsdc, 1));
  const maxUsdc = Math.max(minUsdc, Math.min(asNumber(maxAllowedAmount, minUsdc), asNumber(botState.config.maxTradeUsdc, 2)));
  if (maxUsdc <= minUsdc) return roundMoney(maxUsdc);

  const ask = asNumber(sideBook?.bestAsk ?? analysis?.executable_ask, 0.5);
  const conf = asNumber(analysis?.confidence, 68);
  const obi = asNumber(sideBook?.obi, 0);

  // Quarter-Kelly fraction sobre el payoff binario (1 - ask)
  const payoffOdds = Math.max(0.08, 1 - ask);
  const netEdgeDec = Math.max(0, asNumber(analysis?.edge_pct, 0) / 100);
  const kellyRaw = netEdgeDec / payoffOdds;
  const confMultiplier = Math.max(0.5, Math.min(1.15, (conf - 50) / 40));
  const obiBonus = obi >= 0.2 ? 1.1 : (obi < -0.2 ? 0.85 : 1.0);

  // Escalar entre minUsdc y maxUsdc según la convicción matemática (Edge Neto de 6% -> cerca de minUsdc; Edge Neto >= 14% -> cerca de maxUsdc)
  const convictionRatio = Math.max(0, Math.min(1, ((kellyRaw * 2.2) * confMultiplier * obiBonus)));
  const sized = minUsdc + (maxUsdc - minUsdc) * convictionRatio;
  return roundMoney(Math.max(minUsdc, Math.min(maxUsdc, sized)));
}

// ── IA PROFUNDA CUANTITATIVA (Groq + Google News RSS + Tavily + CLOB Flow + Crypto Spot Oracle + Bayesian Calibration) ──
async function deepAnalyze(m, prelim) {
  const { yesP, noP, vol, vol24, liq, daysLeft, change1h, change24h, change7d, yesBook, noBook, tradeFlow, yesTradable, noTradable } = prelim;
  const marketId = m.id || m.conditionId;
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  let newsContext = "Sin noticias recientes.";
  let topSource = "none";
  let topSnippet = "none";
  let usedCache = false;
  let hasFreshNews = false;

  const [cryptoQuant, cachedNews] = await Promise.all([
    getCryptoSpotContext(m.question, daysLeft),
    Promise.resolve(botState.newsCache[marketId]),
  ]);

  if (cachedNews && (Date.now() - cachedNews.ts) < SIX_HOURS) {
    newsContext = cachedNews.context;
    topSource = cachedNews.source;
    topSnippet = cachedNews.snippet;
    hasFreshNews = Boolean(cachedNews.hasFreshNews);
    usedCache = true;
  } else {
    const combinedLines = [];

    // 1. Fuente Primaria Gratuita e Ilimitada: Google News RSS (con antigüedad exacta en horas)
    const rssArticles = await fetchGoogleNewsRss(m.question);
    for (const art of rssArticles) {
      const ageNum = parseFloat(art.ageHours);
      if (Number.isFinite(ageNum) && ageNum <= 12) hasFreshNews = true;
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
            hasFreshNews = true;
            for (const r of tData.results) {
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

    if (combinedLines.length > 0) {
      newsContext = combinedLines.slice(0, 7).join("\n");
      botState.newsCache[marketId] = {
        ts: Date.now(),
        context: newsContext,
        source: topSource,
        snippet: topSnippet,
        hasFreshNews,
        news: newsContext,
      };
    }
  }

  const daysLeftStr = Number.isFinite(daysLeft) ? daysLeft.toFixed(1) : "?";
  const resolutionRules = (m.description || "Estándar Polymarket").replace(/\s+/g, " ").slice(0, 420);
  const fmtDelta = (v) => `${v >= 0 ? "+" : ""}${(asNumber(v, 0) * 100).toFixed(1)}%`;
  const priceActionStr = `1h=${fmtDelta(change1h)} | 24h=${fmtDelta(change24h)} | 7d=${fmtDelta(change7d)}`;

  const yesBookStr = yesBook?.isValid
    ? `Bid=${(yesBook.bestBid * 100).toFixed(1)}c Ask=${(yesBook.bestAsk * 100).toFixed(1)}c MicroPrice=${((yesBook.microPrice ?? yesBook.midPrice) * 100).toFixed(1)}c Spread=${yesBook.spreadPct.toFixed(2)}% BidDepth=$${yesBook.bidDepthUsd.toFixed(0)} AskDepth=$${yesBook.askDepthUsd.toFixed(0)} OBI=${yesBook.obi >= 0 ? "+" : ""}${yesBook.obi.toFixed(2)} Tradable=${yesTradable ? "YES" : "NO"}`
    : "UNAVAILABLE";
  const noBookStr = noBook?.isValid
    ? `Bid=${(noBook.bestBid * 100).toFixed(1)}c Ask=${(noBook.bestAsk * 100).toFixed(1)}c MicroPrice=${((noBook.microPrice ?? noBook.midPrice) * 100).toFixed(1)}c Spread=${noBook.spreadPct.toFixed(2)}% BidDepth=$${noBook.bidDepthUsd.toFixed(0)} AskDepth=$${noBook.askDepthUsd.toFixed(0)} OBI=${noBook.obi >= 0 ? "+" : ""}${noBook.obi.toFixed(2)} Tradable=${noTradable ? "YES" : "NO"}`
    : "UNAVAILABLE";

  const tapeFlowStr = tradeFlow
    ? `Last_${tradeFlow.sampleCount}_Trades: BullishYES=$${tradeFlow.yesBullUsd.toFixed(0)} (Whales=${tradeFlow.whaleYesCount}) | BullishNO=$${tradeFlow.noBullUsd.toFixed(0)} (Whales=${tradeFlow.whaleNoCount}) | TapeImbalance=${tradeFlow.tapeImbalance >= 0 ? "+" : ""}${tradeFlow.tapeImbalance.toFixed(2)}`
    : "UNAVAILABLE";

  const cryptoLine = cryptoQuant ? `\nLIVE_CRYPTO_ORACLE: ${cryptoQuant.summary}` : "";

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a senior quantitative prediction-market trader managing real capital on Polymarket CLOB.
Your job is to estimate the true probability of the YES outcome (estimated_yes_prob between 0.01 and 0.99) based strictly on verifiable news, base rates, time-to-resolution, price action, order book imbalance (OBI), real trade tape flow, live crypto spot oracle (if present), and the exact market resolution rules.
CRITICAL RULES:
1. Anchor your prior to the market's MicroPrice — only deviate significantly when supported by fresh verifiable news, mathematical barrier models (LIVE_CRYPTO_ORACLE), or strong orderflow (OBI & TapeImbalance).
2. Never recommend a side marked Tradable=NO.
3. Check PRICE_ACTION (1h/24h/7d) vs news age: if a market already moved >20% in 24h because of old news, that catalyst is ALREADY PRICED IN — return action="SKIP".
4. Avoid the Longshot Bias: be extra skeptical of buying outcomes priced below 18c unless mathematical or hard-news evidence is overwhelming.
5. SPORTS & ESPORTS WARNING: If the live CLOB price is between 15c and 85c, the match HAS NOT BEEN PLAYED YET. Any final score in RECENT_NEWS is from a PAST game earlier in the season — NEVER treat a past game score as the result of the upcoming match. If there is no fresh injury/lineup catalyst ("no recent catalyst"), return action="SKIP".
Return ONLY raw valid JSON.`
      },
      {
        role: "user",
        content: `TODAY: ${new Date().toISOString().slice(0, 10)} | CLOSES_IN: ${daysLeftStr} days
QUESTION: "${m.question}"
RESOLUTION_RULES: "${resolutionRules}"
GAMMA_MID: YES=${fmtPct(yesP)} NO=${fmtPct(noP)} | VOL_24H=$${Math.round(vol24)} | LIQ=$${Math.round(liq)}
PRICE_ACTION_YES: ${priceActionStr}
CLOB_YES_BOOK: ${yesBookStr}
CLOB_NO_BOOK: ${noBookStr}
CLOB_TAPE_FLOW: ${tapeFlowStr}${cryptoLine}
QUANT_SIGNALS: ${prelim.signals.join(",") || "none"}
RECENT_NEWS ${usedCache ? "(cached)" : "(live RSS + Web)"}:
${newsContext.slice(0, 1200)}

Return JSON with this exact schema:
{"action":"BUY_YES"|"BUY_NO"|"SKIP","estimated_yes_prob":0.01-0.99,"confidence":0-100,"edge_pct":number,"signal_types":["NEWS"|"MOMENTUM"|"MISPRICING"|"ORDERFLOW"],"news_found":"short summary of key catalyst","news_source":"url or none","reasoning":"concise quantitative rationale citing probability vs ask price, news age, and order book","risk":"LOW"|"MEDIUM"|"HIGH","score":0-100}`
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

  // ── VERIFICACIÓN MATEMÁTICA DURA Y CALIBRACIÓN BAYESIANA POST-IA ──
  let estYesProb = parseFloat(result.estimated_yes_prob);
  if (Number.isFinite(estYesProb)) {
    if (estYesProb > 1 && estYesProb <= 100) estYesProb = estYesProb / 100;
  }

  // Si es un mercado cripto con modelo matemático de barrera (Parkinson + Brownian Motion), anclar el estimado de la IA con la probabilidad matemática real
  if (cryptoQuant && Number.isFinite(cryptoQuant.mathYesProb) && Number.isFinite(estYesProb)) {
    estYesProb = (0.55 * estYesProb) + (0.45 * cryptoQuant.mathYesProb);
  }

  let selectedBook = null;
  let rawSideProb = null;
  let isYesSide = false;

  if (result.action === "BUY_YES") {
    isYesSide = true;
    if (!yesTradable || !yesBook?.isValid) {
      result.action = "SKIP";
      result.reasoning = `[FILTRO CLOB] Lado YES bloqueado por spread/liquidez/OBI. ${result.reasoning || ""}`;
    } else {
      selectedBook = yesBook;
      rawSideProb = Number.isFinite(estYesProb) ? estYesProb : (yesBook.bestAsk + (parseFloat(result.edge_pct || 0) / 100));
    }
  } else if (result.action === "BUY_NO") {
    isYesSide = false;
    if (!noTradable || !noBook?.isValid) {
      result.action = "SKIP";
      result.reasoning = `[FILTRO CLOB] Lado NO bloqueado por spread/liquidez/OBI. ${result.reasoning || ""}`;
    } else {
      selectedBook = noBook;
      rawSideProb = Number.isFinite(estYesProb) ? (1 - estYesProb) : (noBook.bestAsk + (parseFloat(result.edge_pct || 0) / 100));
    }
  }

  if (selectedBook && (result.action === "BUY_YES" || result.action === "BUY_NO")) {
    rawSideProb = Math.max(0.01, Math.min(0.99, rawSideProb));
    const executableAsk = selectedBook.bestAsk;
    const marketMicro = selectedBook.microPrice ?? selectedBook.midPrice ?? executableAsk;
    const sideTapeImbalance = tradeFlow ? (isYesSide ? tradeFlow.tapeImbalance : -tradeFlow.tapeImbalance) : 0;

    // Protección dura contra mercados deportivos donde la IA confunde marcadores pasados o no tiene catalizador nuevo
    const isSportsMatch = m._cat === "SPORTS" || /\b(vs\.?|handicap|esports|nba|nfl|mlb|nhl|ufc)\b/i.test(m.question || "");
    const lacksCatalyst = /no recent catalyst|no new info|older news|no recent news|sin noticias recientes/i.test(
      `${result.news_found || ""} ${result.reasoning || ""}`
    );

    if (lacksCatalyst && (selectedBook.obi < 0.45 || sideTapeImbalance < 0.25)) {
      result.action = "SKIP";
      result.reasoning = `[FILTRO CATALIZADOR] Sin noticia nueva ni flujo institucional fuerte (OBI=${selectedBook.obi.toFixed(2)}, Tape=${sideTapeImbalance.toFixed(2)}). ${result.reasoning || ""}`;
    }

    if (isSportsMatch && executableAsk >= 0.20 && executableAsk <= 0.80) {
      // Un partido entre 20c y 80c aún no se ha resuelto; bloquear alucinaciones de "marcador final ya jugado"
      rawSideProb = Math.min(rawSideProb, marketMicro + 0.14);
    }

    // 1. Contracción Bayesiana (Bayesian Shrinkage) hacia el Micro-Precio eficiente del mercado
    // Evita que la sobreconfianza del LLM invente edges irreales sin respaldo de noticias + flujo
    let aiWeight = 0.56;
    if (hasFreshNews && !lacksCatalyst) aiWeight += 0.08;
    if (selectedBook.obi >= 0.15) aiWeight += 0.06;
    else if (selectedBook.obi <= -0.15) aiWeight -= 0.08;

    if (sideTapeImbalance >= 0.15) aiWeight += 0.06;
    else if (sideTapeImbalance <= -0.20) aiWeight -= 0.08;

    // En mercados ultra-líquidos (>$50k liq), el precio de mercado es más eficiente -> mayor peso al prior del mercado
    if (liq > 50000) aiWeight -= 0.06;
    aiWeight = Math.max(0.42, Math.min(0.75, aiWeight));

    const calibratedFairProb = Math.max(0.01, Math.min(0.99, (aiWeight * rawSideProb) + ((1 - aiWeight) * marketMicro)));

    // 2. Descuento de Spread + Comisión Taker (takerBaseFee) + Penalización Longshot Bias (<18c)
    const spreadCost = selectedBook.spreadAbs;
    const takerBaseFeeBps = asNumber(m.takerBaseFee, 0);
    const feeCost = takerBaseFeeBps > 0 ? (executableAsk * (1 - executableAsk) * 0.015) : 0;
    const longshotPenalty = executableAsk < 0.18 ? 0.015 : 0;

    const rawEdgePct = (rawSideProb - executableAsk) * 100;
    const netEdgePct = (calibratedFairProb - executableAsk - spreadCost - feeCost - longshotPenalty) * 100;

    result.raw_fair_prob = Number(rawSideProb.toFixed(4));
    result.fair_prob = Number(calibratedFairProb.toFixed(4));
    result.executable_ask = Number(executableAsk.toFixed(4));
    result.executable_bid = Number(selectedBook.bestBid.toFixed(4));
    result.micro_price = Number(marketMicro.toFixed(4));
    result.obi = Number((selectedBook.obi ?? 0).toFixed(3));
    result.tape_imbalance = Number(sideTapeImbalance.toFixed(3));
    result.spread_pct = Number(selectedBook.spreadPct.toFixed(2));
    result.raw_edge_pct = Number(rawEdgePct.toFixed(2));
    result.edge_pct = Number(netEdgePct.toFixed(2));

    const conf = parseFloat(result.confidence || 0);
    const risk = String(result.risk || "MEDIUM").toUpperCase();

    if (netEdgePct < MIN_NET_EDGE_PCT || conf < MIN_AI_CONFIDENCE || risk === "HIGH") {
      result.action = "SKIP";
      result.reasoning = `[FILTRO BAYESIANO: Edge Calibrado ${netEdgePct.toFixed(1)}% (min ${MIN_NET_EDGE_PCT}%), RawEdge ${rawEdgePct.toFixed(1)}%, Conf ${conf}%, Risk ${risk}] ${result.reasoning || ""}`;
    }
  } else {
    result.edge_pct = Number(parseFloat(result.edge_pct || 0).toFixed(2));
  }

  if (!result.news_source || result.news_source === "url" || result.news_source === "none") {
    result.news_source = topSource;
  }
  if (!result.news_found && topSnippet !== "none") {
    result.news_found = topSnippet;
  }

  result._newsCached = usedCache;
  return result;
}

// â”€â”€ CICLO MAESTRO DE ESCANEO â”€â”€
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
        const enriched = raw.map(m => {
          const tokenIds = parseTokenIds(m);
          return {
            ...m,
            _cat: detectCategory(m.question),
            _yesTokenId: tokenIds.yesTokenId,
            _noTokenId: tokenIds.noTokenId,
          };
        });
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
          if (Number.isFinite(pre.yesP) && Number.isFinite(pre.noP)) {
            newSnap[id] = { yesP: pre.yesP, noP: pre.noP, ts: Date.now() };
          }
        }
        botState.marketSnapshots = newSnap;

        scored.sort((a, b) => b.pre.score - a.pre.score);
        botState.scanStatus.phase = `Verificando Order Books CLOB (${scored.length} candidatos)...`;
        const targetAiCount = Math.max(3, botState.config.aiTopN || 3);
        const viable = await selectOrderBookVerifiedCandidates(scored, targetAiCount);
        addLog(`✅ Filtros + OrderBook CLOB superados: ${viable.length}/${scored.length} mercados pasan a IA Profunda`, "FILTER");

        for (let i = 0; i < viable.length; i++) {
          const { m, pre } = viable[i];
          botState.scanStatus.phase = `IA Analizando: ${m.question.slice(0, 30)}...`;
          botState.scanStatus.progress = Math.round((i / viable.length) * 100);

          try {
            const analysis = await deepAnalyze(m, pre);

            if (analysis.action === "SKIP" || analysis.score < botState.config.minScore) {
              addLog(`⏭️ [IA SKIP] ${m.question.slice(0, 55)}... | Edge: ${analysis.edge_pct ?? 0}% | Conf: ${analysis.confidence ?? 0}%`, "INFO");
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
            addLog(`✨ [SEÑAL IA] ${analysis.action} | Confianza: ${analysis.confidence}% | Edge Neto: ${analysis.edge_pct}% | Merc: ${m.question.slice(0, 50)}`, "AI");

            await insertAiSignalSafe(sig, m, pre, analysis);

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

            const tradePlan = await buildTradePlan();
            if (!tradePlan.allowed) {
              addLog(`⛔ [TRADE BLOQUEADO] ${tradePlan.reason}`, "WARN");
              continue;
            }

            const sideBook = isYes ? pre.clob?.yes : pre.clob?.no;
            const amt = computeQuantPositionSize(tradePlan.amount, analysis, sideBook);
            const entry = sideBook?.bestAsk ?? (isYes ? pre.yesP : pre.noP);
            const entryBid = sideBook?.bestBid ?? parseFloat(Math.max(0.01, entry - 0.01).toFixed(4));
            const simulatedShares = parseFloat((amt / entry).toFixed(6));
            let executedAmount = amt;
            let executedEntry = entry;
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
            const trade = {
              id: `T-${uid().toUpperCase()}`,
              ts: openedAt,
              question: m.question,
              marketId,
              category: m._cat,
              action: analysis.action,
              side: isYes ? "YES" : "NO",
              conditionId,
              tokenId,
              entryPrice: executedEntry,
              currentPrice: initialMarkPrice,
              shares: executedShares,
              cost: executedAmount,
              confidence: analysis.confidence,
              edge_pct: analysis.edge_pct,
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
              takeProfit: calcTakeProfit(executedEntry, analysis.fair_prob),
              breakEvenArmed: false,
              maxHoldAt: calcMaxHoldAt(openedAt),
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
              addLog(`🚀 [BACKEND COMPRA SIM] ${trade.side} | Inversión: $${executedAmount.toFixed(2)} | Ask: ${fmtPct(executedEntry)} | Bid: ${fmtPct(entryBid)} | SL: ${fmtPct(trade.stopLoss)} | TP: ${fmtPct(trade.takeProfit)}`, "TRADE");
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

          // Fetch live CLOB bestBid in BOTH Simulation and Real mode
          if (trade.tokenId) {
            livePx = await getTokenSellPrice(trade.tokenId);
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

          // Persist mark-to-market price updates when price moves by >= 0.3 cents
          if (Math.abs(livePx - prevPx) >= 0.003) {
            await updateTradeSafe(trade.id, { current_price: livePx });
          }

          const openTrade = botState.trades[tradeIdx];
          const entryPrice = asNumber(openTrade.entryPrice, 0);

          // 1. Break-even activation
          if (!openTrade.breakEvenArmed && entryPrice > 0 && botState.config.breakEvenTriggerPct > 0) {
            const triggerPrice = Math.max(
              entryPrice * (1 + (botState.config.breakEvenTriggerPct / 100)),
              entryPrice + 0.02
            );
            if (livePx >= triggerPrice) {
              const breakEvenStop = parseFloat(
                Math.max(entryPrice * (1 + (botState.config.breakEvenBufferPct / 100)), entryPrice + 0.005).toFixed(4)
              );
              if (breakEvenStop > asNumber(openTrade.stopLoss, 0)) {
                openTrade.stopLoss = breakEvenStop;
                openTrade.breakEvenArmed = true;
                await updateTradeSafe(trade.id, { stop_loss: breakEvenStop, break_even_armed: true, current_price: livePx });
                addLog(`🛡 [RISK] Break-even activado en ${trade.id}. Nuevo SL: ${fmtPct(breakEvenStop)}`, "RISK");
              }
            }
          }

          // 2. Dynamic Trailing Stop once gain is >= 6% and >= +3c above entry
          if (openTrade.breakEvenArmed && entryPrice > 0 && livePx >= Math.max(entryPrice * 1.06, entryPrice + 0.03)) {
            const trailedStop = parseFloat((livePx - 0.022).toFixed(4));
            if (trailedStop > asNumber(openTrade.stopLoss, 0) + 0.005) {
              openTrade.stopLoss = trailedStop;
              await updateTradeSafe(trade.id, { stop_loss: trailedStop, current_price: livePx });
              addLog(`📈 [TRAILING SL] Stop Loss subido en ${trade.id} a ${fmtPct(trailedStop)} (Bid actual: ${fmtPct(livePx)})`, "RISK");
            }
          }

          const stopLoss = asNumber(openTrade.stopLoss, 0);
          const takeProfit = asNumber(openTrade.takeProfit, 0);
          const maxHoldAtMs = openTrade.maxHoldAt ? new Date(openTrade.maxHoldAt).getTime() : NaN;
          const maxHoldReached = Number.isFinite(maxHoldAtMs) && Date.now() >= maxHoldAtMs;

          let closeReason = null;
          if (takeProfit > 0 && livePx >= takeProfit) closeReason = "TAKE_PROFIT";
          else if (stopLoss > 0 && livePx <= stopLoss) closeReason = "STOP_LOSS";
          else if (maxHoldReached) closeReason = "MAX_HOLD";

          if (!closeReason) continue;

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
              const sell = await executeSellOrder({
                tokenId: openTrade.tokenId,
                shares: originalShares,
                expectedPrice: livePx,
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
            pnl = roundMoney((livePx - asNumber(openTrade.entryPrice, 0)) * asNumber(openTrade.shares, 0));
            returned = roundMoney(asNumber(openTrade.cost, 0) + pnl);
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
          botState.dailyPnl = roundMoney(botState.dailyPnl + pnl);

          addLog(`🤖 [BACKEND AUTOPILOT] Cierre ${openTrade.id} (${closeReason}) @ ${fmtPct(closePrice)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`, pnl >= 0 ? "WIN" : "LOSS");
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
        await runWithdrawalAutopilot("FAST_SYNC");
      }
    }
  );

  if (!acquired) {
    addLog("⏭️ [LOCK] Fast sync omitido porque otra instancia ya lo está ejecutando.", "WARN");
  }
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


