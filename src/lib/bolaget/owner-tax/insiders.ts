/**
 * Who is in the låneförbud circle on a given day, from the registers:
 * holders (aktiebok, with their share of the capital), board members and
 * suppleanter, the VD and vice VD (company_roles). Loaded once and replayed
 * per day, so a page of loans costs one read of each register.
 */
import { roundOre } from '@/lib/money'
import type { OperationContext } from '@/lib/operations/types'
import { activeOn } from '../roles'
import { replayShareRegister, summarizeHoldings } from '../register-state'
import { loadShareClasses, loadShareEvents } from '../share-register'
import type { CompanyRoleKind } from '../types'

/** The board for the låneförbud: ordinarie ledamöter and, conservatively, suppleanter. */
const BOARD_ROLES: readonly CompanyRoleKind[] = ['styrelseordforande', 'styrelseledamot', 'styrelsesuppleant']
/** The VD for the låneförbud and the ÅRL 5:18 note: the VD and, conservatively, the vice VD. */
const CEO_ROLES: readonly CompanyRoleKind[] = ['vd', 'vice_vd']

export interface InsiderSnapshot {
  /** Share of the capital in percent per holder. */
  holders: Map<string, number>
  board: Set<string>
  ceo: Set<string>
}

export type InsiderTimeline = (day: string) => InsiderSnapshot

interface RoleRow {
  party_id: string
  role: CompanyRoleKind
  valid_from: string | null
  valid_to: string | null
}

export async function loadInsiderTimeline(ctx: OperationContext): Promise<InsiderTimeline> {
  const [events, classes, rolesRes] = await Promise.all([
    loadShareEvents(ctx.supabase, ctx.companyId),
    loadShareClasses(ctx.supabase, ctx.companyId),
    ctx.supabase.from('company_roles').select('party_id, role, valid_from, valid_to').eq('company_id', ctx.companyId),
  ])
  if (rolesRes.error) throw new Error(`company_roles read failed: ${rolesRes.error.message}`)
  const roles = (rolesRes.data ?? []) as RoleRow[]
  const cache = new Map<string, InsiderSnapshot>()
  return (day: string) => {
    const hit = cache.get(day)
    if (hit) return hit
    const holders = new Map<string, number>()
    try {
      const summary = summarizeHoldings(replayShareRegister(events, day).ranges, classes)
      for (const h of summary.holders) holders.set(h.party_id, roundOre(h.capital_pct))
    } catch {
      // An aktiebok whose history does not replay holds nobody for this check;
      // the aktiebok page names what is wrong with it.
    }
    const active = roles.filter((r) => activeOn(r, day))
    const snapshot: InsiderSnapshot = {
      holders,
      board: new Set(active.filter((r) => BOARD_ROLES.includes(r.role)).map((r) => r.party_id)),
      ceo: new Set(active.filter((r) => CEO_ROLES.includes(r.role)).map((r) => r.party_id)),
    }
    cache.set(day, snapshot)
    return snapshot
  }
}

/** The party's links on any of the days: the largest holding, and board or VD on any of them. */
export function insiderFacts(timeline: InsiderTimeline, partyId: string, days: readonly string[]): { holder_capital_pct: number | null; is_board: boolean; is_ceo: boolean } {
  let pct: number | null = null
  let board = false
  let ceo = false
  for (const day of days) {
    const s = timeline(day)
    const held = s.holders.get(partyId)
    if (held !== undefined) pct = Math.max(pct ?? 0, held)
    board = board || s.board.has(partyId)
    ceo = ceo || s.ceo.has(partyId)
  }
  return { holder_capital_pct: pct, is_board: board, is_ceo: ceo }
}
