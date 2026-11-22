/**
 * Who may reach the Bolaget registers: a company in the BOLAGET_COMPANY_IDS
 * rollout whose legal form keeps an aktiebok (an aktiebolag). One check for
 * every door: the operations, the dashboard routes and the pages.
 *
 * Two scopes. 'registers' (aktiebok, styrelse och firmateckning, verkliga
 * huvudmän) also opens for a company in BOLAGET_REGISTERS_COMPANY_IDS, and
 * for one whose `bolaget_registers_enabled` is set: one set up from a
 * company formation (lib/formation/setup.ts). 'all' (the default: meetings,
 * capital, dividends, owner tax) stays on the rollout alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { keepsShareRegister, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { isBolagetEnabled, isBolagetRegistersEnabled } from '@/lib/env/bolaget-switch'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import type { BolagetHubAccess } from './hub'

export type BolagetGateCode = 'BOLAGET_DISABLED' | 'BOLAGET_NOT_FOR_LEGAL_FORM'

export type BolagetScope = 'registers' | 'all'

/** Whether the registers were opened for this one company (a formation's setup). */
async function registersOpenedFor(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase.from('companies').select('bolaget_registers_enabled').eq('id', companyId).maybeSingle()
  if (error) throw new Error(`companies read failed: ${error.message}`)
  return (data as { bolaget_registers_enabled?: boolean } | null)?.bolaget_registers_enabled === true
}

/** Null when the company may use the registers, else the code that says why not. */
export async function bolagetGate(supabase: SupabaseClient, companyId: string, scope: BolagetScope = 'all'): Promise<BolagetGateCode | null> {
  const open = scope === 'registers' ? isBolagetRegistersEnabled(companyId) || (await registersOpenedFor(supabase, companyId)) : isBolagetEnabled(companyId)
  if (!open) return 'BOLAGET_DISABLED'
  const entityType = await resolveCompanyEntityType(supabase, companyId)
  return keepsShareRegister(entityType) ? null : 'BOLAGET_NOT_FOR_LEGAL_FORM'
}

/**
 * Which halves of the Bolaget pages the company has (hub.ts): the registers
 * by the gate above, Avtal och åtaganden by the same rollout for every form.
 */
export async function bolagetHubAccess(supabase: SupabaseClient, companyId: string): Promise<BolagetHubAccess> {
  return {
    registers: (await bolagetGate(supabase, companyId, 'registers')) === null,
    money: (await bolagetGate(supabase, companyId, 'all')) === null,
    agreements: commitmentsEnabledFor(companyId),
  }
}
