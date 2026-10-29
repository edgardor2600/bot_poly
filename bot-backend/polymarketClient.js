import { AssetType, ClobClient } from "@polymarket/clob-client";
import { Contract, Wallet, providers, utils } from "ethers";
import { getBooleanEnv, getNumberEnv, getEnv, requireEnv } from "./env.js";

const DEFAULT_HOST = "https://clob.polymarket.com";
const DEFAULT_CHAIN_ID = 137;
const DEFAULT_POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const DEFAULT_USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const TOKEN_SCALE = 1_000_000;
const DEFAULT_MIN_PRIORITY_GWEI = 25;
const DEFAULT_MIN_MAX_FEE_GWEI = 35;
const DEFAULT_MAX_FEE_CAP_GWEI = 200;
const USDC_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

let cachedClient = null;
let cachedCreds = null;
let walletSnapshotCache = { ts: 0, data: null };

function readProbabilityPrice(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }

  const candidates = [
    raw?.price,
    raw?.mid,
    raw?.value,
    raw?.bestPrice,
    raw?.result,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
      return parsed;
    }
  }

  if (typeof raw === "object") {
    for (const value of Object.values(raw)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
        return parsed;
      }
    }
  }

  return null;
}

export function isRealTradingEnabled() {
  return getBooleanEnv("REAL_TRADING_ENABLED", false);
}

function resolveTradingConfig() {
  const enabled = isRealTradingEnabled();
  const config = {
    enabled,
    host: getEnv("POLYMARKET_HOST", DEFAULT_HOST),
    chainId: getNumberEnv("POLYMARKET_CHAIN_ID", DEFAULT_CHAIN_ID),
  };

  if (!enabled) return config;

  const privateKey = requireEnv("POLYMARKET_PRIVATE_KEY");
  const signatureType = getNumberEnv("POLYMARKET_SIGNATURE_TYPE", 0);
  const funderAddress = getEnv("POLYMARKET_FUNDER");

  const signer = new Wallet(privateKey);

  config.signer = signer;
  config.signatureType = signatureType;
  config.funderAddress = funderAddress || signer.address;
  config.polygonRpcUrl = getEnv("POLYGON_RPC_URL", DEFAULT_POLYGON_RPC);
  config.usdcAddress = getEnv("POLYGON_USDC_ADDRESS", DEFAULT_USDC_ADDRESS);
  return config;
}

export async function initPolymarketClient() {
  const config = resolveTradingConfig();

  if (!config.enabled) {
    return null;
  }

  if (cachedClient) {
    return cachedClient;
  }

  const tempClient = new ClobClient(config.host, config.chainId, config.signer);
  cachedCreds = await tempClient.createOrDeriveApiKey();

  cachedClient = new ClobClient(
    config.host,
    config.chainId,
    config.signer,
    cachedCreds,
    config.signatureType,
    config.funderAddress,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );

  await cachedClient.getOk();
  return cachedClient;
}

export function getPolymarketApiCreds() {
  return cachedCreds;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundAmount(value, digits = 6) {
  return Number(asNumber(value).toFixed(digits));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function uniqueStrings(values = []) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function isOpenOrderStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("open") ||
    normalized.includes("live") ||
    normalized.includes("pending") ||
    normalized.includes("active") ||
    normalized.includes("partial")
  );
}

function resolveTrackedOrder(orderId, directOrder, openOrders = []) {
  const directId = directOrder?.id || directOrder?.orderID || null;
  if (orderId && directId && String(directId) === String(orderId)) {
    return directOrder;
  }

  return (openOrders || []).find(order => {
    const candidateId = order?.id || order?.orderID || null;
    return candidateId && orderId && String(candidateId) === String(orderId);
  }) || null;
}

function summarizeMatchedTrades(trades = [], orderId) {
  const relevantTrades = (trades || []).filter(trade => {
    if (!trade) return false;
    if (!orderId) return false;
    if (String(trade.taker_order_id || "") === String(orderId)) return true;
    if (Array.isArray(trade.maker_orders)) {
      return trade.maker_orders.some(order => String(order?.order_id || "") === String(orderId));
    }
    return false;
  });

  const txHashes = [];
  let filledShares = 0;
  let filledUsd = 0;

  for (const trade of relevantTrades) {
    const size = asNumber(trade?.size);
    const price = asNumber(trade?.price);
    if (size <= 0 || price <= 0) continue;
    filledShares += size;
    filledUsd += (size * price);
    if (trade?.transaction_hash) {
      txHashes.push(trade.transaction_hash);
    }
  }

  return {
    count: relevantTrades.length,
    filledShares: roundAmount(filledShares),
    filledUsd: roundAmount(filledUsd),
    avgPrice: filledShares > 0 ? roundAmount(filledUsd / filledShares) : null,
    txHashes: uniqueStrings(txHashes),
  };
}

