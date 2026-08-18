/**
 * gnubok_vat_close_check: momsdeklaration completeness gate.
 *
 * Regression cover for the pre-flight hole this tool used to have. Its only
 * declaration check was `acquisitionAndImportBase > 0 && ruta48 === 0`, and
 * ruta 48 aggregates 2641/2642/2645/2646/2647/2649: a single ordinary domestic
 * receipt in the period made it unreachable, and there was no basbelopp check
 * (rutor 20-24 against rutor 30-32) at all. A declaration with fiktiv moms and
 * no underlag, the FK004 shape Skatteverket rejects, came back as "Klart för
 * stängning".
 *
 * The tool now runs the SHARED core checks (lib/reports/vat-declaration-checks)
 * over the full SKV 4700 projection, folded through the same filing gate the
 * web UI uses, so these assertions are really asserting "MCP agrees with the
 * web UI".
 *
 * Only the bank reconciliation is mocked: it queries shapes this fixture has no
 * opinion about, and an unreconciled bank would add an unrelated blocker.
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

import { computeVatCloseCheck } from '../server'

interface MockLine {
  entry?: string
  account_number: string
  debit_amount?: number
  credit_amount?: number
  source_type?: string | null
}

interface MockChartAccount {
  account_number: string
  account_name: string
  account_class: number
  default_vat_rate: number | null
  default_vat_treatment: string | null
}

/**
 * Table-routed Supabase double. journal_entries / journal_entry_lines serve the
 * fixture; everything else (transactions, supplier_invoices, company_settings)
 * comes back empty so no unrelated blocker fires.
 */
function mockSupabase(
  lines: MockLine[],
  chartAccounts: MockChartAccount[] = [],
  companySettings: Record<string, unknown> | null = {
    moms_period: 'monthly',
    vat_taxable_base_over_40m: false,
  },
  companyEntityType: 'aktiebolag' | 'enskild_firma' | null = null,
) {
  const entries = [
    ...new Map(
      lines.map((l, i) => {
        const id = l.entry ?? `entry-${i}`
        return [
          id,
          {
            id,
            source_type: l.source_type ?? 'manual',
            voucher_series: 'A',
            voucher_number: 100 + i,
            entry_date: '2026-01-15',
            description: 'Fixture',
            status: 'posted',
          },
        ]
      }),
    ).values(),
  ]
  const bareLines = lines.map((l, i) => ({
    id: `line-${String(i).padStart(4, '0')}`,
    journal_entry_id: l.entry ?? `entry-${i}`,
    account_number: l.account_number,
    debit_amount: l.debit_amount ?? 0,
    credit_amount: l.credit_amount ?? 0,
  }))

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
      if (table === 'journal_entry_lines') return makeChain(bareLines)
      if (table === 'chart_of_accounts') return makeChain(chartAccounts)
      if (table === 'company_settings') {
        return makeChain(companySettings ? [companySettings] : [])
      }
      if (table === 'companies') {
        return makeChain(companyEntityType ? [{ entity_type: companyEntityType }] : [])
      }
      return makeChain([])
    },
    // The missing-underlag blocker reads the verifikat_without_documents RPC,
    // which answers with an envelope rather than a row set. This fixture has no
    // opinion about underlag, so it answers "none missing"; the predicate itself
    // is covered by vat-close-check-missing-underlag.test.ts.
    rpc: (fn: string) =>
      fn === 'verifikat_without_documents'
        ? Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
        : makeChain([]),
  } as never
}

const PERIOD = { period_type: 'monthly', year: 2026, period: 1 }

