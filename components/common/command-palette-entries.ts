import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Brain,
  Briefcase,
  CalendarClock,
  CalendarRange,
  Car,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  Download,
  FileCheck,
  FileSpreadsheet,
  FileText,
  HandCoins,
  Handshake,
  HelpCircle,
  Home,
  Inbox,
  Landmark,
  ListTree,
  Package,
  Percent,
  Puzzle,
  Receipt,
  ReceiptText,
  Repeat,
  Scale,
  ScrollText,
  Send,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Tags,
  TrendingUp,
  Truck,
  Upload,
  Users,
  Wallet,
} from 'lucide-react'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavV2Item } from '@/components/dashboard/nav-v2'
import {
  isNavHrefEnabled,
  passesNavGates,
  type NavGateContext,
} from '@/components/dashboard/nav-gates'
import type { NavGateFlags } from '@/components/dashboard/nav-v2'
import {
  CATEGORY_LABEL_KEY,
  REPORT_CATALOG,
  foldSearchText,
  isReportVisible,
  reportMatchesQuery,
} from '@/lib/reports/catalog'
import type { DashboardShell } from '@/types'

/**
 * What the command palette (⌘K / Ctrl+K) can jump to, and how it searches.
 *
 * Nothing here is hand-listed twice: pages come from the shell v2 nav tree
 * (nav-v2.ts) through the same gates the sidebar applies (nav-gates.ts),
 * reports from REPORT_CATALOG, settings sections from useSettingsNavItems.
 * Adding a nav row, a report or a settings section adds it to ⌘K. The only
 * palette-owned lists are the actions (deep links that open a "new" dialog),
 * a handful of routes deliberately kept off the sidebar, and the search
 * vocabulary (Swedish and English synonyms, never displayed).
 *
 * Pure module, no React: the component builds a context from hooks and
 * calls buildPaletteEntries(); the tests build the context by hand.
 */

export type PaletteSection = 'actions' | 'pages' | 'reports' | 'settings'

export interface PaletteEntry {
  id: string
  section: PaletteSection
  label: string
  /** Secondary text on the right: parent section, report category, or a shortcut. */
  hint?: string
  icon: LucideIcon
  href: string
  /**
   * Other names for the same place (the sidebar section that shares the
   * href, a report that lives on this page). Searched like the label.
   */
  aliases?: string[]
  /** Extra search vocabulary, lowercase, never shown. */
  keywords: string
  /** A sidebar section head: what the empty palette lists. */
  primary?: boolean
}

export interface PaletteLabels {
  /** `nav` namespace: sidebar labels. */
  nav: (key: string) => string
  /** `reports` namespace: report names and category labels. */
  reports: (key: string) => string
  /** `command_palette` namespace: actions and hints. */
  palette: (key: string) => string
}

export interface PaletteContext {
  gates: NavGateContext
  hasCompany: boolean
  /** Byrå team member: the Klienter cockpit is a destination. */
  isByraMember: boolean
  shell: DashboardShell
  /** Visible settings sections (useSettingsNavItems: already gated). */
  settingsSections: ReadonlyArray<{ id: string; href: string; label: string }>
  /** Platform chord for the settings entry hint (⌘, or Ctrl ,). */
  settingsShortcut: string
  labels: PaletteLabels
}

/**
 * Search vocabulary per destination: the words a user brings from the task
 * ("boka", "stäm av"), from another product (Fortnox, Bokio), or in English.
 * Report-specific vocabulary lives in ReportDescriptor.searchTerms instead,
 * see DECISIONS 2026-07-30.
 */
