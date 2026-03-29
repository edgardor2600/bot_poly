import { AssetType, OrderType, Side } from "@polymarket/clob-client";
import { initPolymarketClient, reconcileMarketOrder } from "./polymarketClient.js";

const TOKEN_SCALE = 1_000_000;

function asNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function toBaseUnits(value) {
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;

  // Polymarket often returns integer strings already in base units (6 decimals).
  if (/^-?\d+$/.test(raw)) {
    const integerValue = asNumber(raw);
    if (integerValue >= 100000) return integerValue;
    // Fallback for providers that may return whole-token integers.
    return integerValue * TOKEN_SCALE;
  }

  // Decimal strings are treated as whole-token values.
  return asNumber(raw) * TOKEN_SCALE;
}

function baseUnitsToDisplay(value) {
  const normalized = asNumber(value) / TOKEN_SCALE;
  if (!Number.isFinite(normalized)) return "0";
  return normalized.toFixed(6);
}

function parseBalanceAndAllowance(raw) {
  const balanceBase = toBaseUnits(raw?.balance);
  const directAllowanceBase = toBaseUnits(raw?.allowance);

  let mappedAllowanceBase = 0;
  const allowanceMap = {};
  if (raw?.allowances && typeof raw.allowances === "object") {
    for (const [spender, allowanceValue] of Object.entries(raw.allowances)) {
      const parsed = toBaseUnits(allowanceValue);
      allowanceMap[spender] = parsed;
      if (parsed > mappedAllowanceBase) mappedAllowanceBase = parsed;
    }
  }

  return {
    balanceBase,
    allowanceBase: Math.max(directAllowanceBase, mappedAllowanceBase),
    allowanceMap,
  };
}

function formatAllowanceMap(allowanceMap) {
  const entries = Object.entries(allowanceMap || {});
  if (!entries.length) return "none";
  return entries
    .map(([spender, allowance]) => `${spender}: ${baseUnitsToDisplay(allowance)}`)
    .join(" | ");
}

function ensureOrderSuccess(response, label) {
  if (!response) {
    throw new Error(`${label} response is empty`);
  }
  if (response.error || response.errorMsg) {
    const msg = response.errorMsg || response.error || "unknown error";
    throw new Error(`${label} failed: ${msg}`);
  }
  if (response.success === false) {
    throw new Error(`${label} failed: success=false`);
  }
}

function ensureFilled({ usd, shares, label }) {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`${label} returned no filled USDC amount`);
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error(`${label} returned no filled shares`);
  }
}

function pickBuyFillAmounts(rawMaking, rawTaking, amountUsdc, sharesRequested) {
  const making = asNumber(rawMaking);
  const taking = asNumber(rawTaking);
  if (making <= 0 && taking <= 0) {
    return { filledUsd: amountUsdc, filledShares: sharesRequested };
  }
  if (making > 0 && taking <= 0) {
    return { filledUsd: amountUsdc, filledShares: making };
  }
  if (taking > 0 && making <= 0) {
    return { filledUsd: taking, filledShares: sharesRequested };
  }

  // In Polymarket market BUY responses, fields may appear swapped depending on side internals.
  const makingUsdDistance = Math.abs(making - amountUsdc);
  const takingUsdDistance = Math.abs(taking - amountUsdc);
  if (takingUsdDistance <= makingUsdDistance) {
    return { filledUsd: taking, filledShares: making };
  }
  return { filledUsd: making, filledShares: taking };
}

function pickSellFillAmounts(rawMaking, rawTaking, requestedShares) {
  const making = asNumber(rawMaking);
  const taking = asNumber(rawTaking);
  if (making <= 0 && taking <= 0) {
    return { soldShares: requestedShares, proceedsUsdc: 0 };
  }
  if (making > 0 && taking <= 0) {
    return { soldShares: making, proceedsUsdc: 0 };
  }
  if (taking > 0 && making <= 0) {
    return { soldShares: requestedShares, proceedsUsdc: taking };
  }

  const makingShareDistance = Math.abs(making - requestedShares);
  const takingShareDistance = Math.abs(taking - requestedShares);
  if (makingShareDistance <= takingShareDistance) {
    return { soldShares: making, proceedsUsdc: taking };
  }
  return { soldShares: taking, proceedsUsdc: making };
}

