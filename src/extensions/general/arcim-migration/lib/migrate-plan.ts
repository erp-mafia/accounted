/**
 * How the wizard drives /migrate: one request per selected step.
 *
 * /migrate runs inside one serverless function with a 300 s ceiling. When
 * every step shared that request, a company with a few thousand invoices
 * used the whole budget on customers, suppliers and the invoice list and was
 * killed before the first invoice row was written; a retry redid the same
 * work and died at the same place (#2469). Each step now gets its own
 * request and therefore its own 300 s. The route contract is unchanged: the
 * per-step flags it always accepted are simply sent one at a time.
 *
 * Steps that need everything else in place (payment reconciliation, the
 * party suggestions) run only in the last request.
 */

import type { MigrationResults } from '../types'

export type MigrateStepKey =
  | 'importCompanyInfo'
  | 'importCustomers'
  | 'importSuppliers'
  | 'importSalesInvoices'
  | 'importSupplierInvoices'
  | 'importAssets'

/** Order the steps run in: parties before the invoices that reference them. */
export const MIGRATE_STEP_ORDER: readonly MigrateStepKey[] = [
  'importCompanyInfo',
  'importCustomers',
  'importSuppliers',
  'importSalesInvoices',
  'importSupplierInvoices',
  'importAssets',
]

export const MIGRATE_STEP_LABELS: Record<MigrateStepKey, string> = {
  importCompanyInfo: 'Hämtar företagsinformation...',
  importCustomers: 'Importerar kunder...',
  importSuppliers: 'Importerar leverantörer...',
  importSalesInvoices: 'Importerar kundfakturor...',
  importSupplierInvoices: 'Importerar leverantörsfakturor...',
  importAssets: 'Importerar anläggningstillgångar...',
}

export interface MigrateRequestBody extends Record<MigrateStepKey, boolean> {
  consentId: string
  reconcileVouchers: boolean
  suggestParties: boolean
}

/**
 * Whether the results so far prove the grant answers on this token: rows
 * came back from at least one register. Sent as `grantProven` on the next
 * request so an opaque 403 there is read as one closed register, exactly as
 * it was when every step shared a request. See ProviderRunState.
 */
export function migrationProvedGrant(results: MigrationResults): boolean {
  return (
    results.companyInfo?.imported === true ||
    (results.customers?.total ?? 0) > 0 ||
    (results.suppliers?.total ?? 0) > 0 ||
    (results.salesInvoices?.total ?? 0) > 0 ||
    (results.supplierInvoices?.total ?? 0) > 0 ||
    (results.assets?.total ?? 0) > 0
  )
}

export interface MigrateRequest {
  step: MigrateStepKey
  label: string
  body: MigrateRequestBody
}

/**
 * One request per selected step, in run order. Empty when nothing is
 * selected. Only the final request carries the finishing work.
 */
export function buildMigrateRequests(
  consentId: string,
  selected: Partial<Record<MigrateStepKey, boolean>>,
): MigrateRequest[] {
  const steps = MIGRATE_STEP_ORDER.filter((step) => selected[step] === true)
  return steps.map((step, index) => {
    const isLast = index === steps.length - 1
    const flags = Object.fromEntries(
      MIGRATE_STEP_ORDER.map((key) => [key, key === step]),
    ) as Record<MigrateStepKey, boolean>
    return {
      step,
      label: MIGRATE_STEP_LABELS[step],
      body: {
        consentId,
        ...flags,
        reconcileVouchers: isLast,
        suggestParties: isLast,
      },
    }
  })
}

/**
 * Fold one request's results into the run total. Step results are keyed by
 * step, so a shallow merge keeps each; the error list is the union.
 */
export function mergeMigrationResults(
  into: MigrationResults,
  next: MigrationResults | null | undefined,
): MigrationResults {
  if (!next) return into
  const { stepErrors: nextErrors, ...rest } = next
  const merged: MigrationResults = { ...into, ...rest }
  const errors = [...(into.stepErrors ?? []), ...(nextErrors ?? [])]
  if (errors.length > 0) merged.stepErrors = errors
  return merged
}
