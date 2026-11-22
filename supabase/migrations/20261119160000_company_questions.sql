-- Questions put to a company: one row per question, with the records it
-- rests on, who filed it and how it ended.
--
--   status        open, answered or closed
--   close_reason  on a closed question: dont_know (the person could not say),
--                 not_relevant (the person does not want it asked), settled
--                 (the books answered it), withdrawn (the asker took it back)
--   options       [{ "id": "...", "label": "..." }], at most three
--   evidence      [{ "kind": "...", "id": "..." }]: the records the question
--                 rests on, at most eight
--   fingerprint   sha256 over the sorted evidence references: one question
--                 per company and fingerprint, whatever its status
--   actor_*       the credential that filed it, named as on pending_operations
--   client        the MCP client label of the connection that filed it
--   answered_*    who answered or closed it, when, and through which door
--   fact_id       the saved fact that answered it, when one did
--
-- Members read their companies' questions. Every write goes through the
-- server (src/lib/questions), which checks the evidence, the amounts and the
-- limits before a row is written: no write policy for members.
--
-- pg-test: covered-by tests/pg/company-questions.pg.test.ts

CREATE TABLE public.company_questions (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  close_reason       text CHECK (close_reason IN ('dont_know', 'not_relevant', 'settled', 'withdrawn')),
  question           text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  why                text CHECK (why IS NULL OR char_length(why) BETWEEN 1 AND 500),
  options            jsonb NOT NULL DEFAULT '[]'::jsonb
                     CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 3),
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb
                     CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 8),
  fingerprint        text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type         text CHECK (actor_type IS NULL OR char_length(actor_type) <= 40),
  actor_id           text CHECK (actor_id IS NULL OR char_length(actor_id) <= 100),
  actor_label        text CHECK (actor_label IS NULL OR char_length(actor_label) <= 200),
  client             text CHECK (client IS NULL OR char_length(client) <= 100),
  answer_option      text CHECK (answer_option IS NULL OR char_length(answer_option) <= 40),
  answer_text        text CHECK (answer_text IS NULL OR char_length(answer_text) <= 2000),
  answered_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  answered_at        timestamptz,
  answered_via       text CHECK (answered_via IS NULL OR char_length(answered_via) <= 60),
  fact_id            uuid REFERENCES public.agent_memory(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_questions_company_fingerprint UNIQUE (company_id, fingerprint),
  CONSTRAINT company_questions_close_reason CHECK ((status = 'closed') = (close_reason IS NOT NULL)),
  CONSTRAINT company_questions_ended CHECK ((status = 'open') = (answered_at IS NULL))
);

COMMENT ON TABLE public.company_questions IS
  'One row per question put to a company: its text, up to three answer options, the records it rests on (evidence), who filed it and how it ended. Written by the server only (src/lib/questions).';
COMMENT ON COLUMN public.company_questions.fingerprint IS
  'sha256 over the sorted evidence references (kind:id). Unique per company, whatever the status, so the same records are asked about once.';
COMMENT ON COLUMN public.company_questions.answered_at IS
  'When the question was answered or closed. NULL exactly while it is open.';
COMMENT ON COLUMN public.company_questions.answered_via IS
  'The door the answer or the close came through, e.g. the MCP client label.';
COMMENT ON COLUMN public.company_questions.fact_id IS
  'The agent_memory fact that answered the question, when one did.';

CREATE INDEX idx_company_questions_company_status
  ON public.company_questions (company_id, status);

CREATE INDEX idx_company_questions_fact
  ON public.company_questions (fact_id)
  WHERE fact_id IS NOT NULL;

ALTER TABLE public.company_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read company_questions"
  ON public.company_questions FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.company_questions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_questions TO service_role;
-- no-grant: anon on public.company_questions (company-scoped: members only)

CREATE TRIGGER set_updated_at_company_questions
  BEFORE UPDATE ON public.company_questions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
