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
const MIN_AI_CONFIDENCE = getNumberEnv("MIN_AI_CONFIDENCE", 70);
const MIN_NET_EDGE_PCT = getNumberEnv("MIN_NET_EDGE_PCT", 5.5);
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
    // 1. Descargar trades y señales históricas en paralelo para cruzar metadatos completos
    const [tradesRes, signalsRes] = await Promise.all([
      supabase.from('user_trades').select('*').order('executed_at', { ascending: false }),
      supabase.from('ai_signals').select('*').order('detected_at', { ascending: false }).limit(250),
    ]);

    if (tradesRes.error) throw tradesRes.error;
    const tradesDb = tradesRes.data || [];
    const signalsDb = signalsRes.data || [];

    await loadWithdrawalStateFromDB();

    // Limpiar en segundo plano filas corruptas o SKIP con confianza 0 en ai_signals
    const invalidSignalIds = signalsDb
      .filter(s => (s.action !== "BUY_YES" && s.action !== "BUY_NO") || asNumber(s.confidence, 0) <= 0)
      .map(s => s.signal_id)
      .filter(Boolean);

    if (invalidSignalIds.length > 0) {
      supabase.from('ai_signals').delete().in('signal_id', invalidSignalIds).then(() => {}).catch(() => {});
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

function computeTradeEconomics(trade) {
  const shares       = Math.max(0, asNumber(trade.shares, 0));
  const entryPrice   = Math.max(0.001, asNumber(trade.entryPrice, 0.5));
  const cost         = Math.max(0, asNumber(trade.cost, shares * entryPrice));
  const currentPrice = Math.max(0.001, asNumber(trade.currentPrice ?? trade.closePrice ?? trade.entryPrice, entryPrice));
  const isClosed     = trade.status === "CLOSED";

  // 1. Entry Fee: 0.35% sobre el nocional + $0.004 gas Polygon
  const entryFeeUsd = asNumber(trade.entryFeeUsd, 0) > 0
    ? asNumber(trade.entryFeeUsd, 0)
    : Number(((cost * 0.0035) + 0.004).toFixed(4));

  // 2. Exit Fee: distingue claramente entre STOP_LOSS (0.50%) y salidas controladas (BREAK_EVEN, TRAILING_STOP, TAKE_PROFIT: 0.35%)
  const exitPx          = isClosed ? asNumber(trade.closePrice ?? trade.currentPrice, currentPrice) : currentPrice;
  const exitNotional    = shares * exitPx;
  const isEmergencyStop = trade.closeReason === "STOP_LOSS";
  const exitFeeRate     = isEmergencyStop ? 0.0050 : 0.0035;

  const exitFeeUsd = isClosed
    ? (asNumber(trade.exitFeeUsd, 0) > 0 ? asNumber(trade.exitFeeUsd, 0) : Number(((exitNotional * exitFeeRate) + 0.004).toFixed(4)))
    : Number(((exitNotional * 0.0035) + 0.004).toFixed(4));

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
  // Banda Operativa Taker estricta [0.20, 0.82]: evita longshots devorados por spread (<20c) y asimetría negativa (>82c)
  if (book.bestAsk < 0.20 || book.bestAsk > 0.82) return false;
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
 * 3. Detector de Catalizador Ya Descontado ("Priced-In Veto")
 * Bloquea compras tardías cuando la noticia tiene > 1.5h y el precio ya subió
 * gran parte del recorrido proyectado por la IA.
 */
export function evaluateCatalystPricedIn({
  hasFreshNews,
  newsAgeHours = 6.0,
  marketMicro,
  rawSideProb,
  priceVelocity6h = 0,
}) {
  const projectedRemainingMove = Math.max(0.001, rawSideProb - marketMicro);

  // Si en las últimas 6h el precio ya avanzó en nuestra dirección:
  if (priceVelocity6h > 0.02) {
    const totalImpliedMoveFromBase = priceVelocity6h + projectedRemainingMove;
    const priceAbsorptionRatio = priceVelocity6h / totalImpliedMoveFromBase; // PAR en [0, 1]

    // Veto Duro: Si la noticia tiene más de 1.5 horas y el mercado ya absorbió >= 65%
    // del movimiento total, o si ya subió +11¢ en las últimas 6h sin flujo fresco nuevo:
    const isAlreadyPricedIn =
      (hasFreshNews && newsAgeHours > 1.5 && priceAbsorptionRatio >= 0.65) ||
      priceVelocity6h >= 0.11;

    // Penalización progresiva sobre el peso de la IA a medida que el precio ya corrió
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
 * 5. Consistencia Combinatoria en Eventos Multi-Resultado (Normalización de Kolmogorov)
 * Si el mercado pertenece a un evento con múltiples candidatos mutuamente excluyentes,
 * descuenta el overround (Suma P_j > 1.0) sobre el MicroPrice.
 */
function computeSiblingNormalizedMicro(m, rawMicro, isYesSide) {
  const eventKey = String(m?.events?.[0]?.slug || m?.events?.[0]?.id || "");
  if (!eventKey || !Array.isArray(botState.allMarkets) || botState.allMarkets.length < 2) {
    return rawMicro;
  }

  const siblings = botState.allMarkets.filter(cand => {
    const cKey = String(cand?.events?.[0]?.slug || cand?.events?.[0]?.id || "");
    return cKey === eventKey && cand?.negRisk === true;
  });

  if (siblings.length < 2) return rawMicro;

  const sumYesP = siblings.reduce((sum, s) => sum + asNumber(s?._prelim?.yesP, 0), 0);
  if (sumYesP <= 1.03 || sumYesP > 1.40) return rawMicro;

  // Normalizar probabilidad implícita de YES dividiendo por la suma del grupo
  if (isYesSide) {
    return Math.max(0.01, Math.min(0.99, rawMicro / sumYesP));
  }
  const impliedYes = 1 - rawMicro;
  const normalizedYes = impliedYes / sumYesP;
  // Para BUY_NO, el overround de YES inflaba artificialmente el precio de YES; mantenemos ancla conservadora
  return Math.max(0.01, Math.min(0.99, (rawMicro + (1 - normalizedYes)) / 2));
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
    const itoDriftDaily = -0.5 * (dailyVol ** 2);

    if (targetPrice && targetPrice > spot * 0.2 && targetPrice < spot * 3.0) {
      const dualOracle = computeDualCryptoOracleProb({
        questionText: q,
        spotPrice: spot,
        barrierPrice: targetPrice,
        sigmaDaily: dailyVol,
        daysToExpiry: tDays,
        itoDriftDaily,
        normalCDFFn: normCdf,
      });
      if (dualOracle) {
        modelType = dualOracle.contractType;
        mathYesProb = dualOracle.pMath;
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
  // Ticket mínimo eficiente ($1.50 USDC) para diluir los $0.008 de gas fijo + truncamiento ERC-1155
  const minUsdc = Math.max(1.25, asNumber(botState.config.minTradeUsdc, 1.50));
  const maxUsdc = Math.max(
    minUsdc,
    Math.min(asNumber(maxAllowedAmount, minUsdc), asNumber(botState.config.maxTradeUsdc, 2.50))
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
async function deepAnalyze(m, prelim) {
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
            hasFreshNews = true;
            if (bestAge > 4.0) bestAge = 3.5;
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

  // PROTOCOLO ANTI-ANCLAJE DE TETLOCK:
  // Ocultamos el nivel de precio actual (Bid/Ask/MicroPrice) al LLM para evitar que sume +10% por inercia al precio actual.
  // Le entregamos únicamente la microestructura de presión (SpreadPct, WOBI, Profundidad y Flujo ETI).
  const yesBookStructureStr = yesBook?.isValid
    ? `Spread=${yesBook.spreadPct.toFixed(2)}% TopDepth=$${(yesBook.topLiquidityUsd ?? (yesBook.bidDepthUsd + yesBook.askDepthUsd)).toFixed(0)} WOBI=${yesBook.obi >= 0 ? "+" : ""}${yesBook.obi.toFixed(2)} Tradable=${yesTradable ? "YES" : "NO"}`
    : "UNAVAILABLE";
  const noBookStructureStr = noBook?.isValid
    ? `Spread=${noBook.spreadPct.toFixed(2)}% TopDepth=$${(noBook.topLiquidityUsd ?? (noBook.bidDepthUsd + noBook.askDepthUsd)).toFixed(0)} WOBI=${noBook.obi >= 0 ? "+" : ""}${noBook.obi.toFixed(2)} Tradable=${noTradable ? "YES" : "NO"}`
    : "UNAVAILABLE";

  const tapeFlowStr = tradeFlow
    ? `Last_${tradeFlow.sampleCount}_Trades: BullishYES=$${tradeFlow.yesBullUsd.toFixed(0)} (Whales=${tradeFlow.whaleYesCount}) | BullishNO=$${tradeFlow.noBullUsd.toFixed(0)} (Whales=${tradeFlow.whaleNoCount}) | ETI_TapeImbalance=${tradeFlow.tapeImbalance >= 0 ? "+" : ""}${tradeFlow.tapeImbalance.toFixed(2)}`
    : "UNAVAILABLE";

  const cryptoLine = cryptoQuant ? `\nLIVE_CRYPTO_ORACLE: ${cryptoQuant.summary}` : "";

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a senior quantitative superforecaster (Tetlock protocol) managing real capital on Polymarket CLOB.
You are intentionally BLIND to the current market price so you cannot anchor to it.
Your job is to estimate from first principles:
1. base_rate_prob (0.01 to 0.99): The historical outside-view base rate probability of YES ignoring today's news.
2. evidence_likelihood_ratio (0.50 to 2.00): The diagnostic strength of RECENT_NEWS & orderflow (1.00 = no fresh catalyst or noise; >1.00 = confirms YES; <1.00 = contradicts YES / confirms NO).
3. estimated_yes_prob (0.01 to 0.99): Your final fundamental probability of the YES outcome.
CRITICAL RULES:
1. Never recommend a side marked Tradable=NO.
2. Check PRICE_MOMENTUM (1h/24h/7d) vs news age: if a market already moved >15% in 24h because of news older than 2 hours, that catalyst is ALREADY PRICED IN — return action="SKIP".
3. SPORTS & ESPORTS WARNING: Any final score in RECENT_NEWS is from a PAST game earlier in the season — NEVER treat a past game score as the result of the upcoming match. If there is no fresh injury/lineup catalyst ("no recent catalyst"), return action="SKIP".
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
{"action":"BUY_YES"|"BUY_NO"|"SKIP","base_rate_prob":0.01-0.99,"evidence_likelihood_ratio":0.50-2.00,"estimated_yes_prob":0.01-0.99,"confidence":0-100,"edge_pct":number,"signal_types":["NEWS"|"MOMENTUM"|"MISPRICING"|"ORDERFLOW"],"news_found":"short summary of key catalyst","news_source":"url or none","reasoning":"concise quantitative rationale citing base rate, news age, and orderflow","risk":"LOW"|"MEDIUM"|"HIGH","score":0-100}`
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

  // ── VERIFICACIÓN MATEMÁTICA DURA Y CALIBRACIÓN BAYESIANA POST-IA (v2.5.0) ──
  const normalizeProb = (v) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 && n <= 100 ? n / 100 : n;
  };

  let estYesProb = normalizeProb(result.estimated_yes_prob);
  const baseRateYes = normalizeProb(result.base_rate_prob) ?? estYesProb;
  const rawLikelihoodRatio = Math.max(0.25, Math.min(4.0, asNumber(result.evidence_likelihood_ratio, 1.0)));

  if (Number.isFinite(baseRateYes) && Number.isFinite(estYesProb)) {
    const safeBase = Math.max(0.02, Math.min(0.98, baseRateYes));
    const decayedLR = 1.0 + (rawLikelihoodRatio - 1.0) * Math.exp(-0.15 * Math.max(0, minNewsAgeHours - 0.5));
    const priorOdds = safeBase / (1 - safeBase);
    const postOdds  = priorOdds * Math.max(0.25, decayedLR);
    const bayesianYesProb = postOdds / (1 + postOdds);
    estYesProb = (0.55 * estYesProb) + (0.45 * bayesianYesProb);
  }

  // Si es un mercado cripto con Oráculo Dual (Digital Europeo vs Barrera Americana), anclar con la probabilidad estocástica exacta
  if (cryptoQuant && Number.isFinite(cryptoQuant.mathYesProb) && Number.isFinite(estYesProb)) {
    estYesProb = (0.45 * estYesProb) + (0.55 * cryptoQuant.mathYesProb);
  }

  // Como el LLM estimó a ciegas sin ver el Ask del CLOB, seleccionamos/validamos el lado donde estYesProb supera al Ask real
  if (Number.isFinite(estYesProb) && result.action !== "SKIP") {
    const yesEdgeBlind = (yesTradable && yesBook?.isValid) ? (estYesProb - yesBook.bestAsk) : -1;
    const noEdgeBlind  = (noTradable && noBook?.isValid) ? ((1 - estYesProb) - noBook.bestAsk) : -1;
    if (result.action === "BUY_YES" && yesEdgeBlind <= 0.01 && noEdgeBlind >= 0.05) {
      result.action = "BUY_NO";
    } else if (result.action === "BUY_NO" && noEdgeBlind <= 0.01 && yesEdgeBlind >= 0.05) {
      result.action = "BUY_YES";
    }
  }

  let selectedBook = null;
  let rawSideProb = null;
  let isYesSide = false;

  if (result.action === "BUY_YES") {
    isYesSide = true;
    if (!yesTradable || !yesBook?.isValid) {
      result.action = "SKIP";
      result.reasoning = `[FILTRO CLOB] Lado YES bloqueado por spread/liquidez/WOBI. ${result.reasoning || ""}`;
    } else {
      selectedBook = yesBook;
      rawSideProb = Number.isFinite(estYesProb) ? estYesProb : (yesBook.bestAsk + (parseFloat(result.edge_pct || 0) / 100));
    }
  } else if (result.action === "BUY_NO") {
    isYesSide = false;
    if (!noTradable || !noBook?.isValid) {
      result.action = "SKIP";
      result.reasoning = `[FILTRO CLOB] Lado NO bloqueado por spread/liquidez/WOBI. ${result.reasoning || ""}`;
    } else {
      selectedBook = noBook;
      rawSideProb = Number.isFinite(estYesProb) ? (1 - estYesProb) : (noBook.bestAsk + (parseFloat(result.edge_pct || 0) / 100));
    }
  }

  if (selectedBook && (result.action === "BUY_YES" || result.action === "BUY_NO")) {
    rawSideProb = Math.max(0.01, Math.min(0.99, rawSideProb));
    const executableAsk = selectedBook.bestAsk;
    const selectedSide  = isYesSide ? "YES" : "NO";

    // 1. Microestructura de 2ª Generación: WOBI (Anti-Spoofing) y ETI (Tape con Decaimiento Temporal + Impacto de Kyle)
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

    // Consistencia Combinatoria entre hermanos (descuenta overround en eventos multi-resultado)
    const marketMicro = computeSiblingNormalizedMicro(m, wBook.pMicroWeighted, isYesSide);

    // Velocidad de precio en 6h combinando la cinta de trades y los deltas de Gamma
    const sideChange1h  = isYesSide ? asNumber(change1h, 0) : -asNumber(change1h, 0);
    const sideChange24h = isYesSide ? asNumber(change24h, 0) : -asNumber(change24h, 0);
    const effectivePriceVelocity6h = Math.max(eTape.priceVelocity6h, sideChange1h, sideChange24h * 0.65);

    // 2. Detector de Catalizador Ya Descontado (Priced-In Detector / PAR)
    const catalystAudit = evaluateCatalystPricedIn({
      hasFreshNews,
      newsAgeHours: minNewsAgeHours,
      marketMicro,
      rawSideProb,
      priceVelocity6h: effectivePriceVelocity6h,
    });

    // Si hay base_rate_prob y LR, penalizar LR también por PAR (1 - 0.75 * PAR)
    if (Number.isFinite(baseRateYes) && catalystAudit.priceAbsorptionRatio > 0) {
      const safeBase = Math.max(0.02, Math.min(0.98, isYesSide ? baseRateYes : (1 - baseRateYes)));
      const sideRawLR = isYesSide ? rawLikelihoodRatio : (1 / Math.max(0.25, rawLikelihoodRatio));
      const lrEffective = 1.0 + (sideRawLR - 1.0)
        * Math.exp(-0.15 * Math.max(0, minNewsAgeHours - 0.5))
        * Math.max(0, 1.0 - 0.75 * catalystAudit.priceAbsorptionRatio);
      const pOdds = (safeBase / (1 - safeBase)) * Math.max(0.25, lrEffective);
      const pPostPar = pOdds / (1 + pOdds);
      rawSideProb = Math.max(0.01, Math.min(0.99, (0.50 * rawSideProb) + (0.50 * pPostPar)));
    }

    // Protección dura contra mercados deportivos donde la IA confunde marcadores pasados o no tiene catalizador nuevo
    const isSportsMatch = m._cat === "SPORTS" || /\b(vs\.?|handicap|esports|nba|nfl|mlb|nhl|ufc|match|game|atp|premier league|champions)\b/i.test(m.question || "");
    const lacksCatalyst = /no recent catalyst|no new info|older news|no recent news|sin noticias recientes/i.test(
      `${result.news_found || ""} ${result.reasoning || ""}`
    );

    if (lacksCatalyst && (effectiveObi < 0.45 || sideTapeImbalance < 0.25)) {
      result.action = "SKIP";
      result.reasoning = `[FILTRO CATALIZADOR] Sin noticia nueva ni flujo institucional fuerte (WOBI=${effectiveObi.toFixed(2)}, ETI=${sideTapeImbalance.toFixed(2)}). ${result.reasoning || ""}`;
    }

    if (isSportsMatch && executableAsk >= 0.20 && executableAsk <= 0.80) {
      // Un partido entre 20c y 80c aún no se ha resuelto; bloquear alucinaciones de "marcador final ya jugado"
      rawSideProb = Math.min(rawSideProb, marketMicro + 0.14);
    }

    // 3. Peso adaptativo de la IA usando el decaimiento continuo de frescura (catalystAudit.effectiveCatalystWeightBoost)
    let aiWeight = 0.50 + (lacksCatalyst ? 0 : catalystAudit.effectiveCatalystWeightBoost);
    if (effectiveObi >= 0.18)          aiWeight += 0.06;
    else if (effectiveObi <= -0.15)    aiWeight -= 0.10;
    if (sideTapeImbalance >= 0.18)     aiWeight += 0.06;
    else if (sideTapeImbalance <= -0.20) aiWeight -= 0.10;
    if (liq > 50000)                   aiWeight -= 0.08;
    aiWeight = Math.max(0.35, Math.min(0.72, aiWeight));

    // 4. Pooling en espacio Log-Odds (corrige sobreconfianza del LLM en extremos)
    const clampP  = (p) => Math.max(0.01, Math.min(0.99, Number(p)));
    const logit   = (p) => Math.log(clampP(p) / (1 - clampP(p)));
    const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));

    // Contracción de Platt (0.82) sobre el logit crudo del LLM para mitigar alucinación de certeza
    const rawLogitShrunk     = 0.82 * logit(rawSideProb);
    const microLogit         = logit(marketMicro);
    const combinedLogit      = (aiWeight * rawLogitShrunk) + ((1 - aiWeight) * microLogit);
    const calibratedFairProb = clampP(sigmoid(combinedLogit));

    // 5. Factor de Convergencia Finita a 24h (Kappa_24h) coherente con MAX_HOLD = 24h
    const endDateRaw = m?.endDate || m?.endDateIso;
    const endDateMs  = endDateRaw ? new Date(endDateRaw).getTime() : (Date.now() + 7 * 86400_000);
    const hoursToResolution = Math.max(1, (endDateMs - Date.now()) / 3600_000);
    const daysToResolution  = hoursToResolution / 24;

    const timeConvergenceBase = Math.pow(24 / Math.max(24, hoursToResolution), 0.45);
    const catalystBoost       = (hasFreshNews && !lacksCatalyst && !catalystAudit.isAlreadyPricedIn) ? 0.35 : 0.0;
    const orderflowBoost      = (effectiveObi >= 0.25 && sideTapeImbalance >= 0.20) ? 0.20 : 0.0;
    const kappa24h            = Math.max(0.25, Math.min(1.0, timeConvergenceBase + catalystBoost + orderflowBoost));

    // Valor justo alcanzable dentro de la ventana operativa de 24h
    const reachableFairProb24h = clampP(
      marketMicro + kappa24h * (calibratedFairProb - marketMicro)
    );

    // 6. Descuento de Fricción Exacto (Sin doble conteo de spread y sin feeCost = 0)
    const bestBidPx      = asNumber(selectedBook.bestBid, executableAsk - selectedBook.spreadAbs);
    const exitHalfSpread = Math.max(0.002, marketMicro - bestBidPx);

    // Probabilidad de cerrar en el CLOB antes de la resolución del oráculo
    const exitProbInClob = hoursToResolution > 24 ? 0.88 : 0.35;

    // Costo real de comisión (usa el mayor entre el fee de API y el 0.35% del motor económico)
    const takerBaseFeeBps  = asNumber(m.takerBaseFee, 0);
    const apiQuadraticFee  = takerBaseFeeBps > 0 ? (executableAsk * (1 - executableAsk) * 0.015) : 0;
    const entryFeePerShare = Math.max(executableAsk * 0.0035, apiQuadraticFee);
    const exitFeePerShare  = reachableFairProb24h * 0.0035;

    // Impacto de gas ($0.004 entrada + $0.004 salida) + slippage expresado por acción
    const refTradeUsdc = Math.max(1.50, (asNumber(botState.config.minTradeUsdc, 1.50) + asNumber(botState.config.maxTradeUsdc, 2.50)) / 2);
    const gasPerShare  = (0.004 * executableAsk) / refTradeUsdc;
    const entryDepthSlippage   = Math.max(0.001, Math.min(0.004, (refTradeUsdc / Math.max(500, liq)) * 0.15));
    const exitSlippageExpected = 0.0015;

    const totalEntryFriction = entryFeePerShare + gasPerShare + entryDepthSlippage;
    const totalExitFriction  = exitProbInClob * (exitHalfSpread + exitFeePerShare + gasPerShare + exitSlippageExpected);

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
      bookQuality: selectedBook.spreadPct <= 3.5 && selectedBook.spreadAbs <= 0.025 && effectiveObi >= -0.05,
      orderflowAlignment: (effectiveObi + sideTapeImbalance) >= 0.10 || (whaleSideCount >= 1 && sideTapeImbalance >= 0),
      catalystOrMath: (hasFreshNews && !lacksCatalyst && !catalystAudit.isAlreadyPricedIn) || (effectiveObi >= 0.35 && sideTapeImbalance >= 0.20),
      positiveExpectancy: netEdgePct >= MIN_NET_EDGE_PCT && conf >= 70 && rewardToRisk >= 1.75,
    };

    const hardVetoes = [];

    // Veto Estratégico 1: Banda Operativa Taker [20¢ - 82¢]
    if (executableAsk < 0.20 || executableAsk > 0.82) {
      hardVetoes.push(`Precio fuera de banda operativa [20¢-82¢] (Ask=${(executableAsk * 100).toFixed(1)}¢)`);
    }

    // Veto Estratégico 2: Filtro de Decaimiento Temporal (>14 días sin catalizador fresco del día)
    if (daysToResolution > 14 && (!hasFreshNews || lacksCatalyst)) {
      hardVetoes.push(`Horizonte > 14d (${daysToResolution.toFixed(1)}d) sin catalizador fresco del día`);
    }

    // Veto Duro A: Prohibido comprar contra el flujo del Order Book (WOBI) y de la Cinta (ETI) simultáneamente
    if (effectiveObi < -0.05 && sideTapeImbalance <= 0.05) {
      hardVetoes.push(`Flujo en contra (WOBI=${effectiveObi.toFixed(2)}, ETI=${sideTapeImbalance.toFixed(2)})`);
    }

    // Veto Duro B: En Cripto con Oráculo Dual (Digital Europeo vs Barrera Americana), la probabilidad estocástica no puede contradecir la compra
    if (cryptoQuant && Number.isFinite(cryptoQuant.mathYesProb)) {
      const mathSideProb = isYesSide ? cryptoQuant.mathYesProb : (1 - cryptoQuant.mathYesProb);
      pillars.catalystOrMath = mathSideProb >= (executableAsk + 0.03);
      if (mathSideProb < executableAsk) {
        hardVetoes.push(`Oráculo Cripto (${cryptoQuant.modelType}) contradice compra (MathProb=${(mathSideProb * 100).toFixed(1)}% < Ask=${(executableAsk * 100).toFixed(1)}%)`);
      }
    }

    // Veto Duro C: En Deportes/Esports exigir confluencia extrema
    if (isSportsMatch) {
      if (conf < 80 || lacksCatalyst || !hasFreshNews || effectiveObi < 0.20 || sideTapeImbalance < 0.15) {
        hardVetoes.push(`Deportes bloqueado sin catalizador + flujo institucional unánime`);
      }
    }

    // Veto Duro D (NUEVO v2.5.0): Catalizador Ya Descontado / Chasing Veto (PAR >= 65% o salto >= +11¢ en 6h)
    if (catalystAudit.isAlreadyPricedIn) {
      hardVetoes.push(`VETO_D_CATALYST_ALREADY_PRICED_IN (PAR=${(catalystAudit.priceAbsorptionRatio * 100).toFixed(0)}%, Vel6h=+${(effectivePriceVelocity6h * 100).toFixed(1)}¢, NewsAge=${minNewsAgeHours.toFixed(1)}h)`);
    }

    // Veto Duro E (NUEVO v2.5.0): Latencia Deportiva In-Play (<= 3.5h para resolución)
    if (isSportsMatch && hoursToResolution <= 3.5) {
      hardVetoes.push(`VETO_E_SPORTS_LIVE_LATENCY_RISK (${hoursToResolution.toFixed(1)}h <= 3.5h)`);
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
    result.price_absorption_ratio = catalystAudit.priceAbsorptionRatio;
    result.fair_value_yes = Number(fairYesProb.toFixed(4));
    result.executable_ask = Number(executableAsk.toFixed(4));
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
      const vetoDetail = hardVetoes.length > 0 ? `Veto: ${hardVetoes.join("; ")} | ` : "";
      result.reasoning = `[CONFLUENCE GATE: ${confluenceScore}/4 pilares | ${vetoDetail}Edge Calibrado ${netEdgePct.toFixed(1)}%, R:R ${rewardToRisk.toFixed(2)}x, Conf ${conf}%] ${result.reasoning || ""}`;
    }
  } else {
    result.action = "SKIP";
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

        for (let i = 0; i < viable.length; i++) {
          const { m, pre } = viable[i];
          botState.scanStatus.phase = `IA Analizando: ${m.question.slice(0, 30)}...`;
          botState.scanStatus.progress = Math.round((i / viable.length) * 100);

          try {
            const analysis = await deepAnalyze(m, pre);

            const isValidAction = analysis.action === "BUY_YES" || analysis.action === "BUY_NO";
            const scoreNum = asNumber(analysis.score, 0);
            const confNum = asNumber(analysis.confidence, 0);

            if (!isValidAction || scoreNum < botState.config.minScore || confNum <= 0) {
              addLog(`⏭️ [IA SKIP] ${m.question.slice(0, 55)}... | Edge: ${analysis.edge_pct ?? 0}% | Conf: ${confNum}%`, "INFO");
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
            const rawAsk = sideBook?.bestAsk ?? (isYes ? pre.yesP : pre.noP);
            const entryBid = sideBook?.bestBid ?? parseFloat(Math.max(0.01, rawAsk - 0.01).toFixed(4));

            // Modelo de Ejecución Realista (Slippage de Pool + Comisión Taker + Gas/Relayer Polygon + Redondeo CTF)
            const askDepthUsd = Math.max(10, asNumber(sideBook?.askDepthUsd, 25));
            const depthImpact = (amt / askDepthUsd) > 0.12
              ? Math.min(0.012, (amt / askDepthUsd) * asNumber(sideBook?.spreadAbs, 0.01))
              : 0.001;
            const effectiveSimEntry = parseFloat(Math.min(0.98, rawAsk + depthImpact).toFixed(4));
            const takerFeeRate = Math.max(0.0035, asNumber(m.takerBaseFee, 0) > 0 ? (rawAsk * (1 - rawAsk) * 0.015) : 0.0035);
            const entryFeeUsd = parseFloat(((amt * takerFeeRate) + 0.004).toFixed(4));
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
              entryFeeUsd,
              frictionDeducted: true,
              confidence: analysis.confidence,
              edge_pct: analysis.edge_pct,
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
          Object.assign(botState.trades[tradeIdx], computeTradeEconomics(botState.trades[tradeIdx]));

          // Persist mark-to-market price updates when price moves by >= 0.3 cents
          if (Math.abs(livePx - prevPx) >= 0.003) {
            await updateTradeSafe(trade.id, { current_price: livePx });
          }

          const openTrade = botState.trades[tradeIdx];
          const entryPrice = asNumber(openTrade.entryPrice, 0.5);
          const shares     = Math.max(0.000001, asNumber(openTrade.shares, 1));

          // ─── Parámetros de Volatilidad Binaria Simétrica σ_bin = sqrt(p*(1-p)) ─
          // Reemplaza la distorsión de entryPrice * 1.08 que asfixiaba precios altos
          const binarySigma = Math.sqrt(Math.max(0.04, entryPrice * (1 - entryPrice)));

          // ─── 1. Break-Even Exacto Libre de Pérdidas ───────────────────────────
          // Cubre entryFee (0.35%), exitFee (0.35%), gas ida/vuelta ($0.008), slippage (0.2¢) + $0.005 de ganancia neta mínima
          const exactBreakEvenPx =
            ((entryPrice * 1.0035) + ((0.008 + 0.005) / shares)) / (1 - 0.0035) + 0.002;
          const exactBreakEvenFloor = parseFloat(Math.max(exactBreakEvenPx, entryPrice + 0.009).toFixed(4));

          // El trigger exige cubrir el Break-Even exacto + un colchón anti-ruido de 2.4¢ a 3.2¢ según σ_bin
          const beNoiseCushion = Math.max(0.024, 0.065 * binarySigma);
          const triggerPrice   = Math.max(
            exactBreakEvenPx + beNoiseCushion,
            entryPrice + Math.max(0.030, 0.070 * binarySigma)
          );

          if (!openTrade.breakEvenArmed && entryPrice > 0 && botState.config.breakEvenTriggerPct > 0 && livePx >= triggerPrice) {
            if (exactBreakEvenFloor > asNumber(openTrade.stopLoss, 0)) {
              openTrade.stopLoss = exactBreakEvenFloor;
              openTrade.breakEvenArmed = true;
              await updateTradeSafe(trade.id, { stop_loss: exactBreakEvenFloor, break_even_armed: true, current_price: livePx });
              addLog(`🛡 [RISK] Break-even exacto activado en ${trade.id}. Nuevo SL libre de pérdidas: ${fmtPct(exactBreakEvenFloor)}`, "RISK");
            }
          }

          // ─── 2. Trailing Stop Adaptativo por Volatilidad Binaria ──────────────
          // Se activa cuando el avance supera max(4.2¢, 0.095 * σ_bin)
          const trailActivationPx = entryPrice + Math.max(0.042, 0.095 * binarySigma);
          const dynamicTrailDist  = Math.max(0.026, 0.068 * binarySigma);

          if (openTrade.breakEvenArmed && entryPrice > 0 && livePx >= trailActivationPx) {
            const trailedStop = parseFloat((livePx - dynamicTrailDist).toFixed(4));
            if (trailedStop > asNumber(openTrade.stopLoss, 0) + 0.004) {
              openTrade.stopLoss = trailedStop;
              openTrade.trailingActive = true;
              await updateTradeSafe(trade.id, { stop_loss: trailedStop, current_price: livePx });
              addLog(`📈 [TRAILING SL] Stop Loss adaptativo (σ_bin=${binarySigma.toFixed(2)}) subido en ${trade.id} a ${fmtPct(trailedStop)} (Bid actual: ${fmtPct(livePx)})`, "RISK");
            }
          }

          const stopLoss = asNumber(openTrade.stopLoss, 0);
          const takeProfit = asNumber(openTrade.takeProfit, 0);
          const maxHoldAtMs = openTrade.maxHoldAt ? new Date(openTrade.maxHoldAt).getTime() : NaN;
          const maxHoldReached = Number.isFinite(maxHoldAtMs) && Date.now() >= maxHoldAtMs;

          // ─── 3. Decisión de Cierre (Con separación de estados y filtro anti-mecha) ─
          let closeReason = null;
          if (takeProfit > 0 && livePx >= takeProfit) {
            closeReason = "TAKE_PROFIT";
          } else if (stopLoss > 0 && livePx <= stopLoss) {
            // Anti-Wick en polling de 3 min: esperar 1.5s y verificar segundo snapshot rápido del CLOB
            if (trade.tokenId) {
              await new Promise(res => setTimeout(res, 1500));
              const secondCheckPx = await getTokenSellPrice(trade.tokenId);
              if (Number.isFinite(secondCheckPx) && secondCheckPx > 0.001 && secondCheckPx < 0.999) {
                livePx = secondCheckPx;
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
            // Simulación Realista: Deslizamiento diferenciado por tipo de salida + Comisión Pool/Taker + Gas Polygon
            const exitSlippage = closeReason === "STOP_LOSS"
              ? 0.0020
              : (closeReason === "TRAILING_STOP" || closeReason === "BREAK_EVEN" ? 0.0015 : 0.0010);
            closePrice = parseFloat(Math.max(0.005, livePx - exitSlippage).toFixed(4));
            const grossProceeds = asNumber(openTrade.shares, 0) * closePrice;
            const exitFeeRate = closeReason === "STOP_LOSS" ? 0.0050 : 0.0035;
            const exitFeeUsd = parseFloat(((grossProceeds * exitFeeRate) + 0.004).toFixed(4));
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
    byCategory,
    byExitReason,
  };
}


