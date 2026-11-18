/**
 * The momsdeklaration filing record over MCP (issues #2785, #2786):
 * gnubok_list_vat_filings (read), gnubok_mark_vat_period_filed and
 * gnubok_unmark_vat_period_filed (staged writes), generated from
 * src/lib/operations/vat-filings.ts. Search-only, so they cost nothing in
 * tools/list. The store is mocked (its rules are tested in
 * lib/vat/__tests__/filing-record-store.test.ts); what matters here is the
 * contract: yearly periods are accepted, the staging preview is the store's
 * own dry run, and a refusal (a Skatteverket-confirmed filing) is raised at
 * staging instead of staging an operation that could never commit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

const store = vi.hoisted(() => ({
  listVatFilings: vi.fn(),
  markVatPeriodFiled: vi.fn(),
  unmarkVatPeriodFiled: vi.fn(),
  previewMarkVatPeriodFiled: vi.fn(),
  previewUnmarkVatPeriodFiled: vi.fn(),
  recordVatFilingConfirmed: vi.fn(),
}))
vi.mock('@/lib/vat/filing-record-store', () => store)

const changes = vi.hoisted(() => ({ listVatFilingsWithChanges: vi.fn() }))
vi.mock('@/lib/vat/filed-period-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vat/filed-period-changes')>()),
  listVatFilingsWithChanges: changes.listVatFilingsWithChanges,
}))

import { isDefaultCatalogTool, tools } from '../server'

const tool = (name: string) => tools.find((t) => t.name === name)!
const listTool = () => tool('gnubok_list_vat_filings')
const markTool = () => tool('gnubok_mark_vat_period_filed')
const unmarkTool = () => tool('gnubok_unmark_vat_period_filed')

const YEARLY_RECORD = {
  deadline_id: '11111111-1111-4111-8111-111111111111',
  period_type: 'yearly',
  year: 2026,
  period: 1,
  tax_period: '2025/2026',
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  filed_on: '2026-08-20',
  source: 'manual',
  reference: null,
}

/** The räkenskapsår the yearly record declares: 2025-07-01 to 2026-06-30, not closed. */
const OPEN_FY_2526 = { id: 'fy-2526', period_start: '2025-07-01', period_end: '2026-06-30', is_closed: false, locked_at: null }

/** Records every insert with its table, over the queued mock. */
function captureInserts(supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = []
  const fromMock = supabase.from as ReturnType<typeof vi.fn>
  const original = fromMock.getMockImplementation() as (table: string) => object
  fromMock.mockImplementation((table: string) => {
    const chain = original(table)
    return new Proxy(chain, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === 'insert' && typeof value === 'function') {
          return (...args: unknown[]) => {
            inserts.push({ table, payload: args[0] as Record<string, unknown> })
            return (value as (...a: unknown[]) => unknown)(...args)
          }
        }
        return value
      },
    })
  })
  return inserts
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registration', () => {
  it('registers the three tools search-only, under the v1 scopes, at the low risk tier', () => {
    for (const t of [listTool(), markTool(), unmarkTool()]) {
      expect(t, 'tool registered').toBeDefined()
      expect(isDefaultCatalogTool(t), t.name).toBe(false)
      expect(t.inputSchema.additionalProperties, t.name).toBe(false)
      expect(t.description.length, t.name).toBeLessThanOrEqual(280)
    }
    expect(listTool().annotations.readOnlyHint).toBe(true)
    expect(markTool().annotations.readOnlyHint).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_list_vat_filings).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_mark_vat_period_filed).toBe('bookkeeping:write')
    expect(TOOL_SCOPE_MAP.gnubok_unmark_vat_period_filed).toBe('bookkeeping:write')
    expect(OPERATION_RISK_TIERS.mark_vat_period_filed).toBe('low')
    expect(OPERATION_RISK_TIERS.unmark_vat_period_filed).toBe('low')
  })

  it('accepts every cadence, helårsmoms included', () => {
    for (const t of [markTool(), unmarkTool()]) {
      const properties = t.inputSchema.properties as Record<string, { enum?: string[] }>
      expect(properties.period_type.enum, t.name).toEqual(['monthly', 'quarterly', 'yearly'])
    }
    const markProps = Object.keys(markTool().inputSchema.properties as object)
    expect(markProps).toEqual(expect.arrayContaining(['filed_on', 'reference', 'dry_run', 'idempotency_key']))
  })

  it('is found by a Swedish search for filed periods', async () => {
    const search = tool('gnubok_search_tools')
    const result = (await search.execute(
      { query: 'markera momsdeklaration som inlämnad helårsmoms', detail: 'name', __keyScopes: ['bookkeeping:write', 'reports:read'] },
      'company-1',
      'user-1',
      {} as never,
    )) as { tools: Array<{ name: string }> }
    expect(result.tools.map((t) => t.name)).toContain('gnubok_mark_vat_period_filed')
  })
})

