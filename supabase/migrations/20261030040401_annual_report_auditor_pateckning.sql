-- Revisorspåteckning facts on the annual-report profile (K3 build, Phase 3,
-- revisor package).
--
-- The revisor makes a hänvisning to the revisionsberättelse on the
-- årsredovisning (ABL 9 kap. 28 § andra stycket). The revisor's name and
-- title live in the signer roster (arsredovisning_signature_requests, roles
-- 'Auktoriserad revisor', 'Godkänd revisor', 'Huvudansvarig revisor'); the
-- date of the påteckning is that slot's signed_at. Two facts are not a
-- person's and belong to the period instead:
--
--   auditor_firm_name  the registered revisionsbolag elected as revisor, when
--                      the revisor is a firm (ValtRevisionsbolagsnamn in the
--                      taxonomy's signature section). NULL: a natural person.
--   auditor_opinion    what the revisionsberättelse says, which decides how
--                      the påteckning is tagged: 'unmodified' (utan
--                      modifierade uttalanden), 'modified' (med modifierade
--                      uttalanden), or one of the påteckningsmeningar for a
--                      revisionsberättelse that avstyrker, or neither
--                      tillstyrker nor avstyrker, that the statements are
--                      adopted. NULL: not answered yet. The mapping to the
--                      taxonomy's vallista lives in
--                      src/lib/bokslut/ixbrl/revisorspateckning.ts.
--
-- Both are known only once the revisor has given the revisionsberättelse,
-- after the board signed, so they are not frozen into a version's content
-- at lock time. They are frozen with the påteckning instead: when the
-- revisor's slot is signed, the opinion and the revisionsbolag as they stand
-- are written onto that slot (pateckning_opinion, pateckning_firm_name below),
-- and a signed slot can no longer change
-- (enforce_signed_signature_request_immutability). A signed or filed version
-- renders the påteckning it was given, whatever the profile says later
-- (BFL 7 kap. 1 §); the profile is read live only while the revisor's slot
-- is pending. Only a signed revisor slot carries them, and it always carries
-- the opinion.
--
-- pg-test: covered-by tests/pg/annual-report-auditor-pateckning.pg.test.ts

ALTER TABLE public.annual_report_profiles
  ADD COLUMN auditor_firm_name text,
  ADD COLUMN auditor_opinion text;

ALTER TABLE public.annual_report_profiles
  ADD CONSTRAINT annual_report_profiles_auditor_firm_name_length CHECK (
    auditor_firm_name IS NULL OR char_length(btrim(auditor_firm_name)) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT annual_report_profiles_auditor_opinion_check CHECK (
    auditor_opinion IS NULL OR auditor_opinion IN (
      'unmodified',
      'modified',
      'avstyrkt_rr_br',
      'avstyrkt_rr',
      'avstyrkt_br',
      'avstyrkt_rr_varken_br',
      'avstyrkt_br_varken_rr',
      'varken_rr_br',
      'varken_rr',
      'varken_br'
    )
  );

COMMENT ON COLUMN public.annual_report_profiles.auditor_firm_name IS
  'Registered revisionsbolag elected as revisor (ValtRevisionsbolagsnamn); NULL when the revisor is a natural person.';
COMMENT ON COLUMN public.annual_report_profiles.auditor_opinion IS
  'What the revisionsberättelse says, for the revisorspåteckning; see src/lib/bokslut/ixbrl/revisorspateckning.ts.';

-- The påteckning as it was given, on the revisor's slot. Written in the same
-- update that signs the slot (lib/bokslut/arsredovisning/workflow-service.ts
-- pateckningGate), then frozen with the rest of the signed row.
ALTER TABLE public.arsredovisning_signature_requests
  ADD COLUMN pateckning_opinion text,
  ADD COLUMN pateckning_firm_name text;

ALTER TABLE public.arsredovisning_signature_requests
  ADD CONSTRAINT arsredovisning_signature_requests_pateckning_check CHECK (
    (pateckning_opinion IS NULL AND pateckning_firm_name IS NULL)
    OR (
      status = 'signed'
      AND pateckning_opinion IS NOT NULL
      AND lower(regexp_replace(btrim(role), '\s+', ' ', 'g'))
        IN ('auktoriserad revisor', 'godkänd revisor', 'huvudansvarig revisor')
    )
  ),
  ADD CONSTRAINT arsredovisning_signature_requests_pateckning_opinion_check CHECK (
    pateckning_opinion IS NULL OR pateckning_opinion IN (
      'unmodified',
      'modified',
      'avstyrkt_rr_br',
      'avstyrkt_rr',
      'avstyrkt_br',
      'avstyrkt_rr_varken_br',
      'avstyrkt_br_varken_rr',
      'varken_rr_br',
      'varken_rr',
      'varken_br'
    )
  ),
  ADD CONSTRAINT arsredovisning_signature_requests_pateckning_firm_length CHECK (
    pateckning_firm_name IS NULL OR char_length(btrim(pateckning_firm_name)) BETWEEN 1 AND 200
  );

COMMENT ON COLUMN public.arsredovisning_signature_requests.pateckning_opinion IS
  'The revisionsberättelse''s opinion as the revisor''s påteckning was given (annual_report_profiles.auditor_opinion at signing); only on a signed revisor slot.';
COMMENT ON COLUMN public.arsredovisning_signature_requests.pateckning_firm_name IS
  'The revisionsbolag as the revisor''s påteckning was given (annual_report_profiles.auditor_firm_name at signing); NULL for a natural person.';

NOTIFY pgrst, 'reload schema';
