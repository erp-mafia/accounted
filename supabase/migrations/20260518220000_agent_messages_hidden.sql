-- Migration: agent_messages.hidden — mark synthetic prompt-template messages
--
-- The first user message of an intent-invoked conversation IS the rendered
-- promptTemplate. The agent sees it as context; the human never typed it.
-- On a fresh-open the UI never renders it because we just stream the
-- assistant response in. On /chat/[id] resume, however, agent_messages is
-- replayed verbatim and the synthetic message surfaces as a literal user
-- bubble — exposing internal scaffolding ("Användaren öppnade ditt fönster
-- med 'Fråga min revisor'…") to the user.
--
-- This flag lets the UI hydrate skipping these rows while loadConversation
-- Messages still includes them in the Anthropic context (so the agent
-- doesn't lose first-turn anchoring on subsequent turns).

ALTER TABLE public.agent_messages
  ADD COLUMN hidden boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
