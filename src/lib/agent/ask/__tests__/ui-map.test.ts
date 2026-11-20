import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { renderAgentGroundRules } from '@/lib/agent/intents/shared-rules'
import { NAV_V3_AREAS } from '@/components/dashboard/nav-v3'

const getDashboardNavFlags = vi.fn()
vi.mock('@/lib/dashboard/nav-flags', () => ({
  getDashboardNavFlags: (...a: unknown[]) => getDashboardNavFlags(...a),
}))
const getCompanyEntitlements = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyEntitlements: (...a: unknown[]) => getCompanyEntitlements(...a),
}))

import {
  GROUND_RULE_BUTTON_KEYS,
  buildUiGrounding,
  loadNavGateContext,
  loadUiLabels,
  menuTrail,
  renderUiGrounding,
  uiLabelGlossary,
} from '../ui-map'
import { SV_LABELS, gateContext, svMenuPath } from './ui-fixture'

const nav = sv.nav as Record<string, string>
const settingsNav = sv.settings_nav as Record<string, string>

describe('renderUiGrounding: the page line', () => {
  it('names the page the user is on by its menu path (the reported Underlag case)', () => {
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS, route: '/e/general/invoice-inbox' })
    expect(out.split('\n')[0]).toBe(
      `Användaren är på sidan: ${nav.arkiv} → ${nav.v3_incoming} (/e/general/invoice-inbox).`,
    )
  })

  it('resolves a detail page to its area and row (a verifikation under Bokföring)', () => {
    expect(svMenuPath('/bookkeeping/5f0c6d0e-0000-4000-8000-000000000001')).toBe(
      `${nav.bookkeeping} → ${nav.v3_vouchers}`,
    )
  })

  it('prefers the longest match (Bokslut, not Verifikat, for the year-end wizard)', () => {
    expect(svMenuPath('/bookkeeping/year-end')).toBe(`${nav.bookkeeping} → ${nav.v2_closing}`)
  })

  it('names a view of a page by its own row (Minne is a view of the wiki)', () => {
    expect(svMenuPath('/wiki')).toBe(`${nav.v3_agents} → ${nav.v3_context}`)
    expect(svMenuPath('/pending')).toBe(`${nav.v2_todo} → ${nav.v3_routine}`)
  })

  it('names a route without a row under the row it is reached from', () => {
    expect(svMenuPath('/mileage')).toBe(`${nav.v2_purchases} → ${nav.mileage}`)
    expect(svMenuPath('/bolaget/moten')).toBe(`${nav.v3_company} → ${nav.v3_meetings}`)
    expect(svMenuPath('/reports/ink2-declaration')).toBe(
      `${nav.bookkeeping} → ${nav.v2_closing} → ${nav.income_declaration}`,
    )
    expect(svMenuPath('/bookkeeping/year-end/arsredovisning')).toBe(
      `${nav.bookkeeping} → ${nav.v2_closing} → ${nav.annual_report}`,
    )
  })

  it('names the settings page Agenter opens from its create button there, as the shell lights it', () => {
    expect(svMenuPath('/settings/api')).toBe(`${nav.v3_agents} → ${nav.v3_connect_agent}`)
  })

  it('names the Agenter rows as the menu does (product decision 2026-11-16)', () => {
    expect(svMenuPath('/rules')).toBe('Agenter → Bokföringsregler')
    expect(svMenuPath('/skills')).toBe('Agenter → Arbetssätt')
    expect(svMenuPath('/wiki?view=skills', gateContext({ agentsEnabled: false }))).toBe('Agenter → Arbetssätt')
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS, hasMcpExtension: true })
    expect(out).toContain(
      '- Agenter: Styr: Bokföringsregler (/rules), Arbetssätt (/skills); Vad agenten vet: Kontext (/wiki), Bokföringsprofil (/wiki?view=map), Minne (/wiki?view=memory); Chatt (/chat). Knappen överst i sidomenyn: Koppla en agent (/settings/api)',
    )
    expect(out).toContain('- Agenter → Koppla en agent (/settings/api): ')
    expect(out).not.toContain('/settings/assistant')
    expect(out).not.toContain('Instruktioner (')
  })

  it('names settings pages by rail group and section, and hub children under their hub', () => {
    expect(svMenuPath('/settings/fiscal-years')).toBe(
      `${nav.settings} → ${settingsNav.group_accounting} → ${settingsNav.fiscal_years}`,
    )
    expect(svMenuPath('/settings/skatteverket')).toBe(
      `${nav.settings} → ${settingsNav.group_tools} → ${settingsNav.connections} → ${settingsNav.skatteverket}`,
    )
    expect(svMenuPath('/settings/mail')).toBe(
      `${nav.settings} → ${settingsNav.group_tools} → ${settingsNav.connections} → ${settingsNav.mail}`,
    )
  })

  it('matches / only exactly', () => {
    expect(svMenuPath('/')).toBe(`${nav.v2_todo} → ${nav.home}`)
    expect(menuTrail('/no-such-page', { ctx: gateContext(), labels: SV_LABELS })).toBeNull()
  })

  it('says so when the page is not in the menu, and omits the line without a route', () => {
    const unknown = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS, route: '/no-such-page' })
    expect(unknown.split('\n')[0]).toBe('Användaren är på sidan /no-such-page, som inte finns i menyn nedan.')
    const none = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS })
    expect(none).not.toContain('Användaren är på sidan')
  })
})

