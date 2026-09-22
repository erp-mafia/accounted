import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { BokslutsbilagorPDF } from '../bokslutsbilagor-pdf-template'
import type { BokslutsbilagorReport } from '../bokslutsbilagor-types'

function report(): BokslutsbilagorReport {
  const account = (n: number): BokslutsbilagorReport['accounts'][number] => ({
    account_key: `manual:${2300 + n}`,
    kind: 'manual',
    account_number: String(2300 + n),
    name: `Skuld ${n} med ett ganska långt namn för radbrytning`,
    opening_balance: -100000 - n,
    movement: 5000,
    closing_balance: -95000 - n,
    external_label_sv: 'Saldo enligt underlag (angivet vid signering)',
    external_label_en: 'Balance per supporting documents (stated at sign-off)',
    external_balance: -95000 - n,
    difference: 0,
    signoff: {
      id: `s${n}`,
      through_date: '2026-12-31',
      on_balansdag: n % 2 === 0,
      external_balance: -95000 - n,
      ledger_balance: -95000 - n,
      unexplained_difference: 0,
      note: n % 3 === 0 ? 'Enligt engagemangsbesked → kontrollerat' : null,
      signed_by: 'u1',
      signed_by_label: 'yasemin@example.se',
      signed_at: '2027-01-10T08:00:00Z',
    },
    attachments: [
      {
        id: `a${n}`,
        through_date: '2026-12-31',
        file_name: `engagemangsbesked-${n}.pdf`,
        mime_type: 'application/pdf',
        size_bytes: 1234,
        sha256: 'ab'.repeat(32),
        note: null,
        uploaded_by_label: 'yasemin@example.se',
        uploaded_at: '2027-01-09T08:00:00Z',
        removed_at: n === 1 ? '2027-01-09T09:00:00Z' : null,
        removed_reason: n === 1 ? 'fel fil' : null,
      },
    ],
  })
  return {
    company: { name: 'Väla Redovisning AB', org_number: '5592383508' },
    period: { id: 'fy-2026', name: 'Räkenskapsår 2026', start: '2026-01-01', end: '2026-12-31' },
    generated_at: '2027-01-15T10:00:00Z',
    app_version: '1.2.3',
    checklist: {
      items: [
        { key: 'bank_signed', group: 'avstamning', label_sv: 'Bankkonton avstämda', label_en: 'Bank reconciled', state: 'done', done_at: null, done_by_label: null, note: null },
        { key: 'inventory_valued', group: 'vardering', label_sv: 'Varulager inventerat', label_en: 'Inventory counted', state: 'not_applicable', done_at: '2027-01-06T08:00:00Z', done_by_label: 'yasemin@example.se', note: 'Inget lager' },
      ],
      summary: { total: 2, done: 1, not_applicable: 1, open: 0 },
    },
    accounts: Array.from({ length: 40 }, (_, i) => account(i)),
    summary: { accounts: 40, signed_on_balansdag: 20, signed_other_date: 20, unsigned: 0, attachments: 39 },
  }
}

describe('BokslutsbilagorPDF', () => {
  it('renders a multi-page pärm without deadlocking and with WinAnsi-safe text', async () => {
    const pdf = await renderToBuffer(BokslutsbilagorPDF({ report: report() }))
    expect(pdf.length).toBeGreaterThan(5000)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    // More than one page: the fixed header/footer repeat and no `break` was needed.
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBeGreaterThan(1)
  }, 30000)

  it('renders the empty pärm', async () => {
    const r = report()
    r.accounts = []
    r.summary = { accounts: 0, signed_on_balansdag: 0, signed_other_date: 0, unsigned: 0, attachments: 0 }
    const pdf = await renderToBuffer(BokslutsbilagorPDF({ report: r }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  }, 30000)
})
