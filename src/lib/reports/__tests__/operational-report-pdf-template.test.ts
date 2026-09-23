import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { BalansrapportPDF, ResultatrapportPDF } from '../operational-report-pdf-template'
import type { BalansrapportReport, CompanySettings, ResultatrapportReport } from '@/types'

// Real @react-pdf/renderer layout is CPU-heavy; under a fully parallel
// test run these can exceed the 5s default on a saturated machine.
const RENDER_TIMEOUT = 30_000

function fakeCompany(): CompanySettings {
  return {
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
    vat_number: 'SE556677889901',
    entity_type: 'aktiebolag',
  } as unknown as CompanySettings
}

function balansrapport(overrides: Partial<BalansrapportReport> = {}): BalansrapportReport {
  return {
    groups: [
      {
        class: 1,
        class_label: '1 Tillgångar',
        rows: [
          { account_number: '1930', account_name: 'Företagskonto', ib: 50000, ub: 75000, period_change: 25000 },
        ],
        subtotal_ib: 50000,
        subtotal_ub: 75000,
      },
    ],
    total_assets_ub: 75000,
    total_equity_liabilities_ub: -75000,
    beraknat_resultat: 0,
    is_balanced: true,
    period: { start: '2026-01-01', end: '2026-12-31' },
    ...overrides,
  }
}

function resultatrapport(overrides: Partial<ResultatrapportReport> = {}): ResultatrapportReport {
  return {
    groups: [
      {
        class: 3,
        class_label: '3 Rörelsens inkomster/intäkter',
        rows: [
          { account_number: '3001', account_name: 'Försäljning 25%', current_period: 100000, prior_period: 80000 },
        ],
        subtotal_current: 100000,
        subtotal_prior: 80000,
      },
    ],
    net_result_current: 100000,
    net_result_prior: 80000,
    period: { start: '2026-01-01', end: '2026-12-31' },
    prior_period: { start: '2025-01-01', end: '2025-12-31' },
    ...overrides,
  }
}

describe('operational report PDFs', () => {
  it(
    'renders the balansrapport with the latest-voucher header line',
    async () => {
      const buffer = await renderToBuffer(
        BalansrapportPDF({
          report: balansrapport({
            latest_vouchers: [
              { series: 'A', last_number: 214 },
              { series: 'B', last_number: 37 },
            ],
          }),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
        })
      )

      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
      expect(buffer.length).toBeGreaterThan(1000)
    },
    RENDER_TIMEOUT
  )

  it(
    'renders the balansrapport without the line when no vouchers exist',
    async () => {
      const buffer = await renderToBuffer(
        BalansrapportPDF({
          report: balansrapport(),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
        })
      )

      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
    },
    RENDER_TIMEOUT
  )

  it(
    'renders the resultatrapport with both the voucher line and a filter note',
    async () => {
      const buffer = await renderToBuffer(
        ResultatrapportPDF({
          report: resultatrapport({
            latest_vouchers: [{ series: 'A', last_number: 88 }],
          }),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
          filterNote: 'Filtrerad (dimension 6: P001), ej fullständig rapport',
        })
      )

      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
      expect(buffer.length).toBeGreaterThan(1000)
    },
    RENDER_TIMEOUT
  )
})
