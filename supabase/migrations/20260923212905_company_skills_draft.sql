-- Own skills an AI saves over MCP (gnubok_create_skill) arrive as drafts:
-- listed on the Skills page, never loadable by an agent until a person adds
-- them there. Skills written in the app are added from the start.
ALTER TABLE public.company_skills ADD COLUMN draft boolean NOT NULL DEFAULT false;
