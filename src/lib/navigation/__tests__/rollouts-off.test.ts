/**
 * A company outside every page rollout (nav-rollouts.ts: Arkiv, Arkiv brain,
 * the Agenter page, the new Inkorg, Autogiro, signing, Bolaget, commitments,
 * the question list),
 * which is what most production companies are. The shell must not name a
 * page that 404s for them: no row, no create entry, no palette entry; and
 * what is left of each area must still be an area (a first row to land on,
 * a create button whose page has a row).
 */
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import { NAV_V3_AREAS, areaCreate, areaCreatePage, areaItems, gateAreas, hrefPath } from '@/components/dashboard/nav-v3'
import { PAGE_ALIASES } from '@/components/common/CommandPalette'
import { palettePages } from '@/components/common/palette-pages'
import { passesNavGates, type NavGateContext } from '../nav-gates'

const nav = sv.nav as Record<string, string>

/** Pages that 404 (or are not offered) outside their rollout. */
const ROLLOUT_PAGES = /^\/(arkiv|inkorg|skills|bolaget|commitments|questions|invoices\/autogiro)(\/|\?|$)|^\/wiki\?view=facts$/

function rolloutsOff(overrides: Partial<NavGateContext> = {}): NavGateContext {
  return {
    entityType: 'aktiebolag',
    surface: { hidden: [], notForLegalForm: [] },
    dimensionsEnabled: false,
    salesOrdersEnabled: false,
    quotesEnabled: true,
    hasWebshop: false,
    hasMileage: false,
    hasExpenseClaims: false,
    hasPosSales: false,
    arkivEnabled: false,
    arkivBrainEnabled: false,
    signingEnabled: false,
    commitmentsEnabled: false,
    agentsEnabled: false,
    inkorgV2Enabled: false,
    autogiroEnabled: false,
    bolagetEnabled: false,
    companyQuestionsEnabled: false,
    agentPictureEnabled: false,
    mcpExtensionEnabled: true,
    capabilities: ['ai'],
    hiddenNavHrefs: new Set(),
    ...overrides,
  }
}

const COMPANIES: Array<[string, NavGateContext]> = [
  ['an aktiebolag with the plan capabilities', rolloutsOff()],
  ['an aktiebolag with no plan capability', rolloutsOff({ capabilities: [] })],
  ['an enskild firma that pays no salaries', rolloutsOff({ entityType: 'enskild_firma', surface: { hidden: [], notForLegalForm: ['payroll'] } })],
]

describe.each(COMPANIES)('outside every rollout: %s', (_name, ctx) => {
  const areas = gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, ctx)).filter(
    (area) => area.id !== 'settings' && area.id !== 'byra' && areaItems(area).length > 0,
  )

  it('names no rollout page in a row or a create entry', () => {
    for (const area of areas) {
      for (const item of areaItems(area)) expect(item.href, `${area.id} row`).not.toMatch(ROLLOUT_PAGES)
      const create = areaCreate(area)
      if (create) expect(create.href, `${area.id} create`).not.toMatch(ROLLOUT_PAGES)
    }
  })

  it('names no rollout page in the palette', () => {
    const pages = palettePages({
      passes: (item) => passesNavGates(item, ctx),
      hasCompany: true,
      isByraMember: false,
      navLabel: (key) => nav[key] ?? key,
      aliases: PAGE_ALIASES,
    })
    expect(pages.length).toBeGreaterThan(20)
    for (const page of pages) expect(page.href, page.id).not.toMatch(ROLLOUT_PAGES)
  })

  it('leaves every area a first row, and a create button only beside a row of its page', () => {
    for (const area of areas) {
      for (const group of area.groups) expect(group.items.length, `${area.id} group`).toBeGreaterThan(0)
      const create = areaCreate(area)
      if (!create || create.action) continue
      // Koppla en agent opens a page Agenter owns without a row (nav-v3.ts areaCreatePage).
      if (areaCreatePage(area)) continue
      const createPath = hrefPath(create.href)
      const rows = areaItems(area).map((item) => hrefPath(item.href))
      expect(rows.some((row) => createPath === row || createPath.startsWith(`${row}/`)), `${area.id}: ${create.href}`).toBe(true)
    }
  })

  it('keeps the rail: the money, sales, purchases, ledger, tax, reports, company and agents areas', () => {
    expect(areas.map((area) => area.id)).toEqual(
      expect.arrayContaining(['todo', 'money', 'sales', 'purchases', 'ledger', 'tax', 'reports', 'company', 'agents']),
    )
  })
})

describe('outside every rollout: what an area shrinks to', () => {
  const rows = (ctx: NavGateContext, id: string) =>
    areaItems(gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, ctx)).find((area) => area.id === id)!).map((item) => item.href)

  it('Företaget is Motparter alone, with no create button', () => {
    const ctx = rolloutsOff()
    expect(rows(ctx, 'company')).toEqual(['/parties'])
    expect(areaCreate(gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, ctx)).find((area) => area.id === 'company')!)).toBeUndefined()
  })

  it('Dokument is the Underlag inbox alone with the plan capability, and off the rail without it', () => {
    expect(rows(rolloutsOff(), 'documents')).toEqual(['/e/general/invoice-inbox'])
    expect(rows(rolloutsOff({ capabilities: [] }), 'documents')).toEqual([])
  })

  it('Agenter keeps Kompetens as a view of the wiki while the Agenter page is closed', () => {
    const agents = rows(rolloutsOff(), 'agents')
    expect(agents).toContain('/wiki?view=skills')
    expect(agents).not.toContain('/skills')
  })

  it('Löner leaves the rail of a form that does not pay salaries', () => {
    expect(rows(rolloutsOff({ entityType: 'enskild_firma', surface: { hidden: [], notForLegalForm: ['payroll'] } }), 'payroll')).toEqual([])
  })
})
