'use client'

import { useCallback, useMemo, useState } from 'react'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import {
  useAccounts,
  useCompanySettings,
  useFiscalPeriods,
  useSuppliers,
} from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { deriveSupplierInvoiceDefaults } from './supplier-invoice-defaults'

/**
 * Reference data for the supplier-invoice editor: suppliers, the BAS chart,
 * company settings (entity type, accounting method, öresavrundning default,
 * dimensions, VAT registration) and fiscal periods.
 *
 * All of it comes from the session cache (lib/reference-data), seeded by the
 * dashboard layout, so the form renders with its moms controls, period and
 * account picker already resolved on the first paint instead of defaulting
 * (vatRegistered=true, series, period) and flipping once four fetches land.
 * The settings-driven values are derived (deriveSupplierInvoiceDefaults),
 * never copied into state, so a background revalidation cannot get them out
 * of step; the per-invoice öresavrundning toggle is the one local override.
 */
export function useSupplierInvoiceData() {
  const company = useCompanyOptional()?.company ?? null
  const { suppliers, isLoading: suppliersLoading } = useSuppliers()
  const { accounts } = useAccounts()
  const { settings } = useCompanySettings()
  const { periods, isLoading: periodsLoading } = useFiscalPeriods()

  const defaults = useMemo(
    () => deriveSupplierInvoiceDefaults(settings, company?.entity_type ?? null),
    [settings, company?.entity_type],
  )
  const [oreRoundingOverride, setOreRoundingOverride] = useState<boolean | null>(null)
  const setOreRounding = useCallback((value: boolean) => setOreRoundingOverride(value), [])

  /** After an inline supplier create: refresh the shared list everywhere. */
  const refreshSuppliers = useCallback(() => invalidateReferenceData('ref:suppliers'), [])

  return {
    suppliers,
    refreshSuppliers,
    suppliersLoaded: !suppliersLoading,
    accounts,
    entityType: defaults.entityType,
    accountingMethod: defaults.accountingMethod,
    oreRounding: oreRoundingOverride ?? defaults.oreRounding,
    setOreRounding,
    dimensionsEnabled: defaults.dimensionsEnabled,
    vatRegistered: defaults.vatRegistered,
    periods,
    periodsLoaded: !periodsLoading,
  }
}
