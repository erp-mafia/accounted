/**
 * The shell's navigation tree (nav-v3.ts): areas on the rail, rows in the
 * area sidebar. Routes did not move when the shell changed, so the tests pin
 * the three things that could silently break: a page that belongs to no
 * area, a page the old menu reached that the new one does not, and a row
 * whose gates differ from the ones its page had before.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { BOLAGET_TABS } from '@/lib/bolaget/hub'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavGateFlags } from '../nav-v2'
import { NAV_V3_AREAS, areaCreate, areaCreatePage, areaItems, createOpenForRole, gateAreas, resolveNavPlace, type NavAreaId } from '../nav-v3'
import { BOOKING_SCREEN_PATH, BOOKING_SCREEN_RETURN_PATHS } from '@/lib/bookkeeping/booking-screen'

const DASHBOARD = join(process.cwd(), 'src/app/(dashboard)')

/** Every page under app/(dashboard) as a URL, dynamic segments filled with a sample value. */
function dashboardRoutes(dir = DASHBOARD, prefix = ''): string[] {
  const routes: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name.startsWith('__') || name.startsWith('_')) continue
      // A route group "(x)" adds no segment; "[id]" is a dynamic one.
      const segment = name.startsWith('(') ? '' : `/${name.replace(/^\[\.{0,3}(.+)\]$/, 'x-$1')}`
      routes.push(...dashboardRoutes(full, `${prefix}${segment}`))
    } else if (name === 'page.tsx') {
      routes.push(prefix || '/')
    }
  }
  return routes.sort()
}

const ROUTES = dashboardRoutes()

describe('every dashboard route belongs to an area', () => {
  it('finds the pages', () => {
    expect(ROUTES.length).toBeGreaterThan(120)
    expect(ROUTES).toContain('/invoices/x-id/edit')
  })

  it.each(ROUTES)('%s', (route) => {
    expect(resolveNavPlace(route), `${route} resolves to no area: give it a row, a row's match, or an area's owns`).not.toBeNull()
  })

  it('places each route as the coverage map does (area, then the row it lights)', () => {
    expect(Object.fromEntries(ROUTES.map((route) => {
      const place = resolveNavPlace(route)!
      return [route, `${place.area}${place.href ? ` > ${place.href}` : ''}`]
    }))).toMatchSnapshot()
  })
})

