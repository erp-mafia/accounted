'use client'

import { useState, useEffect } from 'react'
import type { Supplier, BASAccount, EntityType, FiscalPeriod } from '@/types'

/**
 * Reference data for the supplier-invoice editor: suppliers, the BAS chart,
 * company settings (entity type, accounting method, öresavrundning default,
 * dimensions, VAT registration) and fiscal periods. Extracted verbatim from
 * NewSupplierInvoiceForm; the fetch-once-on-mount semantics are unchanged.
 */
export function useSupplierInvoiceData() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [suppliersLoaded, setSuppliersLoaded] = useState(false)
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [entityType, setEntityType] = useState<EntityType>('enskild_firma')
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
  // Öresavrundning is display-only; defaults to the company-wide setting and is
  // overridable per invoice via the toggle in the totals section.
  const [oreRounding, setOreRounding] = useState<boolean>(true)
  // Dimension tagging (kostnadsställe/projekt). Affordances render only when
  // company_settings.dimensions_enabled: the same UI-visibility gate as
  // JournalEntryForm.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  // Icke momsregistrerad verksamhet has no right to deduct input VAT: the
  // moms controls disappear and every line books at 0 % (the gross amount IS
  // the cost). Defaults true so registered companies keep the 25 % prefill
  // while /api/settings is still in flight.
  const [vatRegistered, setVatRegistered] = useState(true)
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [periodsLoaded, setPeriodsLoaded] = useState(false)

  useEffect(() => {
    async function fetchSuppliers() {
      try {
        const res = await fetch('/api/suppliers')
        const { data } = await res.json()
        setSuppliers(data || [])
      } finally {
        setSuppliersLoaded(true)
      }
    }

    async function fetchAccounts() {
      const res = await fetch('/api/bookkeeping/accounts')
      const { data } = await res.json()
      setAccounts(data || [])
    }

    async function fetchEntityType() {
      try {
        const res = await fetch('/api/settings')
        const { data } = await res.json()
        if (data?.entity_type) setEntityType(data.entity_type)
        // Cash method books at payment, not registration: drives whether the
        // out-of-period warning is relevant (see willBookAtRegistration).
        if (data?.accounting_method === 'cash' || data?.accounting_method === 'accrual') {
          setAccountingMethod(data.accounting_method)
        }
        if (typeof data?.ore_rounding === 'boolean') setOreRounding(data.ore_rounding)
        setDimensionsEnabled(data?.dimensions_enabled === true)
        // Only an explicit false gates: a missing column or failed fetch keeps
        // the registered-company behavior.
        if (data?.vat_registered === false) setVatRegistered(false)
      } catch {
        // Default to enskild_firma / accrual, dimension affordances hidden
      }
    }

    async function fetchPeriods() {
      try {
        const res = await fetch('/api/bookkeeping/fiscal-periods')
        const { data } = await res.json()
        setPeriods(data || [])
      } catch {
        // Non-critical: the server still hard-blocks an out-of-period booking.
      } finally {
        setPeriodsLoaded(true)
      }
    }

    fetchSuppliers()
    fetchAccounts()
    fetchEntityType()
    fetchPeriods()
  }, [])

  return {
    suppliers,
    setSuppliers,
    suppliersLoaded,
    accounts,
    entityType,
    accountingMethod,
    oreRounding,
    setOreRounding,
    dimensionsEnabled,
    vatRegistered,
    periods,
    periodsLoaded,
  }
}
