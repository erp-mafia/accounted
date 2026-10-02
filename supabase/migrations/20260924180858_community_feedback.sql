-- Community upvotes on shared agent instructions (Agentinstruktioner).
--
-- 1. The kind of a shared item (company_skills.kind, added by
--    20260924180657_company_skills_kind) is frozen once the item is submitted,
--    like the name and body (guard_company_skill_change), and read through
--    published_atom_id once the reviewer has published it.
-- 2. community_feedback: one row per (community item, user) holding that
--    person's upvote. A user reads and writes only their own row; everyone
--    sees the counts through community_item_stats(), which returns aggregates
--    and public listing data only, never a company or user.

-- 1. The kind is part of the frozen submission
CREATE FUNCTION public.freeze_company_skill_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' AND OLD.share_status <> 'private' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'Submitted content is frozen for review' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_skills_kind_frozen BEFORE UPDATE ON public.company_skills
  FOR EACH ROW EXECUTE FUNCTION public.freeze_company_skill_kind();

-- 2. Upvotes
CREATE TABLE public.community_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  atom_id text NOT NULL REFERENCES public.agent_atom_registry(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vote boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_feedback_one_per_user UNIQUE (atom_id, user_id)
);
CREATE INDEX community_feedback_user_idx ON public.community_feedback(user_id);
CREATE INDEX community_feedback_company_idx ON public.community_feedback(company_id);

ALTER TABLE public.community_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.community_feedback FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_feedback TO authenticated, service_role;

-- A person's own row, given from a company they belong to. Counts across
-- users come only from community_item_stats().
CREATE POLICY community_feedback_read ON public.community_feedback FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY community_feedback_insert ON public.community_feedback FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT public.user_company_ids()));
CREATE POLICY community_feedback_update ON public.community_feedback FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT public.user_company_ids()));
CREATE POLICY community_feedback_delete ON public.community_feedback FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Only live, published community items can be voted on, and a row stays on its
-- item and its person.
CREATE FUNCTION public.guard_community_feedback() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.atom_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.atom_id, OLD.user_id) THEN
    RAISE EXCEPTION 'Feedback stays on its item and its person' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_atom_registry a
    WHERE a.id = NEW.atom_id AND a.tier = 'community' AND a.is_active AND a.mcp_exposed AND a.parent_atom_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Only live community items can be voted on' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_community_feedback
  BEFORE INSERT OR UPDATE ON public.community_feedback
  FOR EACH ROW EXECUTE FUNCTION public.guard_community_feedback();
CREATE TRIGGER set_updated_at_community_feedback
  BEFORE UPDATE ON public.community_feedback
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER audit_community_feedback
  AFTER INSERT OR UPDATE OR DELETE ON public.community_feedback
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- Everything the catalog shows about a live community item, in one read:
-- its kind, its author, how many items the author has published,
-- whether the author is an accounting firm (a byrå team), the upvote
-- count, and how many companies loaded it (mcp.skill_loaded, as far back as
-- event_log keeps skill loads). SECURITY DEFINER because votes, submissions
-- and loads belong to other tenants; only public listing data and counts
-- leave the function.
CREATE FUNCTION public.community_item_stats()
RETURNS TABLE (
  atom_id text, kind text, author text,
  author_shared integer, author_verified boolean, votes integer, used_by integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH items AS (
    SELECT a.id FROM public.agent_atom_registry a
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
  authors AS (
    SELECT l.author_handle, count(*)::integer AS shared FROM listing l GROUP BY l.author_handle
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
  SELECT i.id, COALESCE(l.kind, 'workflow'), l.author_handle,
    COALESCE(au.shared, 0), COALESCE(l.verified, false),
    COALESCE(an.votes, 0), COALESCE(lo.companies, 0)
  FROM items i
  LEFT JOIN listing l ON l.atom_id = i.id
  LEFT JOIN authors au ON au.author_handle = l.author_handle
  LEFT JOIN upvotes an ON an.atom_id = i.id
  LEFT JOIN loads lo ON lo.atom_id = i.id
  ORDER BY i.id;
$$;
REVOKE ALL ON FUNCTION public.community_item_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.community_item_stats() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
