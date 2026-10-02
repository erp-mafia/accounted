-- Community sharing, before it opens to every company:
--
-- 1. "Dra tillbaka" returns a shared item to 'private'. It used to set
--    'withdrawn', a state with no way out: the author's own AI lost the item
--    and it could not be deleted. 'withdrawn' is gone and its one row is
--    private again. Leaving review also drops the review evidence (approval,
--    publication link, notification), so a later share is reviewed afresh;
--    the author's own withdrawal drops an old send-back note as well.
-- 2. When a submitted or published item leaves review, its community atom
--    (when the text was already merged) is hidden from every AI at once and
--    marked withdrawn_at: the hourly sync keeps it hidden, and the review
--    list asks Accounted to remove the folder from the public repository.
--    The mark sticks: a sync that read the atom before the withdrawal and
--    writes it back afterwards can neither drop it nor expose the text.
-- 3. published_notified_at: when the author was told the item is live on
--    accounted.se ("Din instruktion är publicerad"). Set by Accounted only.

ALTER TABLE public.company_skills ADD COLUMN published_notified_at timestamptz;

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
      IF NEW.share_status <> 'private' OR NEW.published_atom_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_url IS NOT NULL OR NEW.review_note IS NOT NULL OR NEW.approved_body_sha IS NOT NULL OR NEW.published_notified_at IS NOT NULL THEN
        RAISE EXCEPTION 'New skills must be private' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF ROW(NEW.company_id, NEW.team_id, NEW.created_by, NEW.created_at, NEW.atom_id, NEW.published_atom_id, NEW.reviewed_at, NEW.review_url, NEW.review_note, NEW.approved_body_sha, NEW.published_notified_at)
        IS DISTINCT FROM ROW(OLD.company_id, OLD.team_id, OLD.created_by, OLD.created_at, OLD.atom_id, OLD.published_atom_id, OLD.reviewed_at, OLD.review_url, OLD.review_note, OLD.approved_body_sha, OLD.published_notified_at) THEN
        RAISE EXCEPTION 'Skill ownership and review evidence are immutable' USING ERRCODE = '42501';
      END IF;
      IF OLD.share_status <> 'private' AND ROW(NEW.name, NEW.description, NEW.body, NEW.author_handle, NEW.share_confirmed_at, NEW.submission_body_hash)
        IS DISTINCT FROM ROW(OLD.name, OLD.description, OLD.body, OLD.author_handle, OLD.share_confirmed_at, OLD.submission_body_hash) THEN
        RAISE EXCEPTION 'Submitted content is frozen for review' USING ERRCODE = '42501';
      END IF;
      IF NEW.share_status <> OLD.share_status AND NOT (
        (OLD.share_status = 'private' AND NEW.share_status = 'submitted') OR
        (OLD.share_status IN ('submitted', 'published') AND NEW.share_status = 'private')
      ) THEN
        RAISE EXCEPTION 'Invalid skill sharing transition' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF NEW.share_status = 'submitted' AND (TG_OP = 'INSERT' OR OLD.share_status = 'private') THEN
    NEW.submission_body_hash := encode(extensions.digest(NEW.body, 'sha256'), 'hex');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Leaving review: what was approved or published no longer holds.
    IF NEW.share_status = 'private' AND OLD.share_status IN ('submitted', 'published') THEN
      NEW.approved_body_sha := NULL;
      NEW.published_atom_id := NULL;
      NEW.reviewed_at := NULL;
      NEW.review_url := NULL;
      NEW.published_notified_at := NULL;
      -- The author withdrew it; Accounted's send-back writes its note in this same update.
      IF current_user = 'authenticated' THEN
        NEW.review_note := NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- The merged text of an item that left review stops reaching AIs now, not at
-- the next sync, and stays hidden until the folder is removed on GitHub.
CREATE FUNCTION public.hide_withdrawn_community_item()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.agent_atom_registry a
     SET mcp_exposed = false,
         trigger_signals = (a.trigger_signals - 'approved_sha') || jsonb_build_object('withdrawn_at', now()),
         updated_at = now()
   WHERE a.tier = 'community' AND a.parent_atom_id IS NULL
     AND (a.id = OLD.published_atom_id OR a.trigger_signals->>'submission' = OLD.id::text);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.hide_withdrawn_community_item() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER company_skills_hide_withdrawn
  AFTER UPDATE OF share_status ON public.company_skills
  FOR EACH ROW
  WHEN (OLD.share_status IN ('submitted', 'published') AND NEW.share_status = 'private')
  EXECUTE FUNCTION public.hide_withdrawn_community_item();

CREATE FUNCTION public.keep_community_withdrawal()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.trigger_signals ? 'withdrawn_at' THEN
    NEW.trigger_signals := (NEW.trigger_signals - 'approved_sha') || jsonb_build_object('withdrawn_at', OLD.trigger_signals->'withdrawn_at');
    NEW.mcp_exposed := false;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_atom_registry_keep_withdrawal
  BEFORE UPDATE ON public.agent_atom_registry
  FOR EACH ROW
  WHEN (OLD.tier = 'community')
  EXECUTE FUNCTION public.keep_community_withdrawal();

UPDATE public.company_skills SET share_status = 'private' WHERE share_status = 'withdrawn';

ALTER TABLE public.company_skills DROP CONSTRAINT company_skills_share_status_check;
ALTER TABLE public.company_skills ADD CONSTRAINT company_skills_share_status_check
  CHECK (share_status IN ('private', 'submitted', 'published'));

NOTIFY pgrst, 'reload schema';