describe('renderUiGrounding: the menu', () => {
  it('lists every area and row from nav-v3.ts with its sv.json label: one source, no second list', () => {
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS, hasMcpExtension: true })
    for (const area of NAV_V3_AREAS) {
      // Inställningar is listed by its sections; the byrå cockpit is above the company.
      if (area.id === 'settings' || area.id === 'byra') continue
      expect(out).toContain(`- ${nav[area.labelKey]}: `)
      for (const group of area.groups) {
        if (group.labelKey) expect(out).toContain(`${nav[group.labelKey]}: `)
        for (const item of group.items) {
          // The new Inkorg page shows only in its rollout (its own test below).
          if (item.requiresInkorgV2) continue
          // Fakta follows the Arkiv reading rollout; the wiki's Arbetssätt view yields to the Agenter page.
          if (item.requiresArkivBrain || item.hiddenWithAgents) continue
          expect(out).toContain(`${nav[item.labelKey]} (${item.href})`)
        }
      }
      // The widest menu has the new Inkorg page off, so an upload lands in the Underlag workspace.
      const create = area.create?.find((c) => !c.requiresInkorgV2)
      if (create) expect(out).toContain(`${nav[create.labelKey]} (${create.href})`)
    }
  })

  it('describes the shell as it is: an icon rail of areas, a sidebar per area', () => {
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS })
    expect(out).toContain('ikonlist längst till vänster')
    expect(out).toContain(
      `- ${nav.v2_todo}: ${nav.home} (/), ${nav.v3_needs_you} (/?vy=behover), ${nav.v3_routine} (/pending), ${nav.v3_done} (/?vy=gjort)`,
    )
    // A named group stands before its rows.
    expect(out).toContain(`${nav.v3_group_registers}: ${nav.v3_agreements} (/bolaget/avtal)`)
    // The area's quiet settings links, by the settings label.
    expect(out).toContain(`Områdets inställningar, bakom raden Inställningar under sidomenyns rader: ${settingsNav.banking} (/settings/banking)`)
    // The old menu's names are gone.
    expect(out).not.toContain(nav.v2_proposals)
    expect(out).not.toContain('Sidomenyn (huvudval')
  })

  it('lists the pages reached inside another page under the row they are reached from', () => {
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS })
    expect(out).toContain(`- ${nav.bookkeeping} → ${nav.v2_closing} → ${nav.income_declaration} (/reports/ink2-declaration)`)
    expect(out).toContain(`- ${nav.bookkeeping} → ${nav.v2_closing} → ${nav.annual_report} (/bookkeeping/year-end/arsredovisning)`)
  })

  it('hides what the sidebar hides for this company', () => {
    const out = renderUiGrounding({
      ctx: gateContext({
        entityType: 'enskild_firma',
        surface: { hidden: [], notForLegalForm: ['payroll'] },
        arkivEnabled: false,
        agentsEnabled: false,
        capabilities: [],
        hasExpenseClaims: false,
      }),
      labels: SV_LABELS,
    })
    expect(out).not.toContain('(/arkiv)')
    expect(out).not.toContain('(/skills)')
    expect(out).not.toContain('(/salary)')
    expect(out).not.toContain('(/e/general/invoice-inbox)')
    expect(out).not.toContain('(/expenses)')
    expect(out).not.toContain('(/reports/ink2-declaration)')
    expect(out).toContain('(/reports/ne-declaration)')
  })

  it('moves the inbox for a company in the new Inkorg rollout: one Inkommande row, on the new page', () => {
    const before = renderUiGrounding({ ctx: gateContext({ inkorgV2Enabled: false }), labels: SV_LABELS })
    expect(before).not.toContain('(/inkorg)')
    expect(before).toContain(`${nav.v3_incoming} (/e/general/invoice-inbox)`)

    const after = renderUiGrounding({ ctx: gateContext({ inkorgV2Enabled: true }), labels: SV_LABELS })
    expect(after).toContain(`${nav.v3_incoming} (/inkorg)`)
    expect(after).not.toContain('(/e/general/invoice-inbox)')
  })

  it('offers INK2 and the årsredovisning to an ekonomisk förening, as the sidebar does', () => {
    const out = renderUiGrounding({ ctx: gateContext({ entityType: 'ekonomisk_forening' }), labels: SV_LABELS })
    expect(out).toContain('(/reports/ink2-declaration)')
    expect(out).toContain('(/bookkeeping/year-end/arsredovisning)')
    expect(out).not.toContain('(/reports/ne-declaration)')
  })

  it('lists the settings sections with what they contain, so Periodlåsning is findable', () => {
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS, hasMcpExtension: true })
    expect(out).toContain(
      `- ${nav.settings} → ${settingsNav.group_accounting} → ${settingsNav.bookkeeping} (/settings/bookkeeping): ${settingsNav.keywords_bookkeeping}`,
    )
    expect(out).toContain(`${settingsNav.connections} (/settings/connections)`)
    expect(out).toContain('(/settings/api)')
    // Byrå-scope sections never reach a company assistant.
    expect(out).not.toContain('(/settings/team)')
    expect(out).not.toContain('(/settings/brand)')
  })

  // PH 204, #96: the assistant said there was no customer CSV import, because
  // the menu line names Importera/Exportera and nothing it takes.
  it('says what the import page takes, so a customer CSV import is findable', () => {
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS })
    expect(out).toContain(
      `Sidan ${nav.bookkeeping} → ${nav.v3_import} (/import) innehåller: ${settingsNav.keywords_import}.`,
    )
    expect(settingsNav.keywords_import).toMatch(/Importera kunder/)
    expect(settingsNav.keywords_import).toMatch(/CSV/)
  })

  // PH 216, PH 202: the assistant told a new user it did not know where to
  // add another company: the company row is not in the sidebar tree.
  it('says where another company is added: the company row, and the button on Företag', () => {
    const out = renderUiGrounding({ ctx: gateContext(), labels: SV_LABELS })
    const line = out.split('\n').find((l) => l.startsWith('Företag byts och läggs till'))
    expect(line).toContain('företagsraden överst i sidomenyn (klicka på företagsnamnet)')
    expect(line).toContain(`"${sv.company_switcher.add_company}" (/select-company?choose=1)`)
    expect(line).toContain(`${nav.settings} → ${settingsNav.group_company} → ${settingsNav.company} (/settings/company)`)
    // The settings search finds the same section by the words.
    expect(settingsNav.keywords_company).toContain(sv.company_switcher.add_company)
  })

  it('names the add-company button by the English label for an English UI', async () => {
    const en = await loadUiLabels('en')
    const out = renderUiGrounding({ ctx: gateContext(), labels: en })
    expect(out).toContain('"Add company" (/select-company?choose=1)')
  })

  it('uses the English labels for an English UI', async () => {
    const en = await loadUiLabels('en')
    const trail = menuTrail('/e/general/invoice-inbox', { ctx: gateContext(), labels: en })
    const enNav = (await import('@/messages/en.json')).default.nav as Record<string, string>
    expect(trail).toEqual([enNav.arkiv, enNav.v3_incoming])
  })
})

