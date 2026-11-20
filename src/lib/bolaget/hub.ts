/**
 * The Bolaget pages as one place (product decision 2026-10-30). Since the
 * V7 shell (2026-11-15) each page is a row in the Företaget sidebar
 * (components/dashboard/nav-v3.ts) instead of a tab in a shared bar; the
 * list below stays the one definition of which page needs which half, and
 * the sidebar rows are tested against it. Two halves open per
 * company: the registers (aktiebok, board, meetings, capital, owner tax) for
 * a form that keeps an aktiebok inside BOLAGET_COMPANY_IDS (gate.ts), and
 * Avtal och åtaganden for every form inside the same rollout
 * (lib/env/commitments-switch.ts). Pure and client-safe.
 */

export interface BolagetHubAccess {
  /** The registers: the rollout and a form that keeps an aktiebok. */
  registers: boolean
  /** Avtal och åtaganden: the rollout, any form. */
  agreements: boolean
}

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

/** The pages this company has; none when the hub is closed. */
export function bolagetTabs(access: BolagetHubAccess): BolagetTab[] {
  if (!bolagetHubOpen(access)) return []
  return BOLAGET_TABS.filter((tab) => tab.needs === null || access[tab.needs])
}
