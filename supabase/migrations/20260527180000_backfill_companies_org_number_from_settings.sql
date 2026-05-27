-- Backfill companies.org_number from company_settings.org_number.
--
-- Why: the agent onboarding TIC fetch path (lib/agent/composer/tic-fetch.ts:88-96)
-- already falls through to company_settings.org_number when companies.org_number
-- is null — so these companies can fetch TIC fine. But the canonical lives on
-- companies.org_number: the duplicate-org guard, SIE/SRU exports, and
-- cross-company lookups all read from there. Until this is mirrored, those
-- paths silently skip these companies.
--
-- Survey before migration (2026-05-27): 136 candidate rows (companies with
-- null/empty companies.org_number but a value in company_settings.org_number).
-- After dedup + conflict filtering: 105 rows safely mirror, 56 of which belong
-- to "active" companies (journal entries, transactions, invoices, or supplier
-- invoices present).
--
-- Skip rules (each enforced below):
--   1. Unparseable input — only mirror if the value normalizes to exactly 10
--      digits. Strips separators and the 4-digit century prefix on 12-digit
--      input, matching lib/company-lookup/normalize-org-number.ts. Luhn check
--      intentionally omitted in SQL: these values were already accepted by
--      the app-level signup validation, and the TIC extension uses them
--      directly today regardless.
--   2. Duplicate within candidates — same canonical org_number appears on
--      multiple settings rows (sandbox copies, test data). Refuse rather than
--      pick one and have the other quietly conflict later.
--   3. Conflict with existing — another company already owns this org_number
--      on the main table. The unique-by-business-rule invariant wins.
--
-- Idempotent: re-running is a no-op because the WHERE clause requires
-- companies.org_number to be null/empty. Zero TIC API calls — pure data move.

WITH candidates AS (
  SELECT
    cs.company_id,
    CASE
      WHEN regexp_replace(cs.org_number, '[\s-]', '', 'g') ~ '^\d{10}$'
        THEN regexp_replace(cs.org_number, '[\s-]', '', 'g')
      WHEN regexp_replace(cs.org_number, '[\s-]', '', 'g') ~ '^\d{12}$'
        THEN substring(regexp_replace(cs.org_number, '[\s-]', '', 'g') FROM 3 FOR 10)
      ELSE NULL
    END AS canonical
  FROM company_settings cs
  JOIN companies c ON c.id = cs.company_id
  WHERE (c.org_number IS NULL OR c.org_number = '')
    AND cs.org_number IS NOT NULL
    AND cs.org_number <> ''
),
counted AS (
  SELECT
    candidates.*,
    COUNT(*) OVER (PARTITION BY candidates.canonical) AS dup_in_candidates
  FROM candidates
),
mirror_plan AS (
  SELECT cand.company_id, cand.canonical
  FROM counted cand
  WHERE cand.canonical IS NOT NULL
    AND cand.dup_in_candidates = 1
    AND NOT EXISTS (
      SELECT 1 FROM companies c2
      WHERE c2.org_number = cand.canonical
        AND c2.id <> cand.company_id
    )
)
UPDATE companies c
SET org_number = mp.canonical
FROM mirror_plan mp
WHERE c.id = mp.company_id;
