import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { BalansrapportPDF, ResultatrapportPDF } from '../operational-report-pdf-template'
import type { BalansrapportReport, CompanySettings, ResultatrapportReport } from '@/types'
import { pdfTextStrings } from '@/tests/pdf-text'
import { formatAmount } from '@/lib/utils'

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
        sections: [
          {
            key: 'omsattningstillgangar',
            label: 'Omsättningstillgångar',
            total_label: 'Summa omsättningstillgångar',
            rows: [],
            sections: [
              {
                key: 'kassaBank',
                label: 'Kassa och bank',
                total_label: 'Summa kassa och bank',
                // A range that starts after the year's first day: the year
                // opened at 40 000, the range at 50 000.
                rows: [
                  { account_number: '1930', account_name: 'Företagskonto', year_ib: 40000, ib: 50000, ub: 75000, period_change: 25000 },
                ],
                sections: [],
                subtotal_year_ib: 40000,
                subtotal_ib: 50000,
                subtotal_change: 25000,
                subtotal_ub: 75000,
              },
            ],
            subtotal_year_ib: 40000,
            subtotal_ib: 50000,
            subtotal_change: 25000,
            subtotal_ub: 75000,
          },
        ],
        subtotal_year_ib: 40000,
        subtotal_ib: 50000,
        subtotal_change: 25000,
        subtotal_ub: 75000,
      },
    ],
    total_assets_ub: 75000,
    total_equity_liabilities_ub: -75000,
    beraknat_resultat: 0,
    differens: 0,
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
    'prints the balansrapport ÅRL headings and their Summa lines around the accounts',
    async () => {
      const buffer = await renderToBuffer(
        BalansrapportPDF({
          report: balansrapport(),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
        })
      )

      const text = pdfTextStrings(buffer).join('\n')
      const order = [
        '1 Tillgångar',
        'Omsättningstillgångar',
        'Kassa och bank',
        'Företagskonto',
        'Summa kassa och bank',
        'Summa omsättningstillgångar',
        'Summa 1 Tillgångar',
      ].map((label) => text.indexOf(label))
      expect(order.every((index) => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    },
    RENDER_TIMEOUT
  )

  it(
    'prints the year\'s ingående balans, the ingående saldo, the change and UB, in that order',
    async () => {
      const text = pdfTextStrings(await renderToBuffer(
        BalansrapportPDF({
          report: balansrapport(),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
        })
      )).join('\n')

      expect(text.toUpperCase()).toContain('ING. BALANSING. SALDOFÖRÄNDRINGUTG. BALANS')
      // The PDF writes formatAmount's no-break space as a plain one.
      const amounts = [40000, 50000, 25000, 75000].map(formatAmount).join('').replace(/\s/g, ' ')
      expect(text).toContain(`Företagskonto${amounts}`)
      expect(text).toContain(`Summa kassa och bank${amounts}`)
    },
    RENDER_TIMEOUT
  )

  it(
    'prints the differens on its own line only when the balansrapport does not balance',
    async () => {
      const render = async (overrides: Parameters<typeof balansrapport>[0]) =>
        pdfTextStrings(await renderToBuffer(
          BalansrapportPDF({
            report: balansrapport(overrides),
            company: fakeCompany(),
            generatedAt: '2026-07-28T10:00:00.000Z',
          })
        )).join('\n')

      expect(await render({})).not.toContain('Differens')
      const unbalanced = await render({
        total_equity_liabilities_ub: -45_000,
        beraknat_resultat: 0,
        differens: 30_000,
        is_balanced: false,
      })
      expect(unbalanced).toContain('Differens')
      expect(unbalanced).toContain('Balanserar ej')
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

  it(
    'prints class 8 in its blocks with Resultat efter finansiella poster between them',
    async () => {
      const row = (account_number: string, account_name: string, amount: number) => ({
        account_number,
        account_name,
        current_period: amount,
        prior_period: 0,
      })
      const finansiella = [row('8410', 'Räntekostnader', -3000)]
      const skatter = [row('8910', 'Skatt som belastar årets resultat', -20000)]
      const text = pdfTextStrings(await renderToBuffer(
        ResultatrapportPDF({
          report: resultatrapport({
            groups: [
              ...resultatrapport().groups,
              {
                class: 8,
                class_label: '8 Finansiella poster och bokslutsdispositioner',
                rows: [...finansiella, ...skatter],
                subtotal_current: -23000,
                subtotal_prior: 0,
                subgroups: [
                  {
                    key: 'finansiella_poster',
                    label: 'Finansiella poster',
                    total_label: 'Summa finansiella poster',
                    above_result_after_financial: true,
                    rows: finansiella,
                    subtotal_current: -3000,
                    subtotal_prior: 0,
                  },
                  {
                    key: 'skatter',
                    label: 'Skatter',
                    total_label: 'Summa skatter',
                    above_result_after_financial: false,
                    rows: skatter,
                    subtotal_current: -20000,
                    subtotal_prior: 0,
                  },
                ],
              },
            ],
            result_after_financial: { label: 'Resultat efter finansiella poster', current: 97000, prior: 80000 },
            net_result_current: 77000,
          }),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
        })
      )).join('\n')

      // Each label is looked for after the end of the one before it.
      let from = 0
      const missing: string[] = []
      for (const label of [
        '8 Finansiella poster och bokslutsdispositioner',
        'Finansiella poster',
        'Räntekostnader',
        'Summa finansiella poster',
        'Resultat efter finansiella poster',
        'Skatter',
        'Skatt som belastar årets resultat',
        'Summa skatter',
        'Beräknat resultat',
      ]) {
        const at = text.indexOf(label, from)
        if (at < 0) missing.push(label)
        else from = at + label.length
      }
      expect(missing).toEqual([])
      // The line reads the report's figure; the class-8 total is not printed.
      expect(text).toContain(`Resultat efter finansiella poster${formatAmount(97000).replace(/\s/g, ' ')}`)
      expect(text).not.toContain('23 000,00')
    },
    RENDER_TIMEOUT
  )
})