const KEYWORDS: Readonly<Record<string, string>> = {
  '/': 'hem home start översikt dashboard att göra todo',
  '/pending': 'granskning review pending väntande förslag proposals agent',
  '/chat': 'assistent assistant chatt chat fråga ask ai',
  '/agent-knowledge': 'agent kunskap knowledge minne memory',
  '/accounts': 'konton accounts bank bankkonto kassa saldo balance',
  '/reconciliation':
    'avstämning stäm av stämma av bankavstämning bank skattekonto matcha reconcile reconciliation 1630 1930',
  '/transactions': 'transaktioner transaktion bank bokför boka kategorisera categorize transactions',
  '/parties': 'motparter motpart parties counterparties leverantörer kunder',
  '/invoices': 'fakturor faktura fakturering kundfaktura invoices invoice försäljning',
  '/sales-orders': 'kundorder order sales orders offert',
  '/orders': 'webshop order woocommerce shopify',
  '/customers': 'kunder kund customers customer register',
  '/articles': 'artiklar artikel articles produkter products tjänster',
  '/supplier-invoices':
    'leverantörsfakturor leverantörsfaktura inköp purchases supplier invoices bills',
  '/e/general/invoice-inbox':
    'underlag dokument kvitton receipts documents inbox dokumentinkorg ladda upp upload',
  '/expenses': 'utlägg expenses kvitto privat betalat reimbursement',
  '/mileage': 'körjournal milersättning mileage bil resor',
  '/supplier-invoices/payment-files':
    'betalfiler betalfil payment files bankgiro pain.001 betalning',
  '/suppliers': 'leverantörer leverantör suppliers supplier register',
  '/bookkeeping': 'bokföring verifikationer verifikat journal ledger vouchers',
  '/chart-of-accounts': 'kontoplan konton bas chart of accounts konto',
  '/bookkeeping/periodiseringar':
    'periodiseringar periodisering accruals förutbetald upplupen',
  '/assets': 'anläggningstillgångar tillgångar assets avskrivning inventarier',
  '/dimensions': 'kostnadsställen projekt dimensioner dimensions cost centres',
  '/import': 'importera exportera import export sie fortnox visma bokio bank fil',
  '/salary': 'löner lön lönekörning payroll salary',
  '/salary/employees': 'anställda anställd employees employee personal',
  '/reports/vat-declaration': 'moms momsdeklaration vat declaration skatt',
  '/deadlines': 'viktiga datum deadlines kalender calendar skatt förfallodatum',
  '/reports': 'rapporter rapport reports report resultat balans',
  '/kpi': 'nyckeltal kpi key figures',
  '/bookkeeping/year-end': 'bokslut årsbokslut year end closing',
  '/bookkeeping/year-end/arsredovisning': 'årsredovisning annual report bolagsverket',
  '/reports/ink2-declaration': 'inkomstdeklaration ink2 income tax return deklaration',
  '/reports/ne-declaration': 'inkomstdeklaration ne-bilaga ne income tax return deklaration',
  '/rules': 'regler rules automatisk kontering',
  '/skattekonto': 'skattekonto skatteverket tax account 1630',
  '/invoices/recurring': 'återkommande fakturor recurring invoices abonnemang',
  '/invoices/rot-rut': 'rot rut avdrag skatteverket husarbete',
  '/extensions': 'tillägg extensions integrationer plugins',
  '/help': 'hjälp help support guide',
  '/settings': 'inställningar settings',
  '/clients': 'klienter clients byrå',
}

const ICONS: Readonly<Record<string, LucideIcon>> = {
  '/': CheckSquare,
  '/pending': ClipboardCheck,
  '/chat': Sparkles,
  '/agent-knowledge': Brain,
  '/accounts': Landmark,
  '/reconciliation': Scale,
  '/transactions': ArrowLeftRight,
  '/parties': Handshake,
  '/invoices': ReceiptText,
  '/sales-orders': ClipboardList,
  '/orders': ShoppingCart,
  '/customers': Users,
  '/articles': Tag,
  '/supplier-invoices': Wallet,
  '/e/general/invoice-inbox': Inbox,
  '/expenses': Receipt,
  '/mileage': Car,
  '/supplier-invoices/payment-files': Send,
  '/suppliers': Truck,
  '/bookkeeping': BookOpen,
  '/chart-of-accounts': ListTree,
  '/bookkeeping/periodiseringar': CalendarRange,
  '/assets': Package,
  '/dimensions': Tags,
  '/import': Upload,
  '/salary': HandCoins,
  '/salary/employees': Users,
  '/reports/vat-declaration': Percent,
  '/deadlines': CalendarClock,
  '/reports': BarChart3,
  '/kpi': TrendingUp,
  '/bookkeeping/year-end': FileCheck,
  '/bookkeeping/year-end/arsredovisning': ScrollText,
  '/reports/ink2-declaration': FileSpreadsheet,
  '/reports/ne-declaration': FileSpreadsheet,
  '/rules': SlidersHorizontal,
  '/skattekonto': Landmark,
  '/invoices/recurring': Repeat,
  '/invoices/rot-rut': Percent,
  '/extensions': Puzzle,
  '/help': HelpCircle,
  '/settings': Settings,
  '/clients': Briefcase,
}

const REPORT_ICONS: Readonly<Record<string, LucideIcon>> = {
  ledgers: BookOpen,
  tax_vat: Percent,
  export: Download,
}

