-- What an own item is, as the Agentinstruktioner page shows it: a flow the AI
-- runs, knowledge it is given, or an analysis. Chosen when the item is written
-- (by hand in the app or by the AI); every existing own item is a flow.
ALTER TABLE public.company_skills ADD COLUMN kind text NOT NULL DEFAULT 'workflow'
  CHECK (kind IN ('workflow', 'rules', 'analysis'));
