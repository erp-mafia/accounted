import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeTaxCode } from '@/tests/helpers'

// ============================================================
// Mock: separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown; count?: number | null }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lte', 'gte', 'in', 'not', 'or', 'order', 'limit', 'is']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

import { getTaxCodeByCode, calculateMomsFromTaxCodes } from '../tax-code-service'

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
})

describe('getTaxCodeByCode', () => {
  it('prefers user code over system code', async () => {
    const userCode = makeTaxCode({
      id: 'tc-user',
      user_id: 'user-1',
      code: 'MP1',
      description: 'Custom 25% moms',
      rate: 25,
    })

    results = [{ data: userCode, error: null }]

    const supabase = makeClient()
    const result = await getTaxCodeByCode(supabase as never, 'user-1', 'MP1')
    expect(result).not.toBeNull()
    expect(result!.user_id).toBe('user-1')
    expect(result!.description).toBe('Custom 25% moms')
  })

  it('returns null when code does not exist', async () => {
    results = [{ data: null, error: { code: 'PGRST116' } }]

    const supabase = makeClient()
    const result = await getTaxCodeByCode(supabase as never, 'user-1', 'NONEXISTENT')
    expect(result).toBeNull()
  })
})

describe('calculateMomsFromTaxCodes', () => {
  it('aggregates correctly to moms boxes', async () => {
    const mp1 = makeTaxCode({
      code: 'MP1',
      rate: 25,
      moms_basis_boxes: ['05'],
      moms_tax_boxes: ['10'],
      moms_input_boxes: [],
      is_output_vat: true,
    })
    const ip1 = makeTaxCode({
      code: 'IP1',
      rate: 25,
      moms_basis_boxes: [],
      moms_tax_boxes: [],
      moms_input_boxes: ['48'],
      is_output_vat: false,
    })

    const lines = [
      { tax_code: 'MP1', debit_amount: 0, credit_amount: 10000, journal_entry_id: 'je1', journal_entries: {} },
      { tax_code: 'MP1', debit_amount: 0, credit_amount: 5000, journal_entry_id: 'je2', journal_entries: {} },
      { tax_code: 'IP1', debit_amount: 2500, credit_amount: 0, journal_entry_id: 'je3', journal_entries: {} },
    ]

    results = [
      // 0: journal lines query (thenable: no .single())
      { data: lines, error: null },
      // 1: getTaxCodes query (thenable: no .single())
      { data: [mp1, ip1], error: null },
    ]

    const supabase = makeClient()
    const result = await calculateMomsFromTaxCodes(supabase as never, 'user-1', '2024-01-01', '2024-12-31')

    expect(result.length).toBeGreaterThan(0)
    // Results should be sorted by box
    for (let i = 1; i < result.length; i++) {
      expect(result[i].box >= result[i - 1].box).toBe(true)
    }
    // Check that we have the expected boxes
    const boxes = result.map((r) => r.box)
    expect(boxes).toContain('05')
    expect(boxes).toContain('10')
    expect(boxes).toContain('48')
  })
})