describe('gnubok_vat_close_check: declaration completeness', () => {
  it('reads the over-40M setting and returns the following-month 26th deadline', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([], [], {
        moms_period: 'monthly',
        vat_taxable_base_over_40m: true,
      }),
    )

    expect(result.payment.deadline).toBe('2026-02-26')
    expect(result.payment.deadline_label).toBe('26 februari 2026')
  })

  it('surfaces an unavailable deadline instead of guessing when settings are missing', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([], [], null),
    )

    expect(result.payment.deadline).toBeNull()
    expect(result.blockers).toContainEqual(expect.objectContaining({
      kind: 'deadline_unavailable',
      severity: 'high',
    }))
    expect(result.ready_to_close).toBe(false)
  })

  it('does not fall back to the company row when annual settings omit entity type', async () => {
    const result = await computeVatCloseCheck(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabase([], [], {
        moms_period: 'yearly',
        vat_taxable_base_over_40m: false,
        fiscal_year_start_month: 1,
        vat_has_eu_trade: false,
        vat_filing_method: 'electronic',
      }, 'aktiebolag'),
    )

    expect(result.payment.deadline).toBeNull()
    expect(result.blockers).toContainEqual(expect.objectContaining({
      kind: 'deadline_unavailable',
      severity: 'high',
    }))
    expect(result.ready_to_close).toBe(false)
  })

  it.each([
    ['enskild_firma', false, '2027-05-12'],
    ['aktiebolag', true, '2027-02-26'],
  ] as const)('does not require an annual filing method for %s with EU trade %s', async (
    entityType,
    vatHasEuTrade,
    expectedDeadline,
  ) => {
    const result = await computeVatCloseCheck(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabase([], [], {
        moms_period: 'yearly',
        vat_taxable_base_over_40m: false,
        entity_type: entityType,
        fiscal_year_start_month: 1,
        vat_has_eu_trade: vatHasEuTrade,
        vat_filing_method: null,
      }),
    )

    expect(result.payment.deadline).toBe(expectedDeadline)
    expect(result.blockers).not.toContainEqual(expect.objectContaining({
      kind: 'deadline_unavailable',
    }))
  })

  it('requires an annual filing method for an AB without EU trade', async () => {
    const result = await computeVatCloseCheck(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabase([], [], {
        moms_period: 'yearly',
        vat_taxable_base_over_40m: false,
        entity_type: 'aktiebolag',
        fiscal_year_start_month: 1,
        vat_has_eu_trade: false,
        vat_filing_method: null,
      }),
    )

    expect(result.payment.deadline).toBeNull()
    expect(result.blockers).toContainEqual(expect.objectContaining({
      kind: 'deadline_unavailable',
      severity: 'high',
    }))
  })

  it('includes a null-rate 3011 with matching domestic VAT evidence (#1289)', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase(
        [
          { entry: 'e1', account_number: '3011', credit_amount: 9725 },
          { entry: 'e1', account_number: '2611', credit_amount: 2431.25 },
          { entry: 'e1', account_number: '1510', debit_amount: 12156.25 },
        ],
        [{
          account_number: '3011',
          account_name: 'Försäljning tjänster inom Sverige, 25 % moms',
          account_class: 3,
          default_vat_rate: null,
          default_vat_treatment: null,
        }],
      ),
    )

    expect(result.rutor.ruta05).toBe(9725)
    expect(result.rutor.ruta10).toBe(2431.25)
    expect(result.declaration_checks.map((finding) => finding.code))
      .not.toContain('OUTPUT_VAT_WITHOUT_SALES_BASE')
    expect(result.ready_to_close).toBe(true)
  })

  it('honors an explicit override of a standard BAS revenue account', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase(
        [
          { entry: 'e1', account_number: '3011', credit_amount: 1000 },
          { entry: 'e1', account_number: '1510', debit_amount: 1000 },
        ],
        [{
          account_number: '3011',
          account_name: 'Momsfri försäljning',
          account_class: 3,
          default_vat_rate: 0,
          default_vat_treatment: 'exempt',
        }],
      ),
    )

    expect(result.rutor.ruta05).toBe(0)
  })

  it('accepts a custom EU goods basis account in the MCP close check', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase(
        [
          { entry: 'e1', account_number: '4056', debit_amount: 1000 },
          { entry: 'e1', account_number: '2440', credit_amount: 1000 },
          { entry: 'e1', account_number: '2614', credit_amount: 250 },
          { entry: 'e1', account_number: '2645', debit_amount: 250 },
        ],
        [{
          account_number: '4056',
          account_name: 'Inköp varor EU 25 %',
          account_class: 4,
          default_vat_rate: 0.25,
          default_vat_treatment: 'reverse_charge_eu_goods',
        }],
      ),
    )

    expect(result.declaration_checks.map((finding) => finding.code))
      .not.toContain('RC_BASIS_MISSING')
    expect(result.ready_to_close).toBe(true)
  })

  it('refuses the #1164 declaration: fiktiv moms on 2614/2645 with no basbelopp on 44xx/45xx', async () => {
    // Both VAT legs of a reverse-charge purchase booked, but the cost went
    // straight to 6540 instead of the 4535 basis account, so rutor 20-24 stay
    // empty while ruta 30 carries 1 250 kr. This is FK004.
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([
        { entry: 'e1', account_number: '3001', credit_amount: 10000 },
        { entry: 'e1', account_number: '2611', credit_amount: 2500 },
        { entry: 'e1', account_number: '1510', debit_amount: 12500 },
        { entry: 'e2', account_number: '6540', debit_amount: 5000 },
        { entry: 'e2', account_number: '2440', credit_amount: 5000 },
        { entry: 'e2', account_number: '2614', credit_amount: 1250 },
        { entry: 'e2', account_number: '2645', debit_amount: 1250 },
      ]),
    )

    expect(result.ready_to_close).toBe(false)
    expect(result.summary).not.toMatch(/Klart för stängning/)
    expect(result.summary).toMatch(/ofullständigt/)

    const codes = result.declaration_checks.map((c) => c.code)
    expect(codes).toContain('RC_BASIS_MISSING')
    const finding = result.declaration_checks.find((c) => c.code === 'RC_BASIS_MISSING')!
    expect(finding.status).toBe('ERROR')
    expect(finding.message).toMatch(/FK004/)

    const blocker = result.blockers.find((b) => b.check_code === 'RC_BASIS_MISSING')!
    expect(blocker.kind).toBe('reverse_charge_input_missing')
    expect(blocker.severity).toBe('high')

    // The old mirror could not see this at all: ruta 48 carries the 2645 leg.
    expect(result.rutor.ruta48).toBe(1250)
  })

  it('one ordinary domestic receipt no longer suppresses the reverse-charge check', async () => {
    // The exact unreachability bug: 2641 from a normal receipt puts 200 kr in
    // ruta 48, so `ruta48 === 0` was false and the whole period went unchecked
    // even though the reverse charge is booked on one side only.
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([
        { entry: 'e1', account_number: '6210', debit_amount: 800 },
        { entry: 'e1', account_number: '2641', debit_amount: 200 },
        { entry: 'e1', account_number: '1930', credit_amount: 1000 },
        { entry: 'e2', account_number: '6540', debit_amount: 5000 },
        { entry: 'e2', account_number: '2440', credit_amount: 5000 },
        { entry: 'e2', account_number: '2614', credit_amount: 1250 },
      ]),
    )

    expect(result.rutor.ruta48).toBe(200)
    expect(result.rutor.ruta48).not.toBe(0)
    expect(result.ready_to_close).toBe(false)

    const codes = result.declaration_checks.map((c) => c.code)
    expect(codes).toContain('RC_BASIS_MISSING')
    expect(codes).toContain('RC_INPUT_VAT_MISMATCH')

    // The input-VAT mismatch stays advisory (partial deduction can explain a
    // shortfall); the missing basbelopp is what blocks.
    const mismatch = result.blockers.find((b) => b.check_code === 'RC_INPUT_VAT_MISMATCH')!
    expect(mismatch.severity).toBe('medium')
    expect(
      result.blockers.some((b) => b.check_code === 'RC_BASIS_MISSING' && b.severity === 'high'),
    ).toBe(true)
  })

  // The check the shared core sharpened, now reachable from MCP: rutor 30-32 are
  // compared against the reverse-charge INPUT accounts (2645/2647), not against
  // the ruta 48 aggregate that ordinary debiterad ingående moms inflates.
  it('sees a completely missing beräknad ingående moms behind a larger ruta 48', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([
        // EU services purchase, correctly booked on the underlag side: basis on
        // 4535 (ruta 21 = 200 000) and fiktiv utgående moms on 2614 (ruta 30 =
        // 50 000), so there is no FK004 finding to hide behind. The beräknad
        // ingående moms on 2645 was never booked.
        { entry: 'e1', account_number: '4535', debit_amount: 200000 },
        { entry: 'e1', account_number: '2440', credit_amount: 200000 },
        { entry: 'e1', account_number: '2614', credit_amount: 50000 },
        // Ordinary domestic purchases: 60 000 kr of debiterad ingående moms.
        // This is the mask: ruta 48 (60 000) stays ABOVE the RC output (50 000).
        { entry: 'e2', account_number: '5410', debit_amount: 240000 },
        { entry: 'e2', account_number: '2641', debit_amount: 60000 },
        { entry: 'e2', account_number: '1930', credit_amount: 300000 },
      ]),
    )

    expect(result.rutor.ruta30).toBe(50000)
    expect(result.rutor.ruta48).toBe(60000)
    // Precisely the state the aggregate comparison called fine.
    expect(result.rutor.ruta48).toBeGreaterThan(result.rutor.ruta30)

    const mismatch = result.declaration_checks.find((c) => c.code === 'RC_INPUT_VAT_MISMATCH')!
    expect(mismatch).toBeDefined()
    // Still a WARNING, deliberately: limited avdragsrätt (blandad verksamhet,
    // ML 13 kap 18/24-25 §§) makes a shortfall correct for some filers.
    expect(mismatch.status).toBe('WARNING')
    expect(mismatch.message).toMatch(/2645/)
    // \s, not a literal space: sv-SE groups thousands with a no-break space.
    expect(mismatch.message).toMatch(/50\s000 kr saknas/)
    expect(result.declaration_checks.map((c) => c.code)).not.toContain('RC_BASIS_MISSING')

    // A warning is not a blocker: ruta 48 is non-zero, so a partial-deduction
    // story exists and the noInputVatAtAll escalation must stay out of it.
    const blocker = result.blockers.find((b) => b.check_code === 'RC_INPUT_VAT_MISMATCH')!
    expect(blocker.kind).toBe('reverse_charge_input_missing')
    expect(blocker.severity).toBe('medium')
  })

  it('still blocks import output VAT with no deductible input at all (ruta 60 without ruta 48)', async () => {
    // The one case the shared checks do not compare against ruta 48: keep the
    // local escalation so removing the old mirror loses no coverage.
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([
        { entry: 'e1', account_number: '4545', debit_amount: 10000 },
        { entry: 'e1', account_number: '2440', credit_amount: 10000 },
        { entry: 'e1', account_number: '2615', credit_amount: 2500 },
      ]),
    )

    expect(result.ready_to_close).toBe(false)
    const blocker = result.blockers.find((b) => b.kind === 'reverse_charge_input_missing')!
    expect(blocker.severity).toBe('high')
    expect(blocker.message).toMatch(/ruta 60\/61\/62/)
  })

  it('a clean period still passes: reverse charge booked with basbelopp AND both VAT legs', async () => {
    const result = await computeVatCloseCheck(
      PERIOD,
      'company-1',
      mockSupabase([
        { entry: 'e1', account_number: '3001', credit_amount: 10000 },
        { entry: 'e1', account_number: '2611', credit_amount: 2500 },
        { entry: 'e1', account_number: '1510', debit_amount: 12500 },
        // EU services purchase, correctly booked: basis on 4535 (ruta 21),
        // fiktiv utgående på 2614 (ruta 30), beräknad ingående på 2645 (ruta 48).
        { entry: 'e2', account_number: '4535', debit_amount: 5000 },
        { entry: 'e2', account_number: '2440', credit_amount: 5000 },
        { entry: 'e2', account_number: '2614', credit_amount: 1250 },
        { entry: 'e2', account_number: '2645', debit_amount: 1250 },
      ]),
    )

    expect(result.declaration_checks).toEqual([])
    expect(result.blockers.filter((b) => b.severity === 'high')).toEqual([])
    expect(result.ready_to_close).toBe(true)
    expect(result.summary).toMatch(/Klart för stängning/)
    expect(result.rutor.ruta49).toBe(2500)
  })
})
