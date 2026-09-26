-- A company's own knowledge (company_skills, kind 'rules') can be given to a
-- flow, as Accounted's packs can. A choice now points at either a registry
-- pack (atom_id) or an own knowledge item (own_skill_id), never both. Own
-- knowledge is never a default, so it is only ever added (included = true);
-- deleting the item deletes the choice.

ALTER TABLE public.company_agent_knowledge
  ADD COLUMN own_skill_id uuid REFERENCES public.company_skills(id) ON DELETE CASCADE;
ALTER TABLE public.company_agent_knowledge ALTER COLUMN atom_id DROP NOT NULL;
ALTER TABLE public.company_agent_knowledge
  ADD CONSTRAINT company_agent_knowledge_one_target CHECK (num_nonnulls(atom_id, own_skill_id) = 1);
-- NULLs are distinct, so pack rows never collide here and own rows never
-- collide in company_agent_knowledge_one_choice: both stay usable as upsert targets.
ALTER TABLE public.company_agent_knowledge
  ADD CONSTRAINT company_agent_knowledge_one_own_choice UNIQUE (company_id, agent_id, own_skill_id);
CREATE INDEX company_agent_knowledge_own_skill_idx ON public.company_agent_knowledge(own_skill_id);

CREATE OR REPLACE FUNCTION public.guard_company_agent_knowledge() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.atom_id IS NOT NULL AND NEW.included AND NOT EXISTS (
    SELECT 1 FROM public.agent_atom_registry a
    WHERE a.id = NEW.atom_id AND a.is_active AND a.mcp_exposed AND a.parent_atom_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Knowledge pack is unavailable' USING ERRCODE = '23514';
  END IF;
  IF NEW.own_skill_id IS NOT NULL THEN
    IF NOT NEW.included THEN
      RAISE EXCEPTION 'Own knowledge is never a default, so it cannot be taken away' USING ERRCODE = '23514';
    END IF;
    -- The company's own (or its team's), knowledge, added by a person and not withdrawn.
    IF NOT EXISTS (
      SELECT 1 FROM public.company_skills cs
      WHERE cs.id = NEW.own_skill_id AND cs.kind = 'rules' AND cs.draft IS NOT TRUE
        AND cs.share_status <> 'withdrawn' AND cs.atom_id IS NULL
        AND (cs.company_id = NEW.company_id
          OR cs.team_id = (SELECT c.team_id FROM public.companies c WHERE c.id = NEW.company_id))
    ) THEN
      RAISE EXCEPTION 'Own knowledge is unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.company_id, NEW.agent_id, NEW.atom_id, NEW.own_skill_id) IS DISTINCT FROM ROW(OLD.company_id, OLD.agent_id, OLD.atom_id, OLD.own_skill_id) THEN
    RAISE EXCEPTION 'A knowledge choice changes only whether it is included' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