function parseBaseUnitValue(value) {
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^-?\d+$/.test(raw)) return asNumber(raw);
  return asNumber(raw) * TOKEN_SCALE;
}

function parseMaxAllowance(raw) {
  let maxAllowance = parseBaseUnitValue(raw?.allowance);
  if (raw?.allowances && typeof raw.allowances === "object") {
    for (const allowanceValue of Object.values(raw.allowances)) {
      const parsed = parseBaseUnitValue(allowanceValue);
      if (parsed > maxAllowance) maxAllowance = parsed;
    }
  }
  return maxAllowance;
}

function normalizeUsdcAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("USDC amount must be a positive number");
  }
  return Number(parsed.toFixed(6));
}

function gweiToWei(gwei) {
  return utils.parseUnits(Number(gwei).toString(), "gwei");
}

async function buildPolygonFeeOverrides(provider) {
  const feeData = await provider.getFeeData();
  const minPriorityGwei = getNumberEnv("POLYGON_MIN_PRIORITY_FEE_GWEI", DEFAULT_MIN_PRIORITY_GWEI);
  const minMaxFeeGwei = getNumberEnv("POLYGON_MIN_MAX_FEE_GWEI", DEFAULT_MIN_MAX_FEE_GWEI);
  const maxFeeCapGwei = getNumberEnv("POLYGON_MAX_FEE_CAP_GWEI", DEFAULT_MAX_FEE_CAP_GWEI);

  const minPriorityWei = gweiToWei(minPriorityGwei);
  const minMaxFeeWei = gweiToWei(minMaxFeeGwei);
  const maxFeeCapWei = gweiToWei(maxFeeCapGwei);

  let maxPriorityFeePerGas = feeData?.maxPriorityFeePerGas || minPriorityWei;
  if (maxPriorityFeePerGas.lt(minPriorityWei)) {
    maxPriorityFeePerGas = minPriorityWei;
  }

  let maxFeePerGas = feeData?.maxFeePerGas || feeData?.gasPrice || minMaxFeeWei;
  if (maxFeePerGas.lt(minMaxFeeWei)) {
    maxFeePerGas = minMaxFeeWei;
  }
  if (maxFeePerGas.lte(maxPriorityFeePerGas)) {
    maxFeePerGas = maxPriorityFeePerGas.mul(2);
  }
  if (maxFeePerGas.gt(maxFeeCapWei)) {
    maxFeePerGas = maxFeeCapWei;
  }

  return { maxPriorityFeePerGas, maxFeePerGas };
}

export function getTradingWalletAddress() {
  const config = resolveTradingConfig();
  if (!config.enabled) return null;
  return config.signer.address;
}

export async function getLiveWalletSnapshot({ force = false } = {}) {
  const config = resolveTradingConfig();
  if (!config.enabled) return null;

  const ttlMs = getNumberEnv("WALLET_SNAPSHOT_TTL_MS", 15000);
  const now = Date.now();
  if (!force && walletSnapshotCache.data && (now - walletSnapshotCache.ts) < ttlMs) {
    return walletSnapshotCache.data;
  }

  try {
    const client = await initPolymarketClient();
    const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const usdcBalanceBase = parseBaseUnitValue(collateral?.balance);
    const usdcAllowanceBase = parseMaxAllowance(collateral);

    const provider = new providers.JsonRpcProvider(config.polygonRpcUrl);
    const polBalance = asNumber(utils.formatEther(await provider.getBalance(config.signer.address)));

    const usdcContract = new Contract(
      config.usdcAddress,
      USDC_ABI,
      provider
    );
    const usdcOnChainRaw = await usdcContract.balanceOf(config.signer.address);
    const usdcOnChain = asNumber(utils.formatUnits(usdcOnChainRaw, 6));

    const snapshot = {
      address: config.signer.address,
      usdcBalance: parseFloat((usdcOnChain || (usdcBalanceBase / TOKEN_SCALE)).toFixed(6)),
      usdcBalanceClob: parseFloat((usdcBalanceBase / TOKEN_SCALE).toFixed(6)),
      usdcAllowance: parseFloat((usdcAllowanceBase / TOKEN_SCALE).toFixed(6)),
      usdcAllowanceReady: usdcAllowanceBase >= TOKEN_SCALE,
      polBalance: parseFloat(polBalance.toFixed(6)),
      updatedAt: new Date().toISOString(),
    };
    walletSnapshotCache = { ts: now, data: snapshot };
    return snapshot;
  } catch (err) {
    if (walletSnapshotCache.data) return walletSnapshotCache.data;
    throw err;
  }
}

