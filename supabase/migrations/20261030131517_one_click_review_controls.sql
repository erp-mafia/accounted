-- One click under the company's and the rule's control (accounted#130, step 1).
--
-- A bank row's suggestion books with one click, without its review, when the
-- direct-booking policy says the company has already decided it
-- (src/lib/transactions/direct-booking.ts). A controller could not turn that
-- off, could not make one rule always ask, and could not see afterwards
-- whether a booking skipped its review. Three columns:
--
--   * company_settings.direct_booking_enabled: the company's switch. Off,
--     every suggestion opens its review, on the bank rows and in the
--     Inkorg. Default on, which is what every company has today. Audited by
--     the existing company_settings trigger and labelled in the
--     behandlingshistorik (BFNAR 2013:2 p. 9.16: a change to how
--     bokföringsposter are processed).
--   * categorization_templates.always_review: one rule asks on every
--     booking. Set by a person through PATCH /api/rules/[id]. The existing
--     audit_categorization_templates_update trigger logs it: its WHEN clause
--     strips only the learning columns, so a change to this one is a rule
--     change in the behandlingshistorik.
--   * suggestion_log.review_shown: whether the person saw the booking's
--     review before it was booked (false: the row's one click; true:
--     Granska bokföring). Written in the same INSERT as the rest of the row,
--     so the table stays append-only. NULL where the door does not say and
--     on rows written before this migration (no backfill: what a past
--     decision showed is not known).
--
-- No backfill and no column for imported rules: a rule learned from an
-- imported history asks until one booking on it has been reviewed here, and
-- that is read off categorization_templates.source = 'sie_import', which the
-- reviewed booking lifts to 'user_approved' (resolveSource). Every imported
-- rule is covered, the ones learned before this migration too.
--
-- The code is live a few minutes before this runs: the switch reads as on
-- without the column (42703), the rules list reads without always_review,
-- and the decision log writes without review_shown (PGRST204).
-- pg-test: covered-by tests/pg/one-click-review-controls.pg.test.ts

-- Never queue every write behind a long transaction: fail the migration job
-- instead and retry.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS direct_booking_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.company_settings.direct_booking_enabled IS
  'One click on a bank row''s suggestion books it without a review when the direct-booking policy allows it (default true). False: every suggestion, on the bank rows and in the Inkorg, opens its review first (accounted#130).';

ALTER TABLE public.categorization_templates
  ADD COLUMN IF NOT EXISTS always_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.categorization_templates.always_review IS
  'A person set this rule to ask for a review on every booking: its suggestion never books with one click, on the bank rows or in the Inkorg. Set through PATCH /api/rules/[id]; audited by audit_categorization_templates_update.';

ALTER TABLE public.suggestion_log
  ADD COLUMN IF NOT EXISTS review_shown boolean;

COMMENT ON COLUMN public.suggestion_log.review_shown IS
  'Whether the person saw the booking''s review before it was booked: false for a bank row''s one click, true when it was booked from Granska bokföring. NULL when the door does not say, and on rows written before this column existed.';

NOTIFY pgrst, 'reload schema';
