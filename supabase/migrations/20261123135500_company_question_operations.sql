-- The staged operations a question's answer led to: one row per question
-- and pending operation.
--
--   question_id   the question (company_questions)
--   operation_id  the staged operation (pending_operations)
--   company_id    the company both belong to
--
-- A pair is linked once. Members read their companies' rows. Every write
-- goes through the server (src/lib/questions), which checks the question's
-- status, the operation's company and who staged it before a row is written:
-- no write policy for members.
--
-- pg-test: covered-by tests/pg/company-question-operations.pg.test.ts

CREATE TABLE public.company_question_operations (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  question_id  uuid NOT NULL REFERENCES public.company_questions(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES public.pending_operations(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_question_operations_pair UNIQUE (question_id, operation_id)
);

COMMENT ON TABLE public.company_question_operations IS
  'One row per question and staged operation: the pending operations that were staged because of a question''s answer. Written by the server only (src/lib/questions).';

CREATE INDEX idx_company_question_operations_operation
  ON public.company_question_operations (operation_id);

CREATE INDEX idx_company_question_operations_company
  ON public.company_question_operations (company_id);

ALTER TABLE public.company_question_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read company_question_operations"
  ON public.company_question_operations FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.company_question_operations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_question_operations TO service_role;
-- no-grant: anon on public.company_question_operations (company-scoped: members only)

NOTIFY pgrst, 'reload schema';
