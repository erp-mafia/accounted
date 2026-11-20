-- journal_entry_followups: what happened to each journal entry after it was
-- booked, read at query time from the tables that already record it: the
-- proposal that produced it, reversal, inline correction, VAT declaration of
-- its period, and period close and lock. No job, no backfill and no stored
-- copy, so every row is as current as its sources.
--
-- pg-test: tests/pg/journal-entry-followups.pg.test.ts
--
-- One row per journal entry with status posted or reversed. Drafts and
-- cancelled entries are left out.
--
-- Columns, by source:
--   identity     journal_entries: company, voucher series and number, entry
--                date, status, source_type, committed_at, committed_by (the
--                user stamped at commit; NULL on entries posted before
--                20260929220100) and committed_actor_type (NULL before
--                20260619120000).
--   proposal     suggestion_log rows whose final.journal_entry_id names the
--                entry, the link the decision receipts read
--                (src/lib/suggestion-log/receipts.ts). The newest row's id,
--                kind and outcome (accepted, changed or manual; a dismissed
--                row books nothing and has no final), how many rows booked the
--                entry (a samlingsverifikat carries one per bank line), and
--                the newest pending_operation_id any of them records.
--   reversal     journal_entries.reversed_by_id, which the storno path
--                (reverseEntry, correctEntry) sets when it reverses the entry:
--                the storno entry, its committed_at as reversed_at, and the
--                calendar days (Europe/Stockholm) from the entry's commit to
--                the reversal. Plus the corrected entry a storno correction
--                posted (correction_of_id), when there is one.
--   inline       journal_entry_rattelse_log, written by correct_entry_metadata
--   correction   and correct_entry_lines_inline: how many rättelser and when
--                the first one was made.
--   VAT          the momsdeklaration filing record, which is the period's
--                completed moms deadline (src/lib/vat/filing-record.ts):
--                deadlines of type moms_monthly, moms_quarterly or
--                moms_yearly, completed and not dismissed, whose tax_period
--                covers entry_date. tax_period is YYYY-MM monthly, YYYY-QN
--                quarterly, and for yearly the räkenskapsår name of the
--                entry's fiscal period (YYYY when it ends in December, else
--                YYYY-1/YYYY), as the deadline generator writes them. The
--                three formats never overlap. Earliest completed_at of a
--                covering filing, and 'skatteverket' when Skatteverket
--                confirmed one (status confirmed), else 'manual', as
--                VatFilingRecord.source reads it.
--   close        the entry's fiscal period: is_closed, closed_at, locked_at;
--                and company_settings.bookkeeping_locked_through, the company
--                lock date, with whether it covers entry_date (the same
--                entry_date <= lock date test enforce_company_lock_date runs).
--
-- Not included:
--   * pending_operations.result_data as a link to the entry. journal_entry_id
--     is written there also by operations that only reference an existing
--     voucher (link_document_to_voucher, link_invoice_to_voucher), so it does
--     not say which operation produced the entry. The operation comes from
--     suggestion_log.pending_operation_id only, recorded since
--     20261016003000.
--   * a VAT declaration locked for signing and not yet filed: that state is
--     kept by the Skatteverket extension in extension_data, not in a core
--     table. Once the filing is observed the kvittens check completes the
--     deadline read here.
--   * when the company lock date was set: company_settings keeps only the
--     date (the change itself is in audit_log).
--
-- Security: WITH (security_invoker = true), so every table behind the view is
-- read with the caller's privileges and RLS. A member sees the rows of their
-- own companies only, exactly as when reading the tables directly. A view
-- without it runs as its owner and bypasses RLS. Every join also names the
-- entry's company_id.
--
-- Index: suggestion_log is looked up per entry by final->>'journal_entry_id',
-- which no index covers (the existing ones lead with company_id, created_at,
-- or name the bank line, inbox item, document or operation), so every lookup
-- read all of the company's decisions. The other lookups use existing keys:
-- journal_entries by primary key (reversed_by_id) and correction_of_id,
-- journal_entry_rattelse_log by (company_id, journal_entry_id), fiscal_periods
-- and company_settings by key, and deadlines by company_id, read once per
-- company and joined by hash rather than per entry.

