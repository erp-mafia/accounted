-- READ ONLY. Re-run immediately before the separately approved repair.
-- Fingerprints include complete account-level line content, currency,
-- dimensions and correction metadata, preserving repeated identical lines.
-- Linked-record inventory must be reviewed alongside these candidates.
WITH duplicate_keys AS MATERIALIZED (
  SELECT company_id,fiscal_period_id,source_voucher_series,source_voucher_number
  FROM public.journal_entries
  WHERE source_type='import' AND status='posted'
    AND source_voucher_series IS NOT NULL AND source_voucher_number IS NOT NULL
  GROUP BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number
  HAVING count(*)>1
), candidates AS MATERIALIZED (
  SELECT j.* FROM public.journal_entries j JOIN duplicate_keys k
    USING(company_id,fiscal_period_id,source_voucher_series,source_voucher_number)
  WHERE j.source_type='import' AND j.status='posted'
), fingerprints AS (
  SELECT j.id,encode(extensions.digest(jsonb_build_object(
    'date',j.entry_date,'description',j.description,
    'lines',(SELECT jsonb_agg(line ORDER BY line::text) FROM
      (SELECT to_jsonb(l)-'id'-'journal_entry_id'-'created_at'-'sort_order' AS line
       FROM public.journal_entry_lines l WHERE l.journal_entry_id=j.id) x),
    'corrections',(SELECT coalesce(jsonb_agg(to_jsonb(r)-'id'-'journal_entry_id'-'created_at'-'sie_import_id'
      ORDER BY r.created_at),'[]'::jsonb) FROM public.journal_entry_rattelse_log r WHERE r.journal_entry_id=j.id)
  )::text,'sha256'),'hex') content_hash,
  (SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=j.id) line_count
  FROM candidates j
)
SELECT j.company_id,c.name AS company_name,j.fiscal_period_id,j.source_voucher_series,j.source_voucher_number,
  count(*)::int copies,count(DISTINCT f.content_hash)=1 AS complete_content_matches,
  jsonb_agg(jsonb_build_object('id',j.id,'created_at',j.created_at,'series',j.voucher_series,
    'number',j.voucher_number,'content_hash',f.content_hash,'line_count',f.line_count)
    ORDER BY j.created_at,j.id) entries
FROM candidates j JOIN fingerprints f USING(id) JOIN public.companies c ON c.id=j.company_id
GROUP BY j.company_id,c.name,j.fiscal_period_id,j.source_voucher_series,j.source_voucher_number
ORDER BY j.company_id,j.fiscal_period_id,j.source_voucher_series,j.source_voucher_number;