/**
 * Routes that exist but stay off the sidebar on purpose, reachable by
 * searching for them. `parent` names the sidebar section they belong under
 * (the hint on the row). Regler is off the nav until there is a rules engine
 * worth a page (founder call 2026-09-07); the route exists for the ones who
 * need it, and typing "regler" is how they get there.
 */
interface ExtraPage {
  href: string
  labelKey: string
  namespace: 'nav' | 'palette'
  parent?: string
  gate?: Omit<NavGateFlags, 'href'>
}

const EXTRA_PAGES: readonly ExtraPage[] = [
  { href: '/invoices/recurring', labelKey: 'v2_recurring', namespace: 'nav', parent: '/invoices' },
  { href: '/invoices/rot-rut', labelKey: 'page_rot_rut', namespace: 'palette', parent: '/invoices' },
  { href: '/skattekonto', labelKey: 'skattekonto', namespace: 'nav', parent: '/reports/vat-declaration' },
  { href: '/rules', labelKey: 'v2_rules', namespace: 'nav', parent: '/transactions' },
  { href: '/extensions', labelKey: 'extensions', namespace: 'nav' },
  { href: '/help', labelKey: 'help', namespace: 'nav' },
  { href: '/settings', labelKey: 'settings', namespace: 'nav' },
]

/**
 * Deep links that land on an open "new" dialog. Every href here is a page
 * that reads ?new=1 (or the plain list for booking). The gate is the page's
 * own nav gate, so "Ny anställd" hides with Löner.
 */
interface PaletteAction {
  id: string
  labelKey: string
  href: string
  icon: LucideIcon
  keywords: string
  gate?: Omit<NavGateFlags, 'href'>
}

const ACTIONS: readonly PaletteAction[] = [
  {
    id: 'new-invoice',
    labelKey: 'action_new_invoice',
    href: '/invoices?new=1',
    icon: ReceiptText,
    keywords: 'ny faktura kundfaktura skapa fakturera skicka new invoice create send',
  },
  {
    id: 'new-supplier-invoice',
    labelKey: 'action_new_supplier_invoice',
    href: '/supplier-invoices?new=1',
    icon: Wallet,
    keywords: 'ny leverantörsfaktura registrera inköp new supplier invoice bill',
  },
  {
    id: 'new-voucher',
    labelKey: 'action_new_voucher',
    href: '/bookkeeping?new=1',
    icon: BookOpen,
    keywords: 'ny verifikation verifikat manuell bokföring new journal entry voucher',
  },
  {
    id: 'book-transactions',
    labelKey: 'action_book_transactions',
    href: '/transactions',
    icon: ArrowLeftRight,
    keywords: 'boka bokför transaktion kategorisera bank book categorize transactions',
  },
  {
    id: 'new-customer',
    labelKey: 'action_new_customer',
    href: '/customers?new=1',
    icon: Users,
    keywords: 'ny kund lägg till kund new customer add',
  },
  {
    id: 'new-employee',
    labelKey: 'action_new_employee',
    href: '/salary/employees?new=1',
    icon: Users,
    keywords: 'ny anställd lägg till anställd new employee add',
    gate: { employerOnly: true },
  },
  {
    id: 'import-sie',
    labelKey: 'action_import_sie',
    href: '/import',
    icon: Upload,
    keywords: 'importera sie fil flytta från fortnox visma bokio import',
  },
]

