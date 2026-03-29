import { AssetType } from "@polymarket/clob-client";
import dotenv from "dotenv";
import { initPolymarketClient } from "./polymarketClient.js";
dotenv.config();

const TOKEN_SCALE = 1_000_000;

function toBaseUnits(value) {
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return parsed * TOKEN_SCALE;
}

function display(baseUnits) {
  return (Number(baseUnits) / TOKEN_SCALE).toFixed(6);
}

function parseAllowance(raw) {
  let max = toBaseUnits(raw?.allowance);
  const mapped = {};
  if (raw?.allowances && typeof raw.allowances === "object") {
    for (const [spender, value] of Object.entries(raw.allowances)) {
      const parsed = toBaseUnits(value);
      mapped[spender] = parsed;
      if (parsed > max) max = parsed;
    }
  }
  return { max, mapped };
}

async function run() {
  console.log("Checking allowance...");
  const c = await initPolymarketClient();
  if (!c) {
    throw new Error("REAL_TRADING_ENABLED=false en .env");
  }

  const bal = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const allowance = parseAllowance(bal);
  console.log("Current balance raw:", bal);
  console.log("USDC balance:", display(toBaseUnits(bal.balance)));
  console.log("Best allowance:", display(allowance.max));
  console.log("Allowance map:", allowance.mapped);

  if (allowance.max < TOKEN_SCALE) {
    console.log("Sending allowance transaction...");
    try {
      const tx = await c.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      console.log("Tx sent:", tx);
    } catch (e) {
      console.error("Failed to send tx:", e);
    }
  } else {
    console.log("Allowance is already sufficient.");
  }
}
run();