describe('gnubok_list_vat_filings', () => {
  it('lists the filed periods of every cadence with what changed each one after filing', async () => {
    const record = { ...YEARLY_RECORD, changed_after_filing: null }
    changes.listVatFilingsWithChanges.mockResolvedValue([record])
    const supabase = {} as never
    const result = await listTool().execute({}, 'company-1', 'user-1', supabase)
    expect(result).toEqual({ filings: [record] })
    expect(changes.listVatFilingsWithChanges).toHaveBeenCalledWith(supabase, 'company-1')
  })
})

describe('gnubok_mark_vat_period_filed', () => {
  const args = { period_type: 'yearly', year: 2026, period: 1, filed_on: '2026-08-20', reference: 'KV-7' }

  it('stages the mark with the store preview and writes nothing else', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    enqueue({ data: { bookkeeping_locked_through: '2026-06-30' } }) // the books are locked through the period
    enqueue({ data: [OPEN_FY_2526] }) // the company's räkenskapsår
    enqueue({ data: { id: 'op-mark-1' }, error: null }) // pending_operations insert
    const preview = {
      ok: true,
      would_mark: { ...YEARLY_RECORD, reference: 'KV-7' },
      effect: 'update',
      current: null,
    }
    store.previewMarkVatPeriodFiled.mockResolvedValue(preview)

    const result = (await markTool().execute(args, 'company-1', 'user-1', supabase as never, {
      type: 'api_key',
    })) as { staged: boolean; operation_id?: string; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-mark-1')
    expect(result.risk_level).toBe('low')
    expect(result.preview).toMatchObject({
      would_mark: { tax_period: '2025/2026' },
      effect: 'update',
      lock_offer: null,
    })
    // Locked through the period's last day already: no lock to offer.
    expect(result).not.toHaveProperty('next')
    expect(store.previewMarkVatPeriodFiled).toHaveBeenCalledWith(supabase, 'company-1', {
      periodType: 'yearly',
      year: 2026,
      period: 1,
      filedOn: '2026-08-20',
      reference: 'KV-7',
    })
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
    expect(inserts.map((i) => i.table)).toEqual(['pending_operations'])
    expect(inserts[0].payload).toMatchObject({
      operation_type: 'mark_vat_period_filed',
      params: args,
      title: 'Markera momsdeklaration Helår 2026 som inlämnad',
    })
  })

  /**
   * Stages the mark of the yearly period (it ends 2026-06-30) for a company
   * whose lock date and räkenskapsår read as given.
   */
  async function stageMark(lockDate: { data?: unknown; error?: unknown }, years: unknown[]) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    enqueue(lockDate) // company_settings: the lock date
    enqueue({ data: years }) // fiscal_periods: the company's räkenskapsår
    enqueue({ data: { id: 'op-mark' }, error: null }) // pending_operations insert
    store.previewMarkVatPeriodFiled.mockResolvedValue({
      ok: true,
      would_mark: { ...YEARLY_RECORD, reference: 'KV-7' },
      effect: 'create',
      current: null,
    })
    const result = (await markTool().execute(args, 'company-1', 'user-1', supabase as never, {
      type: 'api_key',
    })) as {
      staged: boolean
      preview: Record<string, unknown>
      next?: { description: string; tool: string; args: Record<string, unknown> }
    }
    return { result, inserts }
  }

  // Marking locks nothing, and the lock date was only ever offered on a
  // settings page: while the period's last day is open, the staged answer
  // tells the agent to ask the person about the existing lock tool.
  it('offers to lock the books through the period once the mark is approved, while its last day is open', async () => {
    const { result, inserts } = await stageMark(
      { data: { bookkeeping_locked_through: '2026-03-31' } }, // locked, but short of the period's last day
      [{ ...OPEN_FY_2526, period_end: '2026-12-31' }], // the period lies in a year that runs on past it
    )

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ lock_offer: { through: '2026-06-30', open_year_end: null } })
    expect(result.next).toMatchObject({
      tool: 'gnubok_update_bookkeeping_lock',
      args: { bookkeeping_locked_through: '2026-06-30' },
    })
    expect(result.next?.description).toContain(
      'Once this is approved the period is on record as filed: then ask the user whether to lock the books through 2026-06-30',
    )
    expect(result.next?.description).not.toContain('bokslut')
    // The offer is words to the agent: staging the mark stages the mark only.
    expect(inserts.map((i) => i.payload.operation_type)).toEqual(['mark_vat_period_filed'])
  })

  // The lock date holds every earlier day too: a year that is not closed yet
  // cannot get its bokslut booked behind it, and the person hears that first.
  it('says so when the lock would also hold the last day of a räkenskapsår that is not closed', async () => {
    // The helårsmoms period is the unclosed year itself.
    const { result } = await stageMark({ data: { bookkeeping_locked_through: null } }, [OPEN_FY_2526])

    expect(result.preview).toMatchObject({ lock_offer: { through: '2026-06-30', open_year_end: '2026-06-30' } })
    expect(result.next?.description).toContain(
      'the räkenskapsår ending 2026-06-30 is not closed, so its bokslut cannot be booked until the lock date is moved back',
    )
  })

  it('offers nothing when the lock could not be read: an unread lock is never taken as open', async () => {
    const { result } = await stageMark({ data: null, error: { message: 'connection reset' } }, [OPEN_FY_2526])

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ lock_offer: null })
    expect(result).not.toHaveProperty('next')
  })

  it('names a lock tool that exists, staged and high risk as ever', () => {
    const lock = tool('gnubok_update_bookkeeping_lock')
    expect(lock).toBeDefined()
    expect(OPERATION_RISK_TIERS.update_bookkeeping_lock).toBe('high')
    expect(Object.keys(lock.inputSchema.properties as object)).toContain('bookkeeping_locked_through')
  })

  it('refuses at staging what the approval would refuse, staging nothing', async () => {
    const { supabase } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    store.previewMarkVatPeriodFiled.mockResolvedValue({ ok: false, code: 'VAT_FILING_PERIOD_NOT_ENDED' })

    await expect(
      markTool().execute({ ...args, year: 2027 }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VAT_FILING_PERIOD_NOT_ENDED' })
    expect(inserts).toEqual([])
  })

  it('rejects a yearly period other than 1 before any read', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      markTool().execute({ ...args, period: 6 }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/period/)
    expect(store.previewMarkVatPeriodFiled).not.toHaveBeenCalled()
  })
})

