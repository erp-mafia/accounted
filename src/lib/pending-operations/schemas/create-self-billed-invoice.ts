import { z } from 'zod'
import { CreateSelfBillingInvoiceSchema, SelfBillingInvoiceItemSchema } from '@/lib/api/schemas'
import type { SelfBilledSaleFailure } from '@/lib/invoices/self-billed-sale'

export const CreateSelfBilledInvoiceParamsSchema = CreateSelfBillingInvoiceSchema.strict().extend({
  external_invoice_number: CreateSelfBillingInvoiceSchema.shape.external_invoice_number.trim().min(1)
    .describe('Invoice number on the document issued by the customer.'),
  invoice_date: z.iso.date(),
  received_date: z.iso.date().describe('Date the company received the document, YYYY-MM-DD.'),
  due_date: z.iso.date(),
  items: SelfBillingInvoiceItemSchema.strict().array().min(1, 'At least one item is required'),
})

export function selfBilledInvoiceFailure(failure: SelfBilledSaleFailure) {
  switch (failure.code) {
    case 'duplicate':
      return { code: 'SELF_BILLED_INVOICE_DUPLICATE', message: 'This customer invoice number is already registered.' }
    case 'review_changed':
      return { code: 'SELF_BILLED_INVOICE_REVIEW_CHANGED', message: 'Stage the self-billed invoice again for review.' }
    case 'vat_breakdown_mismatch':
      return { code: 'VAT_BREAKDOWN_MISMATCH', message: 'VAT by rate does not match the invoice lines.' }
    case 'customer_not_found':
      return { code: 'INVOICE_CUSTOMER_NOT_FOUND', message: 'Customer not found. Use gnubok_list_customers to find valid IDs.' }
    case 'vat_rule_violation':
      return {
        code: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
        message: `VAT rate ${failure.attemptedRate}% is not allowed for ${failure.customerType}. Allowed rates: ${failure.allowedRates.join(', ')}.`,
      }
    case 'fx_rate_unavailable':
      return {
        code: 'SELF_BILLED_INVOICE_FX_RATE_UNAVAILABLE',
        message: `No exchange rate for ${failure.currency} on the invoice date (${failure.invoiceDate}).`,
      }
    case 'no_fiscal_period':
      return { code: 'INVOICE_BOOK_NO_FISCAL_PERIOD', message: 'No open fiscal period covers the invoice date.' }
    case 'insert_failed':
      return { code: 'INVOICE_CREATE_INSERT_FAILED', message: 'Could not register the self-billed invoice.' }
    case 'items_failed':
      return { code: 'INVOICE_CREATE_ITEMS_FAILED', message: 'Could not register the self-billed invoice items.' }
  }
}
