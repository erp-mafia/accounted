import type { EntityType } from '@/types'

/**
 * Single source of truth for the reports surface.
 *
 * One descriptor per report drives every entry point: the report-library
 * landing (`ReportLibrary`), the "Senast öppnade" recent shelf, the focused
 * report route (`/reports/[slug]` via `FocusedReport`), and the command-palette
 * "Visa rapport" jumps. Adding a report = adding one row here.
 *
 * `labelKey` / `descKey` resolve against the `reports` i18n namespace. The
 * category labels reuse the existing `group_*` keys so statutory terminology is
 * never re-translated.
 */

export type ReportCategory =
  | 'interim'
  | 'year_end'
  | 'tax_vat'
  | 'ledgers'
  | 'reconciliation'
  | 'payroll'
  | 'export'

/**
 * How the report is parameterised:
 * - `fiscal-range`: fiscal period + an optional date sub-range (ReportDateRange)
 * - `fiscal`: fiscal period only
 * - `calendar`: calendar year + monthly/quarterly/yearly period (VAT family):
 *   the deliberate exception to "pick the fiscal year once"
 * - `none`: no period parameter
 */
export type ReportParams = 'fiscal-range' | 'fiscal' | 'calendar' | 'none'

export type ReportExportFormat = 'pdf' | 'xlsx'

export interface ReportDescriptor {
  /** URL slug at /reports/[slug]; also the legacy activeTab id. */
  slug: string
  /** i18n key in the `reports` namespace for the display name. */
  labelKey: string
  /** i18n key in the `reports` namespace for the one-line description. */
  descKey: string
  category: ReportCategory
  /** When set, the report only appears for this entity type. */
  entityType?: EntityType
  /** When true, only shown if the company has employees. */
  needsEmployees?: boolean
  params: ReportParams
  /** On-page export formats handled by the focused view's export menu. */
  exports?: ReportExportFormat[]
  /**
   * External destination. When set, the library/nav links straight here instead
   * of /reports/[slug] (e.g. reports that own their own route, or live elsewhere).
   */
  route?: string
  /**
   * Hidden from the legacy desktop rail; surfaced only on the library landing.
   * Used for reports that were never in the nav (KPI, payroll, archive…).
   */
  libraryOnly?: boolean
  /**
   * Accepts the per-dimension value filter (?dim_no/&dim_code → jsonb @>).
   * P&L-safe reports ONLY: statutory outputs (balance sheet, balansrapport,
   * kassaflöde, årsredovisning, INK2, NE, VAT, SIE) must never carry this
   * flag; a filtered filing is a wrong filing. The whitelist is pinned by
   * lib/reports/__tests__/dimension-statutory-guard.test.ts.
   */
  dimensions?: boolean
  /**
   * Extra words the library search should match, beyond the translated name
   * and description. For the vocabulary a user brings from another product or
   * from the task they are doing ("verifikat per konto", "kontoanalys"), which
   * is often not the word we chose for the report.
   */
  searchTerms?: string
  /** Only shown when company_settings.dimensions_enabled is true. */
  needsDimensions?: boolean
  /**
   * Nav-promoted page that happens to render in the focused-report shell.
   * Hides the report-library back link and the shell's fiscal-year selector —
   * the view owns all of its period controls.
   */
  standalone?: boolean
}

/** Categories shown in the legacy desktop rail, in order. */
export const NAV_CATEGORIES: ReportCategory[] = [
  'interim',
  'year_end',
  'tax_vat',
  'ledgers',
  'reconciliation',
]

/** All categories shown on the library landing, in order. */
export const LIBRARY_CATEGORIES: ReportCategory[] = [
  'interim',
  'year_end',
  'tax_vat',
  'ledgers',
  'reconciliation',
  'payroll',
  'export',
]

/** Maps a category to its existing `group_*` i18n label key. */
export const CATEGORY_LABEL_KEY: Record<ReportCategory, string> = {
  interim: 'group_interim',
  year_end: 'group_year_end',
  tax_vat: 'group_tax_vat',
  ledgers: 'group_ledgers',
  reconciliation: 'group_reconciliation',
  payroll: 'group_payroll',
  export: 'group_export',
}

