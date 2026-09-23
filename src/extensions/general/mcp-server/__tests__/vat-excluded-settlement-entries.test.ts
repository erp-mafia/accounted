/**
 * gnubok_get_vat_report and gnubok_vat_close_check: say what was excluded.
 *
 * #2805: a customer's agent saw ruta 10 disagree with the general ledger and
 * concluded that manual verifikat are ignored. They are not. The report keeps
 * momsredovisning entries out of the rutor, and recognises the untagged ones by
 * shape, but it never said which verifikat it had dropped, so the gap could not
 * be explained from the tool output.
 *
 * These tests cover the same case table (a to f) as the pg-real suite
 * (tests/pg/vat-skattekonto-counter-entries.pg.test.ts) on the MCP surface,
 * which holds every line in memory and applies core's detectMomsredovisning,
 * plus the two disclosures: excluded_settlement_entries on the report and the
 * informational finding on the close check.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

import { computeVatCloseCheck, computeVatReport } from '../server'

interface MockEntry {
  id: string
  voucher_number: number
  source_type?: string
  entry_date?: string
  /** [account, debit, credit] */
  lines: Array<[string, number, number]>
}

/**
 * Table-routed Supabase double, same shape as the one in
 * vat-close-check-completeness.test.ts. Filters are no-ops: whatever the
 * fixture holds is "the period".
 */
function mockSupabase(fixture: MockEntry[]) {
  const entries = fixture.map((e) => ({
    id: e.id,
    source_type: e.source_type ?? 'manual',
    voucher_series: 'A',
    voucher_number: e.voucher_number,
    entry_date: e.entry_date ?? '2026-01-15',
    status: 'posted',
  }))
  let lineNo = 0
  const lines = fixture.flatMap((e) =>
    e.lines.map(([account_number, debit_amount, credit_amount]) => ({
      id: `line-${String(lineNo++).padStart(4, '0')}`,
      journal_entry_id: e.id,
      account_number,
      debit_amount,
      credit_amount,
    })),
  )

  const makeChain = (rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of [
      'order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[m] = () => chain
    }
    return chain
  }

  return {
    from: (table: string) => {
      if (table === 'journal_entries') return makeChain(entries)
      if (table === 'journal_entry_lines') return makeChain(lines)
      if (table === 'company_settings') {
        return makeChain([{ moms_period: 'monthly', vat_taxable_base_over_40m: false }])
      }
      return makeChain([])
    },
    rpc: (fn: string) =>
      fn === 'verifikat_without_documents'
        ? Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
        : makeChain([]),
  } as never
}

const PERIOD = { period_type: 'monthly', year: 2026, period: 1 }

// The period's real activity: one 25 % sale and one purchase.
const SALE: MockEntry = {
  id: 'sale', voucher_number: 1, source_type: 'invoice_created',
  lines: [['1510', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]],
}
const PURCHASE: MockEntry = {
  id: 'purchase', voucher_number: 2, source_type: 'supplier_invoice_registered',
  lines: [['5410', 400, 0], ['2641', 100, 0], ['2440', 0, 500]],
}
// (a) Skatteverket's omprövning credited to the skattekonto, counter-entry
//     parked on the output VAT account.
const X: MockEntry = {
  id: 'x', voucher_number: 10, lines: [['1630', 86217, 0], ['2610', 0, 86217]],
}
// (b) The same day, the counter-entry is reclassified to the VAT receivable.
const Y: MockEntry = {
  id: 'y', voucher_number: 11, lines: [['2610', 86217, 0], ['1650', 0, 86217]],
}