export async function getOrderBookSnapshot(tokenId) {
  if (!tokenId) return null;
  const host = getEnv("POLYMARKET_HOST", DEFAULT_HOST).replace(/\/+$/, "");

  try {
    const res = await fetch(`${host}/book?token_id=${encodeURIComponent(tokenId)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const book = await res.json();

    const rawBids = Array.isArray(book?.bids) ? book.bids : [];
    const rawAsks = Array.isArray(book?.asks) ? book.asks : [];

    const bids = rawBids
      .map(b => ({ price: asNumber(b?.price), size: asNumber(b?.size) }))
      .filter(b => b.price > 0 && b.price < 1 && b.size > 0)
      .sort((a, b) => b.price - a.price);

    const asks = rawAsks
      .map(a => ({ price: asNumber(a?.price), size: asNumber(a?.size) }))
      .filter(a => a.price > 0 && a.price < 1 && a.size > 0)
      .sort((a, b) => a.price - b.price);

    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;
    const midPrice = (bestBid !== null && bestAsk !== null)
      ? roundAmount((bestBid + bestAsk) / 2, 4)
      : (bestAsk ?? bestBid ?? null);

    const spreadAbs = (bestBid !== null && bestAsk !== null && bestAsk >= bestBid)
      ? roundAmount(bestAsk - bestBid, 4)
      : null;
    const spreadPct = (spreadAbs !== null && bestAsk > 0)
      ? roundAmount((spreadAbs / bestAsk) * 100, 2)
      : null;

    // Calculate executable USD liquidity within 2 cents of top-of-book
    const askDepthUsd = bestAsk !== null
      ? roundAmount(
          asks
            .filter(a => a.price <= bestAsk + 0.02)
            .reduce((sum, a) => sum + (a.price * a.size), 0),
          2
        )
      : 0;

    const bidDepthUsd = bestBid !== null
      ? roundAmount(
          bids
            .filter(b => b.price >= bestBid - 0.02)
            .reduce((sum, b) => sum + (b.price * b.size), 0),
          2
        )
      : 0;

    const totalDepthUsd = bidDepthUsd + askDepthUsd;
    const obi = totalDepthUsd > 0
      ? roundAmount((bidDepthUsd - askDepthUsd) / totalDepthUsd, 3)
      : 0;
    const microPrice = (bestBid !== null && bestAsk !== null && totalDepthUsd > 0)
      ? roundAmount(((bestBid * askDepthUsd) + (bestAsk * bidDepthUsd)) / totalDepthUsd, 4)
      : midPrice;
    const isValid = (
      bestBid !== null &&
      bestAsk !== null &&
      bestAsk >= bestBid &&
      spreadAbs !== null &&
      spreadPct !== null
    );

    return {
      isValid,
      tokenId: String(tokenId),
      bestBid,
      bestAsk,
      midPrice,
      microPrice,
      spreadAbs,
      spreadPct,
      askDepthUsd,
      bidDepthUsd,
      obi,
      tickSize: asNumber(book?.minimum_tick_size) || 0.01,
      minOrderSize: asNumber(book?.min_order_size) || 1,
      negRisk: Boolean(book?.neg_risk),
    };
  } catch {
    return null;
  }
}

export async function getMarketTradeFlow(conditionId) {
  if (!conditionId) return null;
  try {
    const url = `https://data-api.polymarket.com/trades?market=${encodeURIComponent(conditionId)}&limit=40`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const trades = await res.json();
    if (!Array.isArray(trades) || trades.length === 0) return null;

    let yesBullUsd = 0;
    let noBullUsd = 0;
    let whaleYesCount = 0;
    let whaleNoCount = 0;

    for (const t of trades) {
      const side = String(t?.side || "").toUpperCase();
      const outcome = String(t?.outcome || "").toUpperCase();
      const size = asNumber(t?.size);
      const price = asNumber(t?.price);
      if (size <= 0 || price <= 0 || price >= 1) continue;
      const usdVal = size * price;

      // Buying YES or Selling NO = bullish on YES
      const isYesBullish = (outcome === "YES" && side === "BUY") || (outcome === "NO" && side === "SELL");
      const isNoBullish = (outcome === "NO" && side === "BUY") || (outcome === "YES" && side === "SELL");

      if (isYesBullish) {
        yesBullUsd += usdVal;
        if (usdVal >= 100) whaleYesCount++;
      } else if (isNoBullish) {
        noBullUsd += usdVal;
        if (usdVal >= 100) whaleNoCount++;
      }
    }

    const totalFlowUsd = yesBullUsd + noBullUsd;
    const tapeImbalance = totalFlowUsd > 0
      ? roundAmount((yesBullUsd - noBullUsd) / totalFlowUsd, 3)
      : 0;

    return {
      sampleCount: trades.length,
      yesBullUsd: roundAmount(yesBullUsd, 2),
      noBullUsd: roundAmount(noBullUsd, 2),
      whaleYesCount,
      whaleNoCount,
      tapeImbalance,
    };
  } catch {
    return null;
  }
}

export async function getTokenSellPrice(tokenId) {
  if (!tokenId) return null;

  // 1. Primary source (works in BOTH simulation and real trading): real CLOB bestBid
  const book = await getOrderBookSnapshot(tokenId);
  if (book && Number.isFinite(book.bestBid) && book.bestBid > 0.001 && book.bestBid < 0.999) {
    return book.bestBid;
  }

  // 2. Fallback to public CLOB price endpoint
  const host = getEnv("POLYMARKET_HOST", DEFAULT_HOST).replace(/\/+$/, "");
  try {
    const res = await fetch(`${host}/price?token_id=${encodeURIComponent(tokenId)}&side=sell`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      const price = readProbabilityPrice(data);
      if (price !== null) return price;
    }
  } catch {
    // Fallback below.
  }

  // 3. Fallback to authenticated client if real trading is enabled
  const client = await initPolymarketClient();
  if (!client) return book?.midPrice ?? null;

  try {
    const raw = await client.getPrice(tokenId, "sell");
    const price = readProbabilityPrice(raw);
    if (price !== null) return price;
  } catch {
    // Fallback below.
  }

  try {
    const raw = await client.getLastTradePrice(tokenId);
    const price = readProbabilityPrice(raw);
    return price;
  } catch {
    return null;
  }
}

export async function getConditionalTokenSnapshot(tokenId) {
  if (!tokenId) return null;
  const client = await initPolymarketClient();
  if (!client) return null;

  const raw = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  });
  const balanceBase = parseBaseUnitValue(raw?.balance);
  const allowanceBase = parseMaxAllowance(raw);

  return {
    tokenId,
    balance: roundAmount(balanceBase / TOKEN_SCALE),
    allowance: roundAmount(allowanceBase / TOKEN_SCALE),
    allowanceReady: allowanceBase >= TOKEN_SCALE,
  };
}

