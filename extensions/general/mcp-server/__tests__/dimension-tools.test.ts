/**
 * Dimensions PR3: MCP surface tests.
 *
 * Covers the three new tools (gnubok_list_dimensions,
 * gnubok_list_dimension_values, staged gnubok_create_dimension_value), the
 * resolve-don't-select helper (exact / fuzzy / ambiguous / none / archived),
 * and the dims bag flowing from gnubok_create_voucher params into the staged
 * lines. Executor-side coverage (commitCreateDimensionValue incl. duplicate
 * idempotency) lives in lib/pending-operations/__tests__/.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { tools } from '../server'
import {
  resolveValueInDimension,
  resolveDimensionBags,
  DimensionResolutionError,
  mergeLineDimensions,
  parseDimensionsArg,
  type DimensionRegistryEntry,
} from '../dimensions'

const listDimensions = tools.find((t) => t.name === 'gnubok_list_dimensions')!
const listDimensionValues = tools.find((t) => t.name === 'gnubok_list_dimension_values')!
const createDimensionValue = tools.find((t) => t.name === 'gnubok_create_dimension_value')!
const createVoucher = tools.find((t) => t.name === 'gnubok_create_voucher')!
const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!
const categorizeTransaction = tools.find((t) => t.name === 'gnubok_categorize_transaction')!
const bulkBookTransactions = tools.find((t) => t.name === 'gnubok_bulk_book_transactions')!

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Wrap a queued supabase mock so every `.insert(payload)` is recorded with its
 * table name: lets tests assert the exact staged pending_operations params
 * (the contract the parallel-built executors consume), not just the preview.
 */
function captureInserts(
  supabase: ReturnType<typeof createQueuedMockSupabase>['supabase'],
): Array<{ table: string; payload: Record<string, unknown> }> {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = []
  const fromMock = supabase.from as ReturnType<typeof vi.fn>
  const original = fromMock.getMockImplementation() as (table: string) => object
  fromMock.mockImplementation((table: string) => {
    const chain = original(table)
    return new Proxy(chain, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === 'insert' && typeof value === 'function') {
          return (...insertArgs: unknown[]) => {
            inserts.push({ table, payload: insertArgs[0] as Record<string, unknown> })
            return (value as (...a: unknown[]) => unknown)(...insertArgs)
          }
        }
        return value
      },
    })
  })
  return inserts
}

