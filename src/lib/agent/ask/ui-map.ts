import type { SupabaseClient } from '@supabase/supabase-js'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavV2Item } from '@/components/dashboard/nav-v2'
import {
  NAV_V3_AREAS,
  areaCreate,
  areaItems,
  gateAreas,
  hrefPath,
  resolveNavPlace,
  type NavV3Area,
} from '@/components/dashboard/nav-v3'
import { ADD_COMPANY_HREF } from '@/components/settings/company-deletion'
import { passesNavGates, type NavGateContext } from '@/lib/navigation/nav-gates'
import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTION_PARENT,
  settingsMessageKey,
  visibleSettingsSections,
  type SettingsSection,
} from '@/lib/navigation/settings-sections'
import { getDashboardNavFlags } from '@/lib/dashboard/nav-flags'
import { getCompanyEntitlements } from '@/lib/entitlements/has-capability'
import {
  capabilityInputsFromEntitlements,
  capabilitySurface,
  readStoredProfile,
  withOpenObligations,
  resolveCapabilities,
} from '@/lib/modules/capabilities'
import { navRollouts } from '@/lib/navigation/nav-rollouts'
import { getBranding } from '@/lib/branding/service'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { isEntityType } from '@/lib/company/entity-type'
import type { Locale } from '@/i18n/config'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.ask.ui-map')

/**
 * The app's real menu and the page the user is on, as prompt text for the
 * assistant (general.help, AskConsole).
 *
 * Without it the assistant was told to "point the user to the right page"
 * and had no idea what the pages were, so it named buttons and menus that do
 * not exist. The map is not a list written for the prompt: it is the
 * sidebar's own tree (nav-v2.ts) and the settings rail's own sections, run
 * through the same gates the sidebar uses for this company and labelled with
 * the same messages the user sees. A renamed or moved page reaches the
 * assistant with the next deploy, and a page this company does not have is
 * never offered.
 */

export interface UiLabels {
  nav: (key: string) => string
  settings: (key: string) => string
  /** The user menu's company rows (company_switcher), e.g. "Lägg till företag". */
  switcher: (key: string) => string
}

interface Place {
  href: string
  trail: string[]
}

type MessageTable = Record<string, unknown>

function lookup(table: MessageTable | undefined): (key: string) => string {
  return (key) => {
    const value = table?.[key]
    return typeof value === 'string' ? value : key
  }
}

type Messages = {
  nav?: MessageTable
  settings_nav?: MessageTable
  journal_detail?: MessageTable
  company_switcher?: MessageTable
}

async function loadMessages(locale: Locale): Promise<Messages> {
  const mod = locale === 'en' ? await import('@/messages/en.json') : await import('@/messages/sv.json')
  return (mod.default ?? mod) as unknown as Messages
}

/** The nav and settings_nav labels in the locale the user's UI renders in. */
export async function loadUiLabels(locale: Locale = 'sv'): Promise<UiLabels> {
  const messages = await loadMessages(locale)
  return {
    nav: lookup(messages.nav),
    settings: lookup(messages.settings_nav),
    switcher: lookup(messages.company_switcher),
  }
}

/**
 * The verifikation page's correction menu, which AGENT_GROUND_RULES
 * (intents/shared-rules.ts) walks through button by button.
 */
export const GROUND_RULE_BUTTON_KEYS = [
  'correct_menu',
  'strike_lines',
  'correct_metadata',
  'correct_lines',
  'correct_date',
  'reverse_action',
  'delete_entry',
  'correct_opening_balances',
] as const

/**
 * The app's labels as "Swedish = English" lines, for the intent chats.
 *
 * Those prompts name pages and buttons in Swedish ("Dokument → Inkommande",
 * "Stryk rader i verifikatet"). A user running the app in English sees other
 * words, so the English chat gets this table and names them as the user's
 * screen does instead of translating by guess. The shell's own tree and
 * messages, ungated: it translates names, it does not offer pages.
 */
