-- One live verifikat per skattekonto row, enforced by the database (#1302).
--
-- The skattekonto "Bokför" path (extensions/general/skatteverket/lib/
-- skattekonto-booking.ts) creates the verifikat through the engine with
-- source_type = 'system' and source_id = skattekonto_transactions.id, then
-- claims the row with a conditional UPDATE (journal_entry_id IS NULL). Until
-- now the only thing between two concurrent Bokför clicks and two verifikat
-- for one Skatteverket event was an application read-then-write check: both
-- requests could pass the precheck, both could insert a draft, and only the
-- claim decided a winner, leaving the loser's draft behind as an orphan.
--
-- This index makes the second draft INSERT fail (23505) before it exists.
-- Same shape as journal_entries_rot_rut_payout_live_unique (20260904021000)
-- and journal_entries_rot_rut_reclaim_live_unique (20260907160000):
--   * draft is included so the loser fails at the draft insert, not at
--     commit, and leaves nothing behind;
--   * reversed and cancelled entries fall outside the predicate, so a storno
--     or a discarded draft never blocks booking the same row again;
--   * source_id IS NULL is outside the predicate: asset disposal also writes
--     source_type 'system', with no source_id.
--
-- Scope: every source_type = 'system' writer, not only skattekonto. The two
-- writers in the codebase are the skattekonto booking (source_id = the row
-- id: one live verifikat per row by definition) and asset disposal
-- (source_id NULL). The v1 API accepts source_type 'system' with a
-- caller-chosen source_id; prod holds zero groups violating this predicate,
-- and for a system-generated entry "one live verifikat per source row" is
-- what source_id means. A dedicated 'skattekonto' source_type was rejected:
-- the immutability trigger (20240101000017) forbids rewriting source_type on
-- posted rows, so every historical skattekonto verifikat would stay 'system'
-- and every reader would have to match both values forever.
--
-- The skattekonto side is deliberately NOT indexed. A skattekonto row may be
-- MATCHED (Koppla, lib/skatteverket/skattekonto-link.ts) to an existing
-- imported or manual verifikat, and one monthly 1630 summary voucher
-- legitimately covers several Skatteverket events: prod 2026-09-20 holds 76
-- such groups (258 rows). "One skattekonto row per verifikat" is not an
-- invariant; "one live verifikat created per skattekonto row" is, and it
-- lives here.
--
-- Pre-deploy check (must return zero rows):
--   SELECT company_id, source_id, count(*) FROM public.journal_entries
--   WHERE source_type = 'system' AND source_id IS NOT NULL
--     AND status IN ('draft', 'posted')
--   GROUP BY company_id, source_id HAVING count(*) > 1;
-- pg-test: tests/pg/skattekonto-booking-invariants.pg.test.ts

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_system_source_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'system'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');