-- Never queue every write behind a long transaction: fail the migration job
-- instead and retry.
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX idx_suggestion_log_final_journal_entry
  ON public.suggestion_log ((final->>'journal_entry_id'))
  WHERE final->>'journal_entry_id' IS NOT NULL;

CREATE VIEW public.journal_entry_followups WITH (security_invoker = true) AS
WITH vat_filed AS NOT MATERIALIZED (
  SELECT d.company_id,
         d.tax_period,
         min(d.completed_at)            AS declared_at,
         bool_or(d.status = 'confirmed') AS confirmed
    FROM public.deadlines d
   WHERE d.tax_deadline_type IN ('moms_monthly', 'moms_quarterly', 'moms_yearly')
     AND d.is_completed
     AND d.completed_at IS NOT NULL
     AND d.dismissed_at IS NULL
   GROUP BY d.company_id, d.tax_period
)
SELECT
  e.company_id,
  e.id                                  AS journal_entry_id,
  e.voucher_series,
  e.voucher_number,
  e.entry_date,
  e.status,
  e.source_type,
  e.committed_at,
  e.committed_by,
  e.committed_actor_type,

  sl.suggestion_log_id,
  sl.suggestion_kind,
  sl.suggestion_outcome,
  sl.suggestion_count,
  sl.pending_operation_id,

  storno.id                             AS storno_journal_entry_id,
  storno.committed_at                   AS reversed_at,
  (storno.committed_at AT TIME ZONE 'Europe/Stockholm')::date
    - (e.committed_at AT TIME ZONE 'Europe/Stockholm')::date AS days_to_reversal,
  replacement.id                        AS replacement_journal_entry_id,

  rat.inline_correction_count,
  rat.first_inline_correction_at,

  (vm.company_id IS NOT NULL OR vq.company_id IS NOT NULL OR vy.company_id IS NOT NULL)
                                        AS vat_period_declared,
  least(vm.declared_at, vq.declared_at, vy.declared_at) AS vat_declared_at,
  CASE
    WHEN vm.confirmed OR vq.confirmed OR vy.confirmed THEN 'skatteverket'
    WHEN vm.company_id IS NOT NULL OR vq.company_id IS NOT NULL OR vy.company_id IS NOT NULL THEN 'manual'
  END                                   AS vat_declaration_source,

  e.fiscal_period_id,
  coalesce(fp.is_closed, false)         AS fiscal_period_closed,
  CASE WHEN fp.is_closed THEN fp.closed_at END AS fiscal_period_closed_at,
  fp.locked_at                          AS fiscal_period_locked_at,
  cs.bookkeeping_locked_through         AS company_lock_date,
  coalesce(e.entry_date <= cs.bookkeeping_locked_through, false) AS covered_by_lock_date
FROM public.journal_entries e
LEFT JOIN public.fiscal_periods fp
  ON fp.id = e.fiscal_period_id
 AND fp.company_id = e.company_id
LEFT JOIN public.company_settings cs
  ON cs.company_id = e.company_id
LEFT JOIN public.journal_entries storno
  ON storno.id = e.reversed_by_id
 AND storno.company_id = e.company_id
 AND e.status = 'reversed'