/** Registry fixture shared by the producer-tool dims tests below. */
const REGISTRY_ROWS = [
  { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 },
  { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
]
const VALUE_ROWS = [
  { id: 'v1', dimension_id: 'dim-1', code: 'KS01', name: 'Stockholm', is_active: true, start_date: null, end_date: null },
  { id: 'v2', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
]

function makeDim(overrides: Partial<DimensionRegistryEntry> = {}): DimensionRegistryEntry {
  return {
    id: 'dim-6',
    sie_dim_no: 6,
    name: 'Projekt',
    resets_annually: false,
    is_system: true,
    is_active: true,
    sort_order: 20,
    values: [
      { id: 'v1', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
      { id: 'v2', code: 'P002', name: 'Kontorsflytt Solna', is_active: true, start_date: null, end_date: null },
      { id: 'v3', code: 'P099', name: 'Gammalt projekt', is_active: false, start_date: null, end_date: null },
    ],
    ...overrides,
  }
}

// ── Registration + scopes ────────────────────────────────────────────────────

describe('dimension tools registration', () => {
  it('all three tools exist and are mapped in TOOL_SCOPE_MAP (unmapped = any key)', () => {
    expect(listDimensions).toBeDefined()
    expect(listDimensionValues).toBeDefined()
    expect(createDimensionValue).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_list_dimensions).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_list_dimension_values).toBe('reports:read')
    expect(TOOL_SCOPE_MAP.gnubok_create_dimension_value).toBe('bookkeeping:write')
  })

  it('gnubok_create_dimension_value stages (staged-operation output contract)', () => {
    const schema = createDimensionValue.outputSchema as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(schema?.properties?.staged).toBeDefined()
    expect(schema?.required).toContain('staged')
    expect(createDimensionValue.description).toMatch(/stag(e|ing)/i)
  })
})

// ── gnubok_list_dimensions ───────────────────────────────────────────────────

describe('gnubok_list_dimensions', () => {
  it('seeds system dims then returns the registry with nested values (dashboard GET shape)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure_company_dimensions rpc
    enqueue({
      data: [
        { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 },
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
      ],
      error: null,
    })
    enqueue({
      data: [
        { id: 'v1', dimension_id: 'dim-1', code: 'KS01', name: 'Stockholm', is_active: true, start_date: null, end_date: null },
        { id: 'v2', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren', is_active: true, start_date: null, end_date: null },
      ],
      error: null,
    })

    const result = (await listDimensions.execute({}, 'company-1', 'user-1', supabase as never)) as {
      dimensions: Array<{ sie_dim_no: number; values: Array<{ code: string }> }>
    }

    expect(result.dimensions).toHaveLength(2)
    expect(result.dimensions[0].sie_dim_no).toBe(1)
    expect(result.dimensions[0].values.map((v) => v.code)).toEqual(['KS01'])
    expect(result.dimensions[1].values.map((v) => v.code)).toEqual(['P001'])
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('ensure_company_dimensions')
  })

  it('surfaces the ensure RPC failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'rls denied' } })
    await expect(
      listDimensions.execute({}, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/rls denied/)
  })
})

// ── gnubok_list_dimension_values ─────────────────────────────────────────────

describe('gnubok_list_dimension_values', () => {
  it('rejects an unregistered dimension number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: null, error: null }) // dimensions lookup → not found
    await expect(
      listDimensionValues.execute({ sie_dim_no: 12 }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/Dimension 12 finns inte/)
  })

  it('lists values alphabetically without a query', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_active: true }, error: null })
    enqueue({
      data: [
        { id: 'v1', code: 'P001', name: 'Villa Almgren', is_active: true, start_date: null, end_date: null },
        { id: 'v2', code: 'P002', name: 'Kontorsflytt', is_active: true, start_date: null, end_date: null },
      ],
      error: null,
    })

    const result = (await listDimensionValues.execute(
      { sie_dim_no: 6 },
      'company-1',
      'user-1',
      supabase as never,
    )) as { dimension: { sie_dim_no: number }; values: Array<{ code: string; confidence?: number }>; count: number }

    expect(result.dimension.sie_dim_no).toBe(6)
    expect(result.count).toBe(2)
    expect(result.values[0].confidence).toBeUndefined()
  })

  it('ranks by fuzzy confidence when a query is given', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_active: true }, error: null })
    enqueue({
      data: [
        { id: 'v1', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
        { id: 'v2', code: 'P002', name: 'Kontorsflytt Solna', is_active: true, start_date: null, end_date: null },
      ],
      error: null,
    })

    const result = (await listDimensionValues.execute(
      { sie_dim_no: 6, query: 'villa almgren' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { values: Array<{ code: string; confidence?: number }> }

    expect(result.values[0].code).toBe('P001')
    expect(result.values[0].confidence).toBeGreaterThan(0.5)
  })
})

// ── gnubok_create_dimension_value (staging) ──────────────────────────────────

