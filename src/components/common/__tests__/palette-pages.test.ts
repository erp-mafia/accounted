import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import { NAV_V3_AREAS, areaItems } from '@/components/dashboard/nav-v3'
import { passesNavGates } from '@/lib/navigation/nav-gates'
import { gateContext } from '@/lib/agent/ask/__tests__/ui-fixture'
import en from '@/messages/en.json'
import { PAGE_ALIASES, actionEntries, localizeEntry, matches } from '../CommandPalette'
import { groupPalettePages, paletteOpensForRole, palettePages, paletteStartPages } from '../palette-pages'

const nav = sv.nav as Record<string, string>
const navLabel = (key: string) => nav[key] ?? key

function pagesFor(overrides: Parameters<typeof gateContext>[0] = {}, opts: { hasCompany?: boolean; isByraMember?: boolean } = {}) {
  const ctx = { ...gateContext(overrides), mcpExtensionEnabled: true }
  return palettePages({
    passes: (item) => passesNavGates(item, ctx),
    hasCompany: opts.hasCompany ?? true,
    isByraMember: opts.isByraMember ?? false,
    navLabel,
    aliases: PAGE_ALIASES,
  })
}

describe('palettePages: the shell tree is the page list', () => {
  it('lists every row of every company area under the area name, in menu order', () => {
    const pages = pagesFor()
    for (const area of NAV_V3_AREAS) {
      if (area.id === 'settings' || area.id === 'byra') continue
      for (const item of areaItems(area)) {
        // One inbox row at a time (the new page only in its rollout).
        if (item.requiresInkorgV2) continue
        // Fakta follows the Arkiv reading rollout; the wiki's Arbetssätt view yields to the Agenter page.
        if (item.requiresArkivBrain || item.hiddenWithAgents) continue
        const page = pages.find((p) => p.href === item.href && p.id.startsWith('nav:'))
        expect(page, item.href).toBeDefined()
        expect(page!.label).toBe(nav[item.labelKey])
        expect(page!.group).toBe(nav[area.labelKey])
      }
    }
    const groups = groupPalettePages(pages).map((g) => g.group)
    expect(groups.slice(0, 3)).toEqual([nav.v2_todo, nav.v3_money, nav.v3_sales])
  })

  it('hides a row the sidebar hides for the company, and its alias with it', () => {
    const pages = pagesFor({ surface: { hidden: [], notForLegalForm: ['payroll'] }, agentsEnabled: false })
    expect(pages.some((p) => p.href === '/salary')).toBe(false)
    expect(pages.some((p) => p.href === '/salary/employees')).toBe(false)
    expect(pages.some((p) => p.href === '/skills')).toBe(false)
    expect(pages.some((p) => p.href === '/invoices')).toBe(true)
  })

  it('offers Koppla en agent under Agenter although the page has no row, gated like the button', () => {
    const page = pagesFor().find((p) => p.href === '/settings/api')
    expect(page).toMatchObject({ id: 'nav:agents:/settings/api', label: nav.v3_connect_agent, group: nav.v3_agents })
    expect(pagesFor().filter((p) => p.href === '/settings/api')).toHaveLength(1)
    const ctx = { ...gateContext(), mcpExtensionEnabled: false }
    const without = palettePages({ passes: (item) => passesNavGates(item, ctx), hasCompany: true, isByraMember: false, navLabel, aliases: PAGE_ALIASES })
    expect(without.some((p) => p.href === '/settings/api')).toBe(false)
  })

  it('finds the Agenter pages by their menu names (founder decision 2026-11-16)', () => {
    const pages = pagesFor()
    const first = (query: string) => pages.find((p) => matches(p, query))?.href
    expect(first('koppla en agent')).toBe('/settings/api')
    expect(first('bokföringsregler')).toBe('/rules')
    expect(first('arbetssätt')).toBe('/skills')
    // The names the page had before still lead there.
    expect(first('kompetens')).toBe('/skills')
    expect(first('instruktioner')).toBe('/skills')
    expect(first('regler')).toBe('/rules')
    expect(pages.some((p) => p.href === '/settings/assistant')).toBe(false)
  })

  it('lists Byrå only for a byrå team member', () => {
    expect(pagesFor().some((p) => p.group === nav.v3_byra)).toBe(false)
    const byra = pagesFor({}, { isByraMember: true }).filter((p) => p.group === nav.v3_byra)
    expect(byra.map((p) => p.href)).toEqual(['/byra', '/clients', '/byra/automations', '/byra/kpi'])
  })

  it('without a company offers only what opens without one', () => {
    const pages = pagesFor({}, { hasCompany: false })
    expect(pages.map((p) => p.href).sort()).toEqual(['/help', '/settings'])
  })

  it('puts the inbox where the menu puts it, with the extension its page needs', () => {
    const legacy = pagesFor({ inkorgV2Enabled: false }).filter((p) => p.label === nav.v3_incoming)
    expect(legacy.map((p) => p.href)).toEqual(['/e/general/invoice-inbox'])
    const v2 = pagesFor({ inkorgV2Enabled: true }).filter((p) => p.label === nav.v3_incoming)
    expect(v2.map((p) => p.href)).toEqual(['/inkorg'])
    expect(v2[0].extension).toEqual({ sector: 'general', id: 'invoice-inbox' })
  })
})

