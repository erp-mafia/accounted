/**
 * The Bolaget pages as one place (founder decision 2026-10-30): one row in
 * the sidebar, and a tab bar every /bolaget page shares. Two halves open per
 * company: the registers (aktiebok, board, meetings, capital, owner tax) for
 * a form that keeps an aktiebok inside BOLAGET_COMPANY_IDS (gate.ts), and
 * Avtal och åtaganden for every form inside the same rollout
 * (lib/env/commitments-switch.ts). Pure and client-safe: the tab bar reads it.
 */

export interface BolagetHubAccess {
  /** The registers: the rollout and a form that keeps an aktiebok. */
  registers: boolean
  /** Avtal och åtaganden: the rollout, any form. */
  agreements: boolean
}

export const NO_BOLAGET_ACCESS: BolagetHubAccess = { registers: false, agreements: false }

export type BolagetTabKey = 'overview' | 'owners' | 'board' | 'meetings' | 'capital' | 'owner_tax' | 'agreements'

export interface BolagetTab {
  key: BolagetTabKey
  href: string
  /** The half that must be open for the tab to show; null: shown wherever the hub is. */
  needs: keyof BolagetHubAccess | null
}

export const BOLAGET_TABS: readonly BolagetTab[] = [
  { key: 'overview', href: '/bolaget', needs: null },
  { key: 'owners', href: '/bolaget/aktiebok', needs: 'registers' },
  { key: 'board', href: '/bolaget/styrelse', needs: 'registers' },
  { key: 'meetings', href: '/bolaget/moten', needs: 'registers' },
  { key: 'capital', href: '/bolaget/kapital', needs: 'registers' },
  { key: 'owner_tax', href: '/bolaget/agarskatt', needs: 'registers' },
  { key: 'agreements', href: '/bolaget/avtal', needs: 'agreements' },
]

/** Whether the company has any Bolaget page: outside both halves every /bolaget page answers 404. */
export function bolagetHubOpen(access: BolagetHubAccess): boolean {
  return access.registers || access.agreements
}

/** The tabs this company sees; none when the hub is closed. */
export function bolagetTabs(access: BolagetHubAccess): BolagetTab[] {
  if (!bolagetHubOpen(access)) return []
  return BOLAGET_TABS.filter((tab) => tab.needs === null || access[tab.needs])
}

/** The tab a path belongs to: the overview only on /bolaget itself, a register on its page and below. */
export function activeBolagetTab(pathname: string): BolagetTabKey | null {
  if (pathname === '/bolaget') return 'overview'
  return BOLAGET_TABS.find((tab) => tab.key !== 'overview' && (pathname === tab.href || pathname.startsWith(`${tab.href}/`)))?.key ?? null
}
