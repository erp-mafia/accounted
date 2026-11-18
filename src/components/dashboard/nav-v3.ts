import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowTrendingUpIcon,
  ArrowUpTrayIcon,
  ArrowsRightLeftIcon,
  BanknotesIcon,
  BellIcon,
  BoltIcon,
  BookOpenIcon,
  BookmarkIcon,
  BriefcaseIcon,
  BuildingLibraryIcon,
  BuildingOfficeIcon,
  BuildingStorefrontIcon,
  CalculatorIcon,
  CalendarDateRangeIcon,
  ChartBarIcon,
  ChatBubbleLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  CubeIcon,
  DocumentCheckIcon,
  DocumentChartBarIcon,
  DocumentIcon,
  DocumentTextIcon,
  FolderOpenIcon,
  HashtagIcon,
  HomeIcon,
  InboxIcon,
  ListBulletIcon,
  PencilSquareIcon,
  PercentBadgeIcon,
  QueueListIcon,
  ReceiptRefundIcon,
  RectangleGroupIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TableCellsIcon,
  TruckIcon,
  UserIcon,
  UsersIcon,
  WalletIcon,
  type Icon,
  MapIcon,
} from '@/components/icons'
import { EXTENSION_REQUIRED_CAPABILITY } from '@/lib/entitlements/keys'
import type { NavGateFlags } from './nav-v2'

/**
 * The application shell's navigation (the V7/V8 prototype, 2026-11-14): an
 * icon rail of areas, and one sidebar per area holding that area's create
 * action, its menu rows and quiet links to its settings pages.
 *
 * Routes do not move: an area is a grouping of pages that already exist, and
 * every row carries the gate flags its page had in nav-v2.ts, so a surface
 * hides for the same reason it always did (lib/navigation/nav-gates.ts). An
 * area whose every row is gated away leaves the rail.
 *
 * Which area and row a URL belongs to is derived, never listed per page:
 * the longest matching row wins (resolveNavPlace), so /invoices/[id]/edit
 * lights Försäljning and Fakturor, and /reports/vat-declaration lights Skatt
 * and Moms although /reports belongs to Rapporter. A route with no row of
 * its own names the row it belongs under in that row's `match`.
 */

export type NavAreaId =
  | 'todo'
  | 'money'
  | 'sales'
  | 'purchases'
  | 'documents'
  | 'ledger'
  | 'tax'
  | 'reports'
  | 'payroll'
  | 'company'
  | 'agents'
  | 'settings'
  | 'byra'

export interface NavV3Item extends NavGateFlags {
  labelKey: string
  icon: Icon
  /**
   * Route prefixes that have no row of their own and belong under this one
   * (/mileage under Utlägg, the income declarations under Bokslut).
   */
  match?: readonly string[]
}

export interface NavV3Group {
  /** A labelled group ("Register", "Styr"); absent for the area's plain rows. */
  labelKey?: string
  items: NavV3Item[]
}

/** The area's create button: a link to the existing create route, or one of the shell's own dialogs. */
export interface NavV3Create extends NavGateFlags {
  labelKey: string
  /** The button's symbol: a plus on create, the upload arrow on Ladda upp (port spec, symbols on buttons). */
  symbol?: 'upload'
  /**
   * Done by the shell instead of following `href`: the byrå's "Nytt
   * klientbolag" confirm, or the inbox's file dialog.
   */
  action?: 'new-client' | 'upload-inbox'
}

/** A quiet link at the bottom of the area sidebar, labelled by its settings_nav key. */
export interface NavV3SettingsLink {
  href: string
  /** The settings_nav message key of the section the link opens. */
  labelKey: string
}

export interface NavV3Area {
  id: NavAreaId
  labelKey: string
  icon: Icon
  /** Where on the rail: groups are divided by a small gap; 'foot' is pinned at the bottom. */
  rail: 0 | 1 | 2 | 3 | 'foot'
  groups: NavV3Group[]
  /**
   * The area's create action as candidates: the first one whose gates pass is
   * the button (the inbox upload lands on the new Inkorg page inside its
   * rollout and on the Underlag workspace outside it). gateAreas leaves at
   * most one.
   */
  create?: NavV3Create[]
  settings?: NavV3SettingsLink[]
  /** Route prefixes that belong to the area without lighting a row (help and extensions under Inställningar, Koppla en agent under Agenter). */
  owns?: readonly string[]
}

