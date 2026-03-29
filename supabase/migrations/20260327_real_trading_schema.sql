-- Real trading schema extensions for PolyBot
-- Safe to run multiple times.

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
