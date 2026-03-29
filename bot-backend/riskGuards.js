import { getNumberEnv } from "./env.js";

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Number(Math.max(0, value).toFixed(2));
}

const ACTIVE_TRADE_STATUSES = new Set(["OPEN", "PARTIAL", "PENDING_BUY", "PENDING_SELL"]);

function isActiveTradeStatus(status) {
  return ACTIVE_TRADE_STATUSES.has(String(status || "").trim().toUpperCase());
}

export const REAL_TRADING_RULES = {
  minTradeUsdc: getNumberEnv("MIN_TRADE_USDC", 1),
  maxTradeUsdc: getNumberEnv("MAX_TRADE_USDC", 1),
  maxOpenTrades: Math.max(1, Math.floor(getNumberEnv("MAX_OPEN_TRADES", 3))),
  maxExposurePct: Math.max(1, Math.min(100, getNumberEnv("MAX_EXPOSURE_PCT", 40))),
  reserveUsdc: Math.max(0, getNumberEnv("TRADING_RESERVE_USDC", 0)),
  minPolBalance: Math.max(0, getNumberEnv("TRADING_MIN_POL_BALANCE", 0.5)),
  aiTopN: Math.max(1, Math.floor(getNumberEnv("AI_TOP_N", 1))),
};

export function sumOpenExposure(trades = []) {
  return roundMoney(
    trades
      .filter(t => isActiveTradeStatus(t?.status))
      .reduce((sum, trade) => sum + toFiniteNumber(trade?.cost, 0), 0)
  );
}

export function countOpenTrades(trades = []) {
  return trades.filter(t => isActiveTradeStatus(t?.status)).length;
}

export function isSameAddress(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function computeRealTradePlan({
  walletSnapshot,
  openTrades = [],
  rules = REAL_TRADING_RULES,
}) {
  const freeUsdc = toFiniteNumber(walletSnapshot?.usdcBalance, 0);
  const polBalance = toFiniteNumber(walletSnapshot?.polBalance, 0);
  const openExposure = sumOpenExposure(openTrades);
  const openTradesCount = countOpenTrades(openTrades);
  const totalEquity = roundMoney(freeUsdc + openExposure);
  const maxExposureUsdc = roundMoney(totalEquity * (rules.maxExposurePct / 100));
  const reserveUsdc = Math.max(0, rules.reserveUsdc);
  const availableCash = roundMoney(freeUsdc - reserveUsdc);
  const remainingExposure = roundMoney(maxExposureUsdc - openExposure);
  const amount = roundMoney(
    Math.min(rules.maxTradeUsdc, availableCash, remainingExposure)
  );

  if (polBalance < rules.minPolBalance) {
    return {
      allowed: false,
      reason: `POL insuficiente (${polBalance.toFixed(4)} < ${rules.minPolBalance.toFixed(4)})`,
      freeUsdc,
      polBalance,
      openExposure,
      openTradesCount,
      totalEquity,
      maxExposureUsdc,
      availableCash,
      remainingExposure,
      amount: 0,
    };
  }

  if (openTradesCount >= rules.maxOpenTrades) {
    return {
      allowed: false,
      reason: `Límite de trades abiertos alcanzado (${openTradesCount}/${rules.maxOpenTrades})`,
      freeUsdc,
      polBalance,
      openExposure,
      openTradesCount,
      totalEquity,
      maxExposureUsdc,
      availableCash,
      remainingExposure,
      amount: 0,
    };
  }

  if (availableCash < rules.minTradeUsdc) {
    return {
      allowed: false,
      reason: `USDC libre insuficiente (${availableCash.toFixed(2)} < ${rules.minTradeUsdc.toFixed(2)})`,
      freeUsdc,
      polBalance,
      openExposure,
      openTradesCount,
      totalEquity,
      maxExposureUsdc,
      availableCash,
      remainingExposure,
      amount: 0,
    };
  }

  if (remainingExposure < rules.minTradeUsdc) {
    return {
      allowed: false,
      reason: `Exposición máxima alcanzada (${openExposure.toFixed(2)}/${maxExposureUsdc.toFixed(2)} USDC)`,
      freeUsdc,
      polBalance,
      openExposure,
      openTradesCount,
      totalEquity,
      maxExposureUsdc,
      availableCash,
      remainingExposure,
      amount: 0,
    };
  }

  if (amount < rules.minTradeUsdc) {
    return {
      allowed: false,
      reason: `Monto utilizable insuficiente (${amount.toFixed(2)} < ${rules.minTradeUsdc.toFixed(2)})`,
      freeUsdc,
      polBalance,
      openExposure,
      openTradesCount,
      totalEquity,
      maxExposureUsdc,
      availableCash,
      remainingExposure,
      amount: 0,
    };
  }

  return {
    allowed: true,
    reason: null,
    freeUsdc,
    polBalance,
    openExposure,
    openTradesCount,
    totalEquity,
    maxExposureUsdc,
    availableCash,
    remainingExposure,
    amount,
  };
}
