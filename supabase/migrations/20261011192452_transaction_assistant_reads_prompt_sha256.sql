-- Which prompt produced each assistant read.
--
-- suggestion_log copies the stored read's model and prompt hash into the
-- suggestions it records, so a decision can be tied to the exact prompt the
-- model saw. The hash is SHA-256 over the system prompt and the per-row
-- prompt (lib/agent/categorize/select-account.ts); the prompt itself is not
-- stored. Reads stored before this column keep NULL.

ALTER TABLE public.transaction_assistant_reads
  ADD COLUMN prompt_sha256 text;

COMMENT ON COLUMN public.transaction_assistant_reads.prompt_sha256 IS
  'SHA-256 (hex) of the system prompt and prompt that produced this read; NULL for reads stored before it was kept.';

NOTIFY pgrst, 'reload schema';
