-- Store suppliers.org_number in its canonical 10-digit form (#2391).
--
-- The supplier form asked for XXXXXX-XXXX, the v1 API and the MCP tool stored
-- whatever the caller sent, and the AI extractor emits bare digits, so the
-- register held one identity in three spellings and the exact matcher missed
-- most of them. Every write path now canonicalises to the 10 significant
-- digits (lib/invariants/org-number.ts, orgNumberKey: digits only, 10 kept
-- as-is, the last 10 of a 12-digit century form); this backfill brings the
-- rows written before that to the same form.
--
-- Scope:
--   * only rows whose digits form a 10- or 12-digit number; a foreign
--     registration number or an unrecognised value stays exactly as typed;
--   * companies archived by a migration reset are immutable and skipped
--     (company_migration_resets), the same rule as 20260904010000;
--   * idempotent: a second run matches no row.
--
-- suppliers_link_party fires on UPDATE OF org_number. normalize_org_number
-- yields the same value for both spellings, so a linked row keeps its party;
-- a row that never got one is linked now, as any edit would do.
--
-- No unique index on (company_id, org_number) yet: prod holds duplicate
-- pairs under the canonical key that need a merge decision first. Adding the
-- index is a follow-up; the matcher does not depend on it.

UPDATE public.suppliers s
   SET org_number = right(regexp_replace(s.org_number, '\D', '', 'g'), 10)
 WHERE s.org_number IS NOT NULL
   AND regexp_replace(s.org_number, '\D', '', 'g') ~ '^([0-9]{10}|[0-9]{12})$'
   AND s.org_number <> right(regexp_replace(s.org_number, '\D', '', 'g'), 10)
   AND NOT EXISTS (
     SELECT 1
       FROM public.company_migration_resets r
      WHERE r.source_company_id = s.company_id
   );
