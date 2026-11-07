-- Strategy v3.0.0-crypto-oracle telemetry, MFE/MAE excursion tracking, and decision_log audit table.
-- Safe to run multiple times (idempotent).

ALTER TABLE IF EXISTS public.user_trades
  ADD COLUMN IF NOT EXISTS strategy_version text DEFAULT 'v3.0.0-crypto-oracle',
  ADD COLUMN IF NOT EXISTS mfe_price numeric,
  ADD COLUMN IF NOT EXISTS mae_price numeric,
  ADD COLUMN IF NOT EXISTS entry_fee_usd numeric,
  ADD COLUMN IF NOT EXISTS exit_fee_usd numeric,
  ADD COLUMN IF NOT EXISTS fee_rate_bps numeric;

ALTER TABLE IF EXISTS public.ai_signals
  ADD COLUMN IF NOT EXISTS strategy_version text DEFAULT 'v3.0.0-crypto-oracle';

CREATE TABLE IF NOT EXISTS public.decision_log (
  decision_id text PRIMARY KEY,
  market_id text,
  condition_id text,
  question text,
  category text,
  strategy_version text NOT NULL DEFAULT 'v3.0.0-crypto-oracle',
  action text NOT NULL,
  considered_side text,
  skip_reason text,
  yes_bid numeric,
  yes_ask numeric,
  no_bid numeric,
  no_ask numeric,
  spread_pct numeric,
  w_obi numeric,
  eti_imbalance numeric,
  spot_price numeric,
  target_price numeric,
  math_yes_prob numeric,
  fair_prob numeric,
  net_edge_pct numeric,
  fee_rate_bps numeric,
  confidence numeric,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_log_evaluated_at
  ON public.decision_log(evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_log_strategy_action
  ON public.decision_log(strategy_version, action, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_trades_strategy_version
  ON public.user_trades(strategy_version, executed_at DESC);