const INBOX_CAPABILITY = EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox']

/**
 * Uploading underlag: the shell opens the inbox's own upload where the
 * person is (DashboardNav, useInboxUpload), since a browser only opens a
 * file dialog from the click itself. The href is the inbox the files land
 * in, with the gates of the inbox row: the new Inkorg page inside its
 * rollout, the Underlag workspace outside it.
 */
function inboxUpload(labelKey: string): NavV3Create[] {
  return [
    { href: '/inkorg', module: 'inbox', labelKey, symbol: 'upload', action: 'upload-inbox', requiresInkorgV2: true, requiredCapability: INBOX_CAPABILITY },
    { href: '/e/general/invoice-inbox', module: 'inbox', labelKey, symbol: 'upload', action: 'upload-inbox', requiredCapability: INBOX_CAPABILITY, hiddenWithInkorgV2: true },
  ]
}

export const NAV_V3_AREAS: NavV3Area[] = [
  {
    id: 'todo',
    labelKey: 'v2_todo',
    icon: CheckCircleIcon,
    rail: 0,
    create: inboxUpload('v3_upload_underlag'),
    groups: [
      {
        items: [
          { href: '/', module: 'platform', labelKey: 'home', icon: HomeIcon, match: ['/onboarding/books'] },
          { href: '/?vy=behover', module: 'platform', labelKey: 'v3_needs_you', icon: InboxIcon, match: ['/arkiv/granska'] },
          { href: '/pending', module: 'platform', labelKey: 'v3_routine', icon: ArrowPathIcon },
          { href: '/?vy=gjort', module: 'platform', labelKey: 'v3_done', icon: CheckIcon },
        ],
      },
    ],
  },
  {
    id: 'money',
    labelKey: 'v3_money',
    icon: ArrowsRightLeftIcon,
    rail: 1,
    // The bank rows page opens its "Ny transaktion" drawer on ?new.
    create: [{ href: '/transactions?new', module: 'transactions', labelKey: 'v3_create_transaction' }],
    groups: [
      {
        items: [
          { href: '/transactions', module: 'transactions', labelKey: 'v3_bank_rows', icon: ListBulletIcon },
          // One account's reconciliation (/reconciliation?account=) opens from
          // this list and has no row of its own: the bare /reconciliation
          // redirects here (product decision 2026-10-18, next.config.ts).
          { href: '/accounts', module: 'ledger', labelKey: 'v3_accounts_balance', icon: BuildingLibraryIcon, match: ['/reconciliation'] },
        ],
      },
    ],
    settings: [
      { href: '/settings/banking', labelKey: 'banking' },
      { href: '/settings/bank-payments', labelKey: 'bank_payments' },
    ],
  },
  {
    id: 'sales',
    labelKey: 'v3_sales',
    icon: DocumentTextIcon,
    rail: 1,
    create: [{ href: '/invoices/new', module: 'invoicing', labelKey: 'v3_create_invoice' }],
    groups: [
      {
        items: [
          { href: '/invoices', module: 'invoicing', labelKey: 'v3_invoices', icon: DocumentTextIcon },
          { href: '/quotes', module: 'invoicing', labelKey: 'quotes', icon: DocumentIcon, requiresQuotes: true },
          { href: '/sales-orders', module: 'invoicing', labelKey: 'sales_orders', icon: ClipboardDocumentListIcon, requiresSalesOrders: true },
          { href: '/customers', module: 'invoicing', labelKey: 'customers', icon: UsersIcon },
          { href: '/articles', module: 'invoicing', labelKey: 'articles', icon: CubeIcon },
          // Kassa och butik: the POS days and the webshop's orders are two
          // pages with two gates, so each keeps its row.
          { href: '/kassa', module: 'pos', labelKey: 'v3_pos_shop', icon: BuildingStorefrontIcon, requiresPosSales: true, betaBadge: true },
          { href: '/orders', module: 'webshop', labelKey: 'webshop_orders', icon: ShoppingCartIcon, requiresWebshop: true, betaBadge: true },
          { href: '/invoices/autogiro', module: 'invoicing', labelKey: 'autogiro', icon: CreditCardIcon, requiresAutogiro: true },
        ],
      },
    ],
    settings: [
      { href: '/settings/invoicing', labelKey: 'invoicing' },
      { href: '/settings/sending', labelKey: 'sending' },
      { href: '/settings/collections', labelKey: 'collections' },
      { href: '/settings/peppol', labelKey: 'peppol' },
      { href: '/settings/pos', labelKey: 'pos' },
    ],
  },
  {
    id: 'purchases',
    labelKey: 'v2_purchases',
    icon: ShoppingCartIcon,
    rail: 1,
    create: [{ href: '/supplier-invoices/new', module: 'supplier-invoices', labelKey: 'v3_create_supplier_invoice' }],
    groups: [
      {
        items: [
          { href: '/supplier-invoices', module: 'supplier-invoices', labelKey: 'supplier_invoices', icon: WalletIcon },
          { href: '/payments', module: 'payments', labelKey: 'v2_payments', icon: CreditCardIcon },
          { href: '/suppliers', module: 'supplier-invoices', labelKey: 'suppliers', icon: TruckIcon },
          { href: '/expenses', module: 'expenses', labelKey: 'expenses', icon: ReceiptRefundIcon, requiresExpenses: true },
          { href: '/mileage', module: 'expenses', labelKey: 'mileage', icon: MapIcon, requiresMileage: true },
        ],
      },
    ],
    settings: [{ href: '/settings/attest', labelKey: 'attest' }],
  },
  {
    id: 'documents',
    labelKey: 'arkiv',
    icon: ArchiveBoxIcon,
    rail: 1,
    // The inbox's upload; a company with the archive and no inbox uploads there (/arkiv opens its drop zone on ?upload).
    create: [...inboxUpload('v3_upload'), { href: '/arkiv?upload', module: 'inbox', labelKey: 'v3_upload', symbol: 'upload', requiresArkiv: true }],
    groups: [
      {
        items: [
          // Inkommande is the company's one inbox: the new Inkorg page inside
          // its rollout, the Underlag workspace outside it. Never both.
          { href: '/inkorg', module: 'inbox', labelKey: 'v3_incoming', icon: InboxIcon, requiresInkorgV2: true, requiredCapability: INBOX_CAPABILITY },
          { href: '/e/general/invoice-inbox', module: 'inbox', labelKey: 'v3_incoming', icon: InboxIcon, requiredCapability: INBOX_CAPABILITY, hiddenWithInkorgV2: true },
          { href: '/arkiv', module: 'inbox', labelKey: 'v3_archive', icon: ArchiveBoxIcon, requiresArkiv: true },
          { href: '/arkiv/historik', module: 'inbox', labelKey: 'arkiv_history', icon: ClockIcon, requiresArkiv: true },
          { href: '/arkiv/signeringar', module: 'inbox', labelKey: 'arkiv_signings', icon: PencilSquareIcon, requiresArkiv: true, requiresSigning: true },
        ],
      },
    ],
    settings: [
      { href: '/settings/mail', labelKey: 'mail' },
      { href: '/settings/whatsapp', labelKey: 'whatsapp' },
    ],
  },
  {
    id: 'ledger',
    labelKey: 'bookkeeping',
    icon: BookOpenIcon,
    rail: 2,
    // The voucher list opens its "Nytt verifikat" dialog on ?new.
    create: [{ href: '/bookkeeping?new', module: 'ledger', labelKey: 'v3_create_voucher' }],
    groups: [
      {
        items: [
          { href: '/bookkeeping', module: 'ledger', labelKey: 'v3_vouchers', icon: BookOpenIcon, match: ['/dimensions/tagging'] },
          { href: '/chart-of-accounts', module: 'ledger', labelKey: 'chart_of_accounts', icon: QueueListIcon },
          { href: '/dimensions', module: 'ledger', labelKey: 'dimensions', icon: HashtagIcon, requiresDimensions: true },
          { href: '/bookkeeping/periodiseringar', module: 'ledger', labelKey: 'periodiseringar', icon: CalendarDateRangeIcon },
          { href: '/assets', module: 'assets', labelKey: 'v3_assets', icon: CubeIcon },
          {
            href: '/bookkeeping/year-end',
            module: 'year-end',
            labelKey: 'v2_closing',
            icon: DocumentCheckIcon,
            // The income declarations are reached from the year-end pages and
            // from Fler rapporter; they belong to Bokslut, not to Rapporter.
            match: ['/reports/ink2-declaration', '/reports/ne-declaration', '/reports/ink3-declaration'],
          },
          { href: '/import', module: 'import', labelKey: 'v3_import', icon: ArrowUpTrayIcon },
        ],
      },
    ],
    settings: [
      { href: '/settings/bookkeeping', labelKey: 'bookkeeping' },
      { href: '/settings/fiscal-years', labelKey: 'fiscal_years' },
      { href: '/settings/templates', labelKey: 'templates' },
    ],
  },
  {
    id: 'tax',
    labelKey: 'v2_tax',
    icon: PercentBadgeIcon,
    rail: 2,
    groups: [
      {
        items: [
          { href: '/reports/vat-declaration', module: 'vat', labelKey: 'vat_declaration', icon: PercentBadgeIcon },
          { href: '/skattekonto', module: 'skatteverket', labelKey: 'skattekonto', icon: WalletIcon },
          { href: '/deadlines', module: 'deadlines', labelKey: 'v3_deadlines', icon: BellIcon },
        ],
      },
    ],
    settings: [
      { href: '/settings/tax', labelKey: 'tax' },
      { href: '/settings/skatteverket', labelKey: 'skatteverket' },
    ],
  },
  {
    id: 'reports',
    labelKey: 'reports',
    icon: ChartBarIcon,
    rail: 2,
    groups: [
      {
        items: [
          { href: '/reports/resultatrapport', module: 'ledger', labelKey: 'v3_report_result', icon: ChartBarIcon },
          { href: '/reports/balansrapport', module: 'ledger', labelKey: 'v3_report_balance', icon: TableCellsIcon },
          { href: '/reports/huvudbok', module: 'ledger', labelKey: 'v3_report_ledger', icon: BookOpenIcon },
          { href: '/kpi', module: 'ledger', labelKey: 'kpi', icon: ArrowTrendingUpIcon },
          { href: '/budget', module: 'ledger', labelKey: 'budget', icon: CalculatorIcon },
          { href: '/reports', module: 'ledger', labelKey: 'v3_more_reports', icon: DocumentChartBarIcon },
        ],
      },
    ],
  },
  {
    id: 'payroll',
    labelKey: 'salary',
    icon: UsersIcon,
    rail: 2,
    // The employees page opens its "Ny anställd" dialog on ?new.
    create: [{ href: '/salary/employees?new', module: 'payroll', labelKey: 'v3_create_employee' }],
    groups: [
      {
        items: [
          { href: '/salary', module: 'payroll', labelKey: 'v2_salary_runs', icon: BanknotesIcon },
          { href: '/salary/employees', module: 'payroll', labelKey: 'employees', icon: UsersIcon },
        ],
      },
    ],
    settings: [{ href: '/settings/salary', labelKey: 'salary' }],
  },
  {
    id: 'company',
    labelKey: 'v3_company',
    icon: BuildingOfficeIcon,
    rail: 3,
    // The Bolaget pages are rows here (product call 2026-11-15; they shared a
    // tab bar before). Each row carries the gate its tab had in
    // lib/bolaget/hub.ts: the overview where the hub is open, a register
    // where the form keeps an aktiebok inside the rollout, Avtal inside the
    // commitments rollout.
    // The agreements register opens its "Nytt avtal" drawer on ?new, gated like the Avtal row.
    create: [{ href: '/bolaget/avtal?new', module: 'corporate', labelKey: 'v3_create_agreement', requiresCommitments: true }],
    groups: [
      {
        items: [
          { href: '/bolaget', module: 'corporate', labelKey: 'v3_overview', icon: BuildingOfficeIcon, requiresBolagetHub: true },
          { href: '/parties', module: 'parties', labelKey: 'v2_parties', icon: UsersIcon },
        ],
      },
      {
        labelKey: 'v3_group_registers',
        items: [
          {
            href: '/bolaget/avtal',
            module: 'corporate',
            labelKey: 'v3_agreements',
            icon: DocumentTextIcon,
            requiresCommitments: true,
            match: ['/arkiv/avtal', '/commitments', '/signering'],
          },
          { href: '/bolaget/aktiebok', module: 'corporate', labelKey: 'v3_share_register', icon: BookOpenIcon, requiresBolagetRegisters: true },
          { href: '/bolaget/styrelse', module: 'corporate', labelKey: 'v3_board', icon: UserIcon, requiresBolagetRegisters: true },
          { href: '/bolaget/moten', module: 'corporate', labelKey: 'v3_meetings', icon: CalendarDateRangeIcon, requiresBolagetRegisters: true },
          { href: '/bolaget/kapital', module: 'corporate', labelKey: 'v3_capital', icon: BanknotesIcon, requiresBolagetRegisters: true },
          { href: '/bolaget/agarskatt', module: 'corporate', labelKey: 'v3_owner_tax', icon: PercentBadgeIcon, requiresBolagetRegisters: true },
        ],
      },
    ],
    settings: [{ href: '/settings/company', labelKey: 'company' }],
  },
  {
    id: 'agents',
    labelKey: 'v3_agents',
    icon: SparklesIcon,
    rail: 'foot',
    // Koppla en agent opens /settings/api. The page has no row (the button is
    // its one place in the sidebar, product decision 2026-11-16): `owns` keeps
    // it lighting Agenter, and areaCreatePage lists it where there is no
    // button (the phone menu, the command palette, the assistant's UI map).
    create: [{ href: '/settings/api', module: 'agent', labelKey: 'v3_connect_agent', requiresMcpExtension: true }],
    owns: ['/settings/api'],
    groups: [
      {
        labelKey: 'v3_group_steer',
        items: [
          { href: '/rules', module: 'transactions', labelKey: 'v2_rules', icon: AdjustmentsHorizontalIcon },
          { href: '/skills', module: 'agent', labelKey: 'v3_skills', icon: SparklesIcon, newBadge: true, requiresAgents: true },
        ],
      },
      {
        labelKey: 'v3_group_knowledge',
        items: [
          // /agent-knowledge redirects into the wiki, view by view.
          { href: '/wiki', module: 'agent', labelKey: 'v3_context', icon: RectangleGroupIcon, newBadge: true, match: ['/agent-knowledge'] },
          // Every view of the wiki is a row here, so the page carries no view switcher.
          { href: '/wiki?view=map', module: 'agent', labelKey: 'v3_rules_profile', icon: BookOpenIcon },
          { href: '/wiki?view=facts', module: 'agent', labelKey: 'v3_facts', icon: ListBulletIcon, requiresArkivBrain: true },
          { href: '/wiki?view=memory', module: 'agent', labelKey: 'v3_memory', icon: BookmarkIcon },
          // Where the Agenter page is open, Arbetssätt above is that page.
          { href: '/wiki?view=skills', module: 'agent', labelKey: 'v3_skills', icon: SparklesIcon, hiddenWithAgents: true },
        ],
      },
      {
        // The built-in chat will be removed: a
        // customer's own assistant connects over MCP instead (Koppla en agent
        // above). Until then the row stays, behind the switch that takes the
        // chat away (ASSISTANT_CHAT_ENABLED, on unless switched off).
        items: [{ href: '/chat', module: 'agent', labelKey: 'v3_chat', icon: ChatBubbleLeftIcon, requiresAssistantChat: true }],
      },
    ],
  },
  {
    // The settings sections are the area's rows (lib/navigation/settings-sections.ts,
    // drawn by SettingsRail); the tree only says which routes belong here.
    id: 'settings',
    labelKey: 'settings',
    icon: Cog6ToothIcon,
    rail: 'foot',
    owns: ['/settings', '/extensions', '/help', '/e'],
    groups: [],
  },
  {
    // The byrå cockpit, above the companies: shown to byrå team members only
    // (DashboardNav decides; the pages and their APIs enforce it server-side).
    id: 'byra',
    labelKey: 'v3_byra',
    icon: BriefcaseIcon,
    rail: 'foot',
    create: [{ href: '/clients', module: 'byra', labelKey: 'v3_create_client', action: 'new-client' }],
    groups: [
      {
        items: [
          { href: '/byra', module: 'byra', labelKey: 'home', icon: HomeIcon },
          { href: '/clients', module: 'byra', labelKey: 'clients', icon: FolderOpenIcon },
          { href: '/byra/automations', module: 'byra', labelKey: 'automations', icon: BoltIcon },
          { href: '/byra/kpi', module: 'byra', labelKey: 'kpi', icon: ArrowTrendingUpIcon },
        ],
      },
    ],
    settings: [{ href: '/settings/team?ctx=byra', labelKey: 'team' }],
  },
]

