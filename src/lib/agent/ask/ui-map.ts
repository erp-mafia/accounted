import type { SupabaseClient } from '@supabase/supabase-js'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavV2Item } from '@/components/dashboard/nav-v2'
import { gateNavTree, type NavGateContext } from '@/lib/navigation/nav-gates'
import { offersPayroll } from '@/lib/company/offers-payroll'
import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTION_PARENT,
  settingsMessageKey,
  visibleSettingsSections,
  type SettingsSection,
} from '@/lib/navigation/settings-sections'
import { getDashboardNavFlags } from '@/lib/dashboard/nav-flags'
import { getCompanyEntitlements } from '@/lib/entitlements/has-capability'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
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

/** The nav and settings_nav labels in the locale the user's UI renders in. */
export async function loadUiLabels(locale: Locale = 'sv'): Promise<UiLabels> {
  const mod = locale === 'en' ? await import('@/messages/en.json') : await import('@/messages/sv.json')
  const messages = (mod.default ?? mod) as unknown as { nav?: MessageTable; settings_nav?: MessageTable }
  return { nav: lookup(messages.nav), settings: lookup(messages.settings_nav) }
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
  const [settingsRes, companyRes, navFlags, entitlements] = await Promise.all([
    supabase
      .from('company_settings')
      .select('entity_type, pays_salaries, dimensions_enabled, sales_orders_enabled, quotes_enabled, mileage_enabled')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase.from('companies').select('entity_type').eq('id', companyId).maybeSingle(),
    getDashboardNavFlags(supabase, companyId),
    getCompanyEntitlements(supabase, companyId),
  ])
  const settings = settingsRes.data as {
    entity_type?: string | null
    pays_salaries?: boolean | null
    dimensions_enabled?: boolean | null
    sales_orders_enabled?: boolean | null
    quotes_enabled?: boolean | null
    mileage_enabled?: boolean | null
  } | null
  const company = companyRes.data as { entity_type?: string | null } | null

  // Same resolution as the layout: company_settings first, companies second.
  const entityType = settings?.entity_type ?? company?.entity_type
  if (!isEntityType(entityType)) return null
  const paysSalaries = settings?.pays_salaries ?? false

  return {
    entityType,
    isEmployer: offersPayroll(entityType, paysSalaries),
    dimensionsEnabled: settings?.dimensions_enabled ?? false,
    salesOrdersEnabled: settings?.sales_orders_enabled ?? false,
    quotesEnabled: settings?.quotes_enabled ?? true,
    hasWebshop: navFlags.hasWebshop,
    hasMileage: (settings?.mileage_enabled ?? false) || navFlags.hasMileageTrips,
    hasExpenseClaims: navFlags.hasExpenseClaims,
    arkivEnabled: isArkivSectionEnabled(companyId),
    agentsEnabled: isAgentsPageEnabled(companyId),
    capabilities: entitlements.capabilities,
    hiddenNavHrefs: new Set(getBranding().hiddenNavHrefs),
    // The assistant only opens for a built agent (AgentTrigger and the /chat
    // layout both gate on it), so whoever is asking sees the Assistent entry.
    agentVerified: true,
  }
}

function sidebarPlaces(tree: NavV2Item[], labels: UiLabels): Place[] {
  const places: Place[] = []
  for (const section of tree) {
    const sectionLabel = labels.nav(section.labelKey)
    places.push({ href: section.href, trail: [sectionLabel] })
    for (const sub of section.sub ?? []) {
      places.push({ href: sub.href, trail: [sectionLabel, labels.nav(sub.labelKey)] })
    }
  }
  return places
}

const SETTINGS_GROUP_MESSAGE_KEY: Record<SettingsSection['group'], string> = {
  account: 'group_account',
  company: 'group_company',
  accounting: 'group_accounting',
  sales: 'group_sales',
  tools: 'group_tools',
}

function settingsTrail(s: SettingsSection, labels: UiLabels): string[] {
  return [labels.nav('settings'), labels.settings(SETTINGS_GROUP_MESSAGE_KEY[s.group]), labels.settings(settingsMessageKey(s.id))]
}

