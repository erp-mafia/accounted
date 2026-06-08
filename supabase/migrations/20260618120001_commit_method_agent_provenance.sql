-- Agent attribution into the immutable layer (agent_first_vision.md §8 P0-1).
--
-- journal_entries.commit_method could not record that a commit was approved
-- through an agent credential: the MCP approve path hardcoded 'user_accept',
-- so an auditor reading the immutable GL could not distinguish agent-relayed
-- acknowledgments from first-party human sessions. BFNAR 2013:2 kap 8
-- (behandlingshistorik) requires automated processing to be identifiable.
--
--   'api_key' — approval relayed by an agent authenticating with a gnubok_sk_
--               API key. This covers ALL MCP traffic today: the gnubok-mcp
--               bridge AND the claude.ai OAuth connector, whose access_token
--               is itself a minted API key (app/api/mcp-oauth/token/route.ts)
--               and is indistinguishable from a bridge key at the server.
--   'agent'   — reserved for first-party agent surfaces (e.g. in-app agent
--               chat) once they commit through the approval layer with a
--               distinguishable actor type. Not written by any path yet.
--
-- Web-UI approvals keep 'user_accept' / 'bulk_accept'. Every path remains
-- human-approval-gated; agent auto-commit stays removed (20260505190027).

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_commit_method_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_commit_method_check
  CHECK (commit_method IS NULL OR commit_method IN (
    'user_accept', 'bulk_accept', 'timing_ceiling', 'migration', 'legacy',
    'agent', 'api_key'
  ));

NOTIFY pgrst, 'reload schema';
