/**
 * The company's giro register for readGiroCounterparty (crm#1204): its own
 * bankgiro and plusgiro (company settings and every cash account) and the
 * supplier cards that carry a giro number.
 *
 * Client-safe: the transactions page loads it with the browser client (RLS),
 * the MCP list with the caller's client. A read that fails leaves its part
 * empty, so the rows simply show what the bank sent: a missing reading is
 * never an error.
 */
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { buildGiroRegister, type GiroRegister, type GiroRegisterSource } from './giro-counterparty'

type GiroFields = { bankgiro: string | null; plusgiro: string | null }

export async function loadGiroRegister(supabase: SupabaseDataClient, companyId: string): Promise<GiroRegister> {
  const [settings, cashAccounts, suppliers] = await Promise.all([
    supabase
      .from('company_settings')
      .select('bankgiro, plusgiro')
      .eq('company_id', companyId)
      .maybeSingle()
      .then((r) => (r.error ? null : (r.data as GiroFields | null))),
    supabase
      .from('cash_accounts')
      .select('bankgiro, plusgiro')
      .eq('company_id', companyId)
      .then((r) => (r.error ? [] : ((r.data ?? []) as GiroFields[]))),
    fetchAllRows<GiroFields & { id: string; name: string | null }>(({ from, to }) =>
      supabase
        .from('suppliers')
        .select('id, name, bankgiro, plusgiro')
        .eq('company_id', companyId)
        .or('bankgiro.not.is.null,plusgiro.not.is.null')
        .order('id', { ascending: true })
        .range(from, to),
    ).catch(() => []),
  ])
  const source: GiroRegisterSource = {
    own: [...(settings ? [settings] : []), ...cashAccounts],
    suppliers,
  }
  return buildGiroRegister(source)
}
