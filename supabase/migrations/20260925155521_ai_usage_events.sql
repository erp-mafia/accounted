-- What every model call costs (2026-09-25).
--
-- The AI service gets exact token counts back from Bedrock on every call and
-- nothing kept them: ai_usage_tracking went with the old AI subsystem
-- (20260504120000) and the thirteen features that call the model since then
-- never replaced it, so cost could only be estimated. This table keeps one row
-- per call (the tokens are the facts); prices live in their own table so a
-- wrong price is corrected with an UPDATE, not a rewrite; ai_cost_daily turns
-- both into kronor per day, feature and company.
--
-- Internal only: RLS on and no policies, so members see nothing; only the
-- service role writes and reads. Dropping the two tables and the view removes
-- the whole thing.

CREATE TABLE public.ai_usage_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at         timestamptz NOT NULL DEFAULT now(),
  company_id         uuid,
  feature            text NOT NULL,
  tier               text,
  model              text NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0
);

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_usage_events FROM anon, authenticated;
CREATE INDEX idx_ai_usage_events_created_at ON public.ai_usage_events (created_at);
CREATE INDEX idx_ai_usage_events_company_created ON public.ai_usage_events (company_id, created_at);

-- USD per million tokens. model_pattern is matched with LIKE; the longest match wins.
CREATE TABLE public.ai_model_prices (
  model_pattern        text PRIMARY KEY,
  usd_input            numeric NOT NULL,
  usd_output           numeric NOT NULL,
  usd_cache_read       numeric NOT NULL,
  usd_cache_write      numeric NOT NULL,
  sek_per_usd          numeric NOT NULL DEFAULT 10.5,
  note                 text
);

ALTER TABLE public.ai_model_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_model_prices FROM anon, authenticated;

INSERT INTO public.ai_model_prices (model_pattern, usd_input, usd_output, usd_cache_read, usd_cache_write, note) VALUES
  ('%haiku-4-5%', 1, 5, 0.10, 1.25, 'Anthropic list price; check the Bedrock invoice'),
  ('%sonnet-5%', 3, 15, 0.30, 3.75, 'Assumed equal to Sonnet 4 list price; correct with UPDATE when known'),
  ('%sonnet-4%', 3, 15, 0.30, 3.75, 'Anthropic list price');

CREATE VIEW public.ai_cost_daily WITH (security_invoker = true) AS
SELECT
  (e.created_at AT TIME ZONE 'Europe/Stockholm')::date AS day,
  e.feature,
  e.company_id,
  e.model,
  count(*)                    AS calls,
  sum(e.input_tokens)         AS input_tokens,
  sum(e.output_tokens)        AS output_tokens,
  sum(e.cache_read_tokens)    AS cache_read_tokens,
  sum(e.cache_write_tokens)   AS cache_write_tokens,
  round(sum(
    (e.input_tokens * p.usd_input + e.output_tokens * p.usd_output
     + e.cache_read_tokens * p.usd_cache_read + e.cache_write_tokens * p.usd_cache_write)
    / 1000000.0 * p.sek_per_usd
  ), 2)                       AS cost_sek
FROM public.ai_usage_events e
LEFT JOIN LATERAL (
  SELECT * FROM public.ai_model_prices mp
  WHERE e.model LIKE mp.model_pattern
  ORDER BY length(mp.model_pattern) DESC
  LIMIT 1
) p ON true
GROUP BY 1, 2, 3, 4;

REVOKE ALL ON public.ai_cost_daily FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
