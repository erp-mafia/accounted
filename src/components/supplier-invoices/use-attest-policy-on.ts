'use client'

import useSWR from 'swr'
import { createClient } from '@/lib/supabase/client'
import { useCompanyOptional } from '@/contexts/CompanyContext'

/**
 * Whether the active company has its attest policy on
 * (company_attest_policies.enabled): the half of
 * companyAttestsSupplierInvoices (lib/supplier-invoices/lifecycle.ts) the
 * accounting method does not answer. The supplier invoice list, the invoice
 * page and the supplier page read it to decide whether attest is a step.
 *
 * Undefined while it loads, which the rule reads as off: almost every
 * company has no policy, so their pages show the payment step from the
 * start. A failed read answers true, the attest step as it was before the
 * policy decided it; the server holds the policy's own gate either way
 * (attest_required in the payment paths).
 */
export function useAttestPolicyOn(): boolean | undefined {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const { data, error } = useSWR(companyId ? ['company_attest_policy_on', companyId] : null, async ([, id]: [string, string]) => {
    const supabase = createClient()
    const { data: row, error: readError } = await supabase
      .from('company_attest_policies')
      .select('enabled')
      .eq('company_id', id)
      .maybeSingle()
    if (readError) throw readError
    return (row as { enabled?: boolean | null } | null)?.enabled === true
  })
  if (error) return true
  return data
}
