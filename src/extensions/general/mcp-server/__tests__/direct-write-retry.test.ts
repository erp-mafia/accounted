/**
 * Every MCP write that does not stage is safe to send twice.
 *
 * The stateless MCP revision recovers a broken tools/call by sending the
 * same request again. A staging tool is covered by its idempotency_key
 * (stagePendingOperation) and by the claim that admits one commit per
 * pending operation. A tool that writes directly must replay
 * `idempotency_key` itself (withRetryKey, retry-key.ts), or be listed in
 * DIRECT_WRITES_WITHOUT_KEY with the reason a repeat cannot write twice. A
 * new direct write fails here until one of the two is true, and an entry
 * that no longer needs to be here fails too.
 *
 * "Direct write" is every tool that is not read-only and does not declare
 * the staged-operation envelope (isStagingTool). That bucket also holds the
 * tools that stage more than one operation per call, which is why
 * gnubok_create_transactions and gnubok_auto_match_period take a key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createCompanyCore: vi.fn() }))
vi.mock('@/lib/company/create-company', () => ({
  createCompanyCore: (...args: unknown[]) => mocks.createCompanyCore(...args),
}))

import { createIdempotencyKeysFake } from '@/tests/idempotency-fake'
import { tools, isStagingTool, type McpTool } from '../server'
import { IDEMPOTENCY_KEY_PROPERTY, withRetryKey } from '../retry-key'
import { toToolError } from '../tool-result'

const DIRECT_WRITES_WITHOUT_KEY: Record<string, string> = {
  gnubok_stage_tool:
    'Bridge that carries only staging tools (isStagingTool): the inner call replays its own idempotency_key, and nothing commits before an approval.',
  gnubok_stage_across_companies:
    'Stages one pending operation per company under a batch_id: nothing commits before an approval, and each approval claims its operation once.',
  gnubok_approve_pending_operation:
    'The operation_id is the key: the pending to committing claim admits one commit, and a repeat on a settled operation returns its stored outcome.',
  gnubok_approve_from_view:
    'The approval view\'s own door runs the same single approval: the operation_id is the key, and a repeat on a settled operation returns its stored outcome.',
  gnubok_reject_pending_operation:
    'Compare-and-set on status pending: a repeat answers CONFLICT (already rejected) and changes nothing.',
  gnubok_sync_bank:
    'A durable 15-minute lease answers a repeat in-band (synced=false, next_allowed_at), and fetched rows dedupe on the bank transaction id.',
  gnubok_backfill_feed:
    "Fetched rows dedupe on the provider's own id (external_id) and the cursor moves back to the same day: a repeat imports nothing new.",
  gnubok_remember_fact:
    'Content dedupe: a fact within Jaccard 0.82 of a stored one returns the stored fact instead of writing a second row.',
  gnubok_forget_fact: 'Sets is_active=false on one fact: a repeat leaves it inactive.',
  gnubok_feedback:
    'Telemetry to event_log, rate-limited 1 per 60 s per actor: a duplicate report reaches the product team twice and nothing reaches the books.',
  gnubok_create_document_upload:
    'Reserves a short-lived upload URL: a repeat reserves another slot that expires unused, and completion dedupes by content.',
  gnubok_complete_document_upload:
    'Returns the inbox item already created for the upload_id, and archived bytes dedupe by content.',
  gnubok_calculate_salary_run: 'Recomputes the run from its inputs and posts nothing: a repeat computes the same figures.',
  gnubok_import_rot_rut_beslut:
    'A beslut already recorded counts as already_imported: a repeat of the same file records nothing new.',
  gnubok_audit_package: 'Builds an export archive of the period and posts nothing: a repeat builds an equivalent archive.',
  gnubok_set_quote_status:
    'Sets the decision with a compare-and-set on the current quote_status: a repeat writes the same status and keeps quote_decided_at.',
  gnubok_set_inbox_extracted_data: 'Overwrites the inbox item\'s extracted fields: a repeat writes the same values.',
  gnubok_resolve_missing: 'Closes one open finding: a repeat finds it closed and changes nothing.',
}

const isDirectWrite = (tool: McpTool) => tool.annotations.readOnlyHint !== true && !isStagingTool(tool)
const declares = (tool: McpTool, property: string) =>
  property in ((tool.inputSchema.properties ?? {}) as Record<string, unknown>)

describe('direct MCP writes are safe to retry', () => {
  it('replays idempotency_key on every direct write, or knows why a repeat cannot write twice', () => {
    const problems: string[] = []
    for (const tool of tools.filter(isDirectWrite)) {
      const reason = DIRECT_WRITES_WITHOUT_KEY[tool.name]
      if (tool.retryKey && reason) problems.push(`${tool.name}: replays idempotency_key, drop it from DIRECT_WRITES_WITHOUT_KEY`)
      if (!tool.retryKey && !reason) {
        problems.push(
          `${tool.name}: writes without staging and takes no idempotency_key. Wrap it in withRetryKey (retry-key.ts), ` +
            'or list it in DIRECT_WRITES_WITHOUT_KEY with the reason a repeated call cannot write twice.',
        )
      }
      // A key the schema offers but nothing replays would be a promise broken in silence.
      if (!tool.retryKey && declares(tool, 'idempotency_key')) {
        problems.push(`${tool.name}: declares idempotency_key but does not replay it; wrap it in withRetryKey`)
      }
    }
    const known = new Set(tools.filter(isDirectWrite).map((tool) => tool.name))
    for (const name of Object.keys(DIRECT_WRITES_WITHOUT_KEY)) {
      if (!known.has(name)) problems.push(`${name}: listed in DIRECT_WRITES_WITHOUT_KEY but is not a direct write tool`)
    }
    expect(problems).toEqual([])
  })

  it('declares the key and the idempotent hint on every tool that replays it', () => {
    for (const tool of tools.filter((t) => t.retryKey)) {
      expect((tool.inputSchema.properties as Record<string, unknown>).idempotency_key, tool.name).toBe(IDEMPOTENCY_KEY_PROPERTY)
      expect(tool.annotations.idempotentHint, tool.name).toBe(true)
    }
  })

  it('covers the writes that made this guard', () => {
    const replaying = tools.filter((t) => t.retryKey).map((t) => t.name).sort()
    expect(replaying).toEqual([
      'gnubok_auto_match_period',
      'gnubok_cancel_cash_forecast_row',
      'gnubok_create_company',
      'gnubok_create_skill',
      'gnubok_create_transactions',
      'gnubok_generate_rot_rut_file',
      'gnubok_upload_document',
      'gnubok_upsert_cash_forecast_rows',
    ])
  })
})

describe('withRetryKey', () => {
  const COMPANY = '33333333-3333-4333-8333-333333333333'

  function fakeTool(options: Parameters<typeof withRetryKey>[1] = {}) {
    const execute = vi.fn(async (args: Record<string, unknown>) => ({ created_id: `row-${execute.mock.calls.length}`, echoed: args }))
    const tool = withRetryKey(
      {
        name: 'gnubok_fake_write',
        description: 'A direct write.',
        inputSchema: { type: 'object', additionalProperties: false, properties: { amount: { type: 'number' }, dry_run: { type: 'boolean' } } },
        annotations: { effect: 'additive', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute,
      },
      options,
    )
    const idempotency = createIdempotencyKeysFake()
    const supabase = { from: () => idempotency.table(), rpc: idempotency.rpc } as never
    const call = (args: Record<string, unknown>, companyId = COMPANY) => tool.execute(args, companyId, 'user-1', supabase)
    return { tool, execute, idempotency, call }
  }

  beforeEach(() => vi.clearAllMocks())

  it('runs once for a repeat with the same key and arguments, and answers the first result', async () => {
    const { execute, call, idempotency } = fakeTool()
    const first = (await call({ amount: 100, idempotency_key: 'k1' })) as Record<string, unknown>
    const second = (await call({ amount: 100, idempotency_key: 'k1' })) as Record<string, unknown>

    expect(execute).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ ...first, idempotency_replay: true })
    // The key never reaches the tool, and the answer is stored for the company.
    expect(execute.mock.calls[0][0]).toEqual({ amount: 100 })
    expect(idempotency.rows[0]).toMatchObject({ company_id: COMPANY, key: 'k1', scope: 'mcp_tool', response_status: 'success' })
  })

  it('refuses the same key with other arguments as IDEMPOTENCY_KEY_REUSE', async () => {
    const { execute, call } = fakeTool()
    await call({ amount: 100, idempotency_key: 'k1' })
    await expect(call({ amount: 200, idempotency_key: 'k1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps one key per company: the same key in another company is another write', async () => {
    const { execute, call } = fakeTool()
    await call({ amount: 100, idempotency_key: 'k1' })
    await call({ amount: 100, idempotency_key: 'k1' }, '44444444-4444-4444-8444-444444444444')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('changes nothing without a key: there is no derived default', async () => {
    const { execute, call, idempotency } = fakeTool()
    await call({ amount: 100 })
    await call({ amount: 100 })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(idempotency.rows).toHaveLength(0)
  })

  it('neither replays nor stores a preview, so the real call may reuse its key', async () => {
    const { execute, call, idempotency } = fakeTool({ preview: (args) => args.dry_run === true })
    await call({ amount: 100, dry_run: true, idempotency_key: 'k1' })
    expect(idempotency.rows).toHaveLength(0)
    await call({ amount: 100, idempotency_key: 'k1' })
    await call({ amount: 100, idempotency_key: 'k1' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not store a failure: a retry with the same key runs again', async () => {
    const { execute, call, idempotency } = fakeTool()
    execute.mockRejectedValueOnce(new Error('statement timeout'))
    await expect(call({ amount: 100, idempotency_key: 'k1' })).rejects.toThrow('statement timeout')
    expect(idempotency.rows).toHaveLength(0)
    await call({ amount: 100, idempotency_key: 'k1' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('answers a resend that arrives while the first call still runs with IDEMPOTENCY_KEY_IN_PROGRESS, not a second write', async () => {
    const { execute, call } = fakeTool()
    let finishFirst: () => void = () => {}
    execute.mockImplementationOnce(
      (args: Record<string, unknown>) =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ created_id: 'row-1', echoed: args })
        }),
    )

    const first = call({ amount: 100, idempotency_key: 'k1' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    await expect(call({ amount: 100, idempotency_key: 'k1' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      retryAfterSeconds: 2,
    })

    finishFirst()
    const answer = (await first) as Record<string, unknown>
    expect(await call({ amount: 100, idempotency_key: 'k1' })).toEqual({ ...answer, idempotency_replay: true })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('surfaces the in-progress refusal in the structured tool-error shape, marked retryable', async () => {
    const { execute, call } = fakeTool()
    execute.mockImplementationOnce(() => new Promise(() => {}))
    void call({ amount: 100, idempotency_key: 'k1' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))

    const refusal = await call({ amount: 100, idempotency_key: 'k1' }).catch((err: unknown) => err)
    expect(toToolError(refusal).error).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS', retryable: true })
  })

  it('lets a new call take over a claim whose first call never finished, once it is past the claim TTL', async () => {
    const { execute, call, idempotency } = fakeTool()
    execute.mockImplementationOnce(() => new Promise(() => {}))
    void call({ amount: 100, idempotency_key: 'k1' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))

    idempotency.expireAll()
    await call({ amount: 100, idempotency_key: 'k1' })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(idempotency.rows).toHaveLength(1)
    expect(idempotency.rows[0]).toMatchObject({ key: 'k1', state: 'completed', response_status: 'success' })
  })
})

describe('gnubok_create_company with idempotency_key', () => {
  const CREATED = '55555555-5555-4555-8555-555555555555'
  const tool = tools.find((t) => t.name === 'gnubok_create_company')!
  const setup = {
    name: 'Testbolaget AB',
    entity_type: 'aktiebolag',
    org_number: '556000-0001',
    vat_registered: true,
    moms_period: 'quarterly',
    accounting_method: 'accrual',
    f_skatt: true,
  }

  function client() {
    const idempotency = createIdempotencyKeysFake()
    const team: Record<string, ReturnType<typeof vi.fn>> = {}
    for (const method of ['select', 'eq', 'order', 'limit', 'in', 'is']) team[method] = vi.fn(() => team)
    team.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    team.then = vi.fn((resolve: (value: unknown) => void) => resolve({ data: [], error: null }))
    return {
      idempotency,
      supabase: {
        from: vi.fn((table: string) => (table === 'idempotency_keys' ? idempotency.table() : team)),
        rpc: vi.fn((fn: string, params: Record<string, unknown>) =>
          fn === 'claim_idempotency_key' ? idempotency.rpc(fn, params) : Promise.resolve({ data: CREATED, error: null }),
        ),
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createCompanyCore.mockImplementation(
      async (_client: unknown, _input: unknown, createRow: () => Promise<{ data: unknown; error: unknown }>) => {
        const { data } = await createRow()
        return { companyId: data as string }
      },
    )
  })

  it('creates one company for a resent confirm, scoped to the user before the company exists', async () => {
    const { supabase, idempotency } = client()
    const args = { ...setup, confirm: true, idempotency_key: 'onboard-1' }

    const first = (await tool.execute(args, '', 'user-1', supabase as never)) as Record<string, unknown>
    const retry = (await tool.execute(args, '', 'user-1', supabase as never)) as Record<string, unknown>

    expect(mocks.createCompanyCore).toHaveBeenCalledTimes(1)
    expect(first.company_id).toBe(CREATED)
    expect(retry).toMatchObject({ created: true, company_id: CREATED, idempotency_replay: true })
    expect(idempotency.rows).toHaveLength(1)
    expect(idempotency.rows[0]).toMatchObject({ company_id: CREATED, scope: 'company_create', key: 'onboard-1' })
  })

  it('lets the preview and the confirm share a key: the preview is never cached', async () => {
    const { supabase, idempotency } = client()
    const preview = (await tool.execute({ ...setup, idempotency_key: 'onboard-2' }, '', 'user-1', supabase as never)) as Record<
      string,
      unknown
    >
    expect(preview.created).toBe(false)
    expect(idempotency.rows).toHaveLength(0)

    const created = (await tool.execute({ ...setup, confirm: true, idempotency_key: 'onboard-2' }, '', 'user-1', supabase as never)) as Record<
      string,
      unknown
    >
    expect(created.created).toBe(true)
    expect(mocks.createCompanyCore).toHaveBeenCalledTimes(1)
  })
})