export const REPORT_CATALOG: ReportDescriptor[] = [
  // --- Löpande (interim) ---
  {
    slug: 'resultatrapport',
    labelKey: 'name_resultatrapport',
    descKey: 'desc_resultatrapport',
    category: 'interim',
    params: 'fiscal-range',
    exports: ['pdf', 'xlsx'],
    dimensions: true,
  },
  {
    // Resultat per projekt/kostnadsställe: value-as-column P&L matrix over
    // one SIE dimension (Fortnox "Resultatrapport projekt").
    slug: 'dimension-pnl',
    labelKey: 'name_dimension_pnl',
    descKey: 'desc_dimension_pnl',
    category: 'interim',
    params: 'fiscal-range',
    exports: ['xlsx'],
    needsDimensions: true,
  },
  {
    slug: 'balansrapport',
    labelKey: 'name_balansrapport',
    descKey: 'desc_balansrapport',
    category: 'interim',
    params: 'fiscal-range',
    exports: ['pdf', 'xlsx'],
  },
  {
    slug: 'trial-balance',
    labelKey: 'name_trial_balance',
    descKey: 'desc_trial_balance',
    category: 'interim',
    params: 'fiscal',
    exports: ['xlsx'],
  },
  {
    slug: 'kpi',
    labelKey: 'name_kpi',
    descKey: 'desc_kpi',
    category: 'interim',
    params: 'fiscal',
    route: '/kpi',
    libraryOnly: true,
    dimensions: true,
  },

  // --- Bokslut (year-end) ---
  {
    // The year-end closing wizard (dispositions, accruals, execute). Owns its
    // route under /bookkeeping; surfaced here so the closing flow is reachable
    // from Rapporter rather than only via the Bokföring header.
    slug: 'year-end-closing',
    labelKey: 'name_year_end_closing',
    descKey: 'desc_year_end_closing',
    category: 'year_end',
    params: 'fiscal',
    route: '/bookkeeping/year-end',
  },
  {
    slug: 'income-statement',
    labelKey: 'name_income_statement',
    descKey: 'desc_income_statement',
    category: 'year_end',
    params: 'fiscal-range',
    exports: ['pdf', 'xlsx'],
    dimensions: true,
  },
  {
    slug: 'balance-sheet',
    labelKey: 'name_balance_sheet',
    descKey: 'desc_balance_sheet',
    category: 'year_end',
    params: 'fiscal-range',
    exports: ['pdf', 'xlsx'],
  },
  {
    slug: 'kassaflodesanalys',
    labelKey: 'name_kassaflodesanalys',
    descKey: 'desc_kassaflodesanalys',
    category: 'year_end',
    params: 'fiscal',
    route: '/reports/kassaflodesanalys',
  },
  {
    slug: 'arsredovisning',
    labelKey: 'name_arsredovisning',
    descKey: 'desc_arsredovisning',
    category: 'year_end',
    entityType: 'aktiebolag',
    params: 'fiscal',
    route: '/bookkeeping/year-end/arsredovisning',
  },

  // --- Skatt & moms (tax & VAT) ---
  {
    slug: 'vat-declaration',
    labelKey: 'name_vat_declaration',
    descKey: 'desc_vat_declaration',
    category: 'tax_vat',
    params: 'calendar',
    exports: ['xlsx'],
    // Promoted to the Skatt & bokslut nav group — reached directly, not via
    // the report library, and it manages its own period selection.
    standalone: true,
  },
  {
    slug: 'periodisk-sammanstallning',
    labelKey: 'name_periodisk_sammanstallning',
    descKey: 'desc_periodisk_sammanstallning',
    category: 'tax_vat',
    params: 'calendar',
  },
  {
    slug: 'ne-declaration',
    labelKey: 'name_ne_declaration',
    descKey: 'desc_ne_declaration',
    category: 'tax_vat',
    entityType: 'enskild_firma',
    params: 'fiscal',
  },
  {
    slug: 'ink2-declaration',
    labelKey: 'name_ink2_declaration',
    descKey: 'desc_ink2_declaration',
    category: 'tax_vat',
    entityType: 'aktiebolag',
    params: 'fiscal',
  },

  // --- Huvudböcker (ledgers) ---
  {
    slug: 'huvudbok',
    labelKey: 'name_huvudbok',
    descKey: 'desc_huvudbok',
    category: 'ledgers',
    params: 'fiscal-range',
    exports: ['xlsx'],
    dimensions: true,
    // This is the "show me the verifikat behind account 1930" report, which
    // is what people search for when reconciling before årsredovisningen.
    // Fortnox calls it Kontoanalys, Björn Lundén Kontokontroll.
    searchTerms:
      'verifikat verifikationer per konto kontoanalys kontokort kontohistorik stäm av stämma avstämning ledger account statement vouchers',
  },
  {
    slug: 'grundbok',
    labelKey: 'name_grundbok',
    descKey: 'desc_grundbok',
    category: 'ledgers',
    params: 'fiscal',
    exports: ['xlsx'],
  },
  {
    slug: 'kundreskontra',
    labelKey: 'name_kundreskontra',
    descKey: 'desc_kundreskontra',
    category: 'ledgers',
    params: 'fiscal',
    exports: ['pdf', 'xlsx'],
  },
  {
    slug: 'supplier-ledger',
    labelKey: 'name_supplier_ledger',
    descKey: 'desc_supplier_ledger',
    category: 'ledgers',
    params: 'fiscal',
    exports: ['pdf', 'xlsx'],
  },

  // --- Avstämning (reconciliation) ---
  {
    slug: 'bank-reconciliation',
    labelKey: 'name_bank_reconciliation',
    descKey: 'desc_bank_reconciliation',
    category: 'reconciliation',
    // Period-scoped like the ledgers: the report page's räkenskapsår selector
    // drives the reconciliation window (issue #751). Was 'none' (periodless),
    // which left the view to host its OWN fiscal-year selector inside a
    // loading-gated action bar: a render deadlock that hung the page on a
    // permanent skeleton (#771).
    //
    // 'fiscal-range' since 2026-08-20: the view used to host its own "Datum
    // från / Datum till" inputs plus a Filtrera button, a second period control
    // competing with the header's räkenskapsår picker (convention 8). It now
    // uses the shared ReportDateRange like every other report, mounted with a
    // full-year default and its own preset memory (see FocusedReport).
    params: 'fiscal-range',
    // 2026-08-25: the bank view was absorbed by /reconciliation (matcher,
    // manual N:1 matching, residual booking, IB tag, move-to-account all live
    // there). The slug stays for old links and the report library; it redirects.
    route: '/reconciliation',
  },

  // --- Export & arkiv: library-only ---
  {
    slug: 'sie-export',
    labelKey: 'name_sie_export',
    descKey: 'desc_sie_export',
    category: 'export',
    params: 'fiscal',
    route: '/import?view=export#sie-export',
    libraryOnly: true,
  },
  {
    // Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 p. 9.16): the
    // per-räkenskapsår processing history revisorer ask for at bokslut. Lives
    // with export & arkiv like Visma's Bokföring > Rapporter placement; the
    // date sub-range narrows to "what happened between these dates".
    slug: 'behandlingshistorik',
    labelKey: 'name_behandlingshistorik',
    descKey: 'desc_behandlingshistorik',
    category: 'export',
    params: 'fiscal-range',
    exports: ['pdf', 'xlsx'],
    libraryOnly: true,
    searchTerms:
      'behandlingshistorik audit trail audit log händelselogg ändringslogg logg historik vem gjorde vad processing history revision systemdokumentation',
  },
  {
    // Bokslutsbilagor (Reko 140/760/765): the pärm per räkenskapsår, one
    // bilaga per balance account as of the balansdag with balances, the
    // specification or stated balance, the sign-off and the underlag files.
    // Whole period only: a bilaga is per balansdag, not per date range.
    slug: 'bokslutsbilagor',
    labelKey: 'name_bokslutsbilagor',
    descKey: 'desc_bokslutsbilagor',
    category: 'export',
    params: 'fiscal',
    exports: ['pdf'],
    libraryOnly: true,
    searchTerms:
      'bokslutsbilagor bilagor bilaga bokslutspärm pärm avstämning avstämningar underlag signering reko balanskonton specifikation kontoutdrag engagemangsbesked checklista',
  },
]

