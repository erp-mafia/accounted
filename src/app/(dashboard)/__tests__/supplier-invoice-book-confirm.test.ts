/**
 * GitHub #2392: Bokför on a supplier invoice registered without booking
 * (defer_invoice_booking, #967) posted the registration verifikat on the
 * first click and said what it had done only afterwards, in a toast. The same
 * step on a customer invoice confirms first (invoices/[id] openBookConfirm),
 * as does Bokför on a salary run (crm#1216): posting actions confirm up front
 * with the outcome. The confirm names the date the verifikat is dated on,
 * read from the one rule the server books by (supplierInvoiceRegistrationDate).
 * Components are not rendered in this suite (vitest runs in `node`), so the
 * wiring is pinned on the page source and the copy on the message files.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const page = fs.readFileSync(path.resolve(__dirname, '../supplier-invoices/[id]/page.tsx'), 'utf8')

describe('supplier invoice Bokför confirms before posting', () => {
  it('handleBook posts only after the confirm resolves true', () => {
    const body = page.slice(page.indexOf('async function handleBook()'))
    const confirmAt = body.indexOf('await confirmAction(')
    const guardAt = body.indexOf('if (!ok) return')
    const bookAt = body.indexOf('/book`')
    expect(confirmAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(confirmAt)
    expect(bookAt).toBeGreaterThan(guardAt)
    expect(body.slice(confirmAt, guardAt)).toContain("t('book_confirm_description'")
  })

  it('names the date the server books on, from the shared rule', () => {
    expect(page).toMatch(/supplierInvoiceRegistrationDate\(invoice, invoice\.supplier\?\.supplier_type\)/)
  })
})

describe('Bokför confirm copy', () => {
  const keys = ['book_confirm_title', 'book_confirm_description'] as const

  it.each([
    ['sv', sv.supplier_invoice_detail],
    ['en', en.supplier_invoice_detail],
  ] as const)('%s has every string, with the date', (_locale, messages) => {
    for (const key of keys) expect(typeof messages[key]).toBe('string')
    expect(messages.book_confirm_description).toContain('{date}')
    for (const key of keys) expect(messages[key]).not.toMatch(/[–—]/)
  })
})
