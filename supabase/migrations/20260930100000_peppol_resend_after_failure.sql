-- pg-test: covered-by tests/pg/peppol-resend-after-failure.pg.test.ts
--
-- A resend after a failed Peppol delivery stages a new delivery.
--
-- The staged-document key (company_id, invoice_id, xml_sha256) was unique
-- over every row. An invoice is issued and booked before it is submitted, and
-- its XML is deterministic, so a resend of the same invoice staged nothing
-- new: the stage RPC handed back the failed row, which the send answered as
-- already submitted (it had a submission id) or as rejected. An issued
-- invoice whose delivery failed could never be sent again.
--
-- The key now holds for live deliveries only: at most one delivery per exact
-- document that is not failed or no_route. A failed or no_route row is
-- history and stays (it is retained with the invoice's fiscal year); the
-- same XML stages a new row with a new idempotency key. A terminal row never
-- changes status again (record_peppol_delivery_event keeps a terminal
-- projection, and enforce_peppol_delivery_immutability admits no other
-- writer), so a row that left the index never comes back into it.
-- business_rejected stays in the index: the buyer refused the invoice, and
-- the send refuses the same document again (credit it and issue a new one).

DROP INDEX IF EXISTS public.idx_peppol_deliveries_staged_document;

CREATE UNIQUE INDEX idx_peppol_deliveries_staged_document
  ON public.peppol_deliveries (company_id, invoice_id, xml_sha256)
  WHERE status NOT IN ('failed', 'no_route');

-- The body of 20260926020100 with one change: the conflict handling. The
-- same XML while its delivery is live answers that delivery; once it failed
-- (or had no route) it stages a new one. The loop covers the live row
-- turning terminal between the insert and the read.
CREATE OR REPLACE FUNCTION public.stage_peppol_delivery_as_actor(
  p_actor_id uuid,
  p_company_id uuid,
  p_invoice_id uuid,
  p_recipient_scheme text,
  p_recipient_identifier text,
  p_customization_id text,
  p_profile_id text,
  p_filename text,
  p_xml_payload text,
  p_xml_sha256 text
)
RETURNS public.peppol_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  invoice_date date;
  retention_expiry date;
  staged public.peppol_deliveries%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.company_members AS member
    WHERE member.company_id = p_company_id
      AND member.user_id = p_actor_id
      AND member.role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'not authorized to stage Peppol delivery'
      USING ERRCODE = '42501';
  END IF;

  SELECT invoice.invoice_date
  INTO invoice_date
  FROM public.invoices AS invoice
  WHERE invoice.id = p_invoice_id
    AND invoice.company_id = p_company_id
    AND invoice.invoice_number IS NOT NULL
    AND invoice.status <> 'cancelled';

  IF invoice_date IS NULL THEN
    RAISE EXCEPTION 'invoice not found or not eligible for Peppol staging'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT period.retention_expires_at
  INTO retention_expiry
  FROM public.fiscal_periods AS period
  WHERE period.company_id = p_company_id
    AND invoice_date BETWEEN period.period_start AND period.period_end
  ORDER BY period.period_end DESC
  LIMIT 1;

  IF retention_expiry IS NULL THEN
    RAISE EXCEPTION 'Peppol delivery requires a fiscal period retention basis'
      USING ERRCODE = 'P0002';
  END IF;

  LOOP
    INSERT INTO public.peppol_deliveries (
      company_id, user_id, invoice_id,
      recipient_scheme, recipient_identifier, customization_id, profile_id,
      filename, xml_payload, xml_sha256, retention_expires_at
    ) VALUES (
      p_company_id, p_actor_id, p_invoice_id,
      p_recipient_scheme, p_recipient_identifier, p_customization_id, p_profile_id,
      p_filename, p_xml_payload, lower(p_xml_sha256), retention_expiry
    )
    ON CONFLICT (company_id, invoice_id, xml_sha256)
      WHERE status NOT IN ('failed', 'no_route')
      DO NOTHING
    RETURNING * INTO staged;

    EXIT WHEN staged.id IS NOT NULL;

    SELECT * INTO staged
    FROM public.peppol_deliveries AS delivery
    WHERE delivery.company_id = p_company_id
      AND delivery.invoice_id = p_invoice_id
      AND delivery.xml_sha256 = lower(p_xml_sha256)
      AND delivery.status NOT IN ('failed', 'no_route');
    IF FOUND THEN
      RETURN staged;
    END IF;
  END LOOP;

  INSERT INTO public.peppol_delivery_events (
    company_id, delivery_id, source, provider_event_code, normalized_status,
    raw_payload, event_sha256, verification_method, occurred_at
  ) VALUES (
    p_company_id, staged.id, 'local', 'staged', 'staged',
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'idempotency_key', staged.idempotency_key,
      'xml_sha256', staged.xml_sha256
    ),
    staged.xml_sha256,
    'local',
    staged.created_at
  );

  RETURN staged;
END;
$$;

-- Unchanged: service role only, the actor id is trusted input.
REVOKE ALL ON FUNCTION public.stage_peppol_delivery_as_actor(
  uuid, uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_peppol_delivery_as_actor(
  uuid, uuid, uuid, text, text, text, text, text, text, text
) TO service_role;

-- stage_peppol_delivery delegates to the function above with auth.uid()
-- (20260926020100), so the session variant follows the same rule unchanged.

COMMENT ON COLUMN public.peppol_deliveries.idempotency_key IS
  'Stable caller-supplied key for the provider submit call. Reused for retries of this exact staged XML while its delivery is live; a resend after a failed or no_route delivery stages a new row with a new key.';

NOTIFY pgrst, 'reload schema';
