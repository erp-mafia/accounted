import type { CompanySettings, EntityType } from '@/types'

export interface SupplierInvoiceDefaults {
  entityType: EntityType
  accountingMethod: 'accrual' | 'cash'
  /** Company-wide öresavrundning default; overridable per invoice. */
  oreRounding: boolean
  /** UI gate for kostnadsställe/projekt affordances (same as JournalEntryForm). */
  dimensionsEnabled: boolean
  /**
   * Icke momsregistrerad verksamhet has no right to deduct input VAT: the
   * moms controls disappear and every line books at 0 % (the gross amount IS
   * the cost). Only an explicit false gates: a missing column keeps the
   * registered-company behaviour.
   */
  vatRegistered: boolean
}

/**
 * Pure derivation of the supplier-invoice editor's settings-driven defaults.
 * `fallbackEntityType` is the company row's entity type: /api/settings used
 * to fall back to it when company_settings.entity_type is null, and the
 * cached settings row does not, so the caller passes it explicitly.
 */
export function deriveSupplierInvoiceDefaults(
  settings: CompanySettings | null | undefined,
  fallbackEntityType?: EntityType | null,
): SupplierInvoiceDefaults {
  const entityType =
    (settings?.entity_type as EntityType | null | undefined) ?? fallbackEntityType ?? 'enskild_firma'
  return {
    entityType,
    accountingMethod: settings?.accounting_method === 'cash' ? 'cash' : 'accrual',
    oreRounding: typeof settings?.ore_rounding === 'boolean' ? settings.ore_rounding : true,
    dimensionsEnabled: settings?.dimensions_enabled === true,
    vatRegistered: settings?.vat_registered !== false,
  }
}
