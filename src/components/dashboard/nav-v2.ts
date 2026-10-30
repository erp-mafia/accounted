import {
  ArchiveBoxIcon,
  ArrowsRightLeftIcon,
  BanknotesIcon,
  BookOpenIcon,
  BriefcaseIcon,
  BuildingLibraryIcon,
  ChartBarIcon,
  CheckCircleIcon,
  ClipboardDocumentListIcon,
  DocumentCheckIcon,
  DocumentTextIcon,
  InboxIcon,
  PercentBadgeIcon,
  SparklesIcon,
  UsersIcon,
  WalletIcon,
  type Icon,
} from '@/components/icons'
import { EXTENSION_REQUIRED_CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import type { ModuleId } from '@/lib/modules/manifest'
import type { EntityType } from '@/types'

/**
 * Visibility gates shared by the v1 nav items and the v2 tree. DashboardNav
 * evaluates them once (passesGates) so a surface hides for exactly the same
 * reason in both shells.
 */
export interface NavGateFlags {
  href: string
  /**
   * The module (lib/modules/manifest.ts) the surface belongs to. The menu
   * hides it when the resolved capabilities (lib/modules/capabilities.ts)
   * say the module's package is switched off or not in the company's
   * country, or the module is not offered for the legal form (payroll for
   * an enskild firma that does not pay salaries, #782). Required: a menu
   * item without a module is a feature no package can switch
   * (__tests__/nav-modules.test.ts).
   */
  module: ModuleId
  requiresDimensions?: boolean
  requiresSalesOrders?: boolean
  // Offerter: company_settings.quotes_enabled (UI-visibility gate only; the
  // /quotes page and the APIs work regardless, existing quotes are kept).
  requiresQuotes?: boolean
  requiresWebshop?: boolean
  /** Kassarapporter: a POS connection exists, live or ended (computed by the layout). */
  requiresPosSales?: boolean
  requiresMileage?: boolean
  requiresExpenses?: boolean
  // Arkiv: shown only for companies in the ARKIV_COMPANY_IDS rollout (computed by the layout).
  requiresArkiv?: boolean
  /** Signeringar: shown only where BankID document signing is switched on (lib/navigation/nav-rollouts.ts). */
  requiresSigning?: boolean
  /** Avtal och åtaganden: shown only for companies in the Bolaget rollout (BOLAGET_COMPANY_IDS, lib/env/commitments-switch.ts). */
  requiresCommitments?: boolean
  /** The Agenter page (/skills); hidden in production while it is finished (lib/agent-skills/flag.ts). */
  requiresAgents?: boolean
  /** The new Inkorg page (/inkorg): shown only for companies in the INKORG_V2_COMPANY_IDS rollout (lib/inkorg/flag.ts). */
  requiresInkorgV2?: boolean
  /** What the new Inkorg page replaces (Underlag under Inköp): hidden for the companies in that rollout. */
  hiddenWithInkorgV2?: boolean
  /** The Autogiro page (/invoices/autogiro): shown only for companies in the AUTOGIRO_COMPANY_IDS rollout (lib/invoices/autogiro/flag.ts). */
  requiresAutogiro?: boolean
  /** The Bolaget registers (aktiebok, styrelse): shown only for companies in the BOLAGET_COMPANY_IDS rollout (lib/env/bolaget-switch.ts). */
  requiresBolaget?: boolean
  requiredCapability?: CapabilityKey
  /** Show only for these legal forms (one or several). */
  entityOnly?: EntityType | readonly EntityType[]
  byraOnly?: boolean
  hidden?: boolean
  comingSoon?: boolean
  betaBadge?: boolean
  newBadge?: boolean
}

/**
 * Sidebar tree (UI v2 PR 2, the default since PR #2390). Sections are the
 * prototype's BOLAGET list; a section's sub-items render under it while the
 * section is active, so nothing the old rail reached became a dead end.
 * Every href here already has a page; PR 3 to PR 8 change what the pages
 * show, not where they live. Settings, help and the company switcher live
 * in the user menu at the bottom, so the sidebar has no bottom group.
 */
export interface NavV2Item extends NavGateFlags {
  labelKey: string
  icon?: Icon
  sub?: NavV2Item[]
}

export const NAV_V2_TOP: NavV2Item[] = [
  {
    href: '/',
    module: 'platform',
    labelKey: 'v2_todo',
    icon: CheckCircleIcon,
    sub: [{ href: '/pending', module: 'platform', labelKey: 'v2_proposals' }],
  },
  // Inkorg, lifted out of Inköp to sit under Att göra (founder decision
  // 2026-10-16): what arrives is not only purchases, and an inbox that feeds
  // supplier invoices, utlägg and verifikat should not live inside one of
  // them. Per company while it rolls out; Underlag under Inköp hides for the
  // same companies, so the inbox is in one place either way.
  {
    href: '/inkorg',
    module: 'inbox',
    labelKey: 'inkorg',
    icon: InboxIcon,
    requiresInkorgV2: true,
    requiredCapability: EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox'],
  },
  {
    href: '/chat',
    module: 'agent',
    labelKey: 'assistant',
    icon: SparklesIcon,
    sub: [{ href: '/agent-knowledge', module: 'agent', labelKey: 'agent_knowledge' }],
  },
  { href: '/skills', module: 'agent', labelKey: 'skills', icon: ClipboardDocumentListIcon, newBadge: true, requiresAgents: true },
]

export const NAV_V2_COMPANY: NavV2Item[] = [
  {
    href: '/accounts',
    module: 'ledger',
    labelKey: 'v2_accounts',
    icon: BuildingLibraryIcon,
    // One list, no sub-items (founder decision 2026-10-18): Avstämning was a
    // second list of the same accounts, so it merged into Konton. Each row
    // opens the account's reconciliation at /reconciliation?account=, which
    // keeps this row lit (DashboardNav isActive).
  },
  {
    href: '/transactions',
    module: 'transactions',
    labelKey: 'transactions',
    icon: ArrowsRightLeftIcon,
    // Regler is back in the menu (founder call 2026-10-28, reversing the
    // 2026-09-07 one): it is where a rule is set to always ask, and where
    // Ett klick says which rules book without a review (accounted#130).
    sub: [
      { href: '/parties', module: 'parties', labelKey: 'v2_parties' },
      { href: '/rules', module: 'transactions', labelKey: 'v2_rules' },
    ],
  },
  {
    href: '/invoices',
    module: 'invoicing',
    labelKey: 'v2_invoicing',
    icon: DocumentTextIcon,
    sub: [
      // A quote is not an invoice (founder direction 2026-09-12): its own row
      // above Kundfakturor, shown while quotes are switched on in settings.
      { href: '/quotes', module: 'invoicing', labelKey: 'quotes', requiresQuotes: true },
      // Återkommande opens from Ny faktura; it is a way to make invoices, not a place.
      { href: '/invoices', module: 'invoicing', labelKey: 'invoices' },
      { href: '/sales-orders', module: 'invoicing', labelKey: 'sales_orders', requiresSalesOrders: true },
      { href: '/orders', module: 'webshop', labelKey: 'webshop_orders', requiresWebshop: true, betaBadge: true },
      // Kassarapporter: the POS days (kassasystem via Accounted Connect), shown once a venue is connected.
      { href: '/kassa', module: 'pos', labelKey: 'pos_sales', requiresPosSales: true, betaBadge: true },
      { href: '/customers', module: 'invoicing', labelKey: 'customers' },
      { href: '/articles', module: 'invoicing', labelKey: 'articles' },
      // Autogiro: debit files for the bank and Bankgirot's reports, per company while it rolls out.
      { href: '/invoices/autogiro', module: 'invoicing', labelKey: 'autogiro', requiresAutogiro: true },
    ],
  },
  {
    // Inköp lands on the invoice list: the flow-strip landing that sat here
    // said less than the list itself (founder call 2026-09-09).
    href: '/supplier-invoices',
    module: 'supplier-invoices',
    labelKey: 'v2_purchases',
    icon: WalletIcon,
    sub: [
      { href: '/supplier-invoices', module: 'supplier-invoices', labelKey: 'supplier_invoices' },
      {
        href: '/e/general/invoice-inbox',
        module: 'inbox',
        labelKey: 'invoice_inbox',
        requiredCapability: EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox'],
        hiddenWithInkorgV2: true,
      },
      { href: '/expenses', module: 'expenses', labelKey: 'expenses', requiresExpenses: true },
      { href: '/mileage', module: 'expenses', labelKey: 'mileage', requiresMileage: true },
      // Betalningar took over Betalfiler (connections plan, milestone 1): bank
      // payments by where they stand, and the payment files behind a link.
      { href: '/payments', module: 'payments', labelKey: 'v2_payments' },
      { href: '/suppliers', module: 'supplier-invoices', labelKey: 'suppliers' },
    ],
  },
  {
    // Arkiv is its own entry after Inköp, where Underlag lives: Underlag is
    // the queue for what must become a verifikat, Arkiv the place that grows
    // (plan of record, decision 4).
    href: '/arkiv',
    module: 'inbox',
    labelKey: 'arkiv',
    icon: ArchiveBoxIcon,
    requiresArkiv: true,
    sub: [
      { href: '/arkiv', module: 'inbox', labelKey: 'arkiv_all' },
      { href: '/arkiv/historik', module: 'inbox', labelKey: 'arkiv_history' },
      { href: '/arkiv/signeringar', module: 'inbox', labelKey: 'arkiv_signings', requiresSigning: true },
    ],
  },
  {
    href: '/bookkeeping',
    module: 'ledger',
    labelKey: 'bookkeeping',
    icon: BookOpenIcon,
    sub: [
      { href: '/bookkeeping', module: 'ledger', labelKey: 'v2_vouchers' },
      { href: '/chart-of-accounts', module: 'ledger', labelKey: 'chart_of_accounts' },
      { href: '/bookkeeping/periodiseringar', module: 'ledger', labelKey: 'periodiseringar' },
      { href: '/assets', module: 'assets', labelKey: 'assets' },
      { href: '/dimensions', module: 'ledger', labelKey: 'dimensions', requiresDimensions: true },
      { href: '/import', module: 'import', labelKey: 'import' },
    ],
  },
  {
    href: '/salary',
    module: 'payroll',
    labelKey: 'salary',
    icon: BanknotesIcon,
    sub: [
      { href: '/salary', module: 'payroll', labelKey: 'v2_salary_runs' },
      { href: '/salary/employees', module: 'payroll', labelKey: 'employees' },
    ],
  },
  {
    href: '/reports/vat-declaration',
    module: 'vat',
    labelKey: 'v2_tax',
    icon: PercentBadgeIcon,
    sub: [
      { href: '/reports/vat-declaration', module: 'vat', labelKey: 'vat_declaration' },
      { href: '/deadlines', module: 'deadlines', labelKey: 'deadlines' },
    ],
  },
  {
    href: '/reports',
    module: 'ledger',
    labelKey: 'reports',
    icon: ChartBarIcon,
    sub: [
      { href: '/reports', module: 'ledger', labelKey: 'reports' },
      { href: '/kpi', module: 'ledger', labelKey: 'kpi' },
      { href: '/budget', module: 'ledger', labelKey: 'budget' },
    ],
  },
  {
    href: '/bookkeeping/year-end',
    module: 'year-end',
    labelKey: 'v2_closing',
    icon: DocumentCheckIcon,
    sub: [
      { href: '/bookkeeping/year-end', module: 'year-end', labelKey: 'year_end' },
      { href: '/bookkeeping/year-end/arsredovisning', module: 'year-end', labelKey: 'annual_report', entityOnly: ['aktiebolag', 'ekonomisk_forening'] },
      { href: '/reports/ink2-declaration', module: 'ledger', labelKey: 'income_declaration', entityOnly: ['aktiebolag', 'ekonomisk_forening'] },
      { href: '/reports/ne-declaration', module: 'ledger', labelKey: 'income_declaration', entityOnly: 'enskild_firma' },
      { href: '/reports/ink3-declaration', module: 'ledger', labelKey: 'income_declaration', entityOnly: ['ideell_forening'] },
    ],
  },
  {
    // Bolaget, the legal entity: the aktiebok and the board over time
    // (ABL 5, 6 and 8 kap.). An aktiebolag's, per company while it rolls out.
    href: '/bolaget/aktiebok',
    module: 'corporate',
    labelKey: 'bolaget_registers',
    icon: UsersIcon,
    entityOnly: ['aktiebolag'],
    requiresBolaget: true,
    sub: [
      { href: '/bolaget/aktiebok', module: 'corporate', labelKey: 'bolaget_aktiebok', entityOnly: ['aktiebolag'], requiresBolaget: true },
      { href: '/bolaget/styrelse', module: 'corporate', labelKey: 'bolaget_styrelse', entityOnly: ['aktiebolag'], requiresBolaget: true },
      { href: '/bolaget/moten', module: 'corporate', labelKey: 'bolaget_meetings', entityOnly: ['aktiebolag'], requiresBolaget: true },
      { href: '/bolaget/kapital', module: 'corporate', labelKey: 'bolaget_capital', entityOnly: ['aktiebolag'], requiresBolaget: true },
      { href: '/bolaget/agarskatt', module: 'corporate', labelKey: 'bolaget_owner_tax', entityOnly: ['aktiebolag'], requiresBolaget: true },
    ],
  },
  {
    // Avtal och åtaganden (Bolaget): agreements with their payments and
    // dates, ställda säkerheter and eventualförpliktelser, and the group
    // structure the årsredovisning notes are written from. Per company
    // while it rolls out.
    href: '/commitments',
    module: 'year-end',
    labelKey: 'commitments',
    icon: BriefcaseIcon,
    requiresCommitments: true,
  },
]

/**
 * A row claimed by the page (nav-row-claim.ts) overrides the URL: the
 * claimed row is active, and any other row the pathname would match by
 * prefix is not. Undefined when the claim says nothing about `href`, so
 * the URL rules decide.
 */
export function claimedRowActive(href: string, pathname: string, claimedHref: string | null): boolean | undefined {
  if (!claimedHref) return undefined
  if (href === claimedHref) return true
  if (href !== '/' && pathname.startsWith(href)) return false
  return undefined
}

/**
 * Longest matching sub-item wins, so /invoices/recurring lights up
 * Återkommande and not Kundfakturor as well.
 */
export function activeSubHref(item: NavV2Item, isActive: (href: string) => boolean): string | null {
  const matches = (item.sub ?? []).filter((s) => isActive(s.href))
  if (matches.length === 0) return null
  return matches.reduce((best, s) => (s.href.length > best.href.length ? s : best)).href
}