type Row = Record<string, unknown> | null

function supabaseReturning(tables: Record<string, Row>): SupabaseClient {
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
      }
      return chain
    },
  } as unknown as SupabaseClient
}

describe('loadNavGateContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDashboardNavFlags.mockResolvedValue({ hasWebshop: false, hasMileageTrips: true, hasExpenseClaims: false, hasPosSales: false })
    getCompanyEntitlements.mockResolvedValue({ capabilities: ['ai'] })
  })

  it('reads the same columns the layout hands the sidebar, settings before companies', async () => {
    const ctx = await loadNavGateContext(
      supabaseReturning({
        company_settings: {
          entity_type: 'enskild_firma',
          pays_salaries: true,
          dimensions_enabled: true,
          sales_orders_enabled: false,
          quotes_enabled: null,
          mileage_enabled: false,
        },
        companies: { entity_type: 'aktiebolag' },
      }),
      'company-1',
    )
    expect(ctx).toMatchObject({
      entityType: 'enskild_firma',
      // pays_salaries: true, so payroll is offered.
      surface: { hidden: [], notForLegalForm: [] },
      dimensionsEnabled: true,
      salesOrdersEnabled: false,
      quotesEnabled: true,
      hasWebshop: false,
      // Existing trips keep Körjournal visible even with the toggle off.
      hasMileage: true,
      hasExpenseClaims: false,
      hasPosSales: false,
      capabilities: ['ai'],
    })
  })

  it('falls back to companies.entity_type, and gives no context when the form is unknown', async () => {
    const fromCompanies = await loadNavGateContext(
      supabaseReturning({ company_settings: null, companies: { entity_type: 'aktiebolag' } }),
      'company-1',
    )
    expect(fromCompanies?.entityType).toBe('aktiebolag')
    expect(fromCompanies?.surface).toEqual({ hidden: [], notForLegalForm: [] })

    const unknown = await loadNavGateContext(supabaseReturning({ company_settings: null, companies: null }), 'company-1')
    expect(unknown).toBeNull()
  })

  it('lists the Assistent entry before the agent is built, as the sidebar does (crm#1135)', async () => {
    const ctx = await loadNavGateContext(
      supabaseReturning({ company_settings: { entity_type: 'aktiebolag' }, companies: null }),
      'company-1',
    )
    expect(renderUiGrounding({ ctx: ctx!, labels: SV_LABELS })).toContain('(/chat)')
  })
})

