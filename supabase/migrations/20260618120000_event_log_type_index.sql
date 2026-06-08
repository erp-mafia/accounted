-- Telemetry analytics index for event_log.
--
-- mcp.tool_called / mcp.skill_loaded / agent.feedback analytics filter by
-- event_type + time window (error rate per tool, feedback themes, skill-load
-- correlation). The existing indexes cover only (user_id, sequence) for
-- delivery polling and (created_at) for TTL cleanup — every per-type query
-- was a full scan. Also serves the differentiated-retention deletes in
-- /api/events/cleanup/cron (telemetry kept 180 days, delivery events 30).
CREATE INDEX IF NOT EXISTS idx_event_log_type_created
  ON public.event_log (event_type, created_at);

NOTIFY pgrst, 'reload schema';
