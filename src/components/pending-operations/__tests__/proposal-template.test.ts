/**
 * The review template's density (preview-parts.tsx): the same preview sets
 * its typed fields as hairline rows on the review of one proposal and as the
 * two-column grid in the confirm dialog and the chat card. In the template
 * the warning and the underlag are left to the template's own slots, so they
 * are never stated twice.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next-intl', async () => {
  const sv = (await import('@/messages/sv.json')).default as unknown as Record<string, Record<string, unknown>>
  const make = (namespace: string) => {
    const lookup = (key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], sv[namespace])
    const t = (key: string, values?: Record<string, unknown>) => {
      const text = lookup(key)
      return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name])) : key
    }
    return Object.assign(t, { has: (key: string) => typeof lookup(key) === 'string' })
  }
  return { useTranslations: (namespace: string) => make(namespace), useLocale: () => 'sv' }
})

const { OperationPreview } = await import('../OperationPreview')

const render = (operation_type: string, preview_data: Record<string, unknown>, template: boolean) =>
  renderToStaticMarkup(createElement(OperationPreview, { op: { operation_type, preview_data }, detail: template, template }))

const VOUCHER = {
  entry_date: '2026-11-12',
  description: 'Byggvaror',
  compliance_warning: 'No source document attached.',
  lines: [
    { account_number: '4010', debit_amount: 2400, credit_amount: 0 },
    { account_number: '2641', debit_amount: 600, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 3000 },
  ],
}

describe('the review template sets every preview in the same parts', () => {
  it('typed fields are hairline rows in the template and a grid in the compact surfaces', () => {
    const customer = { name: 'Provkund Äng AB', customer_type: 'swedish_business' }
    const template = render('create_customer', customer, true)
    expect(template).toContain('<dl')
    expect(template).toMatch(/<dt[^>]*>Namn<\/dt><dd[^>]*>Provkund Äng AB<\/dd>/)
    const compact = render('create_customer', customer, false)
    expect(compact).not.toContain('<dl')
    expect(compact).toContain('grid-cols-2')
    expect(compact).toContain('Provkund Äng AB')
  })

  it('says a code in words where the product has the word', () => {
    expect(render('create_customer', { name: 'A', customer_type: 'swedish_business' }, true)).not.toContain('swedish_business')
    // A code without a word shows as staged, never as a blank.
    expect(render('create_customer', { name: 'A', customer_type: 'martian' }, true)).toContain('martian')
  })

  it('a type without a dedicated preview gets the same rows from its labelled fields', () => {
    const supplier = render('create_supplier', { name: 'Provleverantör Sjö AB', default_payment_terms: 30, bankgiro: null }, true)
    expect(supplier).toMatch(/<dt[^>]*>Namn<\/dt><dd[^>]*>Provleverantör Sjö AB<\/dd>/)
    expect(supplier).not.toContain('bankgiro')
  })

  it('a verifikat reads as a ledger with its Summa row in the template', () => {
    const template = render('create_voucher', VOUCHER, true)
    expect(template).toMatch(/<dt[^>]*>Datum<\/dt>/)
    expect(template).toContain('Summa')
    expect(template).toContain('4010')
  })

  it('leaves the warning to the template, which has one place for it; the compact surfaces keep it', () => {
    expect(render('create_voucher', VOUCHER, true)).not.toContain('Underlag saknas')
    expect(render('create_voucher', VOUCHER, false)).toContain('Underlag saknas')
  })
})
