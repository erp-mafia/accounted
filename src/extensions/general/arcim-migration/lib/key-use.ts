import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Whether a source connection's stored key still has work to do (crm#1476,
 * PH 219).
 *
 * The key a customer hands over for the migration stays stored (sealed)
 * until they remove it. Accounted only ever reads with it: every provider
 * client issues GET requests only, and the POSTs in the oauth modules are
 * token exchanges. Data minimisation still says a key nothing needs any more
 * should be offered for removal, so the connections list asks this.
 *
 * Three things read with the key after the wizard is done:
 * - a migration job that has not completed (queued, running, waiting for a
 *   retry, or a review the customer has not accepted);
 * - the hourly pass that fetches rows for imported invoices that arrived
 *   without them (invoice-completion-worker); it reads with the company's
 *   newest connection, and only while such an invoice exists;
 * - the opt-in Bokio supplier-invoice completion, for the connection it
 *   enrolled.
 * The underlag import and "Kör migreringen igen" also read with it, but only
 * when the customer clicks them; removing the key and connecting again
 * serves both.
 */
export type ProviderKeyUse = 'migration' | 'invoice_rows' | 'supplier_rows' | 'idle'

export interface ProviderKeyUseFacts {
  /** The states of the company's migration jobs. */
  jobStates: string[]
  /**
   * A migration from before the job queue: a completed ledger import and
   * records it brought in, with no job row to say it finished.
   */
  importedWithoutJob: boolean
  /** An imported invoice still waits for its rows from the source. */
  invoicesAwaitingRows: boolean
  /** Connections enrolled in the Bokio supplier-invoice completion. */
  supplierCompletionConsentIds: ReadonlySet<string>
  /** The connection the invoice-row pass reads with: the company's newest. */
  newestConsentId: string | null
}

export function providerKeyUse(consentId: string, facts: ProviderKeyUseFacts): ProviderKeyUse {
  if (facts.jobStates.some((state) => state !== 'completed')) return 'migration'
  if (!facts.jobStates.includes('completed') && !facts.importedWithoutJob) return 'migration'
  if (facts.supplierCompletionConsentIds.has(consentId)) return 'supplier_rows'
  if (facts.invoicesAwaitingRows && consentId === facts.newestConsentId) return 'invoice_rows'
  return 'idle'
}

/**
 * Read the facts above for one company. Service client (the completion queue
 * has no user policy), so every read filters on company_id. Throws on a
 * failed read: the caller shows nothing rather than calling a key idle that
 * may not be.
 */
export async function readProviderKeyUseFacts(
  service: SupabaseClient,
  companyId: string,
  opts: { hasCompletedSieImport: boolean; importedRecords: number; newestConsentId: string | null },
): Promise<ProviderKeyUseFacts> {
  const [jobs, awaitingRows, enrolled] = await Promise.all([
    service.from('migration_jobs').select('state').eq('company_id', companyId),
    // The invoice-row pass's candidate predicate (claim_invoice_completion_work):
    // an invoice, not an empty in-app draft, with no rows. invoice_items=is.null
    // on the embed is PostgREST's anti-join.
    service
      .from('invoices')
      .select('id, invoice_items(id)')
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .or('status.neq.draft,total.neq.0')
      .is('invoice_items', null)
      .limit(1),
    service.from('bokio_supplier_completion_work').select('consent_id').eq('company_id', companyId),
  ])
  if (jobs.error || awaitingRows.error || enrolled.error) throw new Error('PROVIDER_KEY_USE_READ_FAILED')

  return {
    jobStates: (jobs.data ?? []).map((row) => String((row as { state: unknown }).state)),
    importedWithoutJob: opts.hasCompletedSieImport && opts.importedRecords > 0,
    invoicesAwaitingRows: (awaitingRows.data ?? []).length > 0,
    supplierCompletionConsentIds: new Set(
      (enrolled.data ?? [])
        .map((row) => (row as { consent_id: string | null }).consent_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
    newestConsentId: opts.newestConsentId,
  }
}