describe('palettePages: nothing the old hand-written list found is lost', () => {
  it('finds every old entry by its old label, at the same destination', () => {
    const pages = pagesFor({ inkorgV2Enabled: false })
    for (const alias of PAGE_ALIASES) {
      if (alias.href === '/inkorg') continue
      const hits = pages.filter((p) => matches(p, alias.label.toLowerCase()))
      expect(hits.some((p) => p.href === alias.href), alias.label).toBe(true)
    }
  })

  it('still answers the words people type', () => {
    const pages = pagesFor()
    const first = (query: string) => pages.find((p) => matches(p, query))?.href
    expect(first('verifikat per konto')).toBe('/reports/huvudbok')
    expect(first('stäm av')).toBe('/accounts')
    expect(first('utlägg kvitto')).toBe('/e/general/invoice-inbox')
    expect(first('saldobalans')).toBe('/reports/trial-balance')
    expect(first('agentförslag')).toBe('/pending')
    expect(first('hjälp')).toBe('/help')
  })

  it('files a destination without a row under the area the shell lights for it', () => {
    const pages = pagesFor()
    expect(pages.find((p) => p.href === '/reports/trial-balance')?.group).toBe(nav.reports)
    expect(pages.find((p) => p.href === '/settings')?.group).toBe(nav.settings)
    expect(pages.find((p) => p.href === '/help')?.group).toBe(nav.settings)
  })
})

describe('paletteStartPages', () => {
  it('shows one row per area, where its rail button lands, with the area as the hint', () => {
    const start = paletteStartPages(pagesFor())
    expect(start.map((p) => p.href).slice(0, 4)).toEqual(['/', '/transactions', '/invoices', '/supplier-invoices'])
    expect(start.find((p) => p.href === '/transactions')?.hint).toBe(nav.v3_money)
    expect(new Set(start.map((p) => p.group)).size).toBe(start.length)
  })
})

describe('paletteOpensForRole', () => {
  it('offers the invoicing-only role its own pages and nothing that would bounce to Fakturor', () => {
    for (const href of ['/invoices', '/invoices/new', '/customers', '/quotes', '/articles', '/settings/account']) {
      expect(paletteOpensForRole('invoicer', href), href).toBe(true)
    }
    for (const href of ['/transactions', '/supplier-invoices?new=1', '/reports', '/settings', '/help', '/chat/new', '/pending']) {
      expect(paletteOpensForRole('invoicer', href), href).toBe(false)
    }
  })

  it('changes nothing for every other role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer', null]) {
      for (const page of pagesFor()) expect(paletteOpensForRole(role, page.href)).toBe(true)
    }
  })
})

describe('localizeEntry: the palette in the language of the reader', () => {
  const palette = (messages: typeof sv) => (key: string) => (messages.command_palette as Record<string, string>)[key] ?? key
  const rowless = pagesFor().filter((page) => !page.id.startsWith('nav:'))

  it('shows every action and every destination without a menu row in English, and still finds it by its Swedish words', () => {
    for (const entry of [...actionEntries(null), ...rowless]) {
      const shown = localizeEntry(entry, palette(en))
      expect(shown.label, entry.id).not.toBe(entry.label)
      expect(shown.label, entry.id).not.toMatch(/[åäöÅÄÖ]/)
      expect(matches(shown, entry.label.toLowerCase()), entry.id).toBe(true)
    }
  })

  it('keeps the Swedish wording the palette had', () => {
    for (const entry of [...actionEntries(null), ...rowless]) {
      const shown = localizeEntry(entry, palette(sv))
      expect(shown.label).toBe(entry.label)
      expect(shown.hint).toBe(entry.hint)
    }
  })

  it('leaves an entry with no message as it is', () => {
    const entry = { id: 'add-company', label: 'Lägg till företag', icon: PAGE_ALIASES[0].icon, href: '/companies/new' }
    expect(localizeEntry(entry, palette(en))).toBe(entry)
  })
})
