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
 * - `calendar`: calendar year + monthly/quarterly/yearly period (VAT family) —
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
   * P&L-safe reports ONLY — statutory outputs (balance sheet, balansrapport,
   * kassaflöde, årsredovisning, INK2, NE, VAT, SIE) must never carry this
   * flag; a filtered filing is a wrong filing. The whitelist is pinned by
   * lib/reports/__tests__/dimension-statutory-guard.test.ts.
   */
  dimensions?: boolean
  /** Only shown when company_settings.dimensions_enabled is true. */
  needsDimensions?: boolean
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
    // Resultat per projekt/kostnadsställe — value-as-column P&L matrix over
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
    params: 'fiscal',
    exports: ['xlsx'],
    dimensions: true,
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
    exports: ['xlsx'],
  },
  {
    slug: 'supplier-ledger',
    labelKey: 'name_supplier_ledger',
    descKey: 'desc_supplier_ledger',
    category: 'ledgers',
    params: 'fiscal',
    exports: ['xlsx'],
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
    // loading-gated action bar — a render deadlock that hung the page on a
    // permanent skeleton (#771).
    params: 'fiscal',
  },

  // --- Export & arkiv — library-only ---
  {
    slug: 'sie-export',
    labelKey: 'name_sie_export',
    descKey: 'desc_sie_export',
    category: 'export',
    params: 'fiscal',
    route: '/import?view=export#sie-export',
    libraryOnly: true,
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