LEFT JOIN LATERAL (
  SELECT c.id
    FROM public.journal_entries c
   WHERE c.correction_of_id = e.id
     AND c.company_id = e.company_id
     AND c.status IN ('posted', 'reversed')
   ORDER BY c.committed_at DESC NULLS LAST, c.id DESC
   LIMIT 1
) replacement ON true
CROSS JOIN LATERAL (
  SELECT count(*)::integer                                         AS suggestion_count,
         (array_agg(s.id ORDER BY s.created_at DESC, s.id DESC))[1]      AS suggestion_log_id,
         (array_agg(s.kind ORDER BY s.created_at DESC, s.id DESC))[1]    AS suggestion_kind,
         (array_agg(s.outcome ORDER BY s.created_at DESC, s.id DESC))[1] AS suggestion_outcome,
         (array_agg(s.pending_operation_id ORDER BY s.created_at DESC, s.id DESC)
            FILTER (WHERE s.pending_operation_id IS NOT NULL))[1]   AS pending_operation_id
    FROM public.suggestion_log s
   WHERE s.final->>'journal_entry_id' = e.id::text
     AND s.company_id = e.company_id
) sl
CROSS JOIN LATERAL (
  SELECT count(*)::integer AS inline_correction_count,
         min(r.created_at) AS first_inline_correction_at
    FROM public.journal_entry_rattelse_log r
   WHERE r.company_id = e.company_id
     AND r.journal_entry_id = e.id
) rat
LEFT JOIN vat_filed vm
  ON vm.company_id = e.company_id
 AND vm.tax_period = to_char(e.entry_date, 'YYYY-MM')
LEFT JOIN vat_filed vq
  ON vq.company_id = e.company_id
 AND vq.tax_period = to_char(e.entry_date, 'YYYY-"Q"Q')
LEFT JOIN vat_filed vy
  ON vy.company_id = e.company_id
 AND vy.tax_period = CASE
       WHEN extract(month FROM fp.period_end) = 12 THEN to_char(fp.period_end, 'YYYY')
       ELSE (extract(year FROM fp.period_end)::integer - 1)::text || '/' || to_char(fp.period_end, 'YYYY')
     END
WHERE e.status IN ('posted', 'reversed');

COMMENT ON VIEW public.journal_entry_followups IS
  'One row per posted or reversed journal entry: what happened to it after it was booked. The proposal that produced it (suggestion_log), reversal by storno, inline correction (journal_entry_rattelse_log), VAT declaration of the period containing it (completed moms deadline), and close and lock of its fiscal period and the company lock date. Read at query time; security_invoker, so the RLS of the underlying tables applies.';
COMMENT ON COLUMN public.journal_entry_followups.suggestion_log_id IS
  'The newest suggestion_log row whose final.journal_entry_id names this entry. NULL when no recorded decision booked it.';
COMMENT ON COLUMN public.journal_entry_followups.suggestion_count IS
  'How many suggestion_log rows booked this entry: one per bank line for a samlingsverifikat, 0 when none.';
COMMENT ON COLUMN public.journal_entry_followups.pending_operation_id IS
  'The staged operation the newest of those rows records, when an approval carried the decision.';
COMMENT ON COLUMN public.journal_entry_followups.storno_journal_entry_id IS
  'The storno entry that reversed this one (journal_entries.reversed_by_id). NULL unless status is reversed.';
COMMENT ON COLUMN public.journal_entry_followups.reversed_at IS
  'committed_at of the storno entry.';
COMMENT ON COLUMN public.journal_entry_followups.days_to_reversal IS
  'Calendar days, Europe/Stockholm, from this entry''s commit to its storno''s commit.';
COMMENT ON COLUMN public.journal_entry_followups.replacement_journal_entry_id IS
  'The corrected entry a storno correction posted for this one (journal_entries.correction_of_id).';
COMMENT ON COLUMN public.journal_entry_followups.inline_correction_count IS
  'Number of inline rättelser in journal_entry_rattelse_log, 0 when none.';
COMMENT ON COLUMN public.journal_entry_followups.vat_period_declared IS
  'True when a completed, not dismissed moms deadline (monthly, quarterly or yearly) covers entry_date.';
COMMENT ON COLUMN public.journal_entry_followups.vat_declared_at IS
  'Earliest completed_at of a moms deadline covering entry_date.';
COMMENT ON COLUMN public.journal_entry_followups.vat_declaration_source IS
  'skatteverket when Skatteverket confirmed a covering filing (deadline status confirmed), manual when it was recorded by hand, NULL when not declared.';
COMMENT ON COLUMN public.journal_entry_followups.covered_by_lock_date IS
  'True when entry_date is on or before company_settings.bookkeeping_locked_through.';

GRANT SELECT ON public.journal_entry_followups TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
