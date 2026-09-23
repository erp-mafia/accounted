-- Arkiv phase 9e: the meter on what the pipeline does for a company.
--
-- One row per company, day and activity, added to as the work happens:
-- documents that went through the door, pages read (and of those, pages the
-- vision model transcribed), extractions, and questions asked of documents.
-- Sizes and packs are priced per rolling year on these numbers; until then
-- they are shown, never enforced. Members read their own; the service adds.

CREATE TABLE public.arkiv_usage_daily (
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  day         date NOT NULL,
  activity    text NOT NULL CHECK (activity IN ('documents', 'pages_read', 'pages_vision', 'extractions', 'asks')),
  units       integer NOT NULL DEFAULT 0 CHECK (units >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, day, activity)
);

COMMENT ON TABLE public.arkiv_usage_daily IS
  'Arkiv phase 9e: daily counts of what the pipeline read and answered per company. Operational, recomputable in spirit, not räkenskapsinformation.';

ALTER TABLE public.arkiv_usage_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company arkiv usage"
  ON public.arkiv_usage_daily FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- The pipeline runs as the service role; nobody else adds to the meter.
CREATE OR REPLACE FUNCTION public.arkiv_usage_add(p_company_id uuid, p_activity text, p_units integer, p_day date DEFAULT CURRENT_DATE)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.arkiv_usage_daily (company_id, day, activity, units)
  VALUES (p_company_id, p_day, p_activity, GREATEST(p_units, 0))
  ON CONFLICT (company_id, day, activity)
  DO UPDATE SET units = public.arkiv_usage_daily.units + EXCLUDED.units, updated_at = now();
$$;

REVOKE ALL ON FUNCTION public.arkiv_usage_add(uuid, text, integer, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arkiv_usage_add(uuid, text, integer, date) TO service_role;
