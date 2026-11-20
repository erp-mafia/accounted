/**
 * The two rules of the date package catch the shape of a new hand-written copy
 * and leave what is not one alone. The rule files themselves are checked in
 * one-definition.test.ts; this is what their patterns are for.
 */
import { describe, expect, it } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import pastDue from '../one-definition/due-date-itself-is-on-time.mjs'
import dueDate from '../one-definition/invoice-due-date-from-terms.mjs'

const hits = (rule: { match: RegExp[] }, source: string) => findRuleLines(source, rule).map((h) => h.line)

describe('due-date-itself-is-on-time', () => {
  it.each([
    `if (supplierInvoice.due_date && new Date(supplierInvoice.due_date) < new Date()) {`,
    `const late = new Date(invoice.dueDate) <= now`,
    `if (invoice.due_date < today) return`,
    `if (inv.due_date < window.today) {`,
    `if (row.due_date < todayIso) continue`,
    `if (today <= invoice.dueDate) return skip('not_overdue')`,
    `const open = today > row.due_date`,
    `if (due < window.today) continue`,
  ])('flags %s', (line) => {
    expect(hits(pastDue, line)).toEqual([1])
  })

  it.each([
    `isPastDue(invoice.due_date, today)`,
    `const lastDue = invoice.due_date`,
    `.lt('due_date', today)`,
    `next_due: queue.next_due === null || invoice.due_date < queue.next_due ? invoice.due_date : queue.next_due,`,
    `if (value.due_date < value.invoice_date) {`,
    `if (new Date(input.due_date) < new Date(input.invoice_date)) {`,
    `if (row.due_date <= todayPlus14) continue`,
    `// a due date before today`,
    `payment_date: invoice.due_date > options.today ? invoice.due_date : options.today,`,
  ])('leaves %s', (line) => {
    expect(hits(pastDue, line)).toEqual([])
  })
})

describe('invoice-due-date-from-terms', () => {
  it.each([
    `d.setDate(d.getDate() + (customer.default_payment_terms ?? 30))`,
    `due.setUTCDate(due.getUTCDate() + (customer.default_payment_terms ?? 30))`,
    `const paymentTermsDays = customer.default_payment_terms ?? 30`,
    `default_payment_terms: row.default_payment_terms || 30,`,
    `d.setDate(d.getDate() + paymentTerms)`,
    `return format(addDays(anchor, terms), 'yyyy-MM-dd')`,
    `dueDate = addDaysIso(invoiceDate, paymentTermsDays)`,
  ])('flags %s', (line) => {
    expect(hits(dueDate, line)).toEqual([1])
  })

  it.each([
    `invoiceDueDate(invoiceDate, await loadInvoiceTerms(supabase, companyId, customer.default_payment_terms))`,
    `default_payment_terms: 30,`,
    `addDaysIso(today, ACTION_NEEDED_THRESHOLD_DAYS)`,
    `invoice.setDate(invoice.getDate() + 1)`,
  ])('leaves %s', (line) => {
    expect(hits(dueDate, line)).toEqual([])
  })
})