function settingsPlaces(sections: SettingsSection[], labels: UiLabels): Place[] {
  return sections.map((s) => ({ href: s.href, trail: settingsTrail(s, labels) }))
}

function matches(route: string, href: string): boolean {
  if (href === '/') return route === '/'
  return route === href || route.startsWith(`${href}/`)
}

/** The menu trail of the page at `route`: the longest matching href, the deeper trail on a tie. */
function placeForRoute(route: string, places: Place[], labels: UiLabels): string[] | null {
  const path = route.length > 1 ? route.replace(/\/+$/, '') : route

  // A settings page reached from a hub (Kopplingar → Skatteverket) has no rail
  // entry of its own: name it under its hub, as the rail highlights it.
  const settingsSegment = /^\/settings\/([^/]+)/.exec(path)?.[1]
  const hub = settingsSegment ? SETTINGS_SECTION_PARENT[settingsSegment] : undefined
  if (settingsSegment && hub) {
    const parent = places.find((p) => p.href === `/settings/${hub}`)
    if (parent) return [...parent.trail, labels.settings(settingsMessageKey(settingsSegment))]
  }

  let best: Place | null = null
  for (const place of places) {
    if (!matches(path, place.href)) continue
    if (
      !best ||
      place.href.length > best.href.length ||
      (place.href.length === best.href.length && place.trail.length > best.trail.length)
    ) {
      best = place
    }
  }
  return best ? best.trail : null
}

export interface UiMapInput {
  ctx: NavGateContext
  labels: UiLabels
  hasMcpExtension?: boolean
}

function visibleMenu({ ctx, labels, hasMcpExtension = false }: UiMapInput) {
  const tree = [...gateNavTree(NAV_V2_TOP, ctx), ...gateNavTree(NAV_V2_COMPANY, ctx)]
  // The assistant runs inside a company, never in the byrå cockpit scope.
  const sections = visibleSettingsSections({ hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension })
  const places = [...sidebarPlaces(tree, labels), ...settingsPlaces(sections, labels)]
  return { tree, sections, places }
}

/**
 * The menu trail ("Inköp → Underlag") of the page at `route` for this
 * company, or null when no visible menu entry leads there.
 */
export function menuTrail(route: string, input: UiMapInput): string[] | null {
  return placeForRoute(route, visibleMenu(input).places, input.labels)
}

export interface RenderUiGroundingInput extends UiMapInput {
  /** The pathname the user asked from, as AskConsole sends it. */
  route?: string | null
}

/** Pure: the page line plus the menu, as prompt lines. */
export function renderUiGrounding(input: RenderUiGroundingInput): string {
  const { labels, route } = input
  const { tree, sections, places } = visibleMenu(input)

  const lines: string[] = []
  if (route) {
    const trail = placeForRoute(route, places, labels)
    lines.push(
      trail
        ? `Användaren är på sidan: ${trail.join(' → ')} (${route}).`
        : `Användaren är på sidan ${route}, som inte finns i menyn nedan.`,
    )
    lines.push('')
  }

  lines.push('Appens meny för det här bolaget, exakt som användaren ser den (sökväg inom parentes):')
  lines.push('Sidomenyn (huvudval: underval som visas när huvudvalet är öppet):')
  for (const section of tree) {
    const head = `${labels.nav(section.labelKey)} (${section.href})`
    const subs = (section.sub ?? []).map((s) => `${labels.nav(s.labelKey)} (${s.href})`)
    lines.push(subs.length > 0 ? `- ${head}: ${subs.join(', ')}` : `- ${head}`)
  }
  lines.push(
    `${labels.nav('settings')} öppnas från användarmenyn längst ned i sidomenyn. Sektionerna (grupp → sektion) och vad de innehåller:`,
  )
  for (const group of SETTINGS_GROUP_ORDER) {
    for (const s of sections.filter((x) => x.group === group)) {
      const key = settingsMessageKey(s.id)
      lines.push(`- ${settingsTrail(s, labels).join(' → ')} (${s.href}): ${labels.settings(`keywords_${key}`)}`)
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
