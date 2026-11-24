/**
 * The menu each representative company sees (tests/fixtures/
 * representative-companies.ts): the shell's areas and their rows (nav-v3.ts,
 * which the phone menu is drawn from too) and the v2 tree the assistant's UI
 * map still reads (nav-v2.ts), gated exactly as the app gates them, from the
 * company's database rows through the server read path the assistant's UI
 * map shares with the shell (loadNavGateContext).
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
import { NAV_V3_AREAS, areaCreate, areaItems, gateAreas } from '@/components/dashboard/nav-v3'
import { loadNavGateContext } from '@/lib/agent/ask/ui-map'
import { gateNavTree, passesNavGates, type NavGateContext } from '@/lib/navigation/nav-gates'
import { createTableMockSupabase } from '@/tests/helpers'
import { REPRESENTATIVE_COMPANIES, representativeCompanyTables } from '@/tests/fixtures/representative-companies'

const FIRST = REPRESENTATIVE_COMPANIES[0].id

beforeEach(() => {
  // The per-company rollouts, pinned so the snapshot does not depend on
  // the environment the suite runs in: Arkiv and Agenter on for the first
  // company only, the new Inkorg page for nobody (the menu as it is today).
  vi.stubEnv('ARKIV_COMPANY_IDS', FIRST)
  vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', FIRST)
  vi.stubEnv('INKORG_V2_COMPANY_IDS', '')
  vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', '')
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

/** The shell as the company sees it: one line per area that has a row left, its create route first when it has one. */
function areas(ctx: NavGateContext): string[] {
  return gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, ctx))
    // Inställningar draws the settings sections; Byrå belongs to the byrå team, not to the company.
    .filter((area) => area.id !== 'settings' && area.id !== 'byra' && areaItems(area).length > 0)
    .map((area) => `${area.id}${areaCreate(area) ? ` [+ ${areaCreate(area)!.href}]` : ''}: ${areaItems(area).map((item) => item.href).join(' ')}`)
}

describe('the menu of each representative company', () => {
  it.each(REPRESENTATIVE_COMPANIES.map((c) => [c.name, c] as const))('%s', async (_name, company) => {
    const { supabase } = createTableMockSupabase(representativeCompanyTables(company))
    const ctx = await loadNavGateContext(supabase as unknown as SupabaseClient, company.id)
    expect(ctx).not.toBeNull()
    expect({
      areas: areas(ctx!),
      assistantMap: sidebar(ctx!),
    }).toMatchSnapshot()
  })
})

/**
 * A company with a stored profile, through the same read path. Not
 * snapshots: the snapshots above pin every company without a stored profile,
 * which is every company that existed before profiles.
 */
describe('the menu of a company with a stored profile', () => {
  const company = REPRESENTATIVE_COMPANIES[0]

  async function menuWith(profile: { profile_id: string; profile_version: number } | null) {
    const tables = representativeCompanyTables(company) as Record<string, unknown>
    const row = (tables.companies as { data: Record<string, unknown> }).data
    tables.companies = (chainCalls: Array<{ method: string; args: unknown[] }>) =>
      chainCalls.some((c) => c.method === 'select' && String(c.args[0]).includes('profile_id'))
        ? { data: profile }
        : { data: row }
    const { supabase } = createTableMockSupabase(tables as never)
    const ctx = await loadNavGateContext(supabase as unknown as SupabaseClient, company.id)
    const hrefs = gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, ctx!))
      .filter((area) => area.id !== 'byra')
      .flatMap((area) => areaItems(area).map((item) => item.href))
    const assistantMap = [...gateNavTree(NAV_V2_TOP, ctx!), ...gateNavTree(NAV_V2_COMPANY, ctx!)].flatMap((item) => [
      item.href,
      ...(item.sub ?? []).map((s) => s.href),
    ])
    return { hrefs, assistantMap }
  }

  it('shows exactly the menu of no profile when Standard is stored', async () => {
    expect(await menuWith({ profile_id: 'standard', profile_version: 1 })).toEqual(await menuWith(null))
  })

  it('leaves out the pages of the packages Aktiebolag utan anställda starts with off, and nothing else', async () => {
    const all = await menuWith(null)
    const narrowed = await menuWith({ profile_id: 'limited-company-no-employees', profile_version: 1 })
    const removed = all.hrefs.filter((href) => !narrowed.hrefs.includes(href))
    expect(narrowed.hrefs.every((href) => all.hrefs.includes(href))).toBe(true)
    expect(removed).toEqual(expect.arrayContaining(['/salary', '/salary/employees', '/assets']))
    for (const href of removed) expect(href).toMatch(/^\/(salary|assets|kassa|orders)/)
    expect(narrowed.hrefs).toEqual(expect.arrayContaining(['/invoices', '/supplier-invoices', '/payments', '/bookkeeping']))
  })
})