describe('gnubok_create_dimension_value: staging', () => {
  it('rejects a non-Fortnox code before any staging', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      createDimensionValue.execute(
        { sie_dim_no: 6, code: 'P 001"', name: 'Bad code' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Koden får bara innehålla/)
  })

  it('rejects when the code already exists as an active value', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false }, error: null })
    enqueue({ data: { id: 'v1', code: 'P001', name: 'Villa Almgren', is_active: true }, error: null })

    await expect(
      createDimensionValue.execute(
        { sie_dim_no: 6, code: 'P001', name: 'Duplicate' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/finns redan/)
  })

  it('rejects an archived code with the reactivation hint', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false }, error: null })
    enqueue({ data: { id: 'v1', code: 'P099', name: 'Gammalt', is_active: false }, error: null })

    await expect(
      createDimensionValue.execute(
        { sie_dim_no: 6, code: 'P099', name: 'Revive attempt' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/arkiverat: återaktivera/)
  })

  it('rejects value dates on a resets-annually dimension (kostnadsställe)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true }, error: null })

    await expect(
      createDimensionValue.execute(
        { sie_dim_no: 1, code: 'KS01', name: 'Stockholm', start_date: '2026-01-01' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Start-\/slutdatum är inte tillåtna/)
  })

  it('happy path: stages a create_dimension_value pending operation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false }, error: null })
    enqueue({ data: null, error: null }) // duplicate lookup → none
    enqueue({ data: { id: 'op-dim-1' }, error: null }) // pending_operations insert

    const result = (await createDimensionValue.execute(
      { sie_dim_no: 6, code: 'P010', name: 'Villa Almgren etapp 2' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as { staged: boolean; operation_id?: string; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-dim-1')
    expect(result.risk_level).toBe('low')
    expect(result.preview.code).toBe('P010')
    expect(result.preview.dimension_name).toBe('Projekt')

    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(true)
  })

  it('dry_run validates and previews without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false }, error: null })
    enqueue({ data: null, error: null }) // duplicate lookup → none

    const result = (await createDimensionValue.execute(
      { sie_dim_no: 6, code: 'P010', name: 'Etapp 2', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })
})

// ── Resolve-don't-select helper ──────────────────────────────────────────────

describe('resolveValueInDimension', () => {
  it('resolves an exact code match without echo (exact=true)', () => {
    const r = resolveValueInDimension(makeDim(), 'P001')
    expect(r).toMatchObject({ code: 'P001', exact: true, confidence: 1 })
  })

  it('resolves an exact name match with confidence 1 but exact=false (echoed)', () => {
    const r = resolveValueInDimension(makeDim(), 'Kontorsflytt Solna')
    expect(r).toMatchObject({ code: 'P002', exact: false, confidence: 1 })
  })

  it('resolves a unique high-confidence fuzzy hit', () => {
    const r = resolveValueInDimension(makeDim(), 'villa almgren tak')
    expect(r.code).toBe('P001')
    expect(r.exact).toBe(false)
    expect(r.confidence).toBeGreaterThan(0.7)
  })

  it('rejects an archived code with the Swedish reactivation message', () => {
    expect(() => resolveValueInDimension(makeDim(), 'P099')).toThrow(/arkiverat: återaktivera/)
  })

  it('rejects an unknown value with the create-first instruction (never auto-creates)', () => {
    try {
      resolveValueInDimension(makeDim(), 'Bryggeriet ombyggnad')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DimensionResolutionError)
      expect((err as Error).message).toMatch(/Okänt projekt: "Bryggeriet ombyggnad" \(dimension 6\)/)
      expect((err as Error).message).toMatch(/gnubok_create_dimension_value/)
    }
  })

  it('rejects ambiguous near-tied candidates with a ranked list', () => {
    const dim = makeDim({
      values: [
        { id: 'v1', code: 'P001', name: 'Villa Almgren etapp 1', is_active: true, start_date: null, end_date: null },
        { id: 'v2', code: 'P002', name: 'Villa Almgren etapp 2', is_active: true, start_date: null, end_date: null },
      ],
    })
    try {
      resolveValueInDimension(dim, 'Villa Almgren etapp')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DimensionResolutionError)
      const e = err as DimensionResolutionError
      expect(e.candidates.length).toBeGreaterThanOrEqual(2)
      expect(e.message).toMatch(/Kandidater/)
      expect(e.message).toMatch(/gnubok_create_dimension_value/)
    }
  })
})

describe('resolveDimensionBags', () => {
  it('costs zero queries when no line carries a bag', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await resolveDimensionBags(supabase as never, 'company-1', [undefined, undefined])
    expect(result.resolutions).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('passes bags through verbatim when dimensions_enabled is false (backward compatible)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null }) // company_settings

    const result = await resolveDimensionBags(supabase as never, 'company-1', [{ '6': 'fritext-projekt' }])
    expect(result.bags).toEqual([{ '6': 'fritext-projekt' }])
    expect(result.resolutions).toEqual([])
    expect(supabase.rpc).not.toHaveBeenCalled() // no ensure, no registry reads
  })

  it('resolves names to codes and echoes non-exact resolutions when enabled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: true }, error: null }) // company_settings
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({
      data: [
        { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 },
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
      ],
      error: null,
    })
    enqueue({
      data: [
        { id: 'v1', dimension_id: 'dim-1', code: 'KS01', name: 'Stockholm', is_active: true, start_date: null, end_date: null },
        { id: 'v2', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
      ],
      error: null,
    })

    const result = await resolveDimensionBags(supabase as never, 'company-1', [
      { '1': 'KS01', '6': 'villa almgren tak' },
      { '6': 'villa almgren tak' },
    ])

    expect(result.bags).toEqual([
      { '1': 'KS01', '6': 'P001' },
      { '6': 'P001' },
    ])
    // Exact code KS01 is not echoed; the fuzzy name is echoed ONCE (cached).
    expect(result.resolutions).toHaveLength(1)
    expect(result.resolutions[0]).toMatchObject({
      dimension: 6,
      input: 'villa almgren tak',
      resolved_code: 'P001',
      resolved_name: 'Villa Almgren takrenovering',
    })
    expect(result.resolutions[0].confidence).toBeGreaterThan(0.7)
  })

  it('rejects a dim number with no registry row when enabled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({
      data: [{ id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 }],
      error: null,
    })
    enqueue({ data: [], error: null })

    await expect(
      resolveDimensionBags(supabase as never, 'company-1', [{ '12': 'X' }]),
    ).rejects.toThrow(/Okänd dimension 12/)
  })
})