/** The area's create action once its gates are applied (gateAreas): the first candidate left. */
export function areaCreate(area: NavV3Area): NavV3Create | undefined {
  return area.create?.[0]
}

/**
 * The area's create action when it opens a page of the area that has no row
 * (Koppla en agent, /settings/api): the page is then a destination like any
 * other, so the lists without a create button name it under the area (the
 * phone menu, the command palette, the assistant's UI map). Undefined for a
 * create that opens a dialog, a form or a file picker.
 */
export function areaCreatePage(area: NavV3Area): NavV3Create | undefined {
  const create = areaCreate(area)
  return create && !create.action && (area.owns ?? []).includes(create.href) ? create : undefined
}

/**
 * Whether the shell offers an area's create action to this role. A viewer
 * reads everything and writes nothing (lib/hooks/use-can-write.ts), so the
 * sidebar's create button and the rail's plus are left out for it; Koppla en
 * agent stays reachable from the command palette, the phone menu and the
 * settings search. The byrå's "Lägg till
 * klient" follows the person's role in the byrå team, not in the company.
 */
export function createOpenForRole(create: NavV3Create, role: string | null | undefined): boolean {
  return role !== 'viewer' || create.action === 'new-client'
}

/** Every row of an area, in menu order. */
export function areaItems(area: NavV3Area): NavV3Item[] {
  return area.groups.flatMap((g) => g.items)
}

