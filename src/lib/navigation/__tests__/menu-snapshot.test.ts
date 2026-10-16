/**
 * The menu each representative company sees (tests/fixtures/
 * representative-companies.ts): the desktop sidebar tree (nav-v2.ts), the
 * phone menu and the byrå cockpit list (nav-phone.ts), gated exactly as the
 * app gates them, from the company's database rows through the server read
 * path the assistant's UI map shares with the sidebar (loadNavGateContext).
 *
 * Written before the menu read the resolved capabilities object
 * (lib/modules/capabilities.ts) and kept byte-identical since: the packages
 * step changes how the menu decides, never what it shows. A diff here is a
 * visible change. Update the snapshot only when the menu itself changes (an
 * item added, moved or renamed), never to absorb a capabilities change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavV2Item } from '@/components/dashboard/nav-v2'
import { cockpitNavItems, navItems } from '@/components/dashboard/nav-phone'
import { loadNavGateContext } from '@/lib/agent/ask/ui-map'
import { gateNavTree, passesNavGates, type NavGateContext } from '@/lib/navigation/nav-gates'
import { createTableMockSupabase } from '@/tests/helpers'
import { REPRESENTATIVE_COMPANIES, representativeCompanyTables } from '@/tests/fixtures/representative-companies'

const FIRST = REPRESENTATIVE_COMPANIES[0].id

beforeEach(() => {
  // The two per-company rollouts, pinned so the snapshot does not depend on
  // the environment the suite runs in: both on for the first company only.
  vi.stubEnv('ARKIV_COMPANY_IDS', FIRST)
  vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', FIRST)
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function sidebar(ctx: NavGateContext): string[] {
  const line = (item: NavV2Item) =>
    item.sub && item.sub.length > 0 ? `${item.href}: ${item.sub.map((s) => s.href).join(' ')}` : item.href
  return [...gateNavTree(NAV_V2_TOP, ctx), ...gateNavTree(NAV_V2_COMPANY, ctx)].map(line)
}

describe('the menu of each representative company', () => {
  it.each(REPRESENTATIVE_COMPANIES.map((c) => [c.name, c] as const))('%s', async (_name, company) => {
    const { supabase } = createTableMockSupabase(representativeCompanyTables(company))
    const ctx = await loadNavGateContext(supabase as unknown as SupabaseClient, company.id)
    expect(ctx).not.toBeNull()
    expect({
      sidebar: sidebar(ctx!),
      phone: navItems.filter((i) => passesNavGates(i, ctx!)).map((i) => i.href),
      cockpit: cockpitNavItems.filter((i) => passesNavGates(i, ctx!)).map((i) => i.href),
    }).toMatchSnapshot()
  })
})
