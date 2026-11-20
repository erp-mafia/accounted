/**
 * The Granskning card of a registration of an already-booked supplier invoice
 * (crm#1094). The approval cannot be undone, so the card must read like the
 * kundreskontra registration's: kronor and dates formatted, and the
 * verifikat's lines captioned as booked already, never as a kontering about to
 * be posted or as raw staging fields.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatCurrency } from '@/lib/utils'

vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { has: () => true }),
}))

const { OperationPreview } = await import('../OperationPreview')

const PREVIEW = {
  mode: 'register_booked',
  supplier_name: 'Leverantören AB',
  supplier_invoice_number: '7781',
  arrival_number: 412,
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  currency: 'SEK',
  subtotal: 8000,
  vat_amount: 2000,
  total: 10000,
  vat_treatment: 'standard_25',
  invoice_remaining: 4000.5,
  balance_as_of: '2026-03-31',
  journal_entry_id: '44444444-4444-4444-8444-444444444444',
  voucher_label: 'D45',
  voucher_date: '2026-03-02',
  voucher_description: 'Leverantörsfaktura 7781',
  voucher_lines: [
    { account_number: '6110', debit_amount: 8000, credit_amount: 0 },
    { account_number: '2641', debit_amount: 2000, credit_amount: 0 },
    { account_number: '2440', debit_amount: 0, credit_amount: 10000 },
  ],
  writes_verifikat: false,
  period_lock_applies: false,
}

const render = (previewData: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(OperationPreview, { op: { operation_type: 'create_supplier_invoice_from_inbox', preview_data: previewData } }),
  )

describe('the Granskning preview of a registered supplier invoice', () => {
  it('shows the invoice, its verifikat and its amounts as the approver checks them', () => {
    const html = render(PREVIEW)

    expect(html).toContain('Leverantören AB')
    expect(html).toContain('412')
    expect(html).toContain('D45, 2026-03-02')
    for (const amount of [8000, 2000, 10000, 4000.5]) expect(html).toContain(formatCurrency(amount, 'SEK'))
    // The verifikat's lines, captioned as booked already.
    expect(html).toContain('aria-label="preview_registered_voucher_lines"')
    expect(html).not.toContain('Föreslagen kontering')
    // Staging fields stay out of the card.
    expect(html).not.toContain('standard_25')
    expect(html).not.toContain('writes_verifikat')
    expect(html).not.toContain('period_lock_applies')
    expect(html).not.toContain('4000.5')
  })

  it('shows the payment reference a reused supplier number became', () => {
    const { supplier_invoice_number: _number, ...reused } = PREVIEW
    const html = render({ ...reused, payment_reference: '7781' })
    expect(html).toContain('preview_field.payment_reference')
    expect(html).toContain('7781')
  })

  it('leaves an ordinary inbox conversion to the generic preview', () => {
    const { mode: _mode, ...conversion } = PREVIEW
    const html = render(conversion)
    expect(html).not.toContain('preview_registered_voucher_lines')
    expect(html).toContain('Föreslagen kontering')
  })
})