describe('gnubok_unmark_vat_period_filed', () => {
  const args = { period_type: 'yearly', year: 2026, period: 1 }

  it('refuses to stage undoing a Skatteverket-confirmed filing', async () => {
    const { supabase } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    store.previewUnmarkVatPeriodFiled.mockResolvedValue({
      ok: false,
      code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET',
    })

    await expect(
      unmarkTool().execute(args, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' })
    expect(inserts).toEqual([])
    expect(store.unmarkVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('stages undoing a manual mark, naming the record it would reopen', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    enqueue({ data: { id: 'op-unmark-1' }, error: null }) // pending_operations insert
    store.previewUnmarkVatPeriodFiled.mockResolvedValue({
      ok: true,
      would_unmark: { period_type: 'yearly', year: 2026, period: 1, tax_period: '2025/2026' },
      current: YEARLY_RECORD,
    })

    const result = (await unmarkTool().execute(args, 'company-1', 'user-1', supabase as never, {
      type: 'api_key',
    })) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ current: { deadline_id: YEARLY_RECORD.deadline_id } })
    expect(inserts[0].payload).toMatchObject({ operation_type: 'unmark_vat_period_filed', params: args })
    expect(store.unmarkVatPeriodFiled).not.toHaveBeenCalled()
  })
})
