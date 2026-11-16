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

/**
 * The V7 shell renamed about twenty rows on 2026-11-16 and the palette lists
 * the rows by their new names, so the old name of a page, and the words
 * people type for the pages that lost their row, found nothing. Read in the
 * palette's own order: the actions, then the pages (flatEntries).
 */
describe('the palette answers to the names the menu had before', () => {
  const firstHit = (query: string, pages = pagesFor()) =>
    [...actionEntries(null), ...pages].find((entry) => matches(entry, query))?.href

  it.each([
    ['transaktioner', '/transactions'],
    ['assistent', '/chat'],
    ['viktiga datum', '/deadlines'],
    ['wiki', '/wiki'],
    ['årsbokslut', '/bookkeeping/year-end'],
    ['årsredovisning', '/bookkeeping/year-end'],
    ['inkomstdeklaration', '/reports'],
    ['importera', '/import'],
    ['exportera', '/import'],
    ['alla dokument', '/arkiv'],
    ['bolaget', '/bolaget'],
    ['api och mcp', '/settings/api'],
    // The English menu was renamed too.
    ['transactions', '/transactions'],
    ['assistant', '/chat'],
    ['important dates', '/deadlines'],
  ])('"%s" opens %s first', (oldName, href) => {
    expect(firstHit(oldName)).toBe(href)
  })

  it.each([
    ['banktransaktioner', '/transactions'],
    ['deadlines', '/deadlines'],
    ['förfallodagar', '/deadlines'],
    ['fråga', '/chat'],
    ['ink2', '/reports'],
    ['ink3', '/reports'],
    ['ne-bilaga', '/reports'],
    ['sie', '/import'],
    ['byta', '/import'],
    ['mcp', '/settings/api'],
    ['api-nyckel', '/settings/api'],
    ['chatgpt', '/settings/api'],
    ['kopplingar', '/settings/connections'],
    ['bankkoppling', '/settings/banking'],
    ['koppla bank', '/settings/banking'],
    ['abonnemang', '/settings/billing'],
    ['pris', '/settings/billing'],
    ['användare', '/settings/members'],
    ['medlemmar', '/settings/members'],
    ['bjud in', '/settings/members'],
  ])('"%s", a word people type, opens %s first', (word, href) => {
    expect(firstHit(word)).toBe(href)
  })

  it('lists the årsredovisning and the income declarations where the reports for the legal form are', () => {
    const hits = pagesFor().filter((p) => matches(p, 'årsredovisning')).map((p) => p.href)
    expect(hits).toEqual(['/bookkeeping/year-end', '/reports'])
  })

  // Enter opens the first hit, so a new word must not move one that already led somewhere.
  it.each([
    ['deklaration', '/reports/vat-declaration'],
    ['kontoutdrag', '/reports/huvudbok'],
    ['bank', '/transactions'],
    ['plan', '/chart-of-accounts'],
    ['betalning', '/payments'],
    ['nyckel', '/kpi'],
    ['koppla', '/settings/api'],
    ['rapporter', '/reports'],
    ['inställningar', '/settings'],
  ])('"%s" still opens %s first', (word, href) => {
    expect(firstHit(word)).toBe(href)
  })

  it('files the settings pages under Inställningar and offers them only with a company open', () => {
    const sections = ['/settings/banking', '/settings/connections', '/settings/billing', '/settings/members']
    const pages = pagesFor()
    const settings = pages.find((p) => p.href === '/settings')!
    for (const href of sections) {
      // Under the area's name, with the area's icon: the alias brings none.
      expect(pages.find((p) => p.href === href), href).toMatchObject({ group: nav.settings, icon: settings.icon })
    }
    const without = pagesFor({}, { hasCompany: false })
    for (const href of sections) expect(without.some((p) => p.href === href), href).toBe(false)
  })

  it('lets an old name go with its page when the company does not have the page', () => {
    // No MCP extension: Koppla en agent is not offered, under either name.
    const ctx = { ...gateContext(), mcpExtensionEnabled: false }
    const noMcp = palettePages({ passes: (item) => passesNavGates(item, ctx), hasCompany: true, isByraMember: false, navLabel, aliases: PAGE_ALIASES })
    expect(firstHit('api och mcp', noMcp)).toBeUndefined()
    expect(firstHit('mcp', noMcp)).toBeUndefined()
    // No Bolaget rollout: the old name of its row finds nothing instead of a page that is not there.
    expect(firstHit('bolaget', pagesFor({ bolagetEnabled: false, commitmentsEnabled: false }))).toBeUndefined()
  })

  it('says to try another word when nothing is found: with an empty list Enter opens nothing', () => {
    expect(sv.command_palette.empty).toBe('Inget hittades. Prova ett annat ord.')
    expect(en.command_palette.empty).not.toMatch(/Enter/)
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

  it('hides every destination an old name or a settings alias leads to from the invoicing-only role, except its own pages', () => {
    const offered = pagesFor().filter((page) => paletteOpensForRole('invoicer', page.href)).map((page) => page.href)
    expect(offered).toEqual(['/invoices', '/quotes', '/sales-orders', '/customers', '/articles'])
    for (const href of ['/settings/banking', '/settings/connections', '/settings/billing', '/settings/members', '/settings/api', '/chat', '/import']) {
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
      // The entry has a message of its own ("Bank" reads the same in both languages).
      expect(shown, entry.id).not.toBe(entry)
      if (entry.id !== 'bank') expect(shown.label, entry.id).not.toBe(entry.label)
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
    const entry = { id: 'add-company', label: 'Lägg till företag', icon: actionEntries(null)[0].icon, href: '/companies/new' }
    expect(localizeEntry(entry, palette(en))).toBe(entry)
  })
})
