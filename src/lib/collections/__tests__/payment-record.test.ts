import { describe, expect, it, vi } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ id: 'doc-record' }),
}))

import { uploadDocument } from '@/lib/core/documents/document-service'
import {
  archivePaymentRecord,
  buildPaymentRecordModel,
  formatStockholmTime,
  paymentRecordFilename,
  paymentRecordRows,
  PaymentRecordPDF,
  type PaymentRecordInput,
} from '../payment-record'

function input(overrides: Partial<PaymentRecordInput> = {}): PaymentRecordInput {
  return {
    providerName: 'Acme Inkasso',
    company: { company_name: 'Testbolaget AB', org_number: '556012-5790' },
    invoice: { invoice_number: '1042', customer_name: 'Kund AB' },
    caseNumber: 'CASE-77',
    payment: {
      provider_payment_ref: 'pay/1',
      paid_at: '2026-09-27',
      total: 1100.004,
      capital_paid: 1000.004,
      to_creditor_other: 0,
      to_agency: 100,
    },
    currency: 'SEK',
    clearingAccount: '1689',
    bookedAt: new Date('2026-10-06T12:00:00.000Z'),
    bookedBy: 'Anna Andersson',
    automatic: false,
    ...overrides,
  }
}

describe('payment record', () => {
  it('shows invoice, case, amounts, payment day, the provider reference and who booked it when', () => {
    const model = buildPaymentRecordModel(input())
    expect(model).toMatchObject({ capitalPaid: 1000, total: 1100, bookedAt: '2026-10-06 14:00' })
    // Intl puts a no-break space between thousands.
    const rows = Object.fromEntries(paymentRecordRows(model).map((r) => [r.label, r.value.replace(/\s/g, ' ')]))
    expect(rows).toEqual({
      Faktura: '1042',
      Kund: 'Kund AB',
      'Ärende hos Acme Inkasso': 'CASE-77',
      'Kunden betalade till Acme Inkasso': '2026-09-27',
      'Betalningsreferens hos Acme Inkasso': 'pay/1',
      'Kunden betalade totalt': '1 100,00 SEK',
      'Varav kapital, minskar kundfordran': '1 000,00 SEK',
      'Varav avgifter och ränta som Acme Inkasso behåller': '100,00 SEK',
      'Bokförs mot konto': '1689 (inkasserat, ännu inte utbetalt)',
      Bokförd: '2026-10-06 14:00',
      'Bokförd av': 'Anna Andersson',
    })
  })

  it('prints the org number formatted (NNNNNN-NNNN) however the company stored it', () => {
    expect(buildPaymentRecordModel(input({ company: { company_name: 'Testbolaget AB', org_number: '5599123451' } })).orgNumber).toBe('559912-3451')
    expect(buildPaymentRecordModel(input()).orgNumber).toBe('556012-5790')
    expect(buildPaymentRecordModel(input({ company: { company_name: 'Testbolaget AB', org_number: '  ' } })).orgNumber).toBeNull()
    expect(buildPaymentRecordModel(input({ company: null })).orgNumber).toBeNull()
  })

  it('says when the booking was automatic, and uses the neutral word without a provider name', () => {
    const model = buildPaymentRecordModel(input({ providerName: null, automatic: true, caseNumber: null }))
    const rows = Object.fromEntries(paymentRecordRows(model).map((r) => [r.label, r.value]))
    expect(rows['Bokförd av']).toBe('Automatisk bokföring för Anna Andersson')
    expect(rows['Ärende hos inkassobolaget']).toBe('Uppgift saknas')
  })

  it('names the voucher a rebook replaces, and nothing for a first booking', () => {
    expect(buildPaymentRecordModel(input()).replaces).toBeNull()
    const rows = paymentRecordRows(buildPaymentRecordModel(input({ replaces: 'C12, stornerad genom C13' })))
    expect(rows.map((r) => r.label)).toContain('Ersätter verifikation')
    expect(rows.find((r) => r.label === 'Ersätter verifikation')!.value).toBe('C12, stornerad genom C13')
  })

  it('formats Swedish time in winter too', () => {
    expect(formatStockholmTime(new Date('2026-12-01T08:05:00.000Z'))).toBe('2026-12-01 09:05')
  })

  it('names the file without characters a path cannot carry', () => {
    expect(paymentRecordFilename(buildPaymentRecordModel(input()))).toBe('Inbetalning_inkasso_1042_2026-09-27_pay1.pdf')
  })

  it('renders a PDF', async () => {
    const pdf = await renderToBuffer(PaymentRecordPDF({ model: buildPaymentRecordModel(input()) }))
    expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('archives the record as a system document without extraction, not yet on a voucher', async () => {
    const db = {} as SupabaseClient
    const id = await archivePaymentRecord(db, { companyId: 'c-1', userId: 'u-1', model: buildPaymentRecordModel(input()) })
    expect(id).toBe('doc-record')
    expect(uploadDocument).toHaveBeenCalledWith(
      db,
      'u-1',
      'c-1',
      expect.objectContaining({ name: 'Inbetalning_inkasso_1042_2026-09-27_pay1.pdf', type: 'application/pdf' }),
      { upload_source: 'system', extractionOwner: 'none' },
    )
  })
})
