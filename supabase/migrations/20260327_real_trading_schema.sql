-- Real trading schema extensions for PolyBot
-- Safe to run multiple times (creates base tables if starting from a fresh database).

CREATE TABLE IF NOT EXISTS public.user_trades (
  trade_id text PRIMARY KEY,
  signal_id text,
  market_id text,
  condition_id text,
  token_id text,
  question text,
  side text,
  entry_price numeric,
  current_price numeric,
  shares numeric,
  cost numeric,
  status text,
  execution_mode text DEFAULT 'SIMULATED',
  pnl numeric DEFAULT 0,
  stop_loss numeric,
  take_profit numeric,
  break_even_armed boolean DEFAULT false,
  max_hold_at timestamptz,
  buy_order_id text,
  buy_order_status text,
  buy_tx_hashes text,
  sell_order_id text,
  sell_order_status text,
  sell_tx_hashes text,
  close_reason text,
  executed_at timestamptz DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.ai_signals (
  signal_id text PRIMARY KEY,
  market_id text,
  condition_id text,
  yes_token_id text,
  no_token_id text,
  question text,
  action text,
  score numeric,
  confidence numeric,
  edge_pct numeric,
  yes_price numeric,
  no_price numeric,
  news_found text,
  reasoning text,
  detected_at timestamptz DEFAULT now()
);

ALTER TABLE IF EXISTS public.user_trades
  ADD COLUMN IF NOT EXISTS condition_id text,
  ADD COLUMN IF NOT EXISTS token_id text,
  ADD COLUMN IF NOT EXISTS execution_mode text,
  ADD COLUMN IF NOT EXISTS buy_order_id text,
  ADD COLUMN IF NOT EXISTS buy_order_status text,
  ADD COLUMN IF NOT EXISTS buy_tx_hashes text,
  ADD COLUMN IF NOT EXISTS sell_order_id text,
  ADD COLUMN IF NOT EXISTS sell_order_status text,
  ADD COLUMN IF NOT EXISTS sell_tx_hashes text,
  ADD COLUMN IF NOT EXISTS close_reason text,
  ADD COLUMN IF NOT EXISTS pnl numeric,
  ADD COLUMN IF NOT EXISTS current_price numeric,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE IF EXISTS public.ai_signals
  ADD COLUMN IF NOT EXISTS condition_id text,
  ADD COLUMN IF NOT EXISTS yes_token_id text,
  ADD COLUMN IF NOT EXISTS no_token_id text;

CREATE TABLE IF NOT EXISTS public.order_events (
  id bigserial PRIMARY KEY,
  trade_id text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_trade_id ON public.order_events(trade_id);
CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON public.order_events(created_at DESC);
