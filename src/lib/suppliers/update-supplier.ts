/**
 * Supplier (leverantör) update: the one write path behind the dashboard's
 * PUT /api/suppliers/:id, the v1 PATCH /suppliers/:id and the MCP
 * gnubok_update_supplier (operation suppliers.update,
 * lib/operations/suppliers.ts).
 *
 * The dashboard and v1 each used to carry their own copy of this write, and
 * they had drifted: v1 validated clearing_number and account_number and then
 * dropped them, the dashboard had no archived-supplier rule, and MCP had no
 * door at all (crm#1060). The rules live here now; the doors only translate.
 */
import { z } from 'zod'
import type { UpdateSupplierSchema } from '@/lib/api/schemas'
import { UUID_RE } from '@/lib/invariants/uuid'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { dimensionsBagKey, normalizeLineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { refuseUnknownSupplierDimensions, tolerateMissingDefaultDimensions } from '@/lib/suppliers/default-dimensions'

/** The supplier record every door reads back. */
export const SUPPLIER_COLUMNS =
  'id, name, supplier_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, bankgiro, plusgiro, bank_account, clearing_number, account_number, iban, bic, default_expense_account, default_payment_terms, default_currency, self_billing_agreement_ref, auto_debit, default_dimensions, notes, party_id, archived_at, created_at, updated_at'

export const SupplierRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  supplier_type: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  bank_account: z.string().nullable(),
  /** Swedish bank account payee: clearing number and account number, as payment files read them. */
  clearing_number: z.string().nullable(),
  account_number: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  default_expense_account: z.string().nullable(),
  default_payment_terms: z.number(),
  default_currency: z.string(),
  /** The self-billing agreement with the supplier (ML 2023:200 17 kap 15 §), printed on a självfaktura to it; null = none (crm#1367). */
  self_billing_agreement_ref: z.string().nullable(),
  notes: z.string().nullable(),
  /** The party (motpart) behind the supplier: one per counterpart, shared with the customer side and the ledger. */
  party_id: z.string().uuid().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Debited by the supplier itself (autogiro, account debit), so kept out of to-pay and payments (crm#1463). */
  auto_debit: z.boolean(),
  /** Dimension bag {sie_dim_no: code} its new supplier invoices take when they name none (accounted#144). */
  default_dimensions: z.record(z.string(), z.string()),
})

export type SupplierRecord = z.infer<typeof SupplierRecordSchema>

/** What a caller may change: the dashboard's schema, plus un-archiving. */
export type SupplierChanges = z.output<typeof UpdateSupplierSchema> & { archived_at?: null }

const WRITABLE_FIELDS = [
  'name',
  'supplier_type',
  'email',
  'phone',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'country',
  'org_number',
  'vat_number',
  'bankgiro',
  'plusgiro',
  'bank_account',
  'clearing_number',
  'account_number',
  'iban',
  'bic',
  'default_expense_account',
  'default_payment_terms',
  'default_currency',
  'self_billing_agreement_ref',
  'auto_debit',
  'default_dimensions',
  'notes',
  'archived_at',
] as const

/**
 * The invoices of the supplier still to be paid: a changed auto_debit
 * applies to them as well as to new ones (the insert trigger
 * inherit_supplier_auto_debit), so the open invoice of a supplier that turns
 * out to debit itself leaves the to-pay lists at once (crm#1463).
 */
const UNSETTLED_INVOICE_STATUSES = ['registered', 'approved', 'partially_paid', 'overdue'] as const

/**
 * The fields historical verifikationer reference through their join to the
 * supplier: räkenskapsinformation under BFL 7 kap 1 §, frozen once the
 * supplier is archived. Notes, payment terms, defaults and contact details
 * are not, and stay editable.
 */
const IDENTIFYING_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'supplier_type',
  'org_number',
  'vat_number',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'country',
  'bankgiro',
  'plusgiro',
  'bank_account',
  'clearing_number',
  'account_number',
  'iban',
  'bic',
])

/**
 * Where the supplier is paid. A change here reroutes future payment files,
 * the classic supplier-fraud move, so the preview flags it for the approver.
 */
const PAYMENT_FIELDS: ReadonlySet<string> = new Set([
  'bankgiro',
  'plusgiro',
  'bank_account',
  'clearing_number',
  'account_number',
  'iban',
  'bic',
])

const NOT_FOUND: Extract<OperationOutcome<never>, { ok: false }> = { ok: false, code: 'SUPPLIER_NOT_FOUND' }

/**
 * '' from a cleared form field and an absent value mean the same as null; a
 * dimension bag (the one object field) compares by its normalized entries.
 */
function comparable(value: unknown): unknown {
  if (value === undefined || value === '') return null
  if (value && typeof value === 'object') {
    return dimensionsBagKey(normalizeLineDimensions({ dimensions: value as Record<string, string> }))
  }
  return value
}

