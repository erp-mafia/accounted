import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * rollup_agent_telemetry folds whole UTC days of event_log agent telemetry
 * into anonymous daily counts that outlive the 180-day purge. Each test owns
 * its own days far in the past and rolls them from p_since at their start,
 * one per call.
 *
 * The replayed backfill migration ran on an empty event_log and marked every
 * one of the last 180 days as rolled (correctly: they held no telemetry), so
 * each test first takes its own days back out of the ledger.
 */

async function unroll(...days: string[]) {
  await getPool().query(`DELETE FROM public.agent_telemetry_rollup_days WHERE day = ANY ($1::date[])`, [days])
}

function utcDay(daysAgo: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

async function insertEvent(
  owner: { userId: string; companyId: string },
  eventType: string,
  data: Record<string, unknown>,
  createdAt: string,
) {
  await getPool().query(
    `INSERT INTO public.event_log (user_id, company_id, event_type, data, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [owner.userId, owner.companyId, eventType, JSON.stringify(data), createdAt],
  )
}

async function rollup(since: string, maxDays = 1): Promise<number> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ n: number }>(`SELECT public.rollup_agent_telemetry($1::timestamptz, $2) AS n`, [since, maxDays])
    return rows[0].n
  })
}

// Agents send no Mcp-Session-Id in production, so an agent is its API key.
function toolCall(agent: string, tool: string, extra: Record<string, unknown> = {}) {
  return {
    tool,
    success: true,
    isError: false,
    errorCode: null,
    errorKind: null,
    errorMessage: null,
    latencyMs: 100,
    actorType: 'api_key',
    actorId: agent,
    actorLabel: 'Rickards nyckel',
    sessionId: null,
    client: 'claude-code',
    ...extra,
  }
}

describe('rollup_agent_telemetry', () => {
  it('counts a day with every free-text field reduced to a bounded label', async () => {
    const owner = await seedCompany()
    const day = utcDay(40)
    await unroll(day, utcDay(39))
    const agent = randomUUID()
    await insertEvent(owner, 'mcp.tool_called', toolCall(agent, 'gnubok_list_invoices'), `${day}T10:00:00Z`)
    await insertEvent(
      owner,
      'mcp.tool_called',
      toolCall(agent, 'gnubok_book_rent_for_rickard', {
        success: false,
        isError: true,
        errorKind: 'unknown_tool',
        errorCode: 'UNKNOWN_TOOL',
        errorMessage: 'No tool gnubok_book_rent_for_rickard',
        client: 'nexis-rickard-allpages',
      }),
      `${day}T10:01:00Z`,
    )
    await insertEvent(
      owner,
      'mcp.tool_called',
      toolCall(agent, 'gnubok_list_invoices', { success: false, isError: true, errorKind: 'execution', errorCode: 'PERIOD_LOCKED', latencyMs: 300 }),
      `${day}T10:02:00Z`,
    )
    await insertEvent(owner, 'mcp.skill_loaded', { slug: 'rickards-hemliga-skill', tier: 'own', actorId: agent, actorType: 'api_key' }, `${day}T10:03:00Z`)
    await insertEvent(owner, 'mcp.skill_loaded', { slug: 'swedish-vat', tier: 'horizontal', actorId: agent, actorType: 'api_key' }, `${day}T10:04:00Z`)
    await insertEvent(
      owner,
      'agent.feedback',
      { toolName: 'gnubok_list_invoices', sentiment: 'negative', suggestion: 'Rickard needs the rent field', context: 'Hyra 10 540 kr', actorId: agent, actorType: 'api_key' },
      `${day}T10:05:00Z`,
    )
    // The next day waits for the next call: one day per call, oldest first.
    await insertEvent(owner, 'mcp.tool_called', toolCall(randomUUID(), 'gnubok_list_invoices'), `${utcDay(39)}T08:00:00Z`)

    expect(await rollup(`${day}T00:00:00Z`)).toBe(1)

    const { rows } = await getPool().query(
      `SELECT event_type, name, client, actor_type, outcome, error_kind, error_code, events, actors, companies, latency_ms_p50
         FROM public.agent_telemetry_daily WHERE day = $1 ORDER BY event_type COLLATE "C", name COLLATE "C", outcome COLLATE "C"`,
      [day],
    )
    expect(rows).toEqual([
      { event_type: 'agent.feedback', name: 'gnubok_list_invoices', client: '(none)', actor_type: 'api_key', outcome: 'negative', error_kind: '', error_code: '', events: 1, actors: 1, companies: 1, latency_ms_p50: null },
      { event_type: 'mcp.skill_loaded', name: '(own)', client: '(none)', actor_type: 'api_key', outcome: '', error_kind: '', error_code: '', events: 1, actors: 1, companies: 1, latency_ms_p50: null },
      { event_type: 'mcp.skill_loaded', name: 'swedish-vat', client: '(none)', actor_type: 'api_key', outcome: '', error_kind: '', error_code: '', events: 1, actors: 1, companies: 1, latency_ms_p50: null },
      { event_type: 'mcp.tool_called', name: '(unknown_tool)', client: 'other', actor_type: 'api_key', outcome: 'error', error_kind: 'unknown_tool', error_code: 'UNKNOWN_TOOL', events: 1, actors: 1, companies: 1, latency_ms_p50: 100 },
      { event_type: 'mcp.tool_called', name: 'gnubok_list_invoices', client: 'claude-code', actor_type: 'api_key', outcome: 'error', error_kind: 'execution', error_code: 'PERIOD_LOCKED', events: 1, actors: 1, companies: 1, latency_ms_p50: 300 },
      { event_type: 'mcp.tool_called', name: 'gnubok_list_invoices', client: 'claude-code', actor_type: 'api_key', outcome: 'ok', error_kind: '', error_code: '', events: 1, actors: 1, companies: 1, latency_ms_p50: 100 },
    ])

    const transitions = await getPool().query(
      `SELECT client, from_tool, from_outcome, to_tool, to_outcome, transitions
         FROM public.agent_tool_transitions_daily WHERE day = $1 ORDER BY from_tool COLLATE "C", to_tool COLLATE "C"`,
      [day],
    )
    expect(transitions.rows).toEqual([
      { client: 'claude-code', from_tool: '(start)', from_outcome: '', to_tool: 'gnubok_list_invoices', to_outcome: 'ok', transitions: 1 },
      { client: 'claude-code', from_tool: '(unknown_tool)', from_outcome: 'error', to_tool: 'gnubok_list_invoices', to_outcome: 'error', transitions: 1 },
      { client: 'other', from_tool: 'gnubok_list_invoices', from_outcome: 'ok', to_tool: '(unknown_tool)', to_outcome: 'error', transitions: 1 },
    ])

    // Nothing a customer typed survives: no name, label, message or amount.
    const leaked = await getPool().query(
      `SELECT count(*)::int AS n FROM (
         SELECT row_to_json(d)::text AS t FROM public.agent_telemetry_daily d WHERE day = $1
         UNION ALL
         SELECT row_to_json(t)::text FROM public.agent_tool_transitions_daily t WHERE day = $1
       ) x WHERE t ~* '(rickard|nexis|10 540|hemliga)' OR t LIKE '%' || $2 || '%'`,
      [day, owner.companyId],
    )
    expect(leaked.rows[0].n).toBe(0)

    const ledger = await getPool().query(`SELECT day::text FROM public.agent_telemetry_rollup_days WHERE day IN ($1, $2)`, [day, utcDay(39)])
    expect(ledger.rows).toEqual([{ day }])
    expect(await rollup(`${day}T00:00:00Z`)).toBe(1)
    const next = await getPool().query(`SELECT events FROM public.agent_telemetry_daily WHERE day = $1`, [utcDay(39)])
    expect(next.rows).toEqual([{ events: 1 }])
  })

  it('rolls a day once: a second run finds nothing and changes nothing', async () => {
    const owner = await seedCompany()
    const day = utcDay(45)
    await unroll(day)
    await insertEvent(owner, 'mcp.tools_list_called', { toolCount: 42, actorType: 'api_key', client: 'cursor', sessionId: 'x', latencyMs: 12 }, `${day}T09:00:00Z`)

    expect(await rollup(`${day}T00:00:00Z`)).toBe(1)
    expect(await rollup(`${day}T00:00:00Z`)).toBe(0)

    const { rows } = await getPool().query(`SELECT name, client, events FROM public.agent_telemetry_daily WHERE day = $1`, [day])
    expect(rows).toEqual([{ name: '', client: 'cursor', events: 1 }])
  })

  it('never rolls today, nor a day that began before p_since (it may be partly purged)', async () => {
    const owner = await seedCompany()
    const partial = utcDay(50)
    await unroll(partial, utcDay(49))
    await insertEvent(owner, 'mcp.tools_list_called', { toolCount: 1, client: 'zed' }, `${partial}T20:00:00Z`)
    await insertEvent(owner, 'mcp.tools_list_called', { toolCount: 1, client: 'zed' }, `${utcDay(49)}T01:00:00Z`)

    expect(await rollup(`${partial}T02:00:00Z`)).toBe(1)
    const ledger = await getPool().query(`SELECT day::text FROM public.agent_telemetry_rollup_days WHERE day IN ($1, $2) ORDER BY day`, [partial, utcDay(49)])
    expect(ledger.rows).toEqual([{ day: utcDay(49) }])

    expect(await rollup(new Date(Date.now() - 3_600_000).toISOString(), 400)).toBe(0)
    const today = await getPool().query(`SELECT count(*)::int AS n FROM public.agent_telemetry_rollup_days WHERE day >= (now() AT TIME ZONE 'UTC')::date`)
    expect(today.rows[0].n).toBe(0)
  })

  it('gives a session that crossed midnight its real predecessor, and starts a new one after 30 quiet minutes', async () => {
    const owner = await seedCompany()
    const before = utcDay(61)
    const after = utcDay(60)
    await unroll(before, after)
    const agent = randomUUID()
    await insertEvent(owner, 'mcp.tool_called', toolCall(agent, 'gnubok_get_company'), `${before}T23:59:00Z`)
    await insertEvent(owner, 'mcp.tool_called', toolCall(agent, 'gnubok_list_accounts'), `${after}T00:01:00Z`)
    await insertEvent(owner, 'mcp.tool_called', toolCall(agent, 'gnubok_list_invoices'), `${after}T00:32:00Z`)

    expect(await rollup(`${before}T00:00:00Z`)).toBe(1)
    expect(await rollup(`${before}T00:00:00Z`)).toBe(1)

    const { rows } = await getPool().query(
      `SELECT day::text, from_tool, to_tool, actors FROM public.agent_tool_transitions_daily WHERE day IN ($1, $2) ORDER BY day, to_tool COLLATE "C"`,
      [before, after],
    )
    expect(rows).toEqual([
      { day: before, from_tool: '(start)', to_tool: 'gnubok_get_company', actors: 1 },
      { day: after, from_tool: 'gnubok_get_company', to_tool: 'gnubok_list_accounts', actors: 1 },
      { day: after, from_tool: '(start)', to_tool: 'gnubok_list_invoices', actors: 1 },
    ])
  })

  it('maps client markers to public product families and everything else to other', async () => {
    const { rows } = await getPool().query<{ input: string | null; family: string }>(
      `SELECT v.input, public.agent_client_family(v.input) AS family
         FROM (VALUES (NULL), (''), ('claude'), ('claude_desktop'), ('claude-code-probe'), ('chatgpt'), ('codex-api-key'),
                      ('gemeni'), ('gemini-cli'), ('accounted-cli-0.1.0'), ('vscode'), ('nexis-rent88-resume'), ('styrgrupp')) v(input)`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.input ?? 'null', r.family]))).toEqual({
      null: '(none)',
      '': '(none)',
      claude: 'claude',
      claude_desktop: 'claude-desktop',
      'claude-code-probe': 'claude-code',
      chatgpt: 'chatgpt',
      'codex-api-key': 'codex',
      gemeni: 'gemini',
      'gemini-cli': 'gemini',
      'accounted-cli-0.1.0': 'accounted-cli',
      vscode: 'vscode',
      'nexis-rent88-resume': 'other',
      styrgrupp: 'other',
    })
  })

  it('refuses a missing p_since and an out-of-range p_max_days', async () => {
    await expect(rollup(null as unknown as string)).rejects.toThrow(/p_since is required/)
    await expect(rollup(`${utcDay(70)}T00:00:00Z`, 0)).rejects.toThrow(/p_max_days/)
    await expect(rollup(`${utcDay(70)}T00:00:00Z`, 401)).rejects.toThrow(/p_max_days/)
  })

  it('shows a company member nothing and lets only the service role run it', async () => {
    const { userId } = await seedCompany()
    for (const table of ['agent_telemetry_daily', 'agent_tool_transitions_daily', 'agent_telemetry_rollup_days']) {
      await expect(withUserContext(userId, (c) => c.query(`SELECT * FROM public.${table}`))).rejects.toThrow(/permission denied/)
    }
    await expect(
      withUserContext(userId, (c) => c.query(`SELECT public.rollup_agent_telemetry(now() - interval '2 days', 1)`)),
    ).rejects.toThrow(/permission denied/)
  })
})
