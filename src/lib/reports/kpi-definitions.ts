import type { KPIPreferences } from '@/types'
import { VAT_INPUT_ACCOUNTS, VAT_OUTPUT_ACCOUNTS } from '@/lib/reports/vat-declaration'

export interface KPIDefinition {
  id: string
  // Translation key suffix; used as `kpi.def_<id>_label` / `_description` / `_formula` / `_accounts`.
  defaultAccounts: string[]
  customizableAccounts: boolean
  defaultVisible: boolean
  format: 'currency' | 'percentage' | 'days'
  colorLogic: 'positive-good' | 'negative-good' | 'neutral'
  /**
   * True for a figure computed from the P&L (classes 3-8), which a dimension
   * filter narrows. The others (cash, VAT, receivables, payment days) stay
   * company-wide under a filter (lib/reports/kpi-report.ts), so the KPI page
   * hides them while one is active instead of showing a company figure next
   * to a project's (dimensionScopedPreferences).
   */
  followsDimensionFilter: boolean
}

export const KPI_DEFINITIONS: KPIDefinition[] = [
  {
    id: 'netResult',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'positive-good',
    followsDimensionFilter: true,
  },
  {
    id: 'cashPosition',
    defaultAccounts: ['1910', '1920', '1930', '1940', '1950', '1960', '1970', '1980'],
    customizableAccounts: true,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'positive-good',
    followsDimensionFilter: false,
  },
  {
    id: 'outstandingReceivables',
    defaultAccounts: ['1510'],
    customizableAccounts: false,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'neutral',
    followsDimensionFilter: false,
  },
  {
    id: 'vatLiability',
    // Same 26xx accounts as the momsdeklaration (ruta 49): see vat-declaration.ts
    defaultAccounts: [...VAT_OUTPUT_ACCOUNTS, ...VAT_INPUT_ACCOUNTS],
    customizableAccounts: true,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'negative-good',
    followsDimensionFilter: false,
  },
  {
    id: 'grossMargin',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: false,
    format: 'percentage',
    colorLogic: 'positive-good',
    followsDimensionFilter: true,
  },
  {
    id: 'expenseRatio',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: false,
    format: 'percentage',
    colorLogic: 'negative-good',
    followsDimensionFilter: true,
  },
  {
    id: 'avgPaymentDays',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: false,
    format: 'days',
    colorLogic: 'negative-good',
    followsDimensionFilter: false,
  },
]

export const ALL_KPI_IDS = KPI_DEFINITIONS.map((d) => d.id)

/**
 * The layout the KPI panes render while a dimension filter is active: the
 * user's own, minus the company-wide figures. Render-only, never saved: the
 * stored layout stays what the user chose.
 */
export function dimensionScopedPreferences(prefs: KPIPreferences): KPIPreferences {
  const scoped = new Set(KPI_DEFINITIONS.filter((d) => d.followsDimensionFilter).map((d) => d.id))
  return { ...prefs, visibleKpis: prefs.visibleKpis.filter((id) => scoped.has(id)) }
}

export function getDefaultPreferences(): KPIPreferences {
  return {
    visibleKpis: KPI_DEFINITIONS.filter((d) => d.defaultVisible).map((d) => d.id),
    kpiOrder: ALL_KPI_IDS,
    accountOverrides: {},
    showMonthlyTable: true,
  }
}

export function mergeWithDefaults(prefs: Partial<KPIPreferences>): KPIPreferences {
  const defaults = getDefaultPreferences()
  return {
    visibleKpis: prefs.visibleKpis ?? defaults.visibleKpis,
    kpiOrder: prefs.kpiOrder ?? defaults.kpiOrder,
    accountOverrides: prefs.accountOverrides ?? defaults.accountOverrides,
    showMonthlyTable: prefs.showMonthlyTable ?? defaults.showMonthlyTable,
  }
}
