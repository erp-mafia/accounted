-- A question closed as settled says where the answer is: a short note and
-- the records that hold it.
--
--   close_note      on a question closed as settled: where the answer is, 1
--                   to 300 characters after trimming; NULL otherwise
--   close_evidence  [{ "kind": "...", "id": "..." }]: the records that hold
--                   the answer, at most eight; [] otherwise
--
-- Both are written by the server only (src/lib/questions), which checks the
-- records and the amounts in the note before the row is written. Members
-- read them with the row: the policy and the grants of the table are as they
-- were.
--
-- pg-test: covered-by tests/pg/company-questions.pg.test.ts

ALTER TABLE public.company_questions
  ADD COLUMN close_note text,
  ADD COLUMN close_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.company_questions
  ADD CONSTRAINT company_questions_close_note
    CHECK (close_note IS NULL OR char_length(btrim(close_note)) BETWEEN 1 AND 300),
  ADD CONSTRAINT company_questions_close_evidence
    CHECK (CASE WHEN jsonb_typeof(close_evidence) = 'array' THEN jsonb_array_length(close_evidence) <= 8 ELSE false END),
  -- A note or a non-empty list of records only on a question closed as
  -- settled. IS NOT DISTINCT FROM: a row without a close_reason has neither.
  ADD CONSTRAINT company_questions_settled_note
    CHECK (
      (close_note IS NULL AND close_evidence = '[]'::jsonb)
      OR close_reason IS NOT DISTINCT FROM 'settled'
    );

COMMENT ON COLUMN public.company_questions.close_note IS
  'On a question closed as settled: where the answer is, in 1 to 300 characters. NULL on every other row.';
COMMENT ON COLUMN public.company_questions.close_evidence IS
  'On a question closed as settled: the records that hold the answer, as [{ "kind", "id" }], at most eight. [] on every other row.';

NOTIFY pgrst, 'reload schema';
