import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ACTIVE_STATUSES = ["OPEN", "PARTIAL", "PENDING_BUY", "PENDING_SELL"];

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parseMode(rawTrade) {
  if (rawTrade?.execution_mode) return rawTrade.execution_mode;
  return (
    rawTrade?.buy_order_id ||
    rawTrade?.buy_tx_hashes ||
    rawTrade?.sell_order_id ||
    rawTrade?.sell_tx_hashes ||
    rawTrade?.token_id
  ) ? "REAL" : "SIMULATED";
}

async function columnExists(table, column) {
  const { error } = await supabase.from(table).select(column).limit(1);
  return {
    exists: !error,
    error: error?.message || null,
  };
}

async function rpcExists(name, args) {
  const { error } = await supabase.rpc(name, args);
  return {
    exists: !error,
    error: error?.message || null,
  };
}

async function auditSchema() {
  const checks = {
    user_trades: [
      "condition_id",
      "token_id",
      "execution_mode",
      "buy_order_id",
      "buy_order_status",
      "buy_tx_hashes",
      "sell_order_id",
      "sell_order_status",
      "sell_tx_hashes",
      "close_reason",
      "pnl",
      "current_price",
      "closed_at",
      "stop_loss",
      "take_profit",
      "break_even_armed",
      "max_hold_at",
    ],
    ai_signals: [
      "condition_id",
      "yes_token_id",
      "no_token_id",
    ],
    order_events: [
      "trade_id",
      "event_type",
      "payload_json",
      "created_at",
    ],
  };

  const result = {};
  for (const [table, columns] of Object.entries(checks)) {
    result[table] = {};
    for (const column of columns) {
      result[table][column] = await columnExists(table, column);
    }
  }

  result.runtimeLocks = {
    tryAcquire: await rpcExists("try_acquire_runtime_lock", {
      p_lock_name: "db-maintenance-audit",
      p_owner: "db-maintenance-audit",
      p_ttl_seconds: 30,
    }),
    release: await rpcExists("release_runtime_lock", {
      p_lock_name: "db-maintenance-audit",
      p_owner: "db-maintenance-audit",
    }),
  };

  const { count: simulatedActive } = await supabase
    .from("user_trades")
    .select("*", { count: "exact", head: true })
    .in("status", ACTIVE_STATUSES)
    .neq("execution_mode", "REAL");

  const { count: realActive } = await supabase
    .from("user_trades")
    .select("*", { count: "exact", head: true })
    .in("status", ACTIVE_STATUSES)
    .eq("execution_mode", "REAL");

  result.counts = {
    simulatedActive: simulatedActive || 0,
    realActive: realActive || 0,
  };

  console.log(JSON.stringify(result, null, 2));
}

async function cleanupSimulatedActive({ apply = false } = {}) {
  const { data, error } = await supabase
    .from("user_trades")
    .select("trade_id, status, execution_mode, question, market_id, executed_at, entry_price, current_price, pnl")
    .in("status", ACTIVE_STATUSES)
    .neq("execution_mode", "REAL")
    .order("executed_at", { ascending: false });

  if (error) throw error;

  const rows = data || [];
  const preview = rows.slice(0, 10).map(row => ({
    trade_id: row.trade_id,
    status: row.status,
    execution_mode: row.execution_mode,
    market_id: row.market_id,
    question: row.question,
  }));

  if (!apply) {
    console.log(JSON.stringify({
      apply: false,
      count: rows.length,
      preview,
    }, null, 2));
    return;
  }

  const closedAt = new Date().toISOString();
  const results = [];
  for (const row of rows) {
    const payload = {
      status: "CLOSED",
      closed_at: closedAt,
      close_reason: "CLEANUP_SIMULATED",
      pnl: Number(row?.pnl || 0),
      current_price: row?.current_price ?? row?.entry_price ?? null,
    };

    const { error: updateError } = await supabase
      .from("user_trades")
      .update(payload)
      .match({ trade_id: row.trade_id });

    if (!updateError) {
      await supabase.from("order_events").insert({
        trade_id: row.trade_id,
        event_type: "SIMULATED_TRADE_CLEANUP",
        payload_json: {
          previous_status: row.status,
          previous_execution_mode: row.execution_mode,
          closed_at: closedAt,
          reason: "CLEANUP_SIMULATED",
        },
        created_at: closedAt,
      });
    }

    results.push({
      trade_id: row.trade_id,
      ok: !updateError,
      error: updateError?.message || null,
    });
  }

  console.log(JSON.stringify({
    apply: true,
    count: rows.length,
    results,
  }, null, 2));
}

async function backfillTradeIntegrity({ apply = false } = {}) {
  const { data, error } = await supabase
    .from("user_trades")
    .select("trade_id, market_id, condition_id, token_id, execution_mode, buy_order_id, buy_tx_hashes, sell_order_id, sell_tx_hashes, current_price, entry_price")
    .order("executed_at", { ascending: false })
    .limit(1000);

  if (error) throw error;

  const rows = data || [];
  const patches = [];

  for (const row of rows) {
    const patch = {};
    if (!row.condition_id && row.market_id) {
      patch.condition_id = row.market_id;
    }

    if (!row.execution_mode) {
      patch.execution_mode = parseMode(row);
    }

    if ((row.current_price === null || row.current_price === undefined) && row.entry_price !== null && row.entry_price !== undefined) {
      patch.current_price = row.entry_price;
    }

    if (Object.keys(patch).length > 0) {
      patches.push({
        trade_id: row.trade_id,
        patch,
      });
    }
  }

  if (!apply) {
    console.log(JSON.stringify({
      apply: false,
      count: patches.length,
      preview: patches.slice(0, 20),
    }, null, 2));
    return;
  }

  const results = [];
  for (const item of patches) {
    const { error: updateError } = await supabase
      .from("user_trades")
      .update(item.patch)
      .match({ trade_id: item.trade_id });

    results.push({
      trade_id: item.trade_id,
      ok: !updateError,
      error: updateError?.message || null,
      patch: item.patch,
    });
  }

  console.log(JSON.stringify({
    apply: true,
    count: patches.length,
    results,
  }, null, 2));
}

const command = process.argv[2];

try {
  if (command === "audit-schema") {
    await auditSchema();
  } else if (command === "cleanup-simulated-active") {
    await cleanupSimulatedActive({ apply: hasFlag("--apply") });
  } else if (command === "backfill-trade-integrity") {
    await backfillTradeIntegrity({ apply: hasFlag("--apply") });
  } else {
    console.log("Usage:");
    console.log("  node dbMaintenance.js audit-schema");
    console.log("  node dbMaintenance.js cleanup-simulated-active [--apply]");
    console.log("  node dbMaintenance.js backfill-trade-integrity [--apply]");
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
