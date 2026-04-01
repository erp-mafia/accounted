-- Atomic journal entry commit: assigns voucher number and posts entry in one transaction.
-- Prevents burned voucher numbers from failed commits (the counter increment rolls back
-- if the status update or balance trigger fails).
--
-- Only used for the draft→posted transition (commitEntry). reverseEntry and storno
-- use a different flow (INSERT with voucher number) and still call next_voucher_number.
CREATE OR REPLACE FUNCTION public.commit_journal_entry(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS TABLE (voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
BEGIN
  -- Fetch and lock the draft entry
  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A')
  INTO v_fiscal_period_id, v_series
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  -- Increment voucher sequence (atomic via INSERT ON CONFLICT)
  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, auth.uid(), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  -- Update entry to posted with the assigned voucher number.
  -- If the balance trigger (check_balance_on_post) rejects the UPDATE,
  -- the entire transaction rolls back — including the sequence increment.
  -- No burned number, no gap.
  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted'
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  RETURN QUERY SELECT v_next;
END;
$$;
