-- One live momsredovisning per VAT period from the booking door, enforced at
-- the journal (accounted#58).
--
-- bookVatSettlement (src/lib/reports/vat-settlement-booking.ts, behind v1
-- POST /vat/settlement and the MCP gnubok_book_vat_settlement approval) reads
-- the period's existing settlements and refuses a second one, but the read
-- and the write are separate calls. Two bookings for the same period (two
-- staged operations approved together, an API retry racing an approval) can
-- both pass the read and both post. The proposal clears the WHOLE period, so
-- the second verifikat would clear the 26xx accounts twice.
--
-- The booking now writes source_id = a name based UUID over (company, period
-- start, period end) (vatSettlementSourceId), so both racers compute the same
-- key and the second fails at the draft insert with 23505, before a voucher
-- number is drawn. The app answers it as 409 VAT_SETTLEMENT_ALREADY_BOOKED.
--
-- draft is included on purpose, as in journal_entries_rot_rut_payout_live_unique:
-- the engine inserts a draft and commits it in a second step, so the loser
-- must fail at the draft insert and leave nothing behind. The engine cancels
-- a draft whose commit fails, so a refused commit never strands the key.
-- Reversed and cancelled entries fall outside the predicate, so a storno of a
-- settlement never blocks booking the period again. Settlements booked from
-- the journal entry form, SIE imports and older bookings carry no source_id
-- and are outside the predicate; the application read still gates them.
--
-- Pre-deploy check (must return zero rows; on 2026-11-01 no vat_settlement
-- entry carried a source_id at all):
--   SELECT company_id, source_id, count(*) FROM public.journal_entries
--   WHERE source_type = 'vat_settlement' AND source_id IS NOT NULL
--     AND status IN ('draft', 'posted')
--   GROUP BY company_id, source_id HAVING count(*) > 1;
-- pg-test: tests/pg/vat-settlement-live-unique.pg.test.ts

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_vat_settlement_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'vat_settlement'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');
