/**
 * Dimensions PR4: gnubok_get_dimension_pnl MCP surface tests.
 *
 * Covers registration (schema conventions + scope map) and the execute path:
 * default-period lookup, explicit period + date-window passthrough, and the
 * sie_dim_no guard. The matrix math itself is covered by the generator's own
 * tests in lib/reports/__tests__/: here generateDimensionPnl is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { generateDimensionPnl } from '@/lib/reports/dimension-pnl'
import { tools } from '../server'

vi.mock('@/lib/reports/dimension-pnl', () => ({
  generateDimensionPnl: vi.fn(),
}))

const tool = tools.find((t) => t.name === 'gnubok_get_dimension_pnl')!
const mockGenerate = vi.mocked(generateDimensionPnl)

function makeReport() {
  return {
    dimension: { sie_dim_no: '6', name: 'Projekt' },
    columns: [
      { code: 'P001', name: 'Villa Almgren takrenovering' },
      { code: null, name: null },
    ],
    groups: [
      {
        class: 3,
        class_label: '3 Rörelsens inkomster/intäkter',
        rows: [
          { account_number: '3010', account_name: 'Försäljning', values: [1000, 250], total: 1250 },
        ],
        subtotals: [1000, 250],
        subtotal_total: 1250,
      },
    ],
    net_per_column: [1000, 250],
    net_total: 1250,
    period: { start: '2026-01-01', end: '2026-12-31' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Registration ─────────────────────────────────────────────────────────────

describe('gnubok_get_dimension_pnl: registration', () => {
  it('is registered, read-only, and mapped to reports:read (unmapped = any key)', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(TOOL_SCOPE_MAP.gnubok_get_dimension_pnl).toBe('reports:read')
  })

  it('declares a strict inputSchema and a tight description', () => {
    const input = tool.inputSchema as { additionalProperties?: boolean; required?: string[] }
    expect(input.additionalProperties).toBe(false)
    expect(input.required).toEqual(['sie_dim_no'])
    expect(tool.description.length).toBeLessThanOrEqual(280)
  })

  it('mirrors the DimensionPnlReport contract in its outputSchema', () => {
    const output = tool.outputSchema as { required?: string[]; properties?: Record<string, unknown> }
    expect(output.required).toEqual(['dimension', 'columns', 'groups', 'net_per_column', 'net_total'])
    expect(output.properties?.period).toBeDefined()
  })
})

// ── Execute ──────────────────────────────────────────────────────────────────

describe('gnubok_get_dimension_pnl: execute', () => {
  it('passes an explicit period + date window straight to the generator (no period lookup)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const report = makeReport()
    mockGenerate.mockResolvedValueOnce(report as never)

    const result = await tool.execute(
      { sie_dim_no: '6', period_id: 'fp-1', to_date: '2026-03-31' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', '6', {
      toDate: '2026-03-31',
    })
    expect(result).toEqual(report)
    // Explicit period_id → no fiscal_periods default lookup.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('defaults to the most recent fiscal period when period_id is omitted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'fp-latest', name: '2026' }, error: null }) // fiscal_periods lookup
    mockGenerate.mockResolvedValueOnce(makeReport() as never)

    await tool.execute({ sie_dim_no: '1' }, 'company-1', 'user-1', supabase as never)

    expect(supabase.from).toHaveBeenCalledWith('fiscal_periods')
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'fp-latest', '1', {
      toDate: undefined,
    })
  })

  it('errors when no fiscal period exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    await expect(
      tool.execute({ sie_dim_no: '6' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/No fiscal periods found/)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric sie_dim_no before touching the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    for (const bad of ['projekt', '', '0', '6; drop']) {
      await expect(
        tool.execute({ sie_dim_no: bad }, 'company-1', 'user-1', supabase as never),
      ).rejects.toThrow(/positive SIE dimension number/)
    }
    expect(supabase.from).not.toHaveBeenCalled()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('accepts a numeric sie_dim_no by coercing it to string (lenient hosts)', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockGenerate.mockResolvedValueOnce(makeReport() as never)

    await tool.execute({ sie_dim_no: 6, period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never)

    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', '6', {
      toDate: undefined,
    })
  })
})
