import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { SystemdokumentationPDF } from '../systemdokumentation-pdf-template'
import { buildSystemdokumentation, type SystemdokumentationFacts } from '../systemdokumentation'

// Real @react-pdf/renderer layout is CPU-heavy; give it room on a saturated runner.
const RENDER_TIMEOUT = 30_000

function facts(): SystemdokumentationFacts {
  // A chart long enough to push bilaga A onto later pages, so the fixed
  // header/footer and the wrap rules are exercised across page breaks.
  const accounts = Array.from({ length: 140 }, (_, i) => {
    const number = String(1000 + i * 55)
    return { account_number: number, account_name: `Konto ${number} med ett långt namn för radbrytning`, account_class: Number(number[0]), sru_code: i % 3 === 0 ? '7281' : null }
  })
  return {
    company: { name: 'Testbolaget AB', org_number: '5566778899', accounting_framework: 'k2' },
    settings: {
      entity_type: 'aktiebolag',
      accounting_method: 'cash',
      moms_period: 'yearly',
      vat_registered: true,
      pays_salaries: true,
      fiscal_year_start_month: 7,
      bookkeeping_locked_through: '2026-06-30',
      auto_lock_period_days: 40,
      default_voucher_series: 'A',
      default_voucher_series_per_source_type: { invoice_created: 'B', invoice_paid: 'C', supplier_invoice_registered: 'D', salary_payment: 'K' },
      voucher_series_labels: {},
      ore_rounding: true,
      dimensions_enabled: false,
      recurring_invoices_enabled: true,
      invoice_payment_links_enabled: true,
    },
    period: { id: 'p1', name: 'Räkenskapsår 2025/2026', period_start: '2025-07-01', period_end: '2026-06-30', is_closed: false, locked_at: null },
    accounts,
    sequences: [
      { voucher_series: 'A', last_number: 412 },
      { voucher_series: 'B', last_number: 88 },
    ],
    cashAccounts: [{ name: 'Företagskonto', ledger_account: '1930', voucher_series: 'F', source: 'enable_banking', enabled: true }],
    members: [
      { user_id: 'u1', role: 'owner', joined_at: '2025-07-01T00:00:00Z' },
      { user_id: 'u2', role: 'viewer', joined_at: '2026-01-15T00:00:00Z' },
    ],
    apiKeys: [{ name: 'Claude → bokföring', key_prefix: 'gnubok_sk_9f3a', user_id: 'u1', scopes: ['bookkeeping:write'], created_at: '2026-02-01T00:00:00Z', last_used_at: '2026-09-01T00:00:00Z', unattended_commit_limit: 2500 }],
    dimensions: [],
    connections: { bank: true, skatteverket: true, peppol: true, stripe: false, shopify: true, woocommerce: false, zettle: false, whatsapp: true, email_inbox: true, cloud_backup: true },
    labels: new Map([
      ['u1', 'anna@example.se'],
      ['u2', 'Revisorn'],
    ]),
    env: { appName: 'Accounted', appUrl: 'https://app.accounted.se', hosted: true, mfaRequired: true, appVersion: 'abc123def456', generatedAt: '2026-09-25T12:00:00.000Z' },
  }
}

describe('SystemdokumentationPDF', () => {
  it(
    'renders a valid multi-page PDF from a full report',
    async () => {
      const report = buildSystemdokumentation(facts())
      const buffer = await renderToBuffer(SystemdokumentationPDF({ report }))
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
      // 140 chart rows plus nine sections cannot fit one A4 page.
      expect((buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBeGreaterThan(2)
    },
    RENDER_TIMEOUT,
  )

  it(
    'renders an empty company (no settings, members or keys) without throwing',
    async () => {
      const report = buildSystemdokumentation({ ...facts(), settings: null, accounts: [], sequences: [], cashAccounts: [], members: [], apiKeys: [], labels: new Map(), connections: { bank: false, skatteverket: false, peppol: false, stripe: false, shopify: false, woocommerce: false, zettle: false, whatsapp: false, email_inbox: false, cloud_backup: false } })
      const buffer = await renderToBuffer(SystemdokumentationPDF({ report }))
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
    },
    RENDER_TIMEOUT,
  )
})
