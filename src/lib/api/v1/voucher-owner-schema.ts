import { z } from 'zod'

/**
 * The `owned_by` object the v1 reverse and correct answers carry: the object
 * the verifikat books and its own action (lib/core/bookkeeping/voucher-owner.ts).
 * Null when nothing owns it. Advice only: the storno or correction is posted
 * either way.
 */
export const VoucherOwnerSchema = z.object({
  kind: z.enum([
    'invoice',
    'credit_note',
    'supplier_invoice',
    'supplier_credit_note',
    'accrual_schedule',
    'asset',
    'salary_run',
  ]),
  owner_id: z.string(),
  label: z.string().nullable(),
  href: z.string(),
  action: z.enum([
    'credit_invoice',
    'open_invoice',
    'credit_supplier_invoice',
    'open_supplier_invoice',
    'open_accrual',
    'open_asset',
    'open_salary_run',
  ]),
  action_href: z.string(),
  tool: z.string().nullable(),
  hint_sv: z.string(),
  hint_en: z.string(),
})

/** One pitfall line for every endpoint whose answer carries `owned_by`. */
export const OWNED_BY_PITFALL =
  'The answer carries owned_by when an invoice, credit note, supplier invoice, periodisering, asset or payroll run owns the verifikat (else null): the change is posted, but that object does not follow it, so prefer owned_by.tool (e.g. gnubok_credit_supplier_invoice) or owned_by.action_href. Nothing is refused.'