function basePath(href: string): string {
  return href.split(/[?#]/)[0]
}

/**
 * Section heads whose same-href sub-item carries a label that reads badly
 * alone in a flat list: "Översikt" says nothing without "Konton" above it,
 * and "Löner" is the word people search for, not "Lönekörningar". The other
 * shared hrefs keep the sub-item's more specific label (Kundfakturor over
 * Fakturering, Verifikationer over Bokföring); the losing label stays as
 * vocabulary either way.
 */
const PREFER_SECTION_LABEL: ReadonlySet<string> = new Set(['/accounts', '/salary'])

function iconFor(href: string, fallback: LucideIcon): LucideIcon {
  return ICONS[href] ?? fallback
}

function keywordsFor(href: string): string {
  return KEYWORDS[href] ?? ''
}

interface PageDraft {
  href: string
  label: string
  hint?: string
  icon: LucideIcon
  aliases: string[]
  keywords: string[]
  primary: boolean
}

function addAlias(draft: PageDraft, name: string) {
  if (name !== draft.label && !draft.aliases.includes(name)) draft.aliases.push(name)
}

/**
 * Flattens the v2 tree into one entry per href, in sidebar order. A section
 * head that shares its href with a sub-item ("Fakturering" > "Kundfakturor",
 * both /invoices) becomes one row: the preferred label, the other name as an
 * alias that searches like a label, so typing either finds it.
 */
function pagesFromNavTree(ctx: PaletteContext): PageDraft[] {
  const { nav } = ctx.labels
  const byHref = new Map<string, PageDraft>()
  const homeIcon = ctx.shell === 'v2' ? CheckSquare : Home
  const sections: NavV2Item[] = [...NAV_V2_TOP, ...NAV_V2_COMPANY]

  const add = (
    item: NavV2Item,
    label: string,
    parent: { label: string; icon?: LucideIcon } | null,
    primary: boolean,
  ) => {
    const existing = byHref.get(item.href)
    if (existing) {
      const preferIncoming = primary === PREFER_SECTION_LABEL.has(item.href)
      if (preferIncoming && existing.label !== label) {
        const previous = existing.label
        existing.label = label
        addAlias(existing, previous)
      } else {
        addAlias(existing, label)
      }
      if (primary) existing.primary = true
      return
    }
    byHref.set(item.href, {
      href: item.href,
      label,
      hint: parent?.label,
      icon: item.href === '/' ? homeIcon : iconFor(item.href, item.icon ?? parent?.icon ?? FileText),
      aliases: [],
      keywords: [keywordsFor(item.href)],
      primary,
    })
  }

  for (const section of sections) {
    if (!passesNavGates(section, ctx.gates)) continue
    // The phone bar and the v1 rail name the start page "Hem"; v2 says
    // "Att göra". The palette follows the shell the user is looking at.
    const sectionLabel =
      section.href === '/' ? nav(ctx.shell === 'v2' ? 'v2_todo' : 'home') : nav(section.labelKey)
    add(section, sectionLabel, null, true)
    for (const sub of section.sub ?? []) {
      if (!passesNavGates(sub, ctx.gates)) continue
      add(sub, nav(sub.labelKey), { label: sectionLabel, icon: section.icon }, false)
    }
  }
  const home = byHref.get('/')
  if (home) {
    addAlias(home, nav('home'))
    addAlias(home, nav('v2_todo'))
  }
  return [...byHref.values()]
}

function extraPages(ctx: PaletteContext, known: Map<string, PageDraft>): PageDraft[] {
  const { nav, palette } = ctx.labels
  const out: PageDraft[] = []
  for (const page of EXTRA_PAGES) {
    if (known.has(page.href)) continue
    if (!passesNavGates({ href: page.href, ...page.gate }, ctx.gates)) continue
    const parent = page.parent ? known.get(page.parent) : undefined
    out.push({
      href: page.href,
      label: page.namespace === 'nav' ? nav(page.labelKey) : palette(page.labelKey),
      hint: page.href === '/settings' ? ctx.settingsShortcut : parent?.label,
      icon: iconFor(page.href, FileText),
      aliases: [],
      keywords: [keywordsFor(page.href)],
      primary: false,
    })
  }
  if (ctx.isByraMember && !known.has('/clients')) {
    out.push({
      href: '/clients',
      label: nav('clients'),
      icon: iconFor('/clients', Briefcase),
      aliases: [],
      keywords: [keywordsFor('/clients')],
      primary: false,
    })
  }
  return out
}

/**
 * One entry per visible report. A report whose destination is already a
 * page (Moms, Nyckeltal, Årsbokslut, Bankavstämning) becomes an alias of
 * that page instead of a second row to the same place: "momsdeklaration"
 * then finds the Moms row. The slug is vocabulary too: it is the Swedish
 * name (huvudbok, balansrapport) even when the UI is in English.
 */
function reportEntries(ctx: PaletteContext, pages: Map<string, PageDraft>): PaletteEntry[] {
  const { reports, palette } = ctx.labels
  const out: PaletteEntry[] = []
  for (const r of REPORT_CATALOG) {
    if (!isReportVisible(r, ctx.gates.entityType, ctx.gates.isEmployer, ctx.gates.dimensionsEnabled)) continue
    const href = r.route ?? `/reports/${r.slug}`
    const label = reports(r.labelKey)
    const vocabulary = [palette('hint_report'), r.slug.replace(/-/g, ' '), r.searchTerms ?? ''].join(' ')
    const page = pages.get(href)
    if (page) {
      addAlias(page, label)
      page.keywords.push(vocabulary)
      continue
    }
    out.push({
      id: `report-${r.slug}`,
      section: 'reports',
      label,
      hint: reports(CATEGORY_LABEL_KEY[r.category]),
      icon: REPORT_ICONS[r.category] ?? BarChart3,
      href,
      keywords: vocabulary.toLowerCase(),
    })
  }
  return out
}

function actionEntries(ctx: PaletteContext): PaletteEntry[] {
  const { palette } = ctx.labels
  return ACTIONS.filter((a) => passesNavGates({ href: basePath(a.href), ...a.gate }, ctx.gates)).map(
    (a) => ({
      id: `action-${a.id}`,
      section: 'actions' as const,
      label: palette(a.labelKey),
      icon: a.icon,
      href: a.href,
      keywords: a.keywords,
    }),
  )
}

function settingsEntries(ctx: PaletteContext): PaletteEntry[] {
  const { palette } = ctx.labels
  const hint = palette('hint_settings')
  return ctx.settingsSections.map((s) => ({
    id: `settings-${s.id}`,
    section: 'settings' as const,
    label: s.label,
    hint,
    icon: Settings,
    href: s.href,
    keywords: `${hint} ${keywordsFor('/settings')} ${s.label}`.toLowerCase(),
  }))
}

/** Every destination the palette offers, in section order, gated and deduplicated. */
export function buildPaletteEntries(ctx: PaletteContext): PaletteEntry[] {
  const navPages = pagesFromNavTree(ctx)
  const known = new Map(navPages.map((p) => [p.href, p]))
  const pages = [...navPages, ...extraPages(ctx, known)]
  for (const p of pages) known.set(p.href, p)
  const reports = reportEntries(ctx, known)

  const pageEntries: PaletteEntry[] = pages.map((p) => ({
    id: `page-${p.href}`,
    section: 'pages',
    label: p.label,
    hint: p.hint,
    icon: p.icon,
    href: p.href,
    aliases: p.aliases,
    keywords: p.keywords.join(' ').toLowerCase(),
    primary: p.primary,
  }))

  return [...actionEntries(ctx), ...pageEntries, ...reports, ...settingsEntries(ctx)].filter((e) =>
    isNavHrefEnabled(e.href, ctx.hasCompany),
  )
}

export interface PaletteResultGroup {
  section: PaletteSection
  entries: PaletteEntry[]
}

const SECTION_ORDER: readonly PaletteSection[] = ['actions', 'pages', 'reports', 'settings']

/**
 * How well an entry answers the query: 0 = no match (token-AND over names,
 * hint and vocabulary, diacritic-insensitive like the report library), then
 * a name (label or alias) equal to the query > name prefix > name substring
 * > vocabulary only. "ny kund" is then Ny kund, not Ny kundfaktura.
 */
function score(entry: PaletteEntry, query: string): number {
  const names = [entry.label, ...(entry.aliases ?? [])]
  const haystack = [...names, entry.hint ?? '', entry.keywords].join(' ')
  if (!reportMatchesQuery(haystack, query)) return 0
  const q = foldSearchText(query)
  let best = 1
  for (const name of names) {
    const n = foldSearchText(name)
    if (n === q) return 4
    if (n.startsWith(q)) best = Math.max(best, 3)
    else if (n.includes(q)) best = Math.max(best, 2)
  }
  return best
}

/**
 * The palette's result list. Empty query: the actions and the sidebar's
 * section heads, the same map the user sees on the left. Otherwise every
 * matching entry, ranked inside its section, and the sections themselves
 * ordered by their best hit so the auto-selected first row is the strongest
 * answer (typing "resultat" selects Resultatrapport, not Rapporter).
 * Ties keep the section order, so "stäm av" still lands on Avstämning
 * (the page) ahead of Huvudbok, whose searchTerms also carry the phrase
 * (DECISIONS 2026-07-30).
 */
export function groupPaletteResults(entries: PaletteEntry[], query: string): PaletteResultGroup[] {
  const q = query.trim()
  if (!q) {
    return SECTION_ORDER.map((section) => ({
      section,
      entries: entries.filter(
        (e) => e.section === section && (section === 'actions' || e.primary === true),
      ),
    })).filter((g) => g.entries.length > 0)
  }
  const groups = SECTION_ORDER.map((section, order) => {
    const scored = entries
      .filter((e) => e.section === section)
      .map((entry, index) => ({ entry, index, score: score(entry, q) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
    return {
      section,
      order,
      best: scored[0]?.score ?? 0,
      entries: scored.map((s) => s.entry),
    }
  }).filter((g) => g.entries.length > 0)
  groups.sort((a, b) => b.best - a.best || a.order - b.order)
  return groups.map(({ section, entries: groupEntries }) => ({ section, entries: groupEntries }))
}