describe('mergeLineDimensions / parseDimensionsArg', () => {
  it('line bag wins per key over defaults and legacy aliases fill unset keys', () => {
    const merged = mergeLineDimensions(
      { dimensions: { '6': 'P002' }, cost_center: 'KS01' },
      { '6': 'P001', '1': 'KS99' },
    )
    // Line's own bag beats the default for dim 6; the line's cost_center alias
    // beats the default for dim 1 (per-line explicit > voucher default).
    expect(merged).toEqual({ '1': 'KS01', '6': 'P002' })
  })

  it('returns undefined when nothing is tagged', () => {
    expect(mergeLineDimensions({}, undefined)).toBeUndefined()
  })

  it('parseDimensionsArg throws loudly on an invalid bag shape', () => {
    expect(() => parseDimensionsArg({ '0': 'X' }, 'default_dimensions')).toThrow(/Invalid default_dimensions/)
    expect(() => parseDimensionsArg({ '6': 'har"citat' }, 'lines[0].dimensions')).toThrow(/Invalid lines\[0\]\.dimensions/)
  })
})

// ── Dims bag flowing through gnubok_create_voucher ───────────────────────────

describe('gnubok_create_voucher: dimensions bag', () => {
  it('resolves and stages per-line dims + default_dimensions onto the staged lines', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // resolveDimensionBags: settings → ensure rpc → dimensions → dimension_values
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null })
    enqueue({
      data: [
        { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true, is_active: true, sort_order: 10 },
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
      ],
      error: null,
    })
    enqueue({
      data: [
        { id: 'v1', dimension_id: 'dim-1', code: 'KS01', name: 'Stockholm', is_active: true, start_date: null, end_date: null },
        { id: 'v2', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
      ],
      error: null,
    })
    // fiscal period (explicit id path)
    enqueue({
      data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' },
      error: null,
    })
    // chart_of_accounts
    enqueue({
      data: [
        { account_number: '4010', account_name: 'Inköp material', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    // resolvePeriodStatusForDate: 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    // pending_operations insert
    enqueue({ data: { id: 'op-dims' }, error: null })

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Material Villa Almgren',
        fiscal_period_id: 'fp-1',
        default_dimensions: { '6': 'villa almgren tak' },
        lines: [
          { account_number: '4010', debit_amount: 250, credit_amount: 0, dimensions: { '1': 'KS01' } },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        lines: Array<{ dimensions: Record<string, string> | null }>
        dimension_resolutions?: Array<{ dimension: number; input: string; resolved_code: string; resolved_name: string; confidence: number }>
      }
    }

    expect(result.staged).toBe(true)
    // Expense line: own dim 1 + the voucher default dim 6, resolved to codes.
    expect(result.preview.lines[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    // Bank line inherits the voucher default too (it lacks the key itself).
    expect(result.preview.lines[1].dimensions).toEqual({ '6': 'P001' })
    // Non-exact resolution is echoed with the full contract shape.
    expect(result.preview.dimension_resolutions).toHaveLength(1)
    expect(result.preview.dimension_resolutions![0]).toMatchObject({
      dimension: 6,
      input: 'villa almgren tak',
      resolved_code: 'P001',
      resolved_name: 'Villa Almgren takrenovering',
    })
  })

  it('rejects before staging when a dims value has no registry match (no auto-create)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({
      data: [{ id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 }],
      error: null,
    })
    enqueue({
      data: [{ id: 'v2', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren', is_active: true, start_date: null, end_date: null }],
      error: null,
    })

    await expect(
      createVoucher.execute(
        {
          entry_date: '2026-05-12',
          description: 'Unknown project',
          fiscal_period_id: 'fp-1',
          lines: [
            { account_number: '4010', debit_amount: 100, credit_amount: 0, dimensions: { '6': 'Bryggeriet ombyggnad' } },
            { account_number: '1930', debit_amount: 0, credit_amount: 100 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Okänt projekt[\s\S]*gnubok_create_dimension_value/)

    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })

  it('keeps the untagged path query-free (legacy tests unchanged): no settings read without dims', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' },
      error: null,
    })
    enqueue({
      data: [
        { account_number: '1010', account_name: 'Balanserade utgifter', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
      error: null,
    })
    enqueue({ data: null, error: null }) // period status layer 1
    enqueue({ data: null, error: null }) // period status layer 2
    enqueue({ data: { id: 'op-plain' }, error: null }) // pending_operations insert

    const result = (await createVoucher.execute(
      {
        entry_date: '2026-05-12',
        description: 'Ingen dimension',
        fiscal_period_id: 'fp-1',
        lines: [
          { account_number: '1010', debit_amount: 250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 250 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { dimension_resolutions?: unknown } }

    expect(result.staged).toBe(true)
    expect(result.preview.dimension_resolutions).toBeUndefined()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

// ── Dims bags on the PR7 producer tools ──────────────────────────────────────

describe('gnubok_create_invoice: dimensions bag', () => {
  it('stages resolved default_dimensions top-level and per-item bags (default NOT merged into items)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    // resolveDimensionBags: settings → ensure rpc → dimensions → dimension_values
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: REGISTRY_ROWS, error: null })
    enqueue({ data: VALUE_ROWS, error: null })
    // customers fetch
    enqueue({
      data: { id: 'cust-1', name: 'Acme AB', customer_type: 'swedish_business', vat_number_validated: false, default_payment_terms: 30 },
      error: null,
    })
    // resolvePeriodStatusForDate (auto-extracted from invoice_date): 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    // pending_operations insert
    enqueue({ data: { id: 'op-inv-dims' }, error: null })

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-1',
        invoice_date: '2026-05-12',
        default_dimensions: { '6': 'villa almgren tak' },
        items: [
          { description: 'Takarbete', quantity: 10, unit: 'tim', unit_price: 1000, dimensions: { '1': 'KS01' } },
          { description: 'Material', quantity: 1, unit: 'st', unit_price: 500 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        items: Array<{ dimensions?: Record<string, string> }>
        dimension_resolutions?: Array<Record<string, unknown>>
      }
    }

    expect(result.staged).toBe(true)

    // Contract: staged params carry `default_dimensions` top-level (resolved to
    // codes) and each item its OWN resolved bag: the executor merges.
    const op = inserts.find((i) => i.table === 'pending_operations')!
    expect(op).toBeDefined()
    const params = op.payload.params as {
      default_dimensions?: Record<string, string>
      items: Array<{ dimensions?: Record<string, string> }>
    }
    expect(params.default_dimensions).toEqual({ '6': 'P001' })
    expect(params.items[0].dimensions).toEqual({ '1': 'KS01' })
    expect(params.items[1].dimensions).toBeUndefined()

    // (d) Non-exact name resolution is echoed in the result preview.
    expect(result.preview.dimension_resolutions).toHaveLength(1)
    expect(result.preview.dimension_resolutions![0]).toMatchObject({
      dimension: 6,
      input: 'villa almgren tak',
      resolved_code: 'P001',
      resolved_name: 'Villa Almgren takrenovering',
    })
    // Preview items mirror the staged (resolved) bags.
    expect(result.preview.items[0].dimensions).toEqual({ '1': 'KS01' })
  })

  it('stages no dims keys at all when nothing is tagged (zero dim queries)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    enqueue({
      data: { id: 'cust-1', name: 'Acme AB', customer_type: 'swedish_business', vat_number_validated: false, default_payment_terms: 30 },
      error: null,
    })
    enqueue({ data: null, error: null }) // period status layer 1
    enqueue({ data: null, error: null }) // period status layer 2
    enqueue({ data: { id: 'op-inv-plain' }, error: null })

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-1',
        invoice_date: '2026-05-12',
        items: [{ description: 'Arbete', quantity: 1, unit: 'st', unit_price: 100 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { dimension_resolutions?: unknown } }

    expect(result.staged).toBe(true)
    expect(result.preview.dimension_resolutions).toBeUndefined()
    expect(supabase.rpc).not.toHaveBeenCalled()
    const params = inserts.find((i) => i.table === 'pending_operations')!.payload.params as Record<string, unknown>
    expect(params.default_dimensions).toBeUndefined()
    expect((params.items as Array<Record<string, unknown>>)[0].dimensions).toBeUndefined()
  })
})

describe('gnubok_categorize_transaction: dimensions bag', () => {
  it('resolves the bag and stages it as params.dimensions with the echo in the preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    const tx = makeTransaction({ id: 'tx-1', amount: -500 })
    // categorizeTransactionCore: transaction fetch + company_settings
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    // transaction fetch for the title
    enqueue({ data: tx, error: null })
    // resolveDimensionBags: settings → ensure rpc → dimensions → dimension_values
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: REGISTRY_ROWS, error: null })
    enqueue({ data: VALUE_ROWS, error: null })
    // resolvePeriodStatusForDate: 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    // pending_operations insert
    enqueue({ data: { id: 'op-cat-dims' }, error: null })

    const result = (await categorizeTransaction.execute(
      {
        transaction_id: 'tx-1',
        category: 'expense_office',
        dimensions: { '1': 'KS01', '6': 'villa almgren tak' },
        // Skip the booking-duplicate guard so its queries don't consume the queue.
        allow_duplicate: true,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        dimensions?: Record<string, string>
        dimension_resolutions?: Array<Record<string, unknown>>
      }
    }

    expect(result.staged).toBe(true)

    // Contract: staged param name is `dimensions`, resolved to registry codes.
    const params = inserts.find((i) => i.table === 'pending_operations')!.payload.params as {
      dimensions?: Record<string, string>
    }
    expect(params.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })

    // Resolved bag + non-exact echo surface in the approval preview.
    expect(result.preview.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(result.preview.dimension_resolutions).toHaveLength(1)
    expect(result.preview.dimension_resolutions![0]).toMatchObject({
      dimension: 6,
      input: 'villa almgren tak',
      resolved_code: 'P001',
    })
  })

  it('omits the dimensions key entirely when untagged (zero dim queries)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    const tx = makeTransaction({ id: 'tx-1', amount: -500 })
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: tx, error: null })
    enqueue({ data: null, error: null }) // period status layer 1
    enqueue({ data: null, error: null }) // period status layer 2
    enqueue({ data: { id: 'op-cat-plain' }, error: null })

    const result = (await categorizeTransaction.execute(
      { transaction_id: 'tx-1', category: 'expense_office', allow_duplicate: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.dimension_resolutions).toBeUndefined()
    expect(supabase.rpc).not.toHaveBeenCalled()
    const params = inserts.find((i) => i.table === 'pending_operations')!.payload.params as Record<string, unknown>
    expect('dimensions' in params).toBe(false)
  })
})

describe('gnubok_bulk_book_transactions: dimensions bag', () => {
  it('merges default_dimensions into per-line bags and drops the default from staged params', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inserts = captureInserts(supabase)
    // resolveDimensionBags: settings → ensure rpc → dimensions → dimension_values
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: REGISTRY_ROWS, error: null })
    enqueue({ data: VALUE_ROWS, error: null })
    // transactions fetch
    enqueue({
      data: [{ id: 'tx-1', amount: -400, currency: 'SEK', date: '2026-05-12', journal_entry_id: null }],
      error: null,
    })
    // resolvePeriodStatusForDate: 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    // pending_operations insert
    enqueue({ data: { id: 'op-bulk-dims' }, error: null })

    const result = (await bulkBookTransactions.execute(
      {
        tx_ids: ['tx-1'],
        default_dimensions: { '6': 'villa almgren tak' },
        new_entry: {
          description: 'Samlingsverifikation material',
          lines: [
            { account_number: '4010', debit_amount: 400, credit_amount: 0, currency: 'SEK', dimensions: { '1': 'KS01' } },
            { account_number: '1930', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
          ],
        },
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: { dimension_resolutions?: Array<Record<string, unknown>> }
    }

    expect(result.staged).toBe(true)

    // Contract: per-line `new_entry.lines[].dimensions` carries the MERGED
    // (line-over-default) resolved bags; the top-level default is dropped:
    // the executor's RPC reads per-line dims only.
    const params = inserts.find((i) => i.table === 'pending_operations')!.payload.params as {
      default_dimensions?: Record<string, string>
      new_entry: { lines: Array<{ dimensions?: Record<string, string> }> }
    }
    expect(params.default_dimensions).toBeUndefined()
    expect(params.new_entry.lines[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(params.new_entry.lines[1].dimensions).toEqual({ '6': 'P001' })

    // (d) Non-exact name resolution echoed once in the preview.
    expect(result.preview.dimension_resolutions).toHaveLength(1)
    expect(result.preview.dimension_resolutions![0]).toMatchObject({
      dimension: 6,
      input: 'villa almgren tak',
      resolved_code: 'P001',
      resolved_name: 'Villa Almgren takrenovering',
    })
  })

  it('rejects default_dimensions in link-existing mode (posted verifikat is immutable)', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      bulkBookTransactions.execute(
        {
          tx_ids: ['tx-1'],
          existing_journal_entry_id: 'je-1',
          default_dimensions: { '6': 'P001' },
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/default_dimensions only applies/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
