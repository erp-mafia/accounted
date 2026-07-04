import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseSIEFile } from '../sie-parser'
import { collectSIEDimensionUsage } from '../sie-dimensions'
import { normalizeLineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { generateSIEExport } from '@/lib/reports/sie-export'

// ============================================================
// Dimensions plan PR5: the lossless round-trip guarantee.
//
// parse(source) → what import writes (registry rows + line dimension maps)
// → generateSIEExport over exactly that state → parse(exported) must carry
// the same dimension surface: #DIM/#UNDERDIM declarations, #OBJEKT values,
// and per-line object lists. The comparison is structural (both files run
// through the same parser), so formatting/order differences don't matter.
// ============================================================

// Sequential-queue supabase mock: same consumption order as
// sie-export.test.ts documents:
//   0 fiscal_periods.single, 1 prev period, 2 accounts, 3 journal_entries,
//   4 journal_entry_lines, 5 dimensions, 6 dimension_values, 7 OB fallback
let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'in', 'order', 'range', 'lt', 'lte', 'gte', 'gt', 'limit', 'neq', 'eq']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  resultIdx = 0
  results = []
})

const SOURCE_SIE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Roundtrip AB"',
  '#RAR 0 20260101 20261231',
  '#KONTO 5010 "Lokalhyra"',
  '#KONTO 1930 "Företagskonto"',
  '#DIM 1 "Kostnadsställe"',
  '#DIM 6 "Projekt"',
  '#UNDERDIM 2 "Kostnadsbärare" 1',
  // Custom dimension + custom child — exactly what PR10's "Ny dimension"
  // (SIE 20+, optional parent) produces. Proves the round-trip covers
  // user-created dims, not just the reserved 1/2/6 set.
  '#DIM 20 "Avdelning"',
  '#UNDERDIM 25 "Team" 20',
  '#OBJEKT 1 "KS01" "Butiken"',
  '#OBJEKT 2 "KB1" "Bärare ett"',
  '#OBJEKT 6 "P001" "Villa Almgren"',
  '#OBJEKT 20 "SYD" "Avdelning Syd"',
  '#OBJEKT 25 "T1" "Team ett"',
  '#VER A 1 20260115 "Hyra januari"',
  '{',
  '#TRANS 5010 {1 "KS01" 2 "KB1" 6 "P001"} 15000.00',
  '#TRANS 1930 {} -15000.00',
  '}',
  '#VER A 2 20260116 "Odeklarerat projekt"',
  '{',
  // P002 is referenced but never declared via #OBJEKT: import synthesizes
  // it (name = code) and export must re-declare it.
  '#TRANS 5010 {6 "P002"} 500.00',
  '#TRANS 1930 {} -500.00',
  '}',
  '#VER A 3 20260117 "Avdelningskostnad"',
  '{',
  '#TRANS 5010 {20 "SYD" 25 "T1"} 800.00',
  '#TRANS 1930 {} -800.00',
  '}',
].join('\n')