describe('gnubok_get_vat_report: momsredovisning entries are excluded AND named', () => {
  it('(a)+(b)+(c) X and Y together leave ruta 10 at the real sales VAT', async () => {
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase([SALE, PURCHASE, X, Y]))

    // Before #2805: Y was dropped by shape while X was counted, so ruta 10
    // read 250 + 86 217.
    expect(result.rutor.ruta10).toBe(250)
    expect(result.rutor.ruta48).toBe(100)
    expect(result.rutor.ruta49).toBe(150)

    expect(result.excluded_settlement_entries.count).toBe(2)
    expect(result.excluded_settlement_entries.truncated).toBe(false)
    expect(result.excluded_settlement_entries.note).toMatch(/momsredovisning/)
    expect(result.excluded_settlement_entries.entries).toEqual([
      {
        journal_entry_id: 'x', voucher_label: 'A-10', entry_date: '2026-01-15',
        source_type: 'manual', detected_by: 'tax_account_shape',
      },
      {
        journal_entry_id: 'y', voucher_label: 'A-11', entry_date: '2026-01-15',
        source_type: 'manual', detected_by: 'net_account_shape',
      },
    ])
  })

  it('(a) X alone is excluded: the counted half is what overstated ruta 10', async () => {
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase([SALE, X]))
    expect(result.rutor.ruta10).toBe(250)
    expect(result.excluded_settlement_entries.entries.map((e) => e.journal_entry_id)).toEqual(['x'])
  })

  it('(d) keeps a bidrag received on the skattekonto: 1630 D / 3980 K', async () => {
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase([
      SALE,
      { id: 'bidrag', voucher_number: 20, lines: [['1630', 25136, 0], ['3980', 0, 25136]] },
    ]))
    expect(result.excluded_settlement_entries.count).toBe(0)
    expect(result.excluded_settlement_entries.entries).toEqual([])
  })

  it('(e) keeps a business verifikat paid from the skattekonto: 5410 D / 2641 D / 1630 K', async () => {
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase([
      SALE,
      { id: 'biz', voucher_number: 21, lines: [['5410', 400, 0], ['2641', 100, 0], ['1630', 0, 500]] },
    ]))
    expect(result.rutor.ruta48).toBe(100)
    expect(result.excluded_settlement_entries.count).toBe(0)
  })

  it('(f) still excludes a classic settlement and one that carries a small cost line', async () => {
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase([
      SALE,
      PURCHASE,
      {
        id: 'classic', voucher_number: 30, source_type: 'import',
        lines: [['2611', 250, 0], ['2641', 0, 100], ['2650', 0, 150]],
      },
      {
        id: 'with-cost', voucher_number: 31, source_type: 'import',
        lines: [['2611', 250, 0], ['2641', 0, 100], ['2650', 0, 190], ['6050', 40, 0]],
      },
    ]))
    expect(result.rutor.ruta10).toBe(250)
    expect(result.rutor.ruta48).toBe(100)
    expect(result.excluded_settlement_entries.entries.map((e) => [e.journal_entry_id, e.detected_by]))
      .toEqual([['classic', 'net_account_shape'], ['with-cost', 'net_account_shape']])
  })

  it('lists tagged vat_settlement entries too, marked as tagged', async () => {
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase([
      SALE,
      {
        id: 'tagged', voucher_number: 40, source_type: 'vat_settlement', entry_date: '2026-01-31',
        lines: [['2611', 250, 0], ['2650', 0, 250]],
      },
    ]))
    expect(result.rutor.ruta10).toBe(250)
    expect(result.excluded_settlement_entries.entries).toEqual([
      {
        journal_entry_id: 'tagged', voucher_label: 'A-40', entry_date: '2026-01-31',
        source_type: 'vat_settlement', detected_by: 'tagged',
      },
    ])
  })

  it('caps the list at 20, keeps the true count, and orders by date then voucher', async () => {
    const many: MockEntry[] = Array.from({ length: 23 }, (_, i) => ({
      id: `s${i}`,
      voucher_number: 100 - i,
      entry_date: i === 0 ? '2026-01-02' : '2026-01-20',
      lines: [['2611', 10, 0], ['1630', 0, 10]] as Array<[string, number, number]>,
    }))
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase(many))

    expect(result.excluded_settlement_entries.count).toBe(23)
    expect(result.excluded_settlement_entries.truncated).toBe(true)
    expect(result.excluded_settlement_entries.entries).toHaveLength(20)
    // Earliest date first, then numeric voucher order (A-78 before A-100).
    expect(result.excluded_settlement_entries.entries[0]!.voucher_label).toBe('A-100')
    expect(result.excluded_settlement_entries.entries[1]!.voucher_label).toBe('A-78')
    expect(result.excluded_settlement_entries.entries[2]!.voucher_label).toBe('A-79')
  })

  it('reports an empty list, not a missing key, when nothing was excluded', async () => {
    const result = await computeVatReport(PERIOD, 'company-1', mockSupabase([SALE]))
    expect(result.excluded_settlement_entries).toMatchObject({ count: 0, truncated: false, entries: [] })
  })
})

describe('gnubok_vat_close_check: shape-detected entries become an informational finding', () => {
  it('names the untagged entries, at severity low, without touching ready_to_close', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([
        SALE,
        X,
        Y,
        {
          id: 'tagged', voucher_number: 40, source_type: 'vat_settlement',
          lines: [['2611', 250, 0], ['2650', 0, 250]],
        },
      ]),
    )

    const finding = result.blockers.find((b) => b.kind === 'momsredovisning_entries_excluded')
    expect(finding).toBeDefined()
    expect(finding!.severity).toBe('low')
    // The tagged settlement is the app's own booking: not part of the finding.
    expect(finding!.count).toBe(2)
    expect(finding!.message).toContain('A-10 (2026-01-15)')
    expect(finding!.message).toContain('A-11 (2026-01-15)')
    expect(finding!.message).not.toContain('A-40')
    expect(finding!.entries?.map((e) => e.journal_entry_id)).toEqual(['x', 'y'])

    // Informational: it is not a high blocker, so readiness is decided by
    // everything else, exactly as before.
    expect(result.blockers.filter((b) => b.severity === 'high')).toEqual([])
    expect(result.ready_to_close).toBe(true)
    expect(result.rutor.ruta10).toBe(250)
  })

  it('stays silent when the period only holds tagged settlements or none at all', async () => {
    const tagged = await computeVatCloseCheck(PERIOD, 'company-1', mockSupabase([
      SALE,
      {
        id: 'tagged', voucher_number: 40, source_type: 'vat_settlement',
        lines: [['2611', 250, 0], ['2650', 0, 250]],
      },
    ]))
    expect(tagged.blockers.some((b) => b.kind === 'momsredovisning_entries_excluded')).toBe(false)

    const none = await computeVatCloseCheck(PERIOD, 'company-1', mockSupabase([SALE]))
    expect(none.blockers.some((b) => b.kind === 'momsredovisning_entries_excluded')).toBe(false)
  })
})
