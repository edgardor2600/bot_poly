-- Trade management upgrades:
-- 1) Persist dynamic SL/TP + break-even + max-hold for robust restart behavior.
-- 2) Improve querying of system-level events (auto-withdrawal history).

ALTER TABLE IF EXISTS public.user_trades
  ADD COLUMN IF NOT EXISTS stop_loss numeric,
  ADD COLUMN IF NOT EXISTS take_profit numeric,
  ADD COLUMN IF NOT EXISTS break_even_armed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_hold_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_trades_status_max_hold_at
  ON public.user_trades(status, max_hold_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_events_trade_event_created
  ON public.order_events(trade_id, event_type, created_at DESC);