describe('SIE dimensions round-trip', () => {
  it('parse → import state → export → parse preserves the dimension surface', async () => {
    const parsedSource = parseSIEFile(SOURCE_SIE)
    expect(parsedSource.issues.filter((i) => i.severity === 'error')).toEqual([])

    // ── What the importer writes ─────────────────────────────────
    const usage = collectSIEDimensionUsage(parsedSource)

    // Registry rows exactly as importDimensionRegistry inserts them.
    const dimensionRows = [...usage.dims.entries()].map(([sieDimNo, info], i) => ({
      id: `dim-${sieDimNo}`,
      sie_dim_no: sieDimNo,
      parent_sie_dim_no: info.parent ?? null,
      name: info.name,
      sort_order: i,
    }))
    const valueRows = [...usage.values.values()].map((v) => ({
      dimension_id: `dim-${v.sieDimNo}`,
      code: v.code,
      name: v.name,
    }))

    // Journal lines exactly as importVouchers inserts them (dimensions jsonb
    // via normalizeLineDimensions; SIE amount sign → debit/credit).
    const journalEntries = parsedSource.vouchers.map((v, i) => ({
      id: `e${i + 1}`,
      entry_date: '2026-01-15',
      voucher_number: v.number,
      voucher_series: v.series,
      description: v.description,
      status: 'posted',
    }))
    const journalLines = parsedSource.vouchers.flatMap((v, i) =>
      v.lines.map((line) => ({
        journal_entry_id: `e${i + 1}`,
        account_number: line.account,
        debit_amount: line.amount > 0 ? line.amount : 0,
        credit_amount: line.amount < 0 ? Math.abs(line.amount) : 0,
        line_description: line.description ?? null,
        dimensions: normalizeLineDimensions({ dimensions: line.dimensions ?? null }),
      }))
    )

    // ── Export over exactly that state ───────────────────────────
    results = [
      { data: { id: 'period-1', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null },
      { data: null, error: null }, // prev period
      {
        data: [
          { account_number: '5010', account_name: 'Lokalhyra', sru_code: null, is_active: true },
          { account_number: '1930', account_name: 'Företagskonto', sru_code: null, is_active: true },
        ],
        error: null,
      },
      { data: journalEntries, error: null },
      { data: journalLines, error: null },
      { data: dimensionRows, error: null },
      { data: valueRows, error: null },
      { data: [], error: null }, // OB fallback
    ]

    const exported = await generateSIEExport(makeClient(), 'company-1', {
      fiscal_period_id: 'period-1',
      company_name: 'Roundtrip AB',
      org_number: null,
      program_name: 'ERPBase',
    })

    // ── Compare the two dimension surfaces structurally ──────────
    const parsedExport = parseSIEFile(exported)
    expect(parsedExport.issues.filter((i) => i.severity === 'error')).toEqual([])

    const dimSet = (dims: typeof parsedSource.dimensions) =>
      new Set(dims.map((d) => `${d.sieDimNo}|${d.name}|${d.parentSieDimNo ?? ''}`))
    // Every declaration that carries data survives: including the
    // #UNDERDIM child with its parent link. (A declared dimension with no
    // values and no tagged lines is metadata without data; export
    // deliberately omits it, so the fixture gives every dim a value.)
    for (const entry of dimSet(parsedSource.dimensions)) {
      expect(dimSet(parsedExport.dimensions)).toContain(entry)
    }

    const valueSet = (values: typeof parsedSource.dimensionValues) =>
      new Set(values.map((v) => `${v.sieDimNo}|${v.code}|${v.name}`))
    for (const entry of valueSet(parsedSource.dimensionValues)) {
      expect(valueSet(parsedExport.dimensionValues)).toContain(entry)
    }
    // The undeclared-but-referenced P002 got synthesized (name = code).
    expect(valueSet(parsedExport.dimensionValues)).toContain('6|P002|P002')

    // Per-line object lists survive verbatim.
    const lineDims = (parsed: typeof parsedSource) =>
      parsed.vouchers.flatMap((v) => v.lines.map((l) => l.dimensions ?? null))
    expect(lineDims(parsedExport)).toEqual(lineDims(parsedSource))
  })

  it('collectSIEDimensionUsage synthesizes reserved names and prefers declared ones', () => {
    const parsed = parseSIEFile(
      [
        '#FLAGGA 0',
        '#SIETYP 4',
        '#RAR 0 20260101 20261231',
        // Dim 7 (reserved: Anställd) referenced without declaration; dim 6
        // declared with a custom name that must win over "Projekt".
        '#DIM 6 "Mina projekt"',
        '#VER A 1 20260115 "Löner"',
        '{',
        '#TRANS 7010 {7 "ANNA" 6 "P001" 42 "X"} 1000.00',
        '#TRANS 1930 {} -1000.00',
        '}',
      ].join('\n')
    )

    const usage = collectSIEDimensionUsage(parsed)
    expect(usage.dims.get(7)?.name).toBe('Anställd')
    expect(usage.dims.get(6)?.name).toBe('Mina projekt')
    // Unknown custom number falls back to a generic label.
    expect(usage.dims.get(42)?.name).toBe('Dimension 42')
    expect(usage.taggedLines).toBe(1)
    expect([...usage.values.keys()].sort()).toEqual(['42 X', '6 P001', '7 ANNA'])
  })

  it('rejects registry codes that violate the DB CHECK but keeps them on lines', () => {
    const longCode = 'X'.repeat(41)
    const parsed = parseSIEFile(
      [
        '#FLAGGA 0',
        '#SIETYP 4',
        '#RAR 0 20260101 20261231',
        '#VER A 1 20260115 "För lång kod"',
        '{',
        `#TRANS 5010 {6 "${longCode}"} 100.00`,
        '#TRANS 1930 {} -100.00',
        '}',
      ].join('\n')
    )

    // The line keeps the tag (legacy free-text survives on lines)…
    expect(parsed.vouchers[0].lines[0].dimensions).toEqual({ '6': longCode })
    // …but the registry collection skips it and reports why.
    const usage = collectSIEDimensionUsage(parsed)
    expect(usage.values.size).toBe(0)
    expect(usage.invalidCodes.size).toBe(1)
  })
})
