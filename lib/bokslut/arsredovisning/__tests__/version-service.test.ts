import { describe, expect, it, vi } from 'vitest'
import type { CanonicalAnnualReport } from '../compliance-types'
import {
  annualReportContentHash,
  createAnnualReportVersion,
} from '../version-service'
import { mapTrialBalancesToK2 } from '../../ixbrl/k2-mapper'
import { buildBrRows, buildRrRows } from '../statement-rows'

function model(signedAt: string | null): CanonicalAnnualReport {
  const full = [
    { account_number: '1930', account_name: 'Bank', closing_debit: 100, closing_credit: 0 },
    { account_number: '2081', account_name: 'Share capital', closing_debit: 0, closing_credit: 80 },
    { account_number: '2099', account_name: 'Current result', closing_debit: 0, closing_credit: 20 },
    { account_number: '3010', account_name: 'Revenue', closing_debit: 20, closing_credit: 20 },
  ]
  const preClosing = [
    { account_number: '1930', account_name: 'Bank', closing_debit: 100, closing_credit: 0 },
    { account_number: '2081', account_name: 'Share capital', closing_debit: 0, closing_credit: 80 },
    { account_number: '3010', account_name: 'Revenue', closing_debit: 0, closing_credit: 20 },
  ]
  const mapping = mapTrialBalancesToK2({ full, preClosing }, null)
  const balanceRows = buildBrRows(mapping)
  return {
    schema_version: '1.0',
    generated_at: '2026-07-21T10:00:00Z',
    company_id: 'company-1',
    fiscal_period_id: 'period-1',
    entity_type: 'aktiebolag',
    report: {
      accounting_framework: 'k2',
      signatures: [{ role: 'Styrelseledamot', name: 'Anna Andersson', signed_at: signedAt }],
      resultatrakning: buildRrRows(mapping),
      balansrakning: {
        assets: balanceRows.assets,
        equity_liabilities: balanceRows.equityLiabilities,
        total_assets: 100,
        total_equity_liabilities: 100,
      },
      forvaltningsberattelse: {
        resultatdisposition_amounts: { current_year_result: 20 },
      },
    },
    profile: { reporting_currency: 'SEK' },
    disclosures: {},
    eligibility: {
      digital_filing_eligible: true,
      digital_issues: [],
    },
    validation: { ok: true },
    ixbrl: {
      entryPointId: 'k2-ab-risbs-2024-09-12',
      rr: mapping.rr,
      br: mapping.br,
      totals: mapping.totals,
      underskrifter: {
        dateringsdatum: signedAt,
        signers: [
          {
            firstName: 'Anna',
            lastName: 'Andersson',
            role: 'Styrelseledamot',
            signedDate: signedAt,
          },
        ],
      },
      faststallelseintyg: {
        signerFirstName: 'Anna',
        signerLastName: 'Andersson',
        signerRole: 'Styrelseledamot',
        genereratDatum: '2026-07-21',
      },
    },
  } as unknown as CanonicalAnnualReport
}

describe('annualReportContentHash', () => {
  it('does not change when evidence dates are overlaid after locking', () => {
    expect(annualReportContentHash(model(null))).toBe(
      annualReportContentHash(model('2026-03-01T10:00:00Z')),
    )
  })

  it('changes when signed content changes', () => {
    const original = model(null)
    const changed = model(null)
    changed.report.signatures[0].name = 'Bertil Andersson'
    expect(annualReportContentHash(changed)).not.toBe(annualReportContentHash(original))
  })

  it('locks the digital eligibility decision into the validation snapshot', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: 'version-1', version_number: 1, status: 'draft' }],
      error: null,
    })
    await createAnnualReportVersion({ rpc } as never, 'user-1', model(null), false)
    expect(rpc).toHaveBeenCalledWith(
      'create_annual_report_version',
      expect.objectContaining({
        p_validation_summary: expect.objectContaining({
          digital_filing_eligible: true,
          digital_issues: [],
          profile: expect.objectContaining({ reporting_currency: 'SEK' }),
          disclosures: {},
          eligibility: expect.objectContaining({ digital_filing_eligible: true }),
        }),
      }),
    )
  })

  it('refuses to snapshot inconsistent financial statements', async () => {
    const rpc = vi.fn()
    const inconsistent = model(null)
    inconsistent.report.resultatrakning.find(
      (row) => row.label === 'Årets resultat',
    )!.current = 21
    inconsistent.validation = { ...inconsistent.validation, ok: true, issues: [] }

    await expect(
      createAnnualReportVersion({ rpc } as never, 'user-1', inconsistent, false),
    ).rejects.toThrow('inconsistent financial statements')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a PDF and iXBRL line reclassification with unchanged totals', async () => {
    const rpc = vi.fn()
    const inconsistent = model(null)
    inconsistent.ixbrl!.rr = {
      ...inconsistent.ixbrl!.rr,
      Nettoomsattning: { current: 0, previous: null },
      OvrigaRorelseintakter: { current: 20, previous: null },
    }

    await expect(
      createAnnualReportVersion({ rpc } as never, 'user-1', inconsistent, false),
    ).rejects.toThrow('inconsistent financial statements')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a mutated visible balance-sheet result row', async () => {
    const rpc = vi.fn()
    const inconsistent = model(null)
    inconsistent.report.balansrakning.equity_liabilities.find(
      (row) => row.label === 'Årets resultat',
    )!.current = 19

    await expect(
      createAnnualReportVersion({ rpc } as never, 'user-1', inconsistent, false),
    ).rejects.toThrow('inconsistent financial statements')
    expect(rpc).not.toHaveBeenCalled()
  })
})
