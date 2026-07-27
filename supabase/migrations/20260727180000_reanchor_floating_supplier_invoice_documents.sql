-- Re-anchor supplier-invoice source documents that are floating.
--
-- Problem (support case 2026-07-27, MGS Sweden): a verifikat booked from a
-- supplier invoice showed the invoice PDF when opened, while the verifikat list
-- kept warning "Underlag saknas" on the same row. Both surfaces were behaving
-- as written:
--
--   * every missing-underlag surface (verifikat_without_documents /
--     transactions_without_documents, /api/documents/counts, the transactions
--     list) only accepts a referenced supplier-invoice document as underlag
--     when it is ANCHORED (document_attachments.journal_entry_id IS NOT NULL),
--     because only anchored docs sit behind the WORM deletion guards
--     (block_document_deletion keys on journal_entry_id);
--   * the verifikat view's reference resolver did not check the anchor and
--     displayed the document regardless.
--
-- The resolver is aligned in the same change. This migration fixes the data
-- half: documents that ended up floating even though the invoice still has a
-- posted verifikat to hang on. Two production causes, both observed:
--
--   1. delete_last_voucher clears journal_entry_id on every document attached
--      to the voucher it tears down (the FK is ON DELETE RESTRICT, so it has
--      no alternative). Deleting a rättelse the invoice's PDF had been
--      relinked onto therefore orphans the PDF while the invoice's payment
--      verifikat stays posted.
--   2. Payment/cash verifikat booked for an invoice whose document was never
--      anchored at registration (attached after the fact, or booked through
--      the API-key/MCP mark-paid path, which did not link it at all).
--
-- Anchoring is strictly protective: it moves the document behind the deletion
-- guard, and NULL -> uuid is explicitly permitted by
-- enforce_document_journal_entry_immutability (it returns early when
-- OLD.journal_entry_id IS NULL). Scoped like the 20260724090000 §4 backfill:
-- only currently-unlinked current-version documents (never steal a doc that
-- already serves a verifikat), only into open, unlocked periods
-- (enforce_period_lock_documents raises otherwise), and the target verifikat
-- must be posted and belong to the same company as the document.
--
-- Preference order matches lib/core/documents/supplier-invoice-underlag.ts:
-- the registration booking is the primary booking of the affärshändelse, the
-- payment booking is the fallback (and the only booking under kontantmetoden),
-- then partial-payment verifikat, oldest first.

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
