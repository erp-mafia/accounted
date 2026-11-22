/**
 * The short Bolaget block of the agent briefing: owners with their share of
 * capital and votes, the board, the VD and the firmateckning. Names only,
 * never a personnummer. Best-effort and fail-open: null when the company is
 * outside the rollout, has nothing registered, or a read fails (a table
 * not yet migrated included), so the briefing never breaks on it.
 */
import { isBolagetRegistersEnabled } from '@/lib/env/bolaget-switch'
import type { OperationContext } from '@/lib/operations/types'
import { loadRoles } from './roles'
import { loadShareRegisterData } from './share-register'

export interface BolagetBriefing {
  total_shares: number
  owners: Array<{ name: string; capital_pct: number; votes_pct: number }>
  board: Array<{ name: string; role: string }>
  ceo: string | null
  signatory_rule: string | null
  how: string
}

const MAX_OWNERS = 10

export async function briefBolaget(ctx: OperationContext): Promise<BolagetBriefing | null> {
  if (!isBolagetRegistersEnabled(ctx.companyId)) return null
  try {
    const [register, roles] = await Promise.all([loadShareRegisterData(ctx), loadRoles(ctx)])
    if (register.summary.total_shares === 0 && roles.roles.length === 0) return null
    return {
      total_shares: register.summary.total_shares,
      owners: register.summary.holders.slice(0, MAX_OWNERS).map((h) => ({
        name: register.parties.get(h.party_id)?.name ?? 'okänd',
        capital_pct: h.capital_pct,
        votes_pct: h.votes_pct,
      })),
      board: roles.board.map((r) => ({ name: r.party?.name ?? 'okänd', role: r.label_sv })),
      ceo: roles.ceo?.party?.name ?? null,
      signatory_rule: roles.signatory_rule,
      how: 'Aktieboken: gnubok_get_share_register (as_of) and gnubok_list_share_events; roles: gnubok_list_company_roles. Stage changes with gnubok_register_share_event or gnubok_add_company_role. A company that kept its aktiebok elsewhere enters today\'s holdings as kind ingaende, never as bildande; completes_setup on the last entry takes the register into use. Personnummer are collected in Accounted only, never in a call.',
    }
  } catch (error) {
    ctx.log.warn('[bolaget] briefing block failed', { companyId: ctx.companyId, error: String(error) })
    return null
  }
}
