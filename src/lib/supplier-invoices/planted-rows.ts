/**
 * Touched-detection for kontering rows planted by a supplier default or the
 * counterparty-history prefill (components/supplier-invoices/
 * NewSupplierInvoiceForm.tsx). A supplier SWITCH un-plants those rows; a row
 * the user edited since the plant must survive with only the stale account
 * cleared, never be removed. react-hook-form's dirtyFields is unreliable here
 * (an appended row is born all-dirty against the array defaults), so the form
 * snapshots each planted row at plant time and compares against the snapshot.
 */

import type { SupplierInvoiceLineItem } from './form-payload'
import { editorsOwnValue } from './reading-rows'

function normalizeDims(dims: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(dims ?? {})) {
    if (value) out[key] = value
  }
  return out
}

/**
 * True when the row diverged from its plant-time snapshot in any user-editable
 * field: description, belopp, moms, omvand-moms rate, periodisering,
 * dimensioner or the SLP opt-in. `account_number` is deliberately excluded:
 * the caller already keys on it (a changed account means the row is no longer
 * the planted row at all). What the editor writes to a row by itself is no
 * edit (editorsOwnValue, the list the reading's rows are asked by too): the
 * reverse-charge sats it gives the row when reverse charge is switched on
 * after the plant.
 */
export function plantedRowTouched(
  row: SupplierInvoiceLineItem,
  snapshot: SupplierInvoiceLineItem,
): boolean {
  const edited = (field: keyof SupplierInvoiceLineItem, differs: boolean) =>
    differs && !editorsOwnValue(field, row, snapshot)
  if (edited('amount', (row.amount || 0) !== (snapshot.amount || 0))) return true
  if (edited('description', (row.description || '') !== (snapshot.description || ''))) return true
  if (edited('vat_rate', (row.vat_rate ?? null) !== (snapshot.vat_rate ?? null))) return true
  if (edited('reverse_charge_rate', (row.reverse_charge_rate ?? null) !== (snapshot.reverse_charge_rate ?? null))) return true
  if (edited('accrual_period_start', (row.accrual_period_start || '') !== (snapshot.accrual_period_start || ''))) return true
  if (edited('accrual_period_end', (row.accrual_period_end || '') !== (snapshot.accrual_period_end || ''))) return true
  if (edited('accrual_balance_account', (row.accrual_balance_account || '') !== (snapshot.accrual_balance_account || ''))) return true
  if (edited('apply_slp', (row.apply_slp ?? false) !== (snapshot.apply_slp ?? false))) return true
  const rowDims = normalizeDims(row.dimensions)
  const snapDims = normalizeDims(snapshot.dimensions)
  const keys = new Set([...Object.keys(rowDims), ...Object.keys(snapDims)])
  const dimsDiffer = [...keys].some((key) => (rowDims[key] || '') !== (snapDims[key] || ''))
  return edited('dimensions', dimsDiffer)
}

/** Deep-copies a row so the snapshot cannot alias live form state. */
export function snapshotPlantedRow(row: SupplierInvoiceLineItem): SupplierInvoiceLineItem {
  return {
    ...row,
    ...(row.dimensions ? { dimensions: { ...row.dimensions } } : {}),
  }
}
