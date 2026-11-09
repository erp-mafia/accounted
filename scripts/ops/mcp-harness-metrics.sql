-- READ ONLY. How agents work the MCP surface, per client: the before/after
-- measure for a change to the server instructions, tool descriptions or the
-- tools/list catalog. Run it for a window before the change and an equal
-- window after it (edit `params`), then compare the rows client by client.
--
-- Unit: an episode = one API key's calls with no gap over 30 minutes. Not the
-- Mcp-Session-Id: most clients never send one back (stateless clients never
-- initialize, and some open a new session per call), so per-session numbers
-- describe the few clients that echo it, not the traffic.
--
-- Columns
--   episodes         episodes that started in the window
--   med_calls        median tool calls per episode (fewer for the same work
--   p90_calls        = fewer round trips; read next to the error columns)
--   pct_discovery    share of calls spent finding things: search_tools,
--                    list_skills, load_skill, get_agent_briefing
--   pct_error        share of calls that returned isError
--   pct_wrong_shape  share of calls the server refused before the tool ran:
--                    unknown_tool, invalid_arguments, bridge_refused (an agent
--                    that could not find or call the tool it wanted)
--
-- Read a change as a win only when med_calls or pct_discovery drop without
-- pct_error or pct_wrong_shape rising, on the clients the change reaches.
with
params as (
  select now() - interval '14 days' as from_ts, now() as to_ts
),
calls as (
  select
    l.data->>'actorId' as actor,
    l.data->>'tool' as tool,
    l.created_at,
    coalesce(nullif(l.data->>'client', ''), '(none)') as client,
    coalesce((l.data->>'isError')::boolean, false) as is_err,
    l.data->>'errorKind' as error_kind
  from event_log l, params p
  where l.event_type = 'mcp.tool_called'
    and l.created_at >= p.from_ts
    and l.created_at < p.to_ts
    and l.data->>'actorId' is not null
),
marked as (
  select
    *,
    case
      when lag(created_at) over w is null then 1
      when created_at - lag(created_at) over w > interval '30 minutes' then 1
      else 0
    end as starts_episode
  from calls
  window w as (partition by actor order by created_at)
),
numbered as (
  select *, sum(starts_episode) over (partition by actor order by created_at rows unbounded preceding) as episode
  from marked
),
episodes as (
  select
    actor,
    episode,
    mode() within group (order by client) as client,
    count(*) as n,
    count(*) filter (
      where tool like '%search_tools' or tool like '%list_skills'
         or tool like '%load_skill' or tool like '%get_agent_briefing'
    ) as discovery_calls,
    count(*) filter (where is_err) as error_calls,
    count(*) filter (where error_kind in ('unknown_tool', 'invalid_arguments', 'bridge_refused')) as wrong_shape_calls
  from numbered
  group by actor, episode
)
select
  coalesce(client, 'ALL') as client,
  count(*) as episodes,
  percentile_cont(0.5) within group (order by n) as med_calls,
  percentile_cont(0.9) within group (order by n) as p90_calls,
  round(100.0 * sum(discovery_calls) / sum(n), 1) as pct_discovery,
  round(100.0 * sum(error_calls) / sum(n), 2) as pct_error,
  round(100.0 * sum(wrong_shape_calls) / sum(n), 2) as pct_wrong_shape
from episodes
group by rollup (client)
order by count(*) desc;
