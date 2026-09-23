import { cache } from 'react'
import { getDashboardAuthContext } from './request-context'

/**
 * Reads the Hem islands share. The two islands stream independently and
 * used to run these five queries twice per page load; React cache keys them
 * on the company for the length of one request, so whichever island asks
 * first pays and the other reuses the answer. Each returns the raw query
 * result, so the islands destructure exactly as before.
 */
export const readActiveBankConnections = cache(async (companyId: string) => {
  const { supabase } = await getDashboardAuthContext()
  return supabase
    .from('bank_connections')
    .select('id, status, consent_expires, bank_name, last_sie_sweep')
    .eq('company_id', companyId)
    .eq('status', 'active')
})

export const countTransactions = cache(async (companyId: string) => {
  const { supabase } = await getDashboardAuthContext()
  return supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId)
})

export const countCompletedSieImports = cache(async (companyId: string) => {
  const { supabase } = await getDashboardAuthContext()
  return supabase.from('sie_imports').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'completed')
})

export const countInboxItems = cache(async (companyId: string) => {
  const { supabase } = await getDashboardAuthContext()
  return supabase.from('invoice_inbox_items').select('*', { count: 'exact', head: true }).eq('company_id', companyId)
})