export async function reconcileMarketOrder({
  orderId,
  tokenId,
  fallbackPrice = null,
  fallbackShares = 0,
  fallbackUsd = 0,
  fallbackTxHashes = [],
  retries = 3,
  delayMs = 1200,
} = {}) {
  const client = await initPolymarketClient();
  if (!client) {
    return {
      orderStatus: null,
      isOpen: false,
      filledShares: roundAmount(fallbackShares),
      filledUsd: roundAmount(fallbackUsd),
      avgPrice: Number.isFinite(fallbackPrice) ? roundAmount(fallbackPrice) : null,
      txHashes: uniqueStrings(fallbackTxHashes),
      matchedTrades: 0,
      openOrder: null,
    };
  }

  let directOrder = null;
  let openOrder = null;
  let matched = { count: 0, filledShares: 0, filledUsd: 0, avgPrice: null, txHashes: [] };

  for (let attempt = 0; attempt < retries; attempt++) {
    if (orderId) {
      try {
        directOrder = await client.getOrder(orderId);
      } catch {
        directOrder = null;
      }
    }

    let openOrders = [];
    if (tokenId) {
      try {
        openOrders = await client.getOpenOrders({ asset_id: tokenId }, true);
      } catch {
        openOrders = [];
      }
    }
    openOrder = resolveTrackedOrder(orderId, directOrder, openOrders);

    let trades = [];
    if (tokenId) {
      try {
        trades = await client.getTrades({ asset_id: tokenId }, true);
      } catch {
        trades = [];
      }
    }
    matched = summarizeMatchedTrades(trades, orderId);

    const matchedShares = matched.filledShares > 0;
    const partialFromOrder = asNumber(openOrder?.size_matched) > 0;
    if (matchedShares || partialFromOrder || openOrder || attempt === retries - 1) {
      break;
    }
    await sleep(delayMs);
  }

  let filledShares = matched.filledShares;
  let filledUsd = matched.filledUsd;
  let avgPrice = matched.avgPrice;

  if (filledShares <= 0 && asNumber(openOrder?.size_matched) > 0) {
    filledShares = roundAmount(openOrder.size_matched);
    const orderPrice = asNumber(openOrder?.price);
    avgPrice = orderPrice > 0 ? roundAmount(orderPrice) : (Number.isFinite(fallbackPrice) ? roundAmount(fallbackPrice) : null);
    filledUsd = avgPrice ? roundAmount(filledShares * avgPrice) : 0;
  }

  if (filledShares <= 0 && asNumber(fallbackShares) > 0) {
    filledShares = roundAmount(fallbackShares);
  }
  if (filledUsd <= 0 && asNumber(fallbackUsd) > 0) {
    filledUsd = roundAmount(fallbackUsd);
  }
  if (!avgPrice && filledShares > 0 && filledUsd > 0) {
    avgPrice = roundAmount(filledUsd / filledShares);
  }
  if (!avgPrice && Number.isFinite(fallbackPrice)) {
    avgPrice = roundAmount(fallbackPrice);
  }

  const isOpen = isOpenOrderStatus(openOrder?.status);
  const orderStatus = openOrder?.status || (filledShares > 0 ? "matched" : null);

  return {
    orderStatus,
    isOpen,
    filledShares,
    filledUsd,
    avgPrice,
    txHashes: uniqueStrings([...(matched.txHashes || []), ...(fallbackTxHashes || [])]),
    matchedTrades: matched.count,
    openOrder,
  };
}

