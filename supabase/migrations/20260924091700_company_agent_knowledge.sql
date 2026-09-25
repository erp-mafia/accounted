-- Agenter: the company chooses what each agent knows. An agent ships with
-- default knowledge (src/lib/agent-skills/agents.ts); a row here adds a
-- knowledge pack to it (included = true) or takes a default away
-- (included = false) for this company. get_task reads the result.
--
-- agent_id is a curated agent id ('quarterly-vat-review') or an own agent
-- ('own/<company_skills.id>'). Only live, exposed, top-level packs can be
-- added: a reference file travels with its pack, and a withdrawn pack never
-- comes back through a company's choice.
CREATE TABLE public.company_agent_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agent_id text NOT NULL CHECK (agent_id ~ '^(own/[0-9a-f-]{36}|[a-z0-9][a-z0-9-]{0,63})$'),
  atom_id text NOT NULL REFERENCES public.agent_atom_registry(id) ON DELETE CASCADE,
  included boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_agent_knowledge_one_choice UNIQUE (company_id, agent_id, atom_id)
);

CREATE INDEX company_agent_knowledge_atom_idx ON public.company_agent_knowledge(atom_id);

ALTER TABLE public.company_agent_knowledge ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_agent_knowledge FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_agent_knowledge TO authenticated, service_role;

-- Every member reads what the company's agents know; owners, admins and
-- members change it (viewers cannot), as with the company's own skills.
CREATE POLICY company_agent_knowledge_read ON public.company_agent_knowledge FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY company_agent_knowledge_insert ON public.company_agent_knowledge FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_agent_knowledge.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')));
CREATE POLICY company_agent_knowledge_update ON public.company_agent_knowledge FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_agent_knowledge.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_agent_knowledge.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')));
CREATE POLICY company_agent_knowledge_delete ON public.company_agent_knowledge FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = company_agent_knowledge.company_id AND cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')));

CREATE FUNCTION public.guard_company_agent_knowledge() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.included AND NOT EXISTS (
    SELECT 1 FROM public.agent_atom_registry a
    WHERE a.id = NEW.atom_id AND a.is_active AND a.mcp_exposed AND a.parent_atom_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Knowledge pack is unavailable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.company_id, NEW.agent_id, NEW.atom_id) IS DISTINCT FROM ROW(OLD.company_id, OLD.agent_id, OLD.atom_id) THEN
    RAISE EXCEPTION 'A knowledge choice changes only whether it is included' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_company_agent_knowledge
  BEFORE INSERT OR UPDATE ON public.company_agent_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_agent_knowledge();

CREATE TRIGGER set_updated_at_company_agent_knowledge
  BEFORE UPDATE ON public.company_agent_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_company_agent_knowledge
  AFTER INSERT OR UPDATE OR DELETE ON public.company_agent_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