export async function uiLabelGlossary(): Promise<string[]> {
  const [sv, en] = await Promise.all([loadMessages('sv'), loadMessages('en')])
  const svNav = lookup(sv.nav)
  const enNav = lookup(en.nav)
  const pairs = new Map<string, string>([[svNav('settings'), enNav('settings')]])
  for (const area of NAV_V3_AREAS) {
    pairs.set(svNav(area.labelKey), enNav(area.labelKey))
    for (const group of area.groups) {
      if (group.labelKey) pairs.set(svNav(group.labelKey), enNav(group.labelKey))
      for (const item of group.items) pairs.set(svNav(item.labelKey), enNav(item.labelKey))
    }
  }
  for (const page of INSIDE_PAGE_CATALOGUE) pairs.set(svNav(page.labelKey), enNav(page.labelKey))
  const svJournal = lookup(sv.journal_detail)
  const enJournal = lookup(en.journal_detail)
  for (const key of GROUND_RULE_BUTTON_KEYS) pairs.set(svJournal(key), enJournal(key))
  return [...pairs].filter(([s, e]) => s !== e).map(([s, e]) => `${s} = ${e}`)
}

/**
 * The sidebar's gate inputs for one company, read from the same columns the
 * dashboard layout hands DashboardNav. Null when the company's legal form
 * cannot be resolved (the gates depend on it; better no map than a wrong one).
 */
export async function loadNavGateContext(
  supabase: SupabaseClient,
  companyId: string,
): Promise<NavGateContext | null> {
  const [settingsRes, companyRes, navFlags, entitlements, storedProfile] = await Promise.all([
    supabase
      .from('company_settings')
      .select('entity_type, pays_salaries, dimensions_enabled, sales_orders_enabled, quotes_enabled, mileage_enabled')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase.from('companies').select('entity_type, jurisdiction, ledger_currency').eq('id', companyId).maybeSingle(),
    getDashboardNavFlags(supabase, companyId),
    getCompanyEntitlements(supabase, companyId),
    readStoredProfile(supabase, companyId),
  ])
  const settings = settingsRes.data as {
    entity_type?: string | null
    pays_salaries?: boolean | null
    dimensions_enabled?: boolean | null
    sales_orders_enabled?: boolean | null
    quotes_enabled?: boolean | null
    mileage_enabled?: boolean | null
  } | null
  const company = companyRes.data as {
    entity_type?: string | null
    jurisdiction?: string | null
    ledger_currency?: string | null
  } | null

  // Same resolution as the layout: company_settings first, companies second.
  const entityType = settings?.entity_type ?? company?.entity_type
  if (!isEntityType(entityType)) return null
  const paysSalaries = settings?.pays_salaries ?? false

  // The resolved capabilities, from the reads above: the same function the
  // dashboard layout hands the sidebar its surface with.
  // A package that winds down keeps its pages, as in the menu: its open
  // obligations are read only when a package is switched off.
  const inputs = capabilityInputsFromEntitlements(
    {
      jurisdiction: company?.jurisdiction,
      ledgerCurrency: company?.ledger_currency,
      entityType,
      paysSalaries,
      profileId: storedProfile?.id,
      profileVersion: storedProfile?.version,
    },
    entitlements,
  )
  const capabilities = await withOpenObligations(supabase, companyId, inputs, resolveCapabilities(inputs))

  return {
    entityType,
    surface: capabilitySurface(capabilities),
    dimensionsEnabled: settings?.dimensions_enabled ?? false,
    salesOrdersEnabled: settings?.sales_orders_enabled ?? false,
    quotesEnabled: settings?.quotes_enabled ?? true,
    hasWebshop: navFlags.hasWebshop,
    hasMileage: (settings?.mileage_enabled ?? false) || navFlags.hasMileageTrips,
    hasExpenseClaims: navFlags.hasExpenseClaims,
    hasPosSales: navFlags.hasPosSales,
    ...navRollouts(companyId),
    capabilities: entitlements.capabilities,
    hiddenNavHrefs: new Set(getBranding().hiddenNavHrefs),
  }
}

/**
 * The company areas of the shell for this company: every area but
 * Inställningar (its rows are the settings sections, listed on their own) and
 * Byrå (the assistant runs inside a company, never in the byrå cockpit),
 * gated row by row; an area with no row left is not on the rail.
 */
