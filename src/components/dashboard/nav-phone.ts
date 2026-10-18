import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Briefcase,
  CalendarClock,
  CalendarRange,
  Car,
  ClipboardCheck,
  ClipboardList,
  FileCheck,
  FileSpreadsheet,
  FileText,
  FolderArchive,
  HandCoins,
  Home,
  Inbox,
  Landmark,
  ListTree,
  Package,
  Percent,
  Receipt,
  ReceiptText,
  Scale,
  ScrollText,
  ShoppingCart,
  Sparkles,
  Store,
  Tag,
  Tags,
  TrendingUp,
  Truck,
  Upload,
  Users,
  Wallet,
  Workflow,
} from 'lucide-react'
import { EXTENSION_REQUIRED_CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import type { ModuleId } from '@/lib/modules/manifest'
import type { EntityType } from '@/types'

/**
 * The phone menu's destinations and the byrå cockpit's lean sidebar, read by
 * DashboardNav. Kept out of the component so the menu can be read without
 * rendering it (the menu snapshot and the module guard in __tests__).
 */

export type NavLabelKey =
  | 'dashboard'
  | 'home'
  | 'assistant'
  | 'agent_knowledge'
  | 'kpi'
  | 'invoice_inbox'
  | 'inkorg'
  | 'arkiv'
  | 'arkiv_all'
  | 'arkiv_history'
  | 'invoices'
  | 'quotes'
  | 'sales_orders'
  | 'webshop_orders'
  | 'pos_sales'
  | 'customers'
  | 'articles'
  | 'supplier_invoices'
  | 'suppliers'
  | 'review'
  | 'transactions'
  | 'reconciliation'
  | 'bookkeeping'
  | 'chart_of_accounts'
  | 'dimensions'
  | 'assets'
  | 'reports'
  | 'import'
  | 'salary'
  | 'expenses'
  | 'mileage'
  | 'employees'
  | 'vat_declaration'
  | 'skattekonto'
  | 'deadlines'
  | 'periodiseringar'
  | 'year_end'
  | 'bokslutsbilagor'
  | 'annual_report'
  | 'income_declaration'
  | 'help'
  | 'settings'
  | 'account_settings'
  | 'clients'
  | 'automations'
  | 'back_to_clients'

// Two navigations over the same routes. Desktop: SidebarV2, the section
// tree in nav-v2.ts (sub-items under the active section, user block at the
// bottom). Phone: the bottom bar plus the menu sheet, built from `navItems`:
//   top section          : flat, no header: Hem, Assistent.
//   four groups          : static headers (Arbeta, Analys, Data,
//                          Skatt & bokslut).
// Help + Settings are NOT in `navItems`; they live in the user menu and in
// the sheet's Mitt konto rows.
// Pending (Granskning) stays visible at all times: the badge carries the count.
export type GroupKey = 'top' | 'arbeta' | 'analys' | 'data' | 'skatt'

export interface NavItem {
  href: string
  labelKey: NavLabelKey
  icon: LucideIcon
  group: GroupKey
  // The module the surface belongs to (NavGateFlags.module in nav-v2.ts):
  // the menu hides it when the resolved capabilities say its package is off
  // or the module is not offered for the legal form (payroll for an
  // enskild firma that does not pay salaries, #782).
  module: ModuleId
  // Dimension surfaces: visible only when the company has opted in via
  // company_settings.dimensions_enabled (UI-visibility gate only; the pages
  // and APIs work regardless, dimensions plan §2).
  requiresDimensions?: boolean
  // Kundorder surfaces: visible only when the company has opted in via
  // company_settings.sales_orders_enabled (UI-visibility gate only; the
  // pages and APIs work regardless).
  requiresSalesOrders?: boolean
  // Offerter: visible while company_settings.quotes_enabled is on (UI
  // visibility only; /quotes and the APIs work regardless).
  requiresQuotes?: boolean
  // Webshop surfaces: visible only when the company has an active
  // WooCommerce/Shopify connection or already-imported order rows.
  // UI-visibility gate only; the page and APIs work regardless.
  requiresWebshop?: boolean
  // Kassarapporter: visible only when the company has a POS connection, live
  // or ended (the days stay reachable). UI-visibility gate only.
  requiresPosSales?: boolean
  // Körjournal surfaces: visible only when the company has opted in via the
  // bookkeeping settings toggle (company_settings.mileage_enabled) or already
  // has trips. UI-visibility gate only; the page and APIs work regardless.
  requiresMileage?: boolean
  // Utlägg row: visible only when the company already has expense claims
  // (same "data stays reachable" gate as Körjournal). UI-visibility only.
  requiresExpenses?: boolean
  // The new Inkorg page (/inkorg) and what it replaces (Underlag under
  // Arbeta): per company while it rolls out (lib/inkorg/flag.ts).
  requiresInkorgV2?: boolean
  hiddenWithInkorgV2?: boolean
  // Paywall surfaces: hidden unless the active company holds this paid
  // capability. Cosmetic only, the page and API gates are the real
  // enforcement; this just keeps the sidebar honest for non-payers.
  requiredCapability?: CapabilityKey
  // Statutory surfaces that only exist for one company form (INK2 vs
  // NE-bilaga, årsredovisning): hidden for the other entity type.
  entityOnly?: EntityType | readonly EntityType[]
  // Byrå cockpit surfaces (WL-14): visible only to byrå team members
  // (teams.kind = 'byra'). The /clients page + API enforce server-side.
  byraOnly?: boolean
  hidden?: boolean
  comingSoon?: boolean
  devBadge?: boolean
  betaBadge?: boolean
}

// The phone menu's destinations in concept ordering; the desktop sidebar
// applies the same gates to nav-v2.ts.
export const navItems: NavItem[] = [
  // Top section: flat list, always visible, no header. (Flöden joins here
  // when the flow engine exists.)
  { href: '/', module: 'platform', labelKey: 'home', icon: Home, group: 'top' },
  // Inkorg right under Hem for the companies in its rollout, as on desktop;
  // Underlag leaves Arbeta for the same companies.
  { href: '/inkorg', module: 'inbox', labelKey: 'inkorg', icon: Inbox, group: 'top', requiresInkorgV2: true, requiredCapability: EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox'] },
  // Byrå cockpit (WL-14): the client list, byrå team members only.
  { href: '/clients', module: 'byra', labelKey: 'clients', icon: Briefcase, group: 'top', byraOnly: true },
  { href: '/chat', module: 'agent', labelKey: 'assistant', icon: Sparkles, group: 'top' },
  // Arbeta: everything the user produces, bookkeeping funnel first
  // (Bokföring · Underlag · Transaktioner · Granskning), then the
  // transactional flows. Payroll shows where the company is offered it. #782
  { href: '/bookkeeping', module: 'ledger', labelKey: 'bookkeeping', icon: BookOpen, group: 'arbeta' },
  { href: '/e/general/invoice-inbox', module: 'inbox', labelKey: 'invoice_inbox', icon: Inbox, group: 'arbeta', requiredCapability: EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox'], hiddenWithInkorgV2: true },
  { href: '/transactions', module: 'transactions', labelKey: 'transactions', icon: ArrowLeftRight, group: 'arbeta' },
  { href: '/reconciliation', module: 'transactions', labelKey: 'reconciliation', icon: Scale, group: 'arbeta' },
  { href: '/pending', module: 'platform', labelKey: 'review', icon: ClipboardCheck, group: 'arbeta' },
  // Kundorder: opt-in via the bookkeeping settings toggle (UI gate only).
  { href: '/sales-orders', module: 'invoicing', labelKey: 'sales_orders', icon: ClipboardList, group: 'arbeta', requiresSalesOrders: true },
  // Offerter: a quote is not an invoice, so its own row above Kundfakturor.
  { href: '/quotes', module: 'invoicing', labelKey: 'quotes', icon: FileText, group: 'arbeta', requiresQuotes: true },
  { href: '/invoices', module: 'invoicing', labelKey: 'invoices', icon: ReceiptText, group: 'arbeta' },
  // Webshop orders: visible only for companies that actually have a webshop
  // hooked up (active WooCommerce/Shopify connection or existing order rows).
  // Deliberately NOT capability-gated: a company whose entitlement lapsed
  // must still reach its already-imported orders (accounting underlag).
  { href: '/orders', module: 'webshop', labelKey: 'webshop_orders', icon: ShoppingCart, group: 'arbeta', requiresWebshop: true, betaBadge: true },
  // Kassarapporter: the POS days, visible once a venue is connected.
  { href: '/kassa', module: 'pos', labelKey: 'pos_sales', icon: Store, group: 'arbeta', requiresPosSales: true, betaBadge: true },
  { href: '/supplier-invoices', module: 'supplier-invoices', labelKey: 'supplier_invoices', icon: Wallet, group: 'arbeta' },
  // Utlägg: out-of-pocket purchases and their reimbursement batches. Hidden
  // until a claim exists: a receipt paid privately is registered from the
  // Underlag pane, and the person to pay out surfaces in Att göra. The
  // /expenses route previously redirected to supplier invoices; the nav key
  // has existed in the nav namespace since then.
  { href: '/expenses', module: 'expenses', labelKey: 'expenses', icon: Receipt, group: 'arbeta', requiresExpenses: true },
  { href: '/salary', module: 'payroll', labelKey: 'salary', icon: HandCoins, group: 'arbeta' },
  // Körjournal: hidden by default (most companies have no car); shows when
  // the settings toggle is on or trips already exist (hybrid gate, same
  // "data stays reachable" reasoning as the Order row above).
  { href: '/mileage', module: 'expenses', labelKey: 'mileage', icon: Car, group: 'arbeta', requiresMileage: true },
  // Analys: read the numbers.
  { href: '/kpi', module: 'ledger', labelKey: 'kpi', icon: TrendingUp, group: 'analys' },
  { href: '/reports', module: 'ledger', labelKey: 'reports', icon: BarChart3, group: 'analys' },
  // Data: the registers (master data) + Importera/exportera as its own
  // row. Anställda is a register (you edit an employee rarely, you run
  // payroll monthly), so it lives here while Löner stays in Arbeta.
  { href: '/customers', module: 'invoicing', labelKey: 'customers', icon: Users, group: 'data' },
  { href: '/suppliers', module: 'supplier-invoices', labelKey: 'suppliers', icon: Truck, group: 'data' },
  { href: '/articles', module: 'invoicing', labelKey: 'articles', icon: Tag, group: 'data' },
  { href: '/salary/employees', module: 'payroll', labelKey: 'employees', icon: Users, group: 'data' },
  { href: '/assets', module: 'assets', labelKey: 'assets', icon: Package, group: 'data' },
  { href: '/chart-of-accounts', module: 'ledger', labelKey: 'chart_of_accounts', icon: ListTree, group: 'data' },
  { href: '/dimensions', module: 'ledger', labelKey: 'dimensions', icon: Tags, group: 'data', requiresDimensions: true },
  { href: '/import', module: 'import', labelKey: 'import', icon: Upload, group: 'data' },
  // Skatt & bokslut: everything submitted to the state; the year-end chain
  // (periodiseringar → årsbokslut → årsredovisning → inkomstdeklaration)
  // lives in workflow order; the last two are
  // entity-gated because the surface only exists for one company form.
  { href: '/reports/vat-declaration', module: 'vat', labelKey: 'vat_declaration', icon: Percent, group: 'skatt' },
  { href: '/skattekonto', module: 'skatteverket', labelKey: 'skattekonto', icon: Landmark, group: 'skatt' },
  { href: '/deadlines', module: 'deadlines', labelKey: 'deadlines', icon: CalendarClock, group: 'skatt' },
  { href: '/bookkeeping/periodiseringar', module: 'ledger', labelKey: 'periodiseringar', icon: CalendarRange, group: 'skatt' },
  { href: '/bookkeeping/year-end', module: 'year-end', labelKey: 'year_end', icon: FileCheck, group: 'skatt' },
  { href: '/reports/bokslutsbilagor', module: 'ledger', labelKey: 'bokslutsbilagor', icon: FolderArchive, group: 'skatt' },
  { href: '/bookkeeping/year-end/arsredovisning', module: 'year-end', labelKey: 'annual_report', icon: ScrollText, group: 'skatt', entityOnly: ['aktiebolag', 'ekonomisk_forening'] },
  { href: '/reports/ink2-declaration', module: 'ledger', labelKey: 'income_declaration', icon: FileSpreadsheet, group: 'skatt', entityOnly: ['aktiebolag', 'ekonomisk_forening'] },
  { href: '/reports/ne-declaration', module: 'ledger', labelKey: 'income_declaration', icon: FileSpreadsheet, group: 'skatt', entityOnly: 'enskild_firma' },
  { href: '/reports/ink3-declaration', module: 'ledger', labelKey: 'income_declaration', icon: FileSpreadsheet, group: 'skatt', entityOnly: ['ideell_forening'] },
]

// Byrå cockpit sidebar (lean mode): while a byrå team member is on a
// cockpit route (client overview + the /byra pages) the sidebar shows only
// these four byrå-scope entries instead of the full company nav. Entering a
// company (performCompanySwitch from the client list) is a hard navigation
// to a company route, which swaps the full list back in.
export const cockpitNavItems: NavItem[] = [
  { href: '/byra', module: 'byra', labelKey: 'home', icon: Home, group: 'top' },
  { href: '/clients', module: 'byra', labelKey: 'clients', icon: Briefcase, group: 'top' },
  { href: '/byra/automations', module: 'byra', labelKey: 'automations', icon: Workflow, group: 'top' },
  { href: '/byra/kpi', module: 'byra', labelKey: 'kpi', icon: TrendingUp, group: 'top' },
]
