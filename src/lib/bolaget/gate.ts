/**
 * Who may reach the Bolaget registers: a company in the BOLAGET_COMPANY_IDS
 * rollout whose legal form keeps an aktiebok (an aktiebolag). One check for
 * every door: the operations, the dashboard routes and the pages.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { keepsShareRegister, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { isBolagetEnabled } from '@/lib/env/bolaget-switch'

export type BolagetGateCode = 'BOLAGET_DISABLED' | 'BOLAGET_NOT_FOR_LEGAL_FORM'

/** Null when the company may use the registers, else the code that says why not. */
export async function bolagetGate(supabase: SupabaseClient, companyId: string): Promise<BolagetGateCode | null> {
  if (!isBolagetEnabled(companyId)) return 'BOLAGET_DISABLED'
  const entityType = await resolveCompanyEntityType(supabase, companyId)
  return keepsShareRegister(entityType) ? null : 'BOLAGET_NOT_FOR_LEGAL_FORM'
}