/**
 * Partial update of one supplier. Only the fields sent change; '' clears a
 * text field (null for email and default_expense_account), archived_at null
 * un-archives. An archived supplier keeps its identifying fields: changing
 * one is refused until it is un-archived. The dry run answers the would-be
 * record with the fields that actually change (`changes`, from and to) and
 * whether the payment details move (`payment_details_changed`).
 */
export async function updateSupplier(
  ctx: OperationContext,
  supplierId: string,
  changes: SupplierChanges,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SupplierRecord>> {
  const { supabase, companyId, log } = ctx
  // A non-UUID id can never match a row: 404, not a uuid cast error.
  if (!UUID_RE.test(supplierId)) return NOT_FOUND

  const update: Record<string, unknown> = {}
  for (const key of WRITABLE_FIELDS) {
    const value = (changes as Record<string, unknown>)[key]
    if (value !== undefined) update[key] = value
  }
  if (changes.default_dimensions) update.default_dimensions = normalizeLineDimensions({ dimensions: changes.default_dimensions })
  if (Object.keys(update).length === 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'body', message: 'At least one field must be supplied for update.' },
    }
  }

  const { data: current, error: currentError } = await tolerateMissingDefaultDimensions(SUPPLIER_COLUMNS, (columns) =>
    supabase
      .from('suppliers')
      .select(columns)
      .eq('company_id', companyId)
      .eq('id', supplierId)
      .maybeSingle(),
  )
  if (currentError) return { ok: false, code: 'SUPPLIER_UPDATE_FAILED', error: currentError }
  if (!current) return NOT_FOUND
  const row = current as unknown as Record<string, unknown>

  const changed = Object.keys(update).filter((key) => comparable(row[key]) !== comparable(update[key]))

  const archivedAt = row.archived_at as string | null
  if (archivedAt && update.archived_at !== null) {
    const offendingFields = changed.filter((key) => IDENTIFYING_FIELDS.has(key))
    if (offendingFields.length > 0) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: {
          field: 'archived_at',
          message:
            'Supplier is archived; identifying fields (name, address, banking, org/vat number) are räkenskapsinformation under BFL 7 kap 1 § and cannot be edited. Un-archive (archived_at: null) first if a correction is needed.',
          archived_at: archivedAt,
          offending_fields: offendingFields,
        },
        messageSv:
          'Leverantören är arkiverad. Namn, adress, bankuppgifter och org- eller momsnummer är räkenskapsinformation (BFL 7 kap. 1 §) och kan inte ändras. Återställ leverantören först om uppgifterna behöver rättas.',
      }
    }
  }

  // A new default is judged now, as booking would judge it, not on each
  // invoice that takes it. A bag a form re-sends unchanged is not written:
  // nothing to judge, and before the migration that adds the column has run
  // (where every row reads {}) a re-sent {} still saves the rest.
  if (changed.includes('default_dimensions')) {
    const refused = await refuseUnknownSupplierDimensions(supabase, companyId, update.default_dimensions as Record<string, string>)
    if (refused) return refused
  } else {
    delete update.default_dimensions
  }

  // is_active is the legacy flag the dashboard filters still read: it
  // follows every archive and un-archive.
  if (update.archived_at === null) update.is_active = true

  if (options.dryRun) {
    const { is_active: _isActive, ...visible } = update
    return {
      ok: true,
      dryRun: true,
      preview: {
        ...row,
        ...visible,
        supplier_id: supplierId,
        changes: Object.fromEntries(changed.map((key) => [key, { from: row[key] ?? null, to: update[key] }])),
        payment_details_changed: changed.some((key) => PAYMENT_FIELDS.has(key)),
      },
    }
  }

  // Only the bag it already has was sent: nothing to write.
  if (Object.keys(update).length === 0) return { ok: true, data: row as unknown as SupplierRecord }
  const { data, error } = await tolerateMissingDefaultDimensions(SUPPLIER_COLUMNS, (columns) =>
    supabase
      .from('suppliers')
      .update(update)
      .eq('company_id', companyId)
      .eq('id', supplierId)
      .select(columns)
      .maybeSingle(),
  )
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, code: 'SUPPLIER_DUPLICATE_ORG_NUMBER', details: { field: 'org_number' } }
    }
    log.error('supplier update failed', error)
    return { ok: false, code: 'SUPPLIER_UPDATE_FAILED', error }
  }
  if (!data) return NOT_FOUND
  if (changed.includes('auto_debit')) {
    const { error: invoicesError } = await supabase
      .from('supplier_invoices')
      .update({ auto_debit: update.auto_debit })
      .eq('company_id', companyId)
      .eq('supplier_id', supplierId)
      .eq('is_credit_note', false)
      .in('status', [...UNSETTLED_INVOICE_STATUSES])
    if (invoicesError) {
      log.error('supplier auto_debit not carried to open invoices', invoicesError)
      return { ok: false, code: 'SUPPLIER_UPDATE_FAILED', error: invoicesError }
    }
  }
  return { ok: true, data: data as unknown as SupplierRecord }
}
