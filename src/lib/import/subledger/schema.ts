import { z } from 'zod'

const money = z.number().finite().nonnegative().max(999999999.99)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001)
const date = z.iso.date()

/** Historical balances, never an instruction to issue or post an invoice. */
export const SubledgerRowSchema = z.object({
  counterparty: z.string().trim().min(1).max(100),
  invoice_number: z.string().trim().min(1).max(100),
  invoice_date: date,
  due_date: date,
  currency: z.literal('SEK'),
  vat_treatment: z.enum(['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt']),
  total: money.positive(),
  vat_amount: money,
  remaining_amount: money.positive(),
  voucher_series: z.string().trim().min(1).max(20),
  voucher_number: z.number().int().positive(),
  voucher_year: z.number().int().min(1900).max(9999),
  payment_reference: z.string().trim().max(100).default(''),
}).strict().superRefine((row, ctx) => {
  const rate = ({ standard_25: 25, reduced_12: 12, reduced_6: 6, reverse_charge: 0, export: 0, exempt: 0 })[row.vat_treatment]
  if (Math.abs(Math.round((row.total - row.vat_amount) * rate) / 100 - row.vat_amount) > 0.010001) {
    ctx.addIssue({ code: 'custom', message: 'VAT split is inconsistent with the treatment' })
  }
  if (row.vat_amount > row.total || row.remaining_amount > row.total) {
    ctx.addIssue({ code: 'custom', message: 'Amounts exceed original total' })
  }
})

export const SubledgerImportSchema = z.object({
  company_id: z.uuid(),
  kind: z.enum(['customer', 'supplier']),
  snapshot_date: date,
  rows: z.array(SubledgerRowSchema).min(1).max(500),
  execute: z.boolean().default(false),
  preview_token: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.execute && !input.preview_token) {
    ctx.addIssue({ code: 'custom', path: ['preview_token'], message: 'Preview required' })
  }
  input.rows.forEach((row, index) => {
    if (row.invoice_date > input.snapshot_date) {
      ctx.addIssue({ code: 'custom', path: ['rows', index, 'invoice_date'], message: 'After snapshot' })
    }
  })
})

export type SubledgerRow = z.infer<typeof SubledgerRowSchema>
export type SubledgerImportInput = z.infer<typeof SubledgerImportSchema>
export interface SubledgerResult {
  company_id: string
  company_name: string
  org_number: string | null
  kind: 'customer' | 'supplier'
  snapshot_date: string
  token: string
  imported: number
  already_imported: boolean
  ledger_balance: number
  existing_balance: number
  imported_balance: number
  difference: number
  invoice_number_prefix: string | null
  next_invoice_number_before: number | null
  next_invoice_number_after: number | null
  rows: Array<{ invoice_number: string; counterparty_name: string; remaining_amount: number }>
}

export const SUBLEDGER_COLUMNS = [
  'counterparty', 'invoice_number', 'invoice_date', 'due_date', 'currency',
  'vat_treatment', 'total', 'vat_amount', 'remaining_amount', 'voucher_series', 'voucher_number',
  'voucher_year', 'payment_reference',
] as const