export async function executeBuyOrder({ market, analysis, pre, amountUsdc }) {
  const client = await initPolymarketClient();
  if (!client) {
    throw new Error("Real trading is disabled.");
  }

  const isYes = analysis.action === "BUY_YES";
  const tokenId = isYes ? market._yesTokenId : market._noTokenId;
  const entryPrice = isYes ? pre.yesP : pre.noP;

  if (!tokenId) {
    throw new Error(`Missing tokenID for action ${analysis.action}`);
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`Invalid entry price for action ${analysis.action}`);
  }

  const requiredBase = toBaseUnits(amountUsdc);
  const balanceAllowance = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const parsedBalanceAllowance = parseBalanceAndAllowance(balanceAllowance);
  if (parsedBalanceAllowance.balanceBase < requiredBase) {
    throw new Error(
      `Insufficient USDC balance. Required=${amountUsdc}, available=${baseUnitsToDisplay(parsedBalanceAllowance.balanceBase)}`
    );
  }

  if (parsedBalanceAllowance.allowanceBase < requiredBase) {
    console.log("[TRADE] Sending USDC allowance approval to Polygon... waiting 18s for confirmation.");
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    // Wait for Polygon to mine the approval transaction before rechecking.
    await new Promise(resolve => setTimeout(resolve, 18000));
    const updated = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const parsedUpdated = parseBalanceAndAllowance(updated);
    if (parsedUpdated.allowanceBase < requiredBase) {
      // Allowance tx was sent, Polygon may still be propagating. Proceed optimistically.
      console.warn(
        `[TRADE] WARN: allowance still below required after wait. ` +
        `required=${baseUnitsToDisplay(requiredBase)}, current=${baseUnitsToDisplay(parsedUpdated.allowanceBase)} ` +
        `map=${formatAllowanceMap(parsedUpdated.allowanceMap)}`
      );
    }
  }

  const sharesRequested = parseFloat((amountUsdc / entryPrice).toFixed(6));
  // Add 5% slippage tolerance so FAK orders can fill in thin order books.
  // Capped at 0.97 to avoid paying near-certain prices.
  const priceWithSlippage = parseFloat(Math.min(entryPrice * 1.05, 0.97).toFixed(4));
  console.log(`[TRADE] BUY ${tokenId.slice(0, 10)}... price=${entryPrice} -> with_slippage=${priceWithSlippage} amount=$${amountUsdc}`);
  const marketOrderResponse = await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      price: priceWithSlippage,
      amount: amountUsdc,
      side: Side.BUY,
    },
    undefined,
    OrderType.FAK
  );
  ensureOrderSuccess(marketOrderResponse, "BUY market order");

  const { filledUsd, filledShares } = pickBuyFillAmounts(
    marketOrderResponse?.makingAmount,
    marketOrderResponse?.takingAmount,
    amountUsdc,
    sharesRequested
  );
  let finalFilledUsd = filledUsd;
  let finalFilledShares = filledShares;
  let executedPrice = filledShares > 0 ? filledUsd / filledShares : entryPrice;

  try {
    const reconciled = await reconcileMarketOrder({
      orderId: marketOrderResponse?.orderID || marketOrderResponse?.id || null,
      tokenId,
      fallbackPrice: executedPrice,
      fallbackShares: filledShares,
      fallbackUsd: filledUsd,
      fallbackTxHashes: marketOrderResponse?.transactionsHashes || [],
    });
    finalFilledUsd = reconciled.filledUsd || finalFilledUsd;
    finalFilledShares = reconciled.filledShares || finalFilledShares;
    executedPrice = reconciled.avgPrice || executedPrice;
    marketOrderResponse.status = reconciled.orderStatus || marketOrderResponse?.status || null;
    marketOrderResponse.transactionsHashes = reconciled.txHashes?.length
      ? reconciled.txHashes
      : (marketOrderResponse?.transactionsHashes || []);
  } catch (reconcileErr) {
    console.warn(`[TRADE] WARN: buy reconciliation failed for ${tokenId.slice(0, 10)}... -> ${reconcileErr.message}`);
  }

  ensureFilled({ usd: finalFilledUsd, shares: finalFilledShares, label: "BUY market order" });
  // Sanity: price must be a valid probability between 0.01 and 0.99
  if (!Number.isFinite(executedPrice) || executedPrice <= 0.01 || executedPrice >= 0.99) {
    executedPrice = entryPrice;
  }

  return {
    tokenId,
    entryPrice: parseFloat(executedPrice.toFixed(6)),
    shares: parseFloat(finalFilledShares.toFixed(6)),
    amountUsdc: parseFloat(finalFilledUsd.toFixed(6)),
    orderId: marketOrderResponse?.orderID || marketOrderResponse?.id || null,
    orderStatus: marketOrderResponse?.status || null,
    txHashes: marketOrderResponse?.transactionsHashes || [],
    raw: marketOrderResponse,
  };
}