export async function transferUsdc({ to, amountUsdc }) {
  const config = resolveTradingConfig();
  if (!config.enabled) {
    throw new Error("Real trading is disabled.");
  }
  if (!utils.isAddress(to)) {
    throw new Error(`Invalid destination address: ${to}`);
  }

  const normalizedAmount = normalizeUsdcAmount(amountUsdc);
  const provider = new providers.JsonRpcProvider(config.polygonRpcUrl);
  const signer = config.signer.connect(provider);
  const usdcContract = new Contract(config.usdcAddress, USDC_ABI, signer);
  const transferUnits = utils.parseUnits(normalizedAmount.toFixed(6), 6);
  const signerAddress = await signer.getAddress();
  const currentBalance = await usdcContract.balanceOf(signerAddress);

  if (currentBalance.lt(transferUnits)) {
    throw new Error(
      `Insufficient USDC for transfer. Required=${normalizedAmount.toFixed(6)} Available=${utils.formatUnits(currentBalance, 6)}`
    );
  }

  const feeOverrides = await buildPolygonFeeOverrides(provider);
  const gasEstimate = await usdcContract.estimateGas.transfer(to, transferUnits);
  const gasLimit = gasEstimate.mul(120).div(100); // 20% buffer for reliability.

  const tx = await usdcContract.transfer(to, transferUnits, {
    ...feeOverrides,
    gasLimit,
  });
  const receipt = await tx.wait(1);
  walletSnapshotCache = { ts: 0, data: null };

  return {
    txHash: tx.hash,
    blockNumber: receipt?.blockNumber || null,
    from: signerAddress,
    to,
    amountUsdc: normalizedAmount,
  };
}
