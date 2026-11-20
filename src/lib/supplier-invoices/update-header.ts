/**
 * Change the header of a supplier invoice: its number, dates, payment
 * reference, notes and the "dras automatiskt" mark. Never an amount, an
 * account or a line. One implementation behind the dashboard route
 * (PUT /api/supplier-invoices/[id]), the v1 PATCH and the MCP tool
 * (operation supplier-invoices.update), so every door applies the same rules:
 *
 *   - only an unsettled invoice (registered, approved, overdue): a paid,
 *     credited or reversed one is corrected with a credit note or a storno;
 *   - an issued self-billing invoice keeps its number and date (crm#1367);
 *   - invoice_date and supplier_invoice_number are on the posted registration
 *     verifikat (entry_date and description). Once that entry exists they are
 *     refused here: changing them is a rättelse of the verifikat, through the
 *     sanctioned paths, never a silent edit of the invoice row (#1230). This
 *     function never writes a journal entry or a journal line;
 *   - the overdue label follows the due date the update lands on, in both
 *     directions, instead of waiting for the daily check (#1206);
 *   - the write is a compare-and-swap on what the checks read, so a payment,
 *     an attest or a registration entry that lands in between loses nothing:
 *     the update matches no row and the caller is told why.
 *
 * A dry run reads and checks; it writes nothing (it is also the MCP staging
 * preview).
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  findChangedVerifikatFields,
  findLockedVerifikatFields,
  isUnsettledSupplierInvoiceStatus,
  resolveUnsettledStatus,
} from '@/lib/supplier-invoices/lifecycle'
import { selfBilledLockedFields } from '@/lib/supplier-invoices/self-billing/edit-guard'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** The header fields an update may carry; an absent key is left as it is. */
export interface SupplierInvoiceHeaderPatch {
  supplier_invoice_number?: string
  invoice_date?: string
  due_date?: string
  delivery_date?: string
  payment_reference?: string
  notes?: string
  auto_debit?: boolean
}

/** What the rules read off the stored invoice. `columns` must include them. */
export type SupplierInvoiceHeaderRow = Record<string, unknown> & {
  status: string
  due_date: string
  remaining_amount: number
  is_credit_note: boolean | null
  is_self_billed: boolean | null
  approved_at: string | null
  invoice_date: string | null
  supplier_invoice_number: string | null
  registration_journal_entry_id: string | null
}

export interface UpdateSupplierInvoiceHeaderOptions {
  dryRun?: boolean
  /**
   * The projection read and answered. Defaults to the whole row (the
   * dashboard); a door with a public contract passes its own. It must hold
   * every column of SupplierInvoiceHeaderRow.
   */
  columns?: string
  /**
   * A door's own, narrower admission, asked of the stored row before the
   * shared rules: the v1 PATCH takes only a registered invoice and holds a
   * register-only key to what it could have registered. It can refuse more
   * than the shared rules, never less.
   */
  doorGate?: (existing: SupplierInvoiceHeaderRow) => Failure | null
  /**
   * Leave the stored status label alone instead of re-deriving it from the
   * due date. Only for the v1 PATCH, whose contract is "registered in,
   * registered out": the daily check moves the label there.
   */
  keepStatus?: boolean
}

