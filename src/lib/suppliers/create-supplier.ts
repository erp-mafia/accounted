/**
 * Supplier (leverantör) creation: the one write path behind the dashboard's
 * POST /api/suppliers, the v1 POST /suppliers (operation suppliers.create,
 * lib/operations/suppliers.ts) and the approval of an agent's staged
 * gnubok_create_supplier.
 *
 * The three doors used to carry their own insert and their own rules: the
 * approval dropped clearing_number and account_number, answered a duplicate
 * org number with a raw database error, and refused a foreign registration
 * number the dashboard accepted; the dashboard and v1 stored any bankgiro or
 * IBAN, the agent path checked them. CreateSupplierSchema is the one rule set
 * now, and the insert lives here.
 */
import type { z } from 'zod'
import type { CreateSupplierSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { SUPPLIER_COLUMNS, type SupplierRecord } from '@/lib/suppliers/update-supplier'
import type { Supplier } from '@/types'

export type SupplierCreateInput = z.output<typeof CreateSupplierSchema>

/** An empty field means "not set" on create: stored as null, never as ''. */
function setOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The row a validated input inserts, with the register's defaults. */
function supplierRow(input: SupplierCreateInput) {
  return {
    name: input.name,
    supplier_type: input.supplier_type ?? 'swedish_business',
    email: setOrNull(input.email),
    phone: setOrNull(input.phone),
    address_line1: setOrNull(input.address_line1),
    address_line2: setOrNull(input.address_line2),
    postal_code: setOrNull(input.postal_code),
    city: setOrNull(input.city),
    country: input.country ?? 'SE',
    org_number: setOrNull(input.org_number),
    vat_number: setOrNull(input.vat_number),
    bankgiro: setOrNull(input.bankgiro),
    plusgiro: setOrNull(input.plusgiro),
    bank_account: setOrNull(input.bank_account),
    iban: setOrNull(input.iban),
    bic: setOrNull(input.bic),
    clearing_number: setOrNull(input.clearing_number),
    account_number: setOrNull(input.account_number),
    default_expense_account: setOrNull(input.default_expense_account),
    default_payment_terms: input.default_payment_terms ?? 30,
    default_currency: input.default_currency || 'SEK',
    self_billing_agreement_ref: setOrNull(input.self_billing_agreement_ref),
    notes: setOrNull(input.notes),
  }
}

/**
 * Create one supplier. The dry run answers the row the create would insert;
 * a duplicate org number is SUPPLIER_DUPLICATE_ORG_NUMBER on every door.
 */
export async function createSupplier(
  ctx: OperationContext,
  input: SupplierCreateInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SupplierRecord>> {
  const { supabase, companyId, userId, log } = ctx
  const row = supplierRow(input)
  if (options.dryRun) return { ok: true, dryRun: true, preview: row }

  const { data, error } = await supabase
    .from('suppliers')
    .insert({ ...row, user_id: userId, company_id: companyId })
    .select(SUPPLIER_COLUMNS)
    .single()
  if (error || !data) {
    if ((error as { code?: string } | null)?.code === '23505') {
      // The org number is not echoed: an individual's would be a personnummer.
      return { ok: false, code: 'SUPPLIER_DUPLICATE_ORG_NUMBER', details: { field: 'org_number' } }
    }
    log.error('supplier insert failed', error)
    return { ok: false, code: 'SUPPLIER_CREATE_FAILED', error }
  }

  try {
    await eventBus.emit({
      type: 'supplier.created',
      payload: {
        supplier: { ...(data as unknown as Record<string, unknown>), user_id: userId, company_id: companyId } as unknown as Supplier,
        companyId,
        userId,
      },
    })
  } catch (err) {
    log.warn('supplier.created emit failed (non-critical)', err as Error)
  }
  return { ok: true, data: data as unknown as SupplierRecord, created: true }
}
