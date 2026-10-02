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
  it('lists the filed periods of every cadence from the store', async () => {
    store.listVatFilings.mockResolvedValue([YEARLY_RECORD])
    const supabase = {} as never
    const result = await listTool().execute({}, 'company-1', 'user-1', supabase)
    expect(result).toEqual({ filings: [YEARLY_RECORD] })
    expect(store.listVatFilings).toHaveBeenCalledWith(supabase, 'company-1')
  })
})

describe('gnubok_mark_vat_period_filed', () => {
  const args = { period_type: 'yearly', year: 2026, period: 1, filed_on: '2026-08-20', reference: 'KV-7' }

  it('stages the mark with the store preview and writes nothing else', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
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
    expect(result.preview).toMatchObject({ would_mark: { tax_period: '2025/2026' }, effect: 'update' })
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
