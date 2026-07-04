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
}

export const KPI_DEFINITIONS: KPIDefinition[] = [
  {
    id: 'netResult',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'positive-good',
  },
  {
    id: 'cashPosition',
    defaultAccounts: ['1910', '1920', '1930', '1940', '1950', '1960', '1970', '1980'],
    customizableAccounts: true,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'positive-good',
  },
  {
    id: 'outstandingReceivables',
    defaultAccounts: ['1510'],
    customizableAccounts: false,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'neutral',
  },
  {
    id: 'vatLiability',
    // Same 26xx accounts as the momsdeklaration (ruta 49): see vat-declaration.ts
    defaultAccounts: [...VAT_OUTPUT_ACCOUNTS, ...VAT_INPUT_ACCOUNTS],
    customizableAccounts: true,
    defaultVisible: true,
    format: 'currency',
    colorLogic: 'negative-good',
  },
  {
    id: 'grossMargin',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: false,
    format: 'percentage',
    colorLogic: 'positive-good',
  },
  {
    id: 'expenseRatio',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: false,
    format: 'percentage',
    colorLogic: 'negative-good',
  },
  {
    id: 'avgPaymentDays',
    defaultAccounts: [],
    customizableAccounts: false,
    defaultVisible: false,
    format: 'days',
    colorLogic: 'negative-good',
  },
]

export const ALL_KPI_IDS = KPI_DEFINITIONS.map((d) => d.id)

export function getKPIDefinition(id: string): KPIDefinition | undefined {
  return KPI_DEFINITIONS.find((d) => d.id === id)
}

export function getDefaultPreferences(): KPIPreferences {
  return {
    visibleKpis: KPI_DEFINITIONS.filter((d) => d.defaultVisible).map((d) => d.id),
    kpiOrder: ALL_KPI_IDS,
    accountOverrides: {},
  }
}

export function mergeWithDefaults(prefs: Partial<KPIPreferences>): KPIPreferences {
  const defaults = getDefaultPreferences()
  return {
    visibleKpis: prefs.visibleKpis ?? defaults.visibleKpis,
    kpiOrder: prefs.kpiOrder ?? defaults.kpiOrder,
    accountOverrides: prefs.accountOverrides ?? defaults.accountOverrides,
  }
}