function companyAreas(ctx: NavGateContext): NavV3Area[] {
  return gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, ctx)).filter(
    (area) => area.id !== 'settings' && area.id !== 'byra' && areaItems(area).length > 0,
  )
}

/**
 * Pages that are reached from inside another page and have no row in the
 * new menu (the income declarations and the årsredovisning under Bokslut,
 * the Bolaget overview). The old tree (nav-v2.ts) still carries them with
 * their gates and labels, so it is read as the catalogue: an entry whose
 * route is a row of the new tree is left out.
 */
const V3_ROW_HREFS = new Set(NAV_V3_AREAS.flatMap((area) => areaItems(area).map((item) => item.href)))
const INSIDE_PAGE_CATALOGUE: NavV2Item[] = [...NAV_V2_TOP, ...NAV_V2_COMPANY]
  .flatMap((section) => [section, ...(section.sub ?? [])])
  .filter((item) => !V3_ROW_HREFS.has(item.href))

function navLabel(labels: UiLabels, labelKey: string): string {
  return labels.nav(labelKey)
}

/** The area and row a path sits under in the gated tree, as labels. */
function areaTrail(pathname: string, search: string, areas: NavV3Area[], labels: UiLabels): string[] | null {
  const place = resolveNavPlace(pathname, search, null, areas)
  if (!place) return null
  const area = areas.find((a) => a.id === place.area)
  if (!area) return null
  const row = place.href ? areaItems(area).find((item) => item.href === place.href) : undefined
  return row ? [navLabel(labels, area.labelKey), navLabel(labels, row.labelKey)] : [navLabel(labels, area.labelKey)]
}

function insidePages(areas: NavV3Area[], ctx: NavGateContext, labels: UiLabels): Place[] {
  const places: Place[] = []
  for (const page of INSIDE_PAGE_CATALOGUE) {
    if (!passesNavGates(page, ctx)) continue
    const parent = areaTrail(hrefPath(page.href), '', areas, labels)
    if (!parent) continue
    const label = navLabel(labels, page.labelKey)
    places.push({ href: page.href, trail: parent[parent.length - 1] === label ? parent : [...parent, label] })
  }
  return places
}

const SETTINGS_GROUP_MESSAGE_KEY: Record<SettingsSection['group'], string> = {
  account: 'group_account',
  company: 'group_company',
  accounting: 'group_accounting',
  sales: 'group_sales',
  tools: 'group_tools',
  byra: 'group_byra',
}

function settingsTrail(s: SettingsSection, labels: UiLabels): string[] {
  return [labels.nav('settings'), labels.settings(SETTINGS_GROUP_MESSAGE_KEY[s.group]), labels.settings(settingsMessageKey(s.id))]
}