/** The areas with only the rows `passes` lets through; a group left empty is dropped. */
export function gateAreas(areas: NavV3Area[], passes: (item: NavGateFlags) => boolean): NavV3Area[] {
  return areas.map((area) => ({
    ...area,
    create: area.create?.filter(passes).slice(0, 1),
    groups: area.groups
      .map((g) => ({ ...g, items: g.items.filter(passes) }))
      .filter((g) => g.items.length > 0),
  }))
}

/** The path of an href, without query or hash. */
export function hrefPath(href: string): string {
  return href.split(/[?#]/)[0]
}

/** How much of `pathname` a route pattern covers: its length, or -1 when it does not match. */
function pathScore(pattern: string, pathname: string): number {
  if (pattern === '/') return pathname === '/' ? 1 : -1
  return pathname === pattern || pathname.startsWith(`${pattern}/`) ? pattern.length : -1
}

/**
 * How well a row's own href matches the URL. A row with a query (/?vy=gjort,
 * /wiki?view=map) matches only when the URL carries the same values, and then
 * beats the row of the bare path.
 */
function hrefScore(href: string, pathname: string, search: URLSearchParams): number {
  const [path, query = ''] = href.split('#')[0].split('?')
  const score = pathScore(path, pathname)
  if (score < 0 || !query) return score
  // A row's query names one view of an exact page, never the pages under it.
  if (pathname !== path) return -1
  for (const [key, value] of new URLSearchParams(query)) {
    if (search.get(key) !== value) return -1
  }
  return score + 0.5
}

export interface NavPlace {
  area: NavAreaId
  /** The href of the row the URL belongs to; null when the area owns the route without a row. */
  href: string | null
}

/**
 * The area and row a URL belongs to: the longest match over every row's href
 * and `match` prefixes and every area's `owns` prefixes. Runs on the ungated
 * tree, so a page lights its area also when its own row is hidden for the
 * company (the sidebar then lights no row).
 *
 * A row claimed by the page (nav-row-claim.ts) wins over the URL: an offert
 * in the invoice editor at /invoices/new lights Offerter.
 */
export function resolveNavPlace(
  pathname: string,
  search: URLSearchParams | string = '',
  claimedHref: string | null = null,
  areas: NavV3Area[] = NAV_V3_AREAS,
): NavPlace | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  if (claimedHref) {
    const claimed = areas.find((area) => areaItems(area).some((item) => item.href === claimedHref))
    if (claimed) return { area: claimed.id, href: claimedHref }
  }
  let best: (NavPlace & { score: number }) | null = null
  const offer = (area: NavAreaId, href: string | null, score: number) => {
    if (score >= 0 && (!best || score > best.score)) best = { area, href, score }
  }
  for (const area of areas) {
    for (const item of areaItems(area)) {
      offer(area.id, item.href, hrefScore(item.href, pathname, params))
      for (const prefix of item.match ?? []) offer(area.id, item.href, pathScore(prefix, pathname))
    }
    for (const prefix of area.owns ?? []) offer(area.id, null, pathScore(prefix, pathname))
  }
  if (!best) return null
  const { area, href } = best as NavPlace
  return { area, href }
}