/** Reports that take a fiscal period + optional date sub-range. */
export const DATE_RANGE_SLUGS: ReadonlySet<string> = new Set(
  REPORT_CATALOG.filter((r) => r.params === 'fiscal-range').map((r) => r.slug),
)

/** Reports that accept the per-dimension value filter (mounts DimensionFilter). */
export const DIMENSION_FILTER_SLUGS: ReadonlySet<string> = new Set(
  REPORT_CATALOG.filter((r) => r.dimensions).map((r) => r.slug),
)

export function getReport(slug: string): ReportDescriptor | undefined {
  return REPORT_CATALOG.find((r) => r.slug === slug)
}

function isVisible(
  r: ReportDescriptor,
  entityType?: EntityType,
  hasEmployees?: boolean,
  dimensionsEnabled?: boolean,
): boolean {
  if (r.entityType && r.entityType !== entityType) return false
  if (r.needsEmployees && !hasEmployees) return false
  if (r.needsDimensions && !dimensionsEnabled) return false
  return true
}

export interface ReportSection {
  category: ReportCategory
  labelKey: string
  items: ReportDescriptor[]
}

/** Grouped reports for the legacy desktop rail (excludes library-only items). */
export function getNavSections(
  entityType?: EntityType,
  dimensionsEnabled?: boolean,
): ReportSection[] {
  return NAV_CATEGORIES.map((category) => ({
    category,
    labelKey: CATEGORY_LABEL_KEY[category],
    items: REPORT_CATALOG.filter(
      (r) =>
        r.category === category &&
        !r.libraryOnly &&
        isVisible(r, entityType, undefined, dimensionsEnabled),
    ),
  })).filter((s) => s.items.length > 0)
}

/** Grouped reports for the library landing (includes everything visible). */
export function getLibrarySections(
  entityType?: EntityType,
  hasEmployees?: boolean,
  dimensionsEnabled?: boolean,
): ReportSection[] {
  return LIBRARY_CATEGORIES.map((category) => ({
    category,
    labelKey: CATEGORY_LABEL_KEY[category],
    items: REPORT_CATALOG.filter(
      (r) => r.category === category && isVisible(r, entityType, hasEmployees, dimensionsEnabled),
    ),
  })).filter((s) => s.items.length > 0)
}

/**
 * Token-AND match used by the report library's search box.
 *
 * Every whitespace-separated token in the query must appear somewhere in the
 * haystack, so narrowing words keep narrowing. Case- and diacritic-insensitive
 * so "stam av" finds "stäm av" and a Swedish keyboard is not required.
 */
export function reportMatchesQuery(haystack: string, query: string): boolean {
  const tokens = fold(query).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const hay = fold(haystack)
  return tokens.every((token) => hay.includes(token))
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}