export async function executeSellOrder({ tokenId, shares, expectedPrice }) {
  const client = await initPolymarketClient();
  if (!client) {
    throw new Error("Real trading is disabled.");
  }
  if (!tokenId) {
    throw new Error("Missing tokenId for SELL");
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error("Invalid share size for SELL");
  }

  const requiredSharesBase = toBaseUnits(shares);
  const balanceAllowance = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  });
  const parsedBalanceAllowance = parseBalanceAndAllowance(balanceAllowance);

  if (parsedBalanceAllowance.balanceBase < requiredSharesBase) {
    throw new Error(
      `Insufficient token balance. Required=${shares}, available=${baseUnitsToDisplay(parsedBalanceAllowance.balanceBase)}`
    );
  }

  if (parsedBalanceAllowance.allowanceBase < requiredSharesBase) {
    console.log("[TRADE] Sending conditional token approval to Polygon... waiting 18s for confirmation.");
    await client.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    await new Promise(resolve => setTimeout(resolve, 18000));
    const updated = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    const parsedUpdated = parseBalanceAndAllowance(updated);
    if (parsedUpdated.allowanceBase < requiredSharesBase) {
      // Tx was submitted. Proceed optimistically - exchange will reject if truly not set.
      console.warn(
        `[TRADE] WARN: conditional allowance still below required after wait. ` +
        `required=${baseUnitsToDisplay(requiredSharesBase)}, current=${baseUnitsToDisplay(parsedUpdated.allowanceBase)} ` +
        `map=${formatAllowanceMap(parsedUpdated.allowanceMap)}`
      );
    }
  }

  const sellPrice = Number.isFinite(expectedPrice) && expectedPrice > 0
    ? parseFloat(Math.max(expectedPrice * 0.98, 0.01).toFixed(4))
    : expectedPrice;

  const marketOrderResponse = await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      price: sellPrice,
      amount: shares,
      side: Side.SELL,
    },
    undefined,
    OrderType.FAK
  );
  ensureOrderSuccess(marketOrderResponse, "SELL market order");

  const { soldShares, proceedsUsdc } = pickSellFillAmounts(
    marketOrderResponse?.makingAmount,
    marketOrderResponse?.takingAmount,
    shares
  );
  let finalSoldShares = soldShares;
  let proceeds = proceedsUsdc;
  let executedPrice = soldShares > 0 ? proceeds / soldShares : (sellPrice || expectedPrice || 0);

  try {
    const reconciled = await reconcileMarketOrder({
      orderId: marketOrderResponse?.orderID || marketOrderResponse?.id || null,
      tokenId,
      fallbackPrice: executedPrice,
      fallbackShares: soldShares,
      fallbackUsd: proceedsUsdc,
      fallbackTxHashes: marketOrderResponse?.transactionsHashes || [],
    });
    finalSoldShares = reconciled.filledShares || finalSoldShares;
    proceeds = reconciled.filledUsd || proceeds;
    executedPrice = reconciled.avgPrice || executedPrice;
    marketOrderResponse.status = reconciled.orderStatus || marketOrderResponse?.status || null;
    marketOrderResponse.transactionsHashes = reconciled.txHashes?.length
      ? reconciled.txHashes
      : (marketOrderResponse?.transactionsHashes || []);
  } catch (reconcileErr) {
    console.warn(`[TRADE] WARN: sell reconciliation failed for ${tokenId.slice(0, 10)}... -> ${reconcileErr.message}`);
  }

  ensureFilled({ usd: proceeds, shares: finalSoldShares, label: "SELL market order" });
  executedPrice = finalSoldShares > 0 ? proceeds / finalSoldShares : executedPrice;

  return {
    proceedsUsdc: parseFloat((proceeds || finalSoldShares * (sellPrice || expectedPrice || 0)).toFixed(6)),
    soldShares: parseFloat(finalSoldShares.toFixed(6)),
    exitPrice: parseFloat(executedPrice.toFixed(6)),
    orderId: marketOrderResponse?.orderID || marketOrderResponse?.id || null,
    orderStatus: marketOrderResponse?.status || null,
    txHashes: marketOrderResponse?.transactionsHashes || [],
    raw: marketOrderResponse,
  };
}