export async function updateSupplierInvoiceHeader(
  ctx: OperationContext,
  supplierInvoiceId: string,
  patch: SupplierInvoiceHeaderPatch,
  options: UpdateSupplierInvoiceHeaderOptions = {},
): Promise<OperationOutcome<Record<string, unknown>>> {
  const { supabase, companyId, log } = ctx
  const columns = options.columns ?? '*'

  const update: Record<string, unknown> = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  )
  if (Object.keys(update).length === 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'body', message: 'At least one field must be supplied for update.' },
    }
  }

  const { data: existing, error: readError } = await supabase
    .from('supplier_invoices')
    .select(columns)
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (readError) return { ok: false, code: 'UNKNOWN_ERROR', error: readError }
  if (!existing) return { ok: false, code: 'SI_NOT_FOUND' }
  const row = existing as unknown as SupplierInvoiceHeaderRow

  const refusedByDoor = options.doorGate?.(row)
  if (refusedByDoor) return refusedByDoor

  // 'overdue' is editable: the daily check flips an aging invoice there, and
  // extending the due date is how it gets back (#1206).
  if (!isUnsettledSupplierInvoiceStatus(row.status)) {
    return { ok: false, code: 'SI_EDIT_INVALID_STATUS', details: { currentStatus: row.status } }
  }

  const selfBilledFields = selfBilledLockedFields(patch, row)
  if (selfBilledFields.length > 0) {
    return { ok: false, code: 'SI_SELF_BILL_IMMUTABLE', details: { fields: selfBilledFields } }
  }

  // Resending the stored value is accepted (a form that puts every field
  // back); only a value that differs from the posted verifikat is refused.
  const lockedFields = findLockedVerifikatFields(update, row)
  if (lockedFields.length > 0) {
    return {
      ok: false,
      code: 'SI_EDIT_VERIFIKAT_LOCKED',
      details: { fields: lockedFields, journal_entry_id: row.registration_journal_entry_id },
    }
  }

  const restingStatus = options.keepStatus
    ? row.status
    : resolveUnsettledStatus(
        {
          due_date: (update.due_date as string | undefined) ?? row.due_date,
          remaining_amount: row.remaining_amount,
          is_credit_note: row.is_credit_note,
          approved_at: row.approved_at,
        },
        todayIsoStockholm(),
      )
  const rewritesStatus = restingStatus !== row.status
  const write = rewritesStatus ? { ...update, status: restingStatus } : update

  if (options.dryRun) {
    const changed = Object.keys(update).filter((key) => (row[key] ?? null) !== (update[key] ?? null))
    return {
      ok: true,
      dryRun: true,
      preview: {
        ...row,
        ...write,
        changes: Object.fromEntries(changed.map((key) => [key, { from: row[key] ?? null, to: update[key] }])),
      },
    }
  }

  // The status gate read a row a moment ago: the write holds only while the
  // invoice is still in that status, so a payment or credit that landed in
  // between is never edited underneath.
  let query = supabase
    .from('supplier_invoices')
    .update(write)
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .eq('status', row.status)

  if (findChangedVerifikatFields(update, row).length > 0) {
    // The lock check read a row that was still unbooked. A registration entry
    // posted between that read and this write must lose the race instead of
    // ending up disagreeing with the invoice it was built from.
    query = query.is('registration_journal_entry_id', null)
  }

  if (rewritesStatus) {
    // The new label is derived from the due date and the attest read above:
    // pin them too, so it never overwrites a concurrent flip or approval with
    // a status computed from what those changed.
    query = query.eq('due_date', row.due_date)
    query = row.approved_at ? query.eq('approved_at', row.approved_at) : query.is('approved_at', null)
  }

  const { data, error } = await query.select(columns).maybeSingle()
  if (error) {
    log.error('supplier invoice header update failed', error as unknown as Error, { supplierInvoiceId })
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  if (data) return { ok: true, data: data as unknown as Record<string, unknown> }

  // No row matched: re-read, so the caller gets the reason that applies.
  const { data: current } = await supabase
    .from('supplier_invoices')
    .select('status, registration_journal_entry_id, invoice_date, supplier_invoice_number')
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  const now = current as Pick<
    SupplierInvoiceHeaderRow,
    'registration_journal_entry_id' | 'invoice_date' | 'supplier_invoice_number'
  > | null
  const nowLocked = now ? findLockedVerifikatFields(update, now) : []
  if (now && nowLocked.length > 0) {
    return {
      ok: false,
      code: 'SI_EDIT_VERIFIKAT_LOCKED',
      details: { fields: nowLocked, journal_entry_id: now.registration_journal_entry_id, reason: 'race' },
    }
  }
  return {
    ok: false,
    code: 'SI_EDIT_CONFLICT',
    details: { expectedStatus: row.status, expectedDueDate: row.due_date, reason: 'race' },
  }
}