describe('buildUiGrounding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDashboardNavFlags.mockResolvedValue({ hasWebshop: false, hasMileageTrips: false, hasExpenseClaims: false, hasPosSales: false })
    getCompanyEntitlements.mockResolvedValue({ capabilities: ['ai'] })
  })

  it('renders the page and menu for the company', async () => {
    const out = await buildUiGrounding(
      supabaseReturning({ company_settings: { entity_type: 'aktiebolag' }, companies: null }),
      'company-1',
      { route: '/bookkeeping', locale: 'sv' },
    )
    expect(out).toContain(`Användaren är på sidan: ${nav.bookkeeping} → ${nav.v3_vouchers} (/bookkeeping).`)
    expect(out).toContain('Appens meny')
  })

  it('is best-effort: a failed read leaves the map out instead of failing the answer', async () => {
    getDashboardNavFlags.mockRejectedValue(new Error('PostgREST 500'))
    const out = await buildUiGrounding(
      supabaseReturning({ company_settings: { entity_type: 'aktiebolag' }, companies: null }),
      'company-1',
      { route: '/bookkeeping' },
    )
    expect(out).toBe('')
  })
})

describe('uiLabelGlossary', () => {
  const enNav = en.nav as Record<string, string>
  const svJournal = sv.journal_detail as Record<string, string>
  const enJournal = en.journal_detail as Record<string, string>

  it('pairs the sidebar labels Swedish = English, from the same messages the menu renders', async () => {
    const glossary = await uiLabelGlossary()
    expect(glossary).toContain(`${nav.v2_purchases} = ${enNav.v2_purchases}`)
    expect(glossary).toContain(`${nav.v3_incoming} = ${enNav.v3_incoming}`)
    expect(glossary).toContain(`${nav.v3_vouchers} = ${enNav.v3_vouchers}`)
    expect(glossary).toContain(`${nav.v3_agents} = ${enNav.v3_agents}`)
    expect(glossary).toContain(`${nav.v3_group_registers} = ${enNav.v3_group_registers}`)
    expect(glossary).toContain(`${nav.settings} = ${enNav.settings}`)
  })

  it('pairs the correction buttons the ground rules name, and every one is named there', async () => {
    const glossary = await uiLabelGlossary()
    const rules = renderAgentGroundRules()
    for (const key of GROUND_RULE_BUTTON_KEYS) {
      expect(glossary).toContain(`${svJournal[key]} = ${enJournal[key]}`)
      // A renamed button in either place must update the other.
      expect(rules).toContain(svJournal[key])
    }
  })

  it('leaves out labels that read the same in both languages, and never repeats one', async () => {
    const glossary = await uiLabelGlossary()
    for (const line of glossary) {
      const [s, e] = line.split(' = ')
      expect(s).not.toBe(e)
    }
    expect(new Set(glossary).size).toBe(glossary.length)
  })
})
