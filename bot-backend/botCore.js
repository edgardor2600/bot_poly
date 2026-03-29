import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { getBooleanEnv, getEnv, getNumberEnv, requireEnv } from './env.js';
import { getConditionalTokenSnapshot, getLiveWalletSnapshot, getTokenSellPrice, isRealTradingEnabled, transferUsdc } from './polymarketClient.js';
import { executeBuyOrder, executeSellOrder } from './tradeExecutor.js';
import { REAL_TRADING_RULES, computeRealTradePlan, isSameAddress, sumOpenExposure } from './riskGuards.js';
import { createRuntimeOwner, withRuntimeLock } from './runtimeLocks.js';

dotenv.config();

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_KEY = requireEnv('SUPABASE_KEY');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const API_POLY = "https://gamma-api.polymarket.com/markets";
const API_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const API_TAVILY = "https://api.tavily.com/search";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
export const BASE_CAPITAL = getNumberEnv("BASE_CAPITAL", 15);
const DAILY_GOAL = getNumberEnv("DAILY_GOAL_USDC", 1.50);
const STOP_LOSS_PCT = getNumberEnv("STOP_LOSS_PCT", 4);
const TAKE_PROFIT_PCT = getNumberEnv("TAKE_PROFIT_PCT", 8);
const BREAK_EVEN_TRIGGER_PCT = getNumberEnv("BREAK_EVEN_TRIGGER_PCT", 3);
const BREAK_EVEN_BUFFER_PCT = getNumberEnv("BREAK_EVEN_BUFFER_PCT", 0.25);
const MAX_HOLD_HOURS = getNumberEnv("MAX_HOLD_HOURS", 24);
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
  if (botState.withdrawalPolicy?.enabled && isSameAddress(botState.walletSnapshot?.address, WITHDRAWAL_TARGET_ADDRESS)) {
    warnings.push("El retiro automático apunta a la misma wallet operativa.");
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

async function buildTradePlan() {
  if (!isRealTradingEnabled()) {
    const simulatedAmount = roundMoney(botState.config.maxTradeUsdc || 1);
    return {
      allowed: botState.capital >= simulatedAmount,
      amount: simulatedAmount,
      reason: botState.capital >= simulatedAmount ? null : `Capital simulado insuficiente (${botState.capital.toFixed(2)})`,
      freeUsdc: botState.capital,
      polBalance: 0,
      openExposure: sumOpenExposure(getOpenTrades()),
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

function calcStopLoss(entryPrice) {
  return parseFloat((entryPrice * (1 - botState.config.stopLoss / 100)).toFixed(4));
}

function calcTakeProfit(entryPrice) {
  return parseFloat((entryPrice * (1 + botState.config.takeProfit / 100)).toFixed(4));
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
    botState.capital = parseFloat((BASE_CAPITAL + totalPnl - botState.withdrawnTotal).toFixed(2));
    if (botState.capital < 0) botState.capital = 0;
    botState.dailyPnl = parseFloat(todayPnl.toFixed(2));
    botState.dailyDate = todayStr;
    
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

// â”€â”€ POLYMARKET API â”€â”€
async function fetchAllMarkets(onProgress) {
  const all = [];
  let offset = 0;
  const limit = 100;
  let page = 1;

  while (true) {
    if(onProgress) onProgress(`Descargando pÃ¡gina ${page} (offset ${offset})â€¦`);
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

// â”€â”€ SCORING PRELIMINAR â”€â”€
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

// â”€â”€ IA PROFUNDA (Groq + Tavily) â”€â”€
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
YES=${fmtPct(yesP)} NO=${fmtPct(noP)} SUM=${fmtPct(sum)}${Math.abs(sum-1)>0.03?" âš ARB":""} VOL=${vol} LIQ=${liq}
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
      addLog("[BACKEND] ESCANEO COMPLETO INICIADO", "SYSTEM");

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
          newSnap[id] = { yesP: pre.yesP, noP: pre.noP, ts: Date.now() };
        }
        botState.marketSnapshots = newSnap;

        const viable = scored
          .sort((a, b) => b.pre.score - a.pre.score)
          .slice(0, botState.config.aiTopN);
        addLog(`✅ Filtros superados: ${viable.length} mercados a IA Profunda`, "FILTER");

        for (let i = 0; i < viable.length; i++) {
          const { m, pre } = viable[i];
          botState.scanStatus.phase = `IA Analizando: ${m.question.slice(0, 30)}...`;
          botState.scanStatus.progress = Math.round((i / viable.length) * 100);

          try {
            const analysis = await deepAnalyze(m, pre);

            if (analysis.action === "SKIP" || analysis.score < botState.config.minScore) {
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
            addLog(`✨ [SEÑAL IA] ${analysis.action} | Confianza: ${analysis.confidence}% | Edge: ${analysis.edge_pct}% | Merc: ${m.question.slice(0, 50)}`, "AI");

            await insertAiSignalSafe(sig, m, pre, analysis);

            if (botState.goalReached) {
              addLog("🛑 META DIARIA ALCANZADA: inversión en espera.", "SYSTEM");
              continue;
            }

            if (!botState.config.autoTrade) continue;

            const marketId = String(m.id || m.conditionId || "");
            const conditionId = String(m.conditionId || m.condition_id || m.id || "");
            const tokenId = analysis.action === "BUY_YES" ? m._yesTokenId : m._noTokenId;
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

            const amt = tradePlan.amount;
            const isYes = analysis.action === "BUY_YES";
            const entry = isYes ? pre.yesP : pre.noP;
            const simulatedShares = parseFloat((amt / entry).toFixed(6));
            let executedAmount = amt;
            let executedEntry = entry;
            let executedShares = simulatedShares;
            let buyOrderId = null;
            let buyOrderStatus = "SIMULATED";
            let buyTxHashes = null;
            let executionMode = "SIMULATED";

            if (isRealTradingEnabled()) {
              const realOrder = await executeBuyOrder({
                market: m,
                analysis,
                pre,
                amountUsdc: amt,
              });
              executedAmount = realOrder.amountUsdc;
              executedEntry = realOrder.entryPrice;
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
              currentPrice: executedEntry,
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
              stopLoss: calcStopLoss(executedEntry),
              takeProfit: calcTakeProfit(executedEntry),
              breakEvenArmed: false,
              maxHoldAt: calcMaxHoldAt(openedAt),
            };

            if (executionMode === "REAL") {
              await refreshWalletSnapshot(true);
              addLog(`🚀 [BACKEND COMPRA REAL] ${trade.side} | $${executedAmount.toFixed(2)} | Entrada: ${fmtPct(executedEntry)} | OrderID: ${buyOrderId || "N/A"}`, "TRADE");
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
              addLog(`🚀 [BACKEND COMPRA SIM] ${trade.side} | Inversión: $${executedAmount.toFixed(2)} | Entrada: ${fmtPct(executedEntry)} | Merc: ${trade.question.slice(0, 50)}`, "TRADE");
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
        addLog(`❌ Error Crítico Scanner Backend: ${err.message}`, "ERROR");
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

          if (isRealTradingEnabled() && trade.tokenId) {
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
          botState.trades[tradeIdx].currentPrice = livePx;

          const openTrade = botState.trades[tradeIdx];
          const entryPrice = asNumber(openTrade.entryPrice, 0);

          if (!openTrade.breakEvenArmed && entryPrice > 0 && botState.config.breakEvenTriggerPct > 0) {
            const triggerPrice = entryPrice * (1 + (botState.config.breakEvenTriggerPct / 100));
            if (livePx >= triggerPrice) {
              const breakEvenStop = parseFloat((entryPrice * (1 + (botState.config.breakEvenBufferPct / 100))).toFixed(4));
              if (breakEvenStop > asNumber(openTrade.stopLoss, 0)) {
                openTrade.stopLoss = breakEvenStop;
                openTrade.breakEvenArmed = true;
                await updateTradeSafe(trade.id, { stop_loss: breakEvenStop, break_even_armed: true });
                addLog(`🛡 [RISK] Break-even activado en ${trade.id}. Nuevo SL: ${fmtPct(breakEvenStop)}`, "RISK");
              }
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


