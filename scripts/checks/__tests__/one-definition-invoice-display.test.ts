/**
 * The guards of what a customer invoice shows (which ones are unpaid, its
 * status, its amount) catch the shapes that were written by hand, and leave
 * the lines that only look alike.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import owed from '../one-definition/owed-invoice-population.mjs'
import shownStatus from '../one-definition/invoice-shown-status.mjs'
import shownAmount from '../one-definition/invoice-shown-amount.mjs'

const hits = (rule: Parameters<typeof findRuleLines>[1], line: string) => findRuleLines(line, rule).length > 0

describe.each([
  ['owed-invoice-population', owed, [
    ".in('status', ['sent', 'overdue', 'partially_paid'])",
    "if (['partially_paid', 'sent', 'overdue'].includes(invoice.status)) {",
    // The list of two that hid the partly paid invoices from Obetalda.
    "return ['sent', 'overdue'].includes(invoice.status) && !isCreditNote && docType === 'invoice'",
    ".in('status', ['sent', 'overdue'])",
    'const UNPAID = ["sent", "overdue"] as const',
    "autoRemindersEnabled === true && (invoice.status === 'sent' || invoice.status === 'overdue'),",
    "((invoice.status === 'sent' || invoice.status === 'overdue') &&",
    ".filter((inv) => inv.status === 'sent' || inv.status === 'overdue')",
    "if (status === 'sent' || status === 'overdue') {",
    "if (invoice.status !== 'sent' && invoice.status !== 'overdue') return invoice.status",
  ], [
    'return isInvoiceOwed(invoice)',
    ".in('status', OWED_INVOICE_STATUSES)",
    'if (!isOwedInvoiceStatus(invoice.status)) return false',
    // Other rules with other lists: what can be credited, what Peppol can send.
    "export const CREDITABLE_INVOICE_STATUSES = ['sent', 'paid', 'overdue'] as const",
    "const SENDABLE_STATUSES = new Set<Invoice['status']>(['draft', 'sent', 'overdue'])",
    "if (invoice.status === 'sent' || invoice.status === 'draft') {",
    "if (delivery.status === 'sent' || delivery.status === 'marked_sent') {",
    "if (invoice.status !== 'sent' && invoice.status !== 'cancelled') return null",
  ]],
  ['invoice-shown-status', shownStatus, [
    // The sales order: the label of the stored status.
    'const statusDisplay = invoiceStatusDisplay(invoice.status)',
    'const display = invoiceStatusDisplay(row.original?.status)',
    // The invoice page's own ternary.
    ": (invoice.status === 'sent' || invoice.status === 'overdue') && isInvoiceOverdue(invoice) && invoice.due_date",
    ": invoice.status === 'overdue'",
    "if (originalInvoice?.status === 'overdue') return true",
    "{inv.status === \"overdue\" ? <Badge variant=\"destructive\">{t('status_overdue')}</Badge> : null}",
    // The credit note editor's paid, overdue, unpaid.
    "invoice.status === 'paid' ? t('status_paid') : isInvoiceOverdue(invoice) ? t('status_overdue') : t('status_unpaid')",
    "const tone = isInvoiceOverdue(invoice, today) ? 'destructive' : 'muted'",
  ], [
    'const statusDisplay = invoiceRowStatus(invoice, today)',
    'const display = invoiceStatusDisplay(status)',
    ': invoiceStatusDisplay(effectiveInvoiceStatus(invoice as OpenInvoice))',
    'status: effectiveInvoiceStatus(row, today),',
    "if (row.kind === 'overdue') return OVERDUE_CHIP",
    'REMINDERS_SENDING_ENABLED && !isSelfBilled && isInvoiceOverdue(invoice) && !collectionCaseOnTop',
    // Other things that can be overdue: a declaration, a deadline.
    "const attention = state.status === 'overdue' || state.status === 'invalid'",
    "const overdue = deadlines?.filter((d) => d.status === 'overdue') || []",
  ]],
  ['invoice-shown-amount', shownAmount, [
    // The customer card, the sales order, the send dialog and the payment dialog.
    '{formatCurrency(invoice.total, invoice.currency)}',
    '<DialogDescription>{formatCurrency(invoice.total, invoice.currency)}</DialogDescription>',
    'amount: formatCurrency(Number(inv.total), inv.currency),',
    "{t('title', { amount: formatCurrency(data.invoice.total, data.invoice.currency) })}",
    '{formatCurrency(originalInvoice?.total, originalInvoice?.currency)}',
  ], [
    '{formatCurrency(displayedTotal, invoice.currency)}',
    '{formatCurrency(getAmountToPay(invoice, companySettings).toPay, invoice.currency)}',
    '{formatCurrency(getDisplayTotal(invoice, { ore_rounding: oreRounding }).displayed, invoice.currency)}',
    // Not an invoice: a sales order, a webshop order.
    '{formatCurrency(order.total, order.currency)}',
    // Not the total: the kronor value of a foreign invoice, the open remainder.
    '{formatCurrency(invoice.total_sek)}',
    '{formatCurrency(invoice.remaining_amount, invoice.currency)}',
  ]],
] as const)('%s', (_name, rule, written, alike) => {
  it.each(written)('catches %s', (line) => {
    expect(hits(rule, line)).toBe(true)
  })

  it.each(alike)('leaves %s', (line) => {
    expect(hits(rule, line)).toBe(false)
  })
})
