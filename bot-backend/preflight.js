import dotenv from "dotenv";
import { AssetType } from "@polymarket/clob-client";
import { getEnv } from "./env.js";
import { initPolymarketClient } from "./polymarketClient.js";

dotenv.config();

const TOKEN_SCALE = 1_000_000;

function mask(value) {
  if (!value) return "MISSING";
  return "SET";
}

function checkRequired(name) {
  const value = getEnv(name);
  const ok = !!value;
  console.log(`${ok ? "OK  " : "MISS"} ${name}: ${ok ? mask(value) : "MISSING"}`);
  return ok;
}

function toBaseUnits(value) {
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return parsed * TOKEN_SCALE;
}

function toDisplay(baseUnits) {
  const value = Number(baseUnits) / TOKEN_SCALE;
  if (!Number.isFinite(value)) return "0";
  if (value > 1_000_000_000) return "VERY_LARGE";
  return value.toFixed(6);
}

function parseAllowance(raw) {
  const balanceBase = toBaseUnits(raw?.balance);
  let maxAllowance = toBaseUnits(raw?.allowance);
  const map = {};

  if (raw?.allowances && typeof raw.allowances === "object") {
    for (const [spender, value] of Object.entries(raw.allowances)) {
      const parsed = toBaseUnits(value);
      map[spender] = parsed;
      if (parsed > maxAllowance) maxAllowance = parsed;
    }
  }

  return { balanceBase, maxAllowance, map };
}

async function run() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_KEY",
    "GROQ_API_KEY",
    "TAVILY_API_KEY",
    "CRON_SECRET",
  ];

  console.log("=== PolyBot Preflight ===");
  let allOk = true;
  for (const key of required) {
    allOk = checkRequired(key) && allOk;
  }

  const realTrading = getEnv("REAL_TRADING_ENABLED", "false").toLowerCase() === "true";
  console.log(`Mode REAL_TRADING_ENABLED: ${realTrading ? "true" : "false"}`);

  if (realTrading) {
    const realRequired = [
      "POLYMARKET_PRIVATE_KEY",
      "POLYMARKET_SIGNATURE_TYPE",
    ];
    for (const key of realRequired) {
      allOk = checkRequired(key) && allOk;
    }

    const funder = getEnv("POLYMARKET_FUNDER");
    if (funder) {
      console.log(`OK   POLYMARKET_FUNDER: ${mask(funder)}`);
    } else {
      console.log("WARN POLYMARKET_FUNDER: not set (will default to signer.address)");
    }

    const liveCheck = getEnv("PREFLIGHT_LIVE_CHECK", "true").toLowerCase() === "true";
    if (liveCheck) {
      try {
        const client = await initPolymarketClient();
        if (!client) {
          throw new Error("initPolymarketClient returned null");
        }

        const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const parsed = parseAllowance(collateral);
        const mapPreview = Object.entries(parsed.map)
          .map(([spender, value]) => `${spender.slice(0, 10)}...=${toDisplay(value)}`)
          .join(" | ") || "none";

        console.log(`OK   LIVE_CHECK: Polymarket auth/connectivity OK`);
        console.log(`OK   LIVE_USDC_BALANCE: ${toDisplay(parsed.balanceBase)}`);
        console.log(`OK   LIVE_USDC_ALLOWANCE_MAX: ${toDisplay(parsed.maxAllowance)}`);
        console.log(`OK   LIVE_USDC_ALLOWANCE_MAP: ${mapPreview}`);

        if (parsed.balanceBase < TOKEN_SCALE) {
          console.log("WARN LIVE_USDC_BALANCE: below $1.00, trades may fail");
        }
        if (parsed.maxAllowance < TOKEN_SCALE) {
          console.log("WARN LIVE_USDC_ALLOWANCE: below $1.00, approvals may be required");
        }
      } catch (err) {
        allOk = false;
        console.log(`MISS LIVE_CHECK: ${err.message}`);
      }
    } else {
      console.log("SKIP LIVE_CHECK: PREFLIGHT_LIVE_CHECK=false");
    }

    const autoWithdraw = getEnv("AUTO_WITHDRAW_ENABLED", "true").toLowerCase() === "true";
    console.log(`Mode AUTO_WITHDRAW_ENABLED: ${autoWithdraw ? "true" : "false"}`);
    if (autoWithdraw) {
      const target = getEnv("WITHDRAWAL_TARGET_ADDRESS");
      if (!target) {
        allOk = false;
        console.log("MISS WITHDRAWAL_TARGET_ADDRESS: required when AUTO_WITHDRAW_ENABLED=true");
      } else {
        console.log(`OK   WITHDRAWAL_TARGET_ADDRESS: ${mask(target)}`);
      }
    }
  }

  if (!allOk) {
    console.log("\nPreflight FAILED: missing variables or failed live checks.");
    process.exit(1);
  }

  console.log("\nPreflight OK.");
}

run();
