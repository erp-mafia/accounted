-- A bank row is booked once, decided where the verifikat is posted (#205).
--
-- What happened. Every door that books a new verifikat on a bank row asks the
-- gate first (decideBankRowRebooking, lib/transactions/is-booked.ts), posts
-- the verifikat, then claims the row (its pointer) in a second write. Two
-- things got past that:
--   * The claim and the door's compensating storno both lost the busy
--     bank-account lock during bursts of parallel bookings (October 2026): the
--     verifikat stood beside a row that read open, and the row was booked a
--     second time. #203 made the gate read the verifikat booked from the row,
--     but only its source half (source_type 'bank_transaction', source_id),
--     not a verifikat that names the row in its bank_booking_context.
--   * Two bookings of the same row that both pass the gate before either is
--     posted (a double submit, two tabs, an agent and a person) are both
--     posted: nothing in the database compares them. Production holds 22 rows
--     with two posted verifikat booked from each (left as they are here).
--
-- The verifikat already names the bank rows it books, in the transaction that
-- posts it: guard_bank_booking_context requires every 'bank_transaction'
-- verifikat to carry its row in bank_booking_context and locks each named row
-- FOR UPDATE NOWAIT. So the claim that counts is made atomically with the
-- posting; what was missing is the check.
--
-- What changes. guard_bank_row_single_booking, a BEFORE trigger on
-- journal_entries: when a verifikat becomes posted (INSERT as posted, or
-- UPDATE of status into 'posted'), each bank row it names (bank_booking_context,
-- and source_id for a 'bank_transaction' verifikat) must not be booked by
-- another posted verifikat:
--   - its pointer or a bank_line link at a live verifikat
--     (bank_row_posted_anchor, the SQL side of the gate: a reversed one counts
--     through its standing correction), or
--   - another posted verifikat naming the row (posted_entries_naming_bank_row,
--     the source half and the bank_booking_context half), or a reversed one
--     booked from the row whose correction stands (standing_correction), as
--     the gate reads it (readBookedFromRows). A reversed one that names the
--     row only in its context is not read, by the gate or here: the context
--     index holds posted verifikat only.
-- Otherwise it raises BANK_ROW_ALREADY_BOOKED (PT409), the other verifikat in
-- the detail, and the whole statement rolls back: inside commit_journal_entry
-- that includes the voucher number, so none is used up.
--
-- It fires after guard_bank_booking_context (triggers of one event fire in
-- name order), so the named rows are locked. commit_journal_entry takes the
-- company lock before anything else and holds it to its commit, so the second
-- of two concurrent commits waits for the first and then sees it; any other
-- posting meets the held locks NOWAIT and is refused as busy. It checks new
-- postings only: the 22 existing pairs stay, and a third booking of one of
-- those rows is refused. Storno and rättelse never name a bank row
-- (correction-column-policy leaves bank_booking_context behind), and inline
-- rättelse does not change status, so neither is affected.
--
-- SECURITY DEFINER, as guard_cash_transaction_binding (20261107213000): as the
-- caller the bank_booking_context half cannot use its GIN index under row
-- level security. Every read is bounded by NEW.company_id, the search path is
-- empty, and a trigger function has no direct entry point.
--
-- pg-test: tests/pg/bank-row-single-booking.pg.test.ts,
--          tests/pg/named-bank-row-gate.pg.test.ts

CREATE FUNCTION public.guard_bank_row_single_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row uuid;
  v_other uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'posted' OR (TG_OP = 'UPDATE' AND OLD.status = 'posted') THEN
    RETURN NEW;
  END IF;

  FOR v_row IN
    SELECT (c->>'transaction_id')::uuid FROM jsonb_array_elements(NEW.bank_booking_context) c
    UNION
    SELECT NEW.source_id WHERE NEW.source_type = 'bank_transaction' AND NEW.source_id IS NOT NULL
  LOOP
    -- The row's pointer or bank_line link at a live verifikat. This one is
    -- not posted in the table yet, so it is never its own anchor.
    SELECT public.bank_row_posted_anchor(t.company_id, t.id, t.journal_entry_id)
      INTO v_other
      FROM public.transactions t
     WHERE t.company_id = NEW.company_id AND t.id = v_row;

    -- Another posted verifikat booked from the row or naming it in its bank
    -- booking context: a booking whose claim never landed. The first by
    -- voucher number, as the gate names it.
    IF v_other IS NULL THEN
      SELECT j.id INTO v_other
        FROM public.posted_entries_naming_bank_row(NEW.company_id, v_row) n(e)
        JOIN public.journal_entries j ON j.id = n.e AND j.company_id = NEW.company_id
       WHERE n.e <> NEW.id
       ORDER BY j.voucher_number, j.id
       LIMIT 1;
    END IF;

    -- One booked from the row and reversed, whose correction books its money
    -- on: the row stays booked through the correction.
    IF v_other IS NULL THEN
      SELECT c.id INTO v_other
        FROM public.journal_entries j
       CROSS JOIN LATERAL (SELECT public.standing_correction(j.id) AS id) c
       WHERE j.company_id = NEW.company_id
         AND j.source_type = 'bank_transaction'
         AND j.source_id = v_row
         AND j.status = 'reversed'
         AND j.id <> NEW.id
         AND c.id IS NOT NULL
       ORDER BY j.voucher_number, j.id
       LIMIT 1;
    END IF;

    IF v_other IS NOT NULL AND v_other <> NEW.id THEN
      RAISE EXCEPTION 'BANK_ROW_ALREADY_BOOKED'
        USING ERRCODE = 'PT409',
              DETAIL = jsonb_build_object('transaction_id', v_row, 'journal_entry_id', v_other)::text;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_bank_row_single_booking() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_bank_row_single_booking() IS
  'A verifikat being posted may not name a bank row another posted verifikat books (pointer, bank_line link, naming it by source or bank_booking_context, or a corrected one booked from it): BANK_ROW_ALREADY_BOOKED (PT409). Fires after guard_bank_booking_context, under its row locks (#205).';

CREATE TRIGGER guard_bank_row_single_booking
  BEFORE INSERT OR UPDATE OF status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_bank_row_single_booking();
