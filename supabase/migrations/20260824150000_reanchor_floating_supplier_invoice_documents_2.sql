-- Re-anchor floating supplier-invoice source documents, round 2.
--
-- Same repair as 20260727180000 (support case 2026-07-27, MGS Sweden), re-run
-- because one booking surface kept producing floating documents after that
-- sweep: POST /api/supplier-invoices/[id]/book (the deferred #967 flow) set
-- registration_journal_entry_id without ever anchoring the invoice's retained
-- source document. Support case 2026-08-24 (verifikat booked from a
-- leverantorsfaktura/utlagg stuck under "Saknar underlag" with the PDF
-- plainly attached) is this exact state. The code half of the fix adds
-- anchorSupplierInvoiceDocument() to that route in the same change; this
-- migration repairs the rows created before it ships.
--
-- The sweep is idempotent and strictly protective: only currently-unlinked
-- current-version documents (never steal a doc that already serves a
-- verifikat), only into posted verifikat in open, unlocked periods
-- (enforce_period_lock_documents raises otherwise), NULL -> uuid is the
-- explicitly permitted direction in enforce_document_journal_entry_immutability.
--
-- Preference order matches lib/core/documents/supplier-invoice-underlag.ts:
-- registration booking first (the primary booking of the affarshandelse),
-- payment booking second (the only booking under kontantmetoden), then
-- partial-payment verifikat, oldest first.

DO $$
DECLARE
  v_updated integer;
BEGIN
  WITH candidate AS (
    SELECT
      si.document_id,
      si.company_id,
      je.id AS journal_entry_id,
      ROW_NUMBER() OVER (
        PARTITION BY si.document_id
        ORDER BY rank_source, coalesce(sip.payment_date, je.entry_date), je.id
      ) AS pick
    FROM supplier_invoices si
    JOIN document_attachments d
      ON d.id = si.document_id
     AND d.company_id = si.company_id
     AND d.journal_entry_id IS NULL
     AND d.is_current_version = true
    CROSS JOIN LATERAL (
      SELECT si.registration_journal_entry_id AS entry_id, 1 AS rank_source, NULL::uuid AS payment_id
      UNION ALL
      SELECT si.payment_journal_entry_id, 2, NULL::uuid
      UNION ALL
      SELECT p.journal_entry_id, 3, p.id
      FROM supplier_invoice_payments p
      WHERE p.supplier_invoice_id = si.id
        AND p.company_id = si.company_id
        AND p.journal_entry_id IS NOT NULL
    ) AS src(entry_id, rank_source, payment_id)
    LEFT JOIN supplier_invoice_payments sip ON sip.id = src.payment_id
    JOIN journal_entries je
      ON je.id = src.entry_id
     AND je.company_id = si.company_id
     AND je.status = 'posted'
    JOIN fiscal_periods fp
      ON fp.id = je.fiscal_period_id
     AND fp.is_closed = false
     AND fp.locked_at IS NULL
  )
  UPDATE document_attachments d
  SET journal_entry_id = candidate.journal_entry_id
  FROM candidate
  WHERE candidate.pick = 1
    AND d.id = candidate.document_id
    AND d.company_id = candidate.company_id
    AND d.journal_entry_id IS NULL
    AND d.is_current_version = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 're-anchored % floating supplier-invoice documents to a posted verifikat', v_updated;
END;
$$;