describe('resolveNavPlace', () => {
  const place = (pathname: string, search = '', claim: string | null = null) => resolveNavPlace(pathname, search, claim)

  it('keeps the menu row the booking screen was opened from lit: each page it returns to is a row', () => {
    for (const origin of BOOKING_SCREEN_RETURN_PATHS) {
      expect(place(BOOKING_SCREEN_PATH, '', origin)?.href, origin).toBe(origin)
    }
    expect(place(BOOKING_SCREEN_PATH, '', '/att-bokfora')?.area).toBe('todo')
  })

  it('lets the longest row win, so a carved-out page lights its own area', () => {
    expect(place('/reports/vat-declaration')).toEqual({ area: 'tax', href: '/reports/vat-declaration' })
    expect(place('/reports/huvudbok')).toEqual({ area: 'reports', href: '/reports/huvudbok' })
    expect(place('/reports/kassaflodesanalys')).toEqual({ area: 'reports', href: '/reports' })
    expect(place('/bookkeeping/year-end/arsredovisning')).toEqual({ area: 'ledger', href: '/bookkeeping/year-end' })
    expect(place('/bookkeeping/abc')).toEqual({ area: 'ledger', href: '/bookkeeping' })
    expect(place('/salary/runs/1/employees/2')).toEqual({ area: 'payroll', href: '/salary' })
    expect(place('/salary/employees/7')).toEqual({ area: 'payroll', href: '/salary/employees' })
    expect(place('/invoices/12/edit')).toEqual({ area: 'sales', href: '/invoices' })
  })

  it('matches whole segments only', () => {
    expect(place('/invoices-old')).toBeNull()
    expect(place('/byra/kpi')).toEqual({ area: 'byra', href: '/byra/kpi' })
    expect(place('/byra')).toEqual({ area: 'byra', href: '/byra' })
  })

  it('puts a route with no row under the row that names it', () => {
    expect(place('/mileage')).toEqual({ area: 'purchases', href: '/mileage' })
    expect(place('/reports/ink2-declaration')).toEqual({ area: 'ledger', href: '/bookkeeping/year-end' })
    expect(place('/dimensions/tagging')).toEqual({ area: 'ledger', href: '/bookkeeping' })
    expect(place('/arkiv/granska')).toEqual({ area: 'todo', href: '/' })
    expect(place('/bolaget/moten')).toEqual({ area: 'company', href: '/bolaget/moten' })
    expect(place('/bolaget')).toEqual({ area: 'company', href: '/bolaget' })
    expect(place('/bolaget/kapital')).toEqual({ area: 'company', href: '/bolaget/kapital' })
  })

  it('reads a view in the query as its own row, on that exact page only', () => {
    expect(place('/')).toEqual({ area: 'todo', href: '/' })
    expect(place('/', 'vy=gjort')).toEqual({ area: 'todo', href: '/?vy=gjort' })
    expect(place('/', 'vy=nonsense')).toEqual({ area: 'todo', href: '/' })
    expect(place('/wiki')).toEqual({ area: 'agents', href: '/wiki' })
    expect(place('/wiki', 'view=memory')).toEqual({ area: 'agents', href: '/wiki?view=memory' })
    expect(place('/wiki', 'view=map')).toEqual({ area: 'agents', href: '/wiki?view=map' })
    // An unknown view lights Kontext.
    expect(place('/wiki', 'view=nonsense')).toEqual({ area: 'agents', href: '/wiki' })
    expect(place('/wiki/party/1', 'view=map')).toEqual({ area: 'agents', href: '/wiki' })
  })

  it('keeps settings in Inställningar, except the page Agenter opens from its create button', () => {
    expect(place('/settings/company')).toEqual({ area: 'settings', href: null })
    // Koppla en agent has no row: Agenter owns the page and lights no row for it.
    expect(place('/settings/api')).toEqual({ area: 'agents', href: null })
    expect(place('/settings/api', 'ctx=byra')).toEqual({ area: 'agents', href: null })
    // The old Assistenten page only redirects into the wiki.
    expect(place('/settings/assistant')).toEqual({ area: 'settings', href: null })
    expect(place('/help')).toEqual({ area: 'settings', href: null })
    expect(place('/extensions/general')).toEqual({ area: 'settings', href: null })
    expect(place('/e/general/invoice-inbox')).toEqual({ area: 'documents', href: '/e/general/invoice-inbox' })
    expect(place('/e/other/thing')).toEqual({ area: 'settings', href: null })
  })

  it('lets a row claimed by the page win over the URL', () => {
    expect(place('/invoices/new', '', '/quotes')).toEqual({ area: 'sales', href: '/quotes' })
    // A claim that names no row changes nothing.
    expect(place('/invoices/new', '', '/nowhere')).toEqual({ area: 'sales', href: '/invoices' })
  })
})

