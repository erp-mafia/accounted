-- Community publishing through the public repository erp-mafia/accounted-skills
-- (community/<slug>/SKILL.md, MIT). Accounted reviews a shared own item in the
-- app, opens it there as a pull request, and a merge publishes it: an hourly
-- sync (src/lib/agent-skills/community-sync.ts) upserts a tier 'community' atom
-- and marks the submission published. Items contributed straight on GitHub
-- have no submission row, so their kind, author and industries travel on the
-- atom (trigger_signals) and community_item_stats() falls back to them.

-- 1. The reviewer's reason when a submission is sent back (it returns to
--    'private' so the author can fix it and share again). Review evidence:
--    set by Accounted only, never by the author.
ALTER TABLE public.company_skills ADD COLUMN review_note text;

CREATE OR REPLACE FUNCTION public.guard_company_skill_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.atom_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.agent_atom_registry a WHERE a.id = NEW.atom_id AND a.is_active AND a.mcp_exposed AND a.parent_atom_id IS NULL AND a.tier <> 'horizontal') THEN
      RAISE EXCEPTION 'Skill is unavailable or always enabled' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF current_user = 'authenticated' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.share_status <> 'private' OR NEW.published_atom_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_url IS NOT NULL OR NEW.review_note IS NOT NULL THEN
        RAISE EXCEPTION 'New skills must be private' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF ROW(NEW.company_id, NEW.team_id, NEW.created_by, NEW.created_at, NEW.atom_id, NEW.published_atom_id, NEW.reviewed_at, NEW.review_url, NEW.review_note)
        IS DISTINCT FROM ROW(OLD.company_id, OLD.team_id, OLD.created_by, OLD.created_at, OLD.atom_id, OLD.published_atom_id, OLD.reviewed_at, OLD.review_url, OLD.review_note) THEN
        RAISE EXCEPTION 'Skill ownership and review evidence are immutable' USING ERRCODE = '42501';
      END IF;
      IF OLD.share_status <> 'private' AND ROW(NEW.name, NEW.description, NEW.body, NEW.author_handle, NEW.share_confirmed_at, NEW.submission_body_hash)
        IS DISTINCT FROM ROW(OLD.name, OLD.description, OLD.body, OLD.author_handle, OLD.share_confirmed_at, OLD.submission_body_hash) THEN
        RAISE EXCEPTION 'Submitted content is frozen for review' USING ERRCODE = '42501';
      END IF;
      IF NEW.share_status <> OLD.share_status AND NOT (
        (OLD.share_status = 'private' AND NEW.share_status = 'submitted') OR
        (OLD.share_status IN ('submitted', 'published') AND NEW.share_status = 'withdrawn')
      ) THEN
        RAISE EXCEPTION 'Invalid skill sharing transition' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF NEW.share_status = 'submitted' AND (TG_OP = 'INSERT' OR OLD.share_status = 'private') THEN
    NEW.submission_body_hash := encode(extensions.digest(NEW.body, 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. Stats for every live community item, whether it came from an Accounted
--    submission or straight from GitHub. The return type gains industries, so
--    the function is replaced, not altered.
DROP FUNCTION public.community_item_stats();

CREATE FUNCTION public.community_item_stats()
RETURNS TABLE (
  atom_id text, kind text, author text,
  author_shared integer, author_verified boolean, votes integer, used_by integer,
  industries text[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH items AS (
    SELECT a.id, a.trigger_signals FROM public.agent_atom_registry a
    WHERE a.tier = 'community' AND a.is_active AND a.mcp_exposed AND a.parent_atom_id IS NULL
  ),
  listing AS (
    SELECT DISTINCT ON (cs.published_atom_id)
      cs.published_atom_id AS atom_id, cs.kind, cs.author_handle,
      EXISTS (
        SELECT 1 FROM public.teams t
        WHERE t.kind = 'byra' AND t.id = COALESCE(cs.team_id, (SELECT c.team_id FROM public.companies c WHERE c.id = cs.company_id))
      ) AS verified
    FROM public.company_skills cs JOIN items i ON i.id = cs.published_atom_id
    WHERE cs.share_status = 'published'
    ORDER BY cs.published_atom_id, cs.reviewed_at DESC NULLS LAST, cs.id
  ),
  effective AS (
    SELECT i.id,
      COALESCE(l.kind, i.trigger_signals->>'kind', 'workflow') AS kind,
      COALESCE(l.author_handle, i.trigger_signals->>'author') AS author,
      COALESCE(l.verified, false) AS verified,
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.trigger_signals->'industries') = 'array' THEN i.trigger_signals->'industries' ELSE '[]'::jsonb END)), '{}') AS industries
    FROM items i LEFT JOIN listing l ON l.atom_id = i.id
  ),
  authors AS (
    SELECT e.author, count(*)::integer AS shared FROM effective e WHERE e.author IS NOT NULL GROUP BY e.author
  ),
  upvotes AS (
    SELECT f.atom_id, (count(*) FILTER (WHERE f.vote))::integer AS votes
    FROM public.community_feedback f JOIN items i ON i.id = f.atom_id
    GROUP BY f.atom_id
  ),
  loads AS (
    SELECT e.data->>'slug' AS atom_id, (count(DISTINCT e.company_id))::integer AS companies
    FROM public.event_log e
    WHERE e.event_type = 'mcp.skill_loaded' AND e.created_at > now() - interval '180 days'
      AND e.data->>'slug' LIKE 'community/%'
    GROUP BY 1
  )
  SELECT e.id, e.kind, e.author,
    COALESCE(au.shared, 0), e.verified,
    COALESCE(an.votes, 0), COALESCE(lo.companies, 0),
    e.industries
  FROM effective e
  LEFT JOIN authors au ON au.author = e.author
  LEFT JOIN upvotes an ON an.atom_id = e.id
  LEFT JOIN loads lo ON lo.atom_id = e.id
  ORDER BY e.id;
$$;
REVOKE ALL ON FUNCTION public.community_item_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.community_item_stats() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