/** A settings page reached from a hub (Bank under Kopplingar) is offered when its hub is. */
function isHubChild(href: string, sectionHrefs: ReadonlySet<string>): boolean {
  const segment = /^\/settings\/([^/?#]+)/.exec(href)?.[1]
  const hub = segment ? SETTINGS_SECTION_PARENT[segment] : undefined
  return !!hub && sectionHrefs.has(`/settings/${hub}`)
}

function settingsPlaces(sections: SettingsSection[], labels: UiLabels): Place[] {
  return sections.map((s) => ({ href: s.href, trail: settingsTrail(s, labels) }))
}

/** The menu trail of the page at `route`: the area and row the shell lights for it, or its settings section. */
function placeForRoute(route: string, menu: VisibleMenu, labels: UiLabels): string[] | null {
  const [rawPath, search = ''] = route.split('#')[0].split('?')
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath

  // The longest match over the whole tree decides, as in the shell: a
  // settings route that is a row of an area (Agenter's Instruktioner) is
  // named there, every other settings route by its section below.
  const place = resolveNavPlace(path, search)

  // A page inside another page (the income declaration under Bokslut) is
  // named with its own label after the row it is reached from, unless a row
  // of its own covers more of the path (Avtal under the Bolaget overview).
  const inside = menu.inside
    .filter((p) => path === p.href || path.startsWith(`${p.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]
  const row = place?.href
    ? NAV_V3_AREAS.flatMap(areaItems).find((item) => item.href === place.href)
    : undefined
  const rowCover = Math.max(
    0,
    ...(row ? [hrefPath(row.href), ...(row.match ?? [])] : [])
      .filter((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      .map((prefix) => prefix.length),
  )
  if (inside && rowCover <= inside.href.length) return inside.trail

  const inArea = place && place.area !== 'settings' ? areaTrail(path, search, menu.areas, labels) : null
  if (inArea) return inArea

  // A settings page reached from a hub (Kopplingar → Skatteverket) has no
  // section of its own: name it under its hub, as the sidebar lights it.
  const settingsSegment = /^\/settings\/([^/]+)/.exec(path)?.[1]
  const hub = settingsSegment ? SETTINGS_SECTION_PARENT[settingsSegment] : undefined
  if (settingsSegment && hub) {
    const parent = menu.settingsPlaces.find((p) => p.href === `/settings/${hub}`)
    if (parent) return [...parent.trail, labels.settings(settingsMessageKey(settingsSegment))]
  }
  const section = menu.settingsPlaces
    .filter((p) => path === p.href || path.startsWith(`${p.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]
  return section ? section.trail : null
}

export interface UiMapInput {
  ctx: NavGateContext
  labels: UiLabels
  hasMcpExtension?: boolean
}

interface VisibleMenu {
  areas: NavV3Area[]
  sections: SettingsSection[]
  settingsPlaces: Place[]
  inside: Place[]
}

function visibleMenu({ ctx, labels, hasMcpExtension = false }: UiMapInput): VisibleMenu {
  // The row "Koppla en agent" follows the same switch as its settings section.
  const gateCtx: NavGateContext = { ...ctx, mcpExtensionEnabled: ctx.mcpExtensionEnabled ?? hasMcpExtension }
  const areas = companyAreas(gateCtx)
  // The assistant runs inside a company, never in the byrå cockpit scope.
  const sections = visibleSettingsSections({ hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension })
  return { areas, sections, settingsPlaces: settingsPlaces(sections, labels), inside: insidePages(areas, gateCtx, labels) }
}

/**
 * The menu trail ("Dokument → Inkommande") of the page at `route` for this
 * company, or null when no visible menu entry leads there.
 */
export function menuTrail(route: string, input: UiMapInput): string[] | null {
  return placeForRoute(route, visibleMenu(input), input.labels)
}

/** Menu pages whose contents the settings search describes (settings_nav keywords_*). */
const SIDEBAR_PAGE_KEYWORDS: ReadonlyArray<{ href: string; keywordsKey: string }> = [
  { href: '/import', keywordsKey: 'keywords_import' },
]

export interface RenderUiGroundingInput extends UiMapInput {
  /** The pathname the user asked from, as AskConsole sends it. */
  route?: string | null
}

/** Pure: the page line plus the menu, as prompt lines. */
export function renderUiGrounding(input: RenderUiGroundingInput): string {
  const { labels, route } = input
  const menu = visibleMenu(input)
  const { areas, sections } = menu
  const sectionHrefs = new Set(sections.map((s) => s.href))

  const lines: string[] = []
  if (route) {
    const trail = placeForRoute(route, menu, labels)
    lines.push(
      trail
        ? `Användaren är på sidan: ${trail.join(' → ')} (${route}).`
        : `Användaren är på sidan ${route}, som inte finns i menyn nedan.`,
    )
    lines.push('')
  }

  lines.push('Appens meny för det här bolaget, exakt som användaren ser den (sökväg inom parentes):')
  lines.push(
    'Menyn har två delar: en smal ikonlist längst till vänster med ett område per ikon, och bredvid den områdets egen sidomeny med dess rader. Områdena och deras rader (område: rader; en namngiven grupp i sidomenyn står före sina rader):',
  )
  for (const area of areas) {
    const groups = area.groups.map((group) => {
      const rows = group.items.map((item) => `${labels.nav(item.labelKey)} (${item.href})`).join(', ')
      return group.labelKey ? `${labels.nav(group.labelKey)}: ${rows}` : rows
    })
    let line = `- ${labels.nav(area.labelKey)}: ${groups.join('; ')}`
    const create = areaCreate(area)
    if (create) line += `. Knappen överst i sidomenyn: ${labels.nav(create.labelKey)} (${create.href})`
    const links = (area.settings ?? []).filter((link) => sectionHrefs.has(hrefPath(link.href)) || isHubChild(link.href, sectionHrefs))
    if (links.length > 0) {
      line += `. Områdets inställningar, bakom raden Inställningar under sidomenyns rader: ${links.map((l) => `${labels.settings(l.labelKey)} (${l.href})`).join(', ')}`
    }
    lines.push(line)
  }
  if (menu.inside.length > 0) {
    lines.push('Sidor som nås inifrån en annan sida och inte har en egen rad i menyn:')
    for (const page of menu.inside) lines.push(`- ${page.trail.join(' → ')} (${page.href})`)
  }
  // The menu names a page, not what it takes: told only the page's name,
  // the assistant said there was no customer CSV import (PH 204, #96). These
  // are the pages the settings search links to (useSettingsNavItems), with
  // the same keywords it searches.
  for (const { href, keywordsKey } of SIDEBAR_PAGE_KEYWORDS) {
    const trail = areaTrail(href, '', areas, labels)
    const listed = areas.some((area) => areaItems(area).some((item) => item.href === href))
    if (trail && listed) lines.push(`Sidan ${trail.join(' → ')} (${href}) innehåller: ${labels.settings(keywordsKey)}.`)
  }
  // The user menu is not in the sidebar tree, so the assistant could not say
  // where another company is added and told a new user it did not know
  // (PH 216, PH 202). Same labels and door as the menu (UserMenu).
  const companySettings = menu.settingsPlaces.find((p) => p.href === '/settings/company')
  lines.push(
    `Företag byts och läggs till i företagsraden överst i sidomenyn (klicka på företagsnamnet): välj ett företag i listan för att byta; "${labels.switcher('add_company')}" (${ADD_COMPANY_HREF}) ligger sist i samma lista. På mobilen: öppna menyn och tryck på företaget överst. Användarmenyn längst ned i sidomenyn (klicka på ditt namn) har ditt konto, hjälp, support och Logga ut.`
      + (companySettings ? ` "${labels.switcher('add_company')}" finns också som knapp överst på ${companySettings.trail.join(' → ')} (${companySettings.href}).` : ''),
  )
  lines.push(
    `${labels.nav('settings')} är ett eget område längst ned i ikonlisten (kugghjulet); dess sidomeny visar sektionerna i grupper. Sektionerna (grupp → sektion) och vad de innehåller:`,
  )
  for (const group of SETTINGS_GROUP_ORDER) {
    for (const s of sections.filter((x) => x.group === group)) {
      const key = settingsMessageKey(s.id)
      // A section the shell files under an area (Koppla en agent) is named there.
      const trail = placeForRoute(s.href, menu, labels) ?? settingsTrail(s, labels)
      lines.push(`- ${trail.join(' → ')} (${s.href}): ${labels.settings(`keywords_${key}`)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Load and render the grounding for one company. Best-effort: a failed read
 * leaves the map out (the system prompt then tells the model to say it does
 * not know where something is) rather than failing the answer.
 */
export async function buildUiGrounding(
  supabase: SupabaseClient,
  companyId: string,
  opts: { route?: string | null; locale?: Locale } = {},
): Promise<string> {
  try {
    const [ctx, labels] = await Promise.all([loadNavGateContext(supabase, companyId), loadUiLabels(opts.locale)])
    if (!ctx) return ''
    return renderUiGrounding({
      ctx,
      labels,
      route: opts.route,
      hasMcpExtension: ENABLED_EXTENSION_IDS.has('mcp-server'),
    })
  } catch (err) {
    log.warn('ui grounding unavailable', { companyId, error: err instanceof Error ? err.message : String(err) })
    return ''
  }
}