describe('the tree', () => {
  const rows = NAV_V3_AREAS.flatMap((area) => areaItems(area).map((item) => ({ area: area.id, item })))

  it('has the rail of the port spec: four groups, then Agenter, Inställningar and Byrå at the foot', () => {
    const rail = (group: unknown) => NAV_V3_AREAS.filter((a) => a.rail === group).map((a) => a.id)
    expect(rail(0)).toEqual(['todo'])
    expect(rail(1)).toEqual(['money', 'sales', 'purchases', 'documents'])
    expect(rail(2)).toEqual(['ledger', 'tax', 'reports', 'payroll'])
    expect(rail(3)).toEqual(['company'])
    expect(rail('foot')).toEqual(['agents', 'settings', 'byra'])
  })

  it('gives each row one place', () => {
    // Under either state of the agent picture. The two rows the picture keeps
    // (Kontext, Bokföringsregler) are listed once for a company with the
    // picture and once for one without, never twice for the same company.
    for (const picture of [false, true]) {
      const hrefs = rows.filter(({ item }) => (picture ? !item.hiddenWithAgentPicture : !item.requiresAgentPicture)).map((r) => r.item.href)
      expect(hrefs.filter((href, index) => hrefs.indexOf(href) !== index), `agent picture ${picture ? 'on' : 'off'}`).toEqual([])
    }
    // A row is doubled only as such a pair, alike but for the gate.
    const hrefs = rows.map((r) => r.item.href)
    const doubled = [...new Set(hrefs.filter((href, index) => hrefs.indexOf(href) !== index))]
    expect(doubled.sort()).toEqual(['/rules', '/wiki'])
    for (const href of doubled) {
      const pair = rows.filter((r) => r.item.href === href)
      expect(pair.map((r) => r.area)).toEqual(['agents', 'agents'])
      expect(pair.map((r) => [!!r.item.requiresAgentPicture, !!r.item.hiddenWithAgentPicture])).toEqual([[true, false], [false, true]])
      expect(pair[0].item.labelKey).toBe(pair[1].item.labelKey)
      expect(pair[0].item.module).toBe(pair[1].item.module)
      expect(pair[0].item.match).toEqual(pair[1].item.match)
    }
  })

  /** Pages the v2 menu listed that the shell reaches from inside another page, and where. */
  const REACHED_INSIDE: Readonly<Record<string, string>> = {
    // The year-end pages link to the annual report; Fler rapporter lists the declarations.
    '/bookkeeping/year-end/arsredovisning': '/bookkeeping/year-end',
    '/reports/ink2-declaration': '/reports',
    '/reports/ne-declaration': '/reports',
    '/reports/ink3-declaration': '/reports',
  }

  const v2 = [...NAV_V2_TOP, ...NAV_V2_COMPANY].flatMap((section) =>
    [section, ...(section.sub ?? [])].map((item) => ({ item, parent: section })),
  )

  it('still reaches every page the v2 menu listed', () => {
    const placed = new Set(rows.map((r) => r.item.href))
    const dropped = v2.map(({ item }) => item.href).filter((href) => !placed.has(href) && !(href in REACHED_INSIDE))
    expect(dropped).toEqual([])
    for (const [href, via] of Object.entries(REACHED_INSIDE)) {
      expect(placed.has(via), `${href} is reached from ${via}`).toBe(true)
      expect(resolveNavPlace(href), href).not.toBeNull()
    }
  })

  const GATE_KEYS = [
    'module', 'requiresDimensions', 'requiresSalesOrders', 'requiresQuotes', 'requiresWebshop', 'requiresPosSales',
    'requiresMileage', 'requiresExpenses', 'requiresArkiv', 'requiresSigning', 'requiresBolagetHub', 'requiresAgents',
    'requiresInkorgV2', 'hiddenWithInkorgV2', 'requiresAutogiro', 'requiresAssistantChat', 'requiredCapability', 'entityOnly', 'byraOnly',
    'hidden', 'comingSoon', 'betaBadge', 'newBadge',
  ] as const satisfies readonly (keyof NavGateFlags)[]

  it('carries the gate flags each page had in nav-v2.ts', () => {
    const differing: string[] = []
    for (const { item, parent } of v2) {
      const now = rows.find((r) => r.item.href === item.href)?.item
      if (!now) continue
      // A v2 sub-item showed only while its section did, so it inherits the
      // section's rollout gates (Arkiv's pages behind requiresArkiv).
      const inherited = Object.fromEntries(Object.entries(parent).filter(([key, value]) => key.startsWith('requires') && value === true))
      const old: NavGateFlags = { ...inherited, ...item }
      for (const key of GATE_KEYS) {
        if (JSON.stringify(now[key]) !== JSON.stringify(old[key])) differing.push(`${item.href}: ${key}`)
      }
    }
    expect(differing).toEqual([])
  })

  it('keeps a v2 sub-item behind its section rollout gate (Arkiv)', () => {
    const arkiv = rows.filter((r) => r.item.href.startsWith('/arkiv'))
    expect(arkiv.length).toBe(3)
    expect(arkiv.every((r) => r.item.requiresArkiv)).toBe(true)
  })

  it('labels every area, row, group, create action and settings link in both languages', () => {
    const missing: string[] = []
    const check = (table: Record<string, unknown>, lang: string, namespace: string, key: string) => {
      if (typeof table[key] !== 'string') missing.push(`${lang} ${namespace}.${key}`)
    }
    for (const [lang, messages] of [['sv', sv], ['en', en]] as const) {
      const nav = messages.nav as Record<string, unknown>
      const settings = messages.settings_nav as Record<string, unknown>
      for (const area of NAV_V3_AREAS) {
        check(nav, lang, 'nav', area.labelKey)
        for (const create of area.create ?? []) check(nav, lang, 'nav', create.labelKey)
        for (const group of area.groups) {
          if (group.labelKey) check(nav, lang, 'nav', group.labelKey)
          for (const item of group.items) check(nav, lang, 'nav', item.labelKey)
        }
        for (const link of area.settings ?? []) check(settings, lang, 'settings_nav', link.labelKey)
      }
      for (const key of ['v3_more', 'v3_create', 'v3_search']) check(nav, lang, 'nav', key)
    }
    expect(missing).toEqual([])
  })

  it('uses the Swedish labels of the port spec', () => {
    const nav = sv.nav as Record<string, string>
    const labels = (id: NavAreaId) => areaItems(NAV_V3_AREAS.find((a) => a.id === id)!).map((item) => nav[item.labelKey])
    expect(NAV_V3_AREAS.map((a) => nav[a.labelKey])).toEqual([
      'Att göra', 'Pengar', 'Försäljning', 'Inköp', 'Dokument', 'Bokföring', 'Skatt', 'Rapporter', 'Löner', 'Företaget', 'Agenter', 'Inställningar', 'Byrå',
    ])
    expect(labels('todo')).toEqual(['Hem', 'Att bokföra', 'Rutin', 'Frågor', 'Gjort'])
    expect(labels('money')).toEqual(['Bankrader', 'Konton och saldo'])
    expect(labels('tax')).toEqual(['Moms', 'Skattekonto', 'Frister'])
    expect(labels('reports')).toEqual(['Resultat', 'Balans', 'Huvudbok', 'Nyckeltal', 'Budget', 'Fler rapporter'])
    expect(labels('payroll')).toEqual(['Lönekörningar', 'Anställda'])
  })

  it('gives Bokföring a create button that opens the new-voucher dialog on the list', () => {
    const ledger = NAV_V3_AREAS.find((a) => a.id === 'ledger')!
    expect(ledger.create).toMatchObject([{ href: '/bookkeeping?new', module: 'ledger' }])
    expect((sv.nav as Record<string, string>)[ledger.create![0].labelKey]).toBe('Ny verifikation')
    const gated = gateAreas(NAV_V3_AREAS, (item) => item.module !== 'ledger')
    expect(areaCreate(gated.find((a) => a.id === 'ledger')!)).toBeUndefined()
  })

  it('drops an area from the rail when every row is gated away', () => {
    const gated = gateAreas(NAV_V3_AREAS, (item) => item.module !== 'payroll')
    expect(areaItems(gated.find((a) => a.id === 'payroll')!)).toEqual([])
    expect(areaCreate(gated.find((a) => a.id === 'payroll')!)).toBeUndefined()
    expect(areaItems(gated.find((a) => a.id === 'sales')!).length).toBeGreaterThan(0)
  })

  it('gives each area the create action of the prototype, with the gates of its target', () => {
    const nav = sv.nav as Record<string, string>
    const all = gateAreas(NAV_V3_AREAS, (item) => !item.hiddenWithInkorgV2)
    const label = (id: NavAreaId) => {
      const create = areaCreate(all.find((a) => a.id === id)!)
      return create ? `${nav[create.labelKey]} ${create.action ?? create.href}` : null
    }
    expect(label('todo')).toBe('Ladda upp underlag upload-inbox')
    expect(label('money')).toBe('Ny transaktion /transactions?new')
    expect(label('sales')).toBe('Ny faktura /invoices/new')
    expect(label('purchases')).toBe('Registrera faktura /supplier-invoices/new')
    expect(label('documents')).toBe('Ladda upp upload-inbox')
    expect(label('ledger')).toBe('Ny verifikation /bookkeeping?new')
    expect(label('payroll')).toBe('Ny anställd /salary/employees?new')
    expect(label('company')).toBe('Nytt avtal /bolaget/avtal?new')
    expect(label('agents')).toBe('Koppla en agent /settings/api')
    expect(label('tax')).toBeNull()
    expect(label('reports')).toBeNull()
  })

  it('offers a viewer no create action in a company', () => {
    const offered = (role: string | null) =>
      NAV_V3_AREAS.flatMap((area) => (area.create ?? []).filter((create) => createOpenForRole(create, role)).map((create) => create.href))
    // The byrå's own create follows the byrå role; Koppla en agent stays listed as a page of Agenter
    // (the command palette, the phone menu), which is how a viewer reaches it.
    expect(offered('viewer')).toEqual(['/clients'])
    expect(areaCreatePage(NAV_V3_AREAS.find((area) => area.id === 'agents')!)?.href).toBe('/settings/api')
    for (const role of ['owner', 'admin', 'member', 'invoicer', null]) {
      expect(offered(role)).toEqual(NAV_V3_AREAS.flatMap((area) => (area.create ?? []).map((create) => create.href)))
    }
  })

  it('has the Agenter menu of the product decision 2026-11-16: Styr, Vad agenten vet, Chatt', () => {
    const agents = NAV_V3_AREAS.find((a) => a.id === 'agents')!
    const nav = sv.nav as Record<string, string>
    const enNav = en.nav as Record<string, string>
    // The menu of a company without the agent picture (the picture's own menu is the next test).
    const withoutPicture = gateAreas([agents], (item) => !item.requiresAgentPicture)[0]
    const menu = (table: Record<string, string>) =>
      withoutPicture.groups.map((g) => [g.labelKey ? table[g.labelKey] : null, g.items.map((item) => table[item.labelKey])])
    expect(menu(nav)).toEqual([
      ['Styr', ['Bokföringsregler', 'Arbetssätt']],
      ['Vad agenten vet', ['Kontext', 'Bokföringsprofil', 'Fakta', 'Minne', 'Arbetssätt']],
      [null, ['Chatt']],
    ])
    expect(menu(enNav)).toEqual([
      ['Steer', ['Bookkeeping rules', 'Ways of working']],
      ['What the agent knows', ['Context', 'Bookkeeping profile', 'Facts', 'Memory', 'Ways of working']],
      [null, ['Chat']],
    ])
    // Arbetssätt is one row at a time: the Agenter page where it is open, the wiki view elsewhere.
    const skills = areaItems(agents).filter((item) => item.labelKey === 'v3_skills')
    expect(skills.map((item) => [item.href, !!item.requiresAgents, !!item.hiddenWithAgents])).toEqual([
      ['/skills', true, false],
      ['/wiki?view=skills', false, true],
    ])
    // Instruktioner and the Koppla en agent row are gone; the create button stays with its gate.
    expect(areaItems(agents).map((item) => item.href)).not.toEqual(expect.arrayContaining(['/settings/assistant']))
    expect(areaItems(agents).map((item) => item.href)).not.toContain('/settings/api')
    expect(agents.create).toEqual([{ href: '/settings/api', module: 'agent', labelKey: 'v3_connect_agent', requiresMcpExtension: true }])
  })

  it('has, where the agent picture is on, Koppla en agent, then Kontext and Bokföringsregler with no group label, then Chatt', () => {
    const agents = NAV_V3_AREAS.find((a) => a.id === 'agents')!
    const nav = sv.nav as Record<string, string>
    const enNav = en.nav as Record<string, string>
    const withPicture = gateAreas([agents], (item) => !item.hiddenWithAgentPicture)[0]
    const menu = (table: Record<string, string>) =>
      withPicture.groups.map((g) => [g.labelKey ? table[g.labelKey] : null, g.items.map((item) => table[item.labelKey])])
    expect(menu(nav)).toEqual([
      [null, ['Kontext', 'Bokföringsregler']],
      [null, ['Chatt']],
    ])
    expect(menu(enNav)).toEqual([
      [null, ['Context', 'Bookkeeping rules']],
      [null, ['Chat']],
    ])
    expect(areaItems(withPicture).map((item) => item.href)).toEqual(['/wiki', '/rules', '/chat'])
    expect(areaCreate(withPicture)?.href).toBe('/settings/api')
    // What the picture replaces is in no row: Arbetssätt, Bokföringsprofil, Fakta, Minne and the wiki's Arbetssätt view.
    const hidden = areaItems(agents).filter((item) => item.hiddenWithAgentPicture).map((item) => item.href)
    expect(hidden).toEqual(['/rules', '/skills', '/wiki', '/wiki?view=map', '/wiki?view=facts', '/wiki?view=memory', '/wiki?view=skills'])
    // Each hidden page still resolves to the area: it is reachable by its address.
    for (const href of ['/skills', '/wiki?view=map', '/wiki?view=facts', '/wiki?view=memory', '/wiki?view=skills', '/chat', '/chat/new']) {
      const [path, query = ''] = href.split('?')
      expect(resolveNavPlace(path, query)?.area, href).toBe('agents')
    }
    // The Chatt row is one row with one gate, the chat's own switch: the picture does not hide it.
    const chat = areaItems(agents).filter((item) => item.href === '/chat')
    expect(chat.map((item) => [!!item.requiresAssistantChat, !!item.hiddenWithAgentPicture, !!item.requiresAgentPicture])).toEqual([[true, false, false]])
  })

  it('lists the page a create button opens only where the area owns it without a row', () => {
    expect(NAV_V3_AREAS.filter((area) => areaCreatePage(area)).map((area) => area.id)).toEqual(['agents'])
    // Gated like the button: no MCP extension, no entry.
    const gated = gateAreas(NAV_V3_AREAS, (item) => !item.requiresMcpExtension)
    expect(areaCreatePage(gated.find((a) => a.id === 'agents')!)).toBeUndefined()
  })

  it('uploads to the one inbox the company has, and to the archive when it has no inbox', () => {
    const upload = (passes: (item: NavGateFlags) => boolean) =>
      areaCreate(gateAreas(NAV_V3_AREAS, passes).find((a) => a.id === 'documents')!)
    expect(upload((item) => !item.hiddenWithInkorgV2)?.href).toBe('/inkorg')
    expect(upload((item) => !item.requiresInkorgV2)?.href).toBe('/e/general/invoice-inbox')
    expect(upload((item) => !item.requiredCapability)).toMatchObject({ href: '/arkiv?upload', requiresArkiv: true })
    // Att göra's upload is the inbox's alone: no inbox, no button.
    expect(areaCreate(gateAreas(NAV_V3_AREAS, (item) => !item.requiredCapability).find((a) => a.id === 'todo')!)).toBeUndefined()
    // Nytt avtal follows the Avtal row's gate.
    expect(areaCreate(gateAreas(NAV_V3_AREAS, (item) => !item.requiresCommitments).find((a) => a.id === 'company')!)).toBeUndefined()
  })

  it('has every Bolaget page as a Företaget row with the gate its tab had (lib/bolaget/hub.ts)', () => {
    const company = NAV_V3_AREAS.find((a) => a.id === 'company')!
    const nav = sv.nav as Record<string, string>
    expect(company.groups.map((g) => g.items.map((item) => nav[item.labelKey]))).toEqual([
      ['Översikt', 'Motparter'],
      ['Avtal', 'Aktiebok', 'Styrelse', 'Möten', 'Kapital', 'Ägarskatt'],
    ])
    for (const tab of BOLAGET_TABS) {
      const row = areaItems(company).find((item) => item.href === tab.href)
      expect(row, tab.href).toBeDefined()
      expect({
        hub: !!row!.requiresBolagetHub,
        registers: !!row!.requiresBolagetRegisters,
        agreements: !!row!.requiresCommitments,
      }).toEqual({ hub: tab.needs === null, registers: tab.needs === 'registers', agreements: tab.needs === 'agreements' })
    }
  })
})
