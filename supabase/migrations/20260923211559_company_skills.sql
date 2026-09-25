-- Company and accounting-firm skills share one tenant-scoped collection.
-- Extend the deployed constraint, preserving tiers introduced independently.
-- Staging also has a product tier; replacing its allowlist would reject data.
DO $$
DECLARE existing_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO existing_check FROM pg_constraint
    WHERE conrelid = 'public.agent_atom_registry'::regclass AND conname = 'agent_atom_registry_tier_check';
  IF existing_check IS NULL THEN RAISE EXCEPTION 'Missing atom tier constraint'; END IF;
  ALTER TABLE public.agent_atom_registry DROP CONSTRAINT agent_atom_registry_tier_check;
  EXECUTE 'ALTER TABLE public.agent_atom_registry ADD CONSTRAINT agent_atom_registry_tier_check CHECK ((' || existing_check || ') OR tier = ''community'')';
END;
$$;
ALTER TABLE public.agent_atom_registry ADD COLUMN reviewed_at timestamptz;

CREATE TABLE public.company_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE,
  atom_id text REFERENCES public.agent_atom_registry(id),
  name text,
  description text,
  body text,
  share_status text NOT NULL DEFAULT 'private' CHECK (share_status IN ('private', 'submitted', 'published', 'withdrawn')),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  share_confirmed_at timestamptz,
  author_handle text CHECK (author_handle ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  submission_body_hash text,
  published_atom_id text REFERENCES public.agent_atom_registry(id),
  reviewed_at timestamptz,
  review_url text,
  CONSTRAINT company_skills_one_scope CHECK (num_nonnulls(company_id, team_id) = 1),
  CONSTRAINT company_skills_content CHECK (
    (atom_id IS NOT NULL AND body IS NULL AND name IS NULL AND description IS NULL AND share_status = 'private') OR
    (atom_id IS NULL AND length(btrim(name)) BETWEEN 1 AND 120 AND name IS NOT NULL
      AND description IS NOT NULL AND length(description) BETWEEN 1 AND 500
      AND body IS NOT NULL AND octet_length(body) BETWEEN 1 AND 32768)
  ),
  CONSTRAINT company_skills_share_consent CHECK (
    share_status = 'private' OR (share_confirmed_at IS NOT NULL AND author_handle IS NOT NULL AND submission_body_hash IS NOT NULL)
  )
);
CREATE INDEX company_skills_company_idx ON public.company_skills(company_id);
CREATE INDEX company_skills_team_idx ON public.company_skills(team_id);
CREATE INDEX company_skills_creator_idx ON public.company_skills(created_by);
CREATE INDEX company_skills_atom_idx ON public.company_skills(atom_id);
CREATE INDEX company_skills_published_atom_idx ON public.company_skills(published_atom_id);
CREATE INDEX company_skills_review_idx ON public.company_skills(share_status) WHERE share_status <> 'private';
CREATE UNIQUE INDEX company_skills_company_atom_key ON public.company_skills(company_id, atom_id) WHERE atom_id IS NOT NULL;
CREATE UNIQUE INDEX company_skills_team_atom_key ON public.company_skills(team_id, atom_id) WHERE atom_id IS NOT NULL;

ALTER TABLE public.company_skills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_skills FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_skills TO authenticated, service_role;

-- A firm's instructions are inherited by its companies. Company members may
-- read them; only firm owners/admins may change instructions for the whole firm.
CREATE POLICY company_skills_read ON public.company_skills FOR SELECT TO authenticated USING (
  company_id IN (SELECT public.user_company_ids()) OR
  team_id IN (SELECT tm.team_id FROM public.team_members tm WHERE tm.user_id = auth.uid()) OR
  team_id IN (SELECT c.team_id FROM public.companies c WHERE c.id IN (SELECT public.user_company_ids()))
);
CREATE POLICY company_skills_insert ON public.company_skills FOR INSERT TO authenticated WITH CHECK (
  created_by = auth.uid() AND (
    (company_id IN (SELECT public.user_company_ids()) AND EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_skills.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member'))) OR
    EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = company_skills.team_id AND tm.user_id = auth.uid() AND tm.role IN ('owner', 'admin'))
  )
);
CREATE POLICY company_skills_update ON public.company_skills FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_skills.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')) OR
  EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = company_skills.team_id AND tm.user_id = auth.uid() AND tm.role IN ('owner', 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_skills.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')) OR
  EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = company_skills.team_id AND tm.user_id = auth.uid() AND tm.role IN ('owner', 'admin'))
);
CREATE POLICY company_skills_delete ON public.company_skills FOR DELETE TO authenticated USING (
  share_status = 'private' AND (
    EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_skills.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')) OR
    EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = company_skills.team_id AND tm.user_id = auth.uid() AND tm.role IN ('owner', 'admin'))
  )
);

CREATE FUNCTION public.guard_company_skill_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.atom_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.agent_atom_registry a WHERE a.id = NEW.atom_id AND a.is_active AND a.mcp_exposed AND a.parent_atom_id IS NULL AND a.tier <> 'horizontal') THEN
      RAISE EXCEPTION 'Skill is unavailable or always enabled' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF current_user = 'authenticated' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.share_status <> 'private' OR NEW.published_atom_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_url IS NOT NULL THEN
        RAISE EXCEPTION 'New skills must be private' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF ROW(NEW.company_id, NEW.team_id, NEW.created_by, NEW.created_at, NEW.atom_id, NEW.published_atom_id, NEW.reviewed_at, NEW.review_url)
        IS DISTINCT FROM ROW(OLD.company_id, OLD.team_id, OLD.created_by, OLD.created_at, OLD.atom_id, OLD.published_atom_id, OLD.reviewed_at, OLD.review_url) THEN
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
$$;
CREATE TRIGGER company_skills_guard BEFORE INSERT OR UPDATE ON public.company_skills
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_skill_change();
CREATE TRIGGER company_skills_updated_at BEFORE UPDATE ON public.company_skills
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER company_skills_audit AFTER INSERT OR UPDATE OR DELETE ON public.company_skills
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
