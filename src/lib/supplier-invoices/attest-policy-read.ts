/**
 * Reading a company's attest policy (company_attest_policies), kept apart
 * from the attest service so the worklist and the payment paths read it
 * without loading the service's writers. The rules are attest-policy.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { NO_ATTEST_POLICY, paymentWaitsForAttest, type AttestInvoiceFacts, type AttestPolicy } from './attest-policy'

export const POLICY_COLUMNS = 'company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, updated_by, updated_at'

export interface PolicyRow {
  company_id: string
  enabled: boolean
  threshold_amount: number | string | null
  mode: 'any' | 'all'
  attesters: string[] | null
  preparer_may_attest: boolean
  updated_by: string | null
  updated_at: string | null
}

export function toPolicy(row: PolicyRow | null): AttestPolicy {
  if (!row) return NO_ATTEST_POLICY
  return {
    enabled: row.enabled === true,
    threshold_amount: row.threshold_amount === null || row.threshold_amount === undefined ? null : Number(row.threshold_amount),
    mode: row.mode === 'all' ? 'all' : 'any',
    attesters: row.attesters ?? [],
    preparer_may_attest: row.preparer_may_attest === true,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  }
}

/** The company's attest policy; no row reads as no policy. Throws on a failed read: payment must not read "no policy" from an error. */
export async function loadAttestPolicy(supabase: SupabaseClient, companyId: string): Promise<AttestPolicy> {
  const { data, error } = await supabase.from('company_attest_policies').select(POLICY_COLUMNS).eq('company_id', companyId).maybeSingle()
  if (error) throw error
  return toPolicy(data as PolicyRow | null)
}

/**
 * The invoices among `invoiceIds` that payment must leave out: the policy
 * requires attest for them and it has not been given (code attest_required
 * in the payment file and bank payment paths). Empty when the policy is off
 * or the company keeps kontantmetoden. Throws when it cannot tell: payment
 * must not read "no attest needed" from a failed read.
 */
export async function loadAttestBlockedInvoiceIds(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const policy = await loadAttestPolicy(supabase, companyId)
  if (!policy.enabled) return new Set()
  const { data: settings, error: settingsError } = await supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle()
  if (settingsError) throw settingsError
  const accountingMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method ?? null
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select('id, user_id, approved_at, is_credit_note, currency, total, total_sek, exchange_rate')
    .eq('company_id', companyId)
    .in('id', [...invoiceIds])
  if (error) throw error
  const blocked = new Set<string>()
  for (const row of (data ?? []) as Array<AttestInvoiceFacts & { id: string; approved_at: string | null }>) {
    if (paymentWaitsForAttest(policy, accountingMethod, { ...row, total: Number(row.total) })) blocked.add(row.id)
  }
  return blocked
}
