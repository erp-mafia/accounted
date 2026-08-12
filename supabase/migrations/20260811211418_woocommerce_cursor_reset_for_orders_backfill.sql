-- One-time cursor reset for active WooCommerce connections.
--
-- The Orders switch-over replaced the transactions feed with webshop_orders
-- rows, and the overlap with already-imported feed rows is handled by
-- cross-marking (legacy_transaction_id). But the sync only lists orders
-- modified after cursor - 24h, and the 90-day backfill only runs when the
-- cursor is NULL: connections that synced under the old feed would never
-- re-list their existing orders, so those orders would never become
-- webshop_orders rows and the promised cross-marks would never happen.
--
-- Resetting the cursor makes the next run re-fetch the last 90 days as a
-- backfill. Idempotent by design: upsert on (company_id, external_id) turns
-- re-seen orders into no-ops, and rows that also exist in the transactions
-- feed get cross-marked instead of double-imported.
--
-- Guarded: environments that never received the WooCommerce extension's
-- table (e.g. drifted dev databases) skip the reset.

do $$
begin
  if to_regclass('public.woocommerce_connections') is not null then
    update public.woocommerce_connections
      set last_order_synced_at = null
      where status = 'active';
  end if;
end $$;
