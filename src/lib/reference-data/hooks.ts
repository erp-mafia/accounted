'use client'

/**
 * Company-scoped reference data, cached for the session.
 *
 * Why: forms and pickers used to fetch the same fiscal periods, accounts,
 * cash accounts, settings, dimensions and templates on every mount and every
 * dialog open (fiscal periods from 47 call sites, settings from 27), each
 * request paying the auth proxy + route wrapper before its own query. That
 * is the customer-visible "fields load late when clicking around". These
 * hooks share one SWR cache entry per company and data set, render from the
 * cache (or the server seed, see components/providers/ReferenceDataSeed.tsx)
 * on first paint, and revalidate in the background.
 *
 * Rules:
 *   - Keys come from lib/reference-data/keys.ts only.
 *   - After a client write, call invalidateReferenceData() from
 *     lib/reference-data/invalidate.ts; the dedupe window is bypassed.
 *   - `revalidateIfStale` stays on so writes made elsewhere (MCP, agent,
 *     another tab, SIE import) surface within a minute of the next mount.
 *   - Consumers needing `entity_type` read useCompany().company.entity_type:
 *     /api/settings falls back to companies.entity_type, this hook does not.
 */

import { useMemo } from 'react'
import useSWR, { type SWRConfiguration } from 'swr'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type {
  Article,
  Employee,
  BASAccount,
  Customer,
  FiscalPeriod,
  Supplier,
} from '@/types'
import type { DimensionDto } from '@/components/dimensions/types'
import type { CashAccountWithBank } from '@/lib/cash-accounts/labels'
import { refKeys } from './keys'
import { missingKeepId, withKeptRow } from './keep-row'
import {
  fetchAccounts,
  fetchArticles,
  fetchBookingTemplates,
  fetchCashAccounts,
  fetchCustomer,
  fetchCustomers,
  fetchDimensions,
  fetchEmployees,
  fetchFiscalPeriods,
  fetchSuppliers,
  type BookingTemplateWithUsage,
} from './fetchers'

export { useCompanySettings } from '@/components/settings/useSettings'

export const REFERENCE_SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  // At most one background refresh per key per minute; mutate() bypasses it.
  dedupingInterval: 60_000,
  // Never blank a picker while a refresh is in flight.
  keepPreviousData: true,
} satisfies SWRConfiguration

const EMPTY: never[] = []

export interface ReferenceListState {
  /** True only while the FIRST load for this key is in flight (no cache, no seed). */
  isLoading: boolean
  error: unknown
  /** Re-run the fetch for this key now (bypasses the dedupe window). */
  refresh: () => Promise<unknown>
}

function useActiveCompanyId(): string | null {
  return useCompanyOptional()?.company?.id ?? null
}

function useReferenceList<T, K extends readonly unknown[] | null>(
  key: K,
  fetcher: (key: NonNullable<K>) => Promise<T[]>,
): ReferenceListState & { items: T[] } {
  const { data, error, isLoading, mutate } = useSWR<T[]>(
    key,
    fetcher as (key: unknown) => Promise<T[]>,
    REFERENCE_SWR_OPTIONS,
  )
  return {
    items: data ?? (EMPTY as T[]),
    isLoading: key !== null && isLoading,
    error,
    refresh: mutate,
  }
}

export function useFiscalPeriods(): ReferenceListState & { periods: FiscalPeriod[] } {
  const companyId = useActiveCompanyId()
  const { items, ...state } = useReferenceList(refKeys.fiscalPeriods(companyId), ([, id]) =>
    fetchFiscalPeriods(id),
  )
  return { periods: items, ...state }
}

export function useCashAccounts(
  options: { enabledOnly?: boolean } = {},
): ReferenceListState & { cashAccounts: CashAccountWithBank[] } {
  const companyId = useActiveCompanyId()
  const { items, ...state } = useReferenceList(refKeys.cashAccounts(companyId), ([, id]) =>
    fetchCashAccounts(id),
  )
  const enabledOnly = options.enabledOnly ?? false
  // One cache entry serves both variants: the enabled filter is cheap and
  // keeping a single key means one seed and one invalidation.
  const cashAccounts = useMemo(
    () => (enabledOnly ? items.filter((a) => a.enabled) : items),
    [items, enabledOnly],
  )
  return { cashAccounts, ...state }
}

export function useAccounts(activeOnly = true): ReferenceListState & { accounts: BASAccount[] } {
  const companyId = useActiveCompanyId()
  const { items, ...state } = useReferenceList(refKeys.accounts(companyId, activeOnly), ([, , active]) =>
    fetchAccounts(active),
  )
  return { accounts: items, ...state }
}

export function useDimensions(): ReferenceListState & { dimensions: DimensionDto[] } {
  const companyId = useActiveCompanyId()
  const { items, ...state } = useReferenceList(refKeys.dimensions(companyId), () => fetchDimensions())
  return { dimensions: items, ...state }
}

export function useBookingTemplates(): ReferenceListState & { templates: BookingTemplateWithUsage[] } {
  const companyId = useActiveCompanyId()
  const { items, ...state } = useReferenceList(refKeys.bookingTemplates(companyId), () =>
    fetchBookingTemplates(),
  )
  return { templates: items, ...state }
}

/**
 * The company's customers. /api/customers leaves archived customers out, so a
 * form editing a draft, schedule, order or deadline that points at one passes
 * its id as `keepId`: that one customer is fetched on its own and kept in the
 * list (CustomerCombobox's `keepId` then keeps it selectable), or the picker
 * would render blank.
 */
export function useCustomers(
  options: { keepId?: string | null } = {},
): ReferenceListState & { customers: Customer[] } {
  const companyId = useActiveCompanyId()
  const { items, ...state } = useReferenceList(refKeys.customers(companyId), () => fetchCustomers())
  const { data: kept } = useSWR<Customer | null>(
    refKeys.customer(companyId, missingKeepId(items, options.keepId, state.isLoading)),
    ([, , id]: readonly [string, string, string]) =>
      // A customer that no longer resolves simply leaves the picker unselected.
      fetchCustomer(id).catch(() => null),
    REFERENCE_SWR_OPTIONS,
  )
  const customers = useMemo(() => withKeptRow(items, kept), [items, kept])
  return { customers, ...state }
}

export function useSuppliers(): ReferenceListState & { suppliers: Supplier[] } {
  const companyId = useActiveCompanyId()
  const { items, ...state } = useReferenceList(refKeys.suppliers(companyId), () => fetchSuppliers())
  return { suppliers: items, ...state }
}

/**
 * The salary roster, active employees unless `includeInactive`. Invalidate
 * 'ref:employees' after creating, editing or removing an employee.
 */
export function useEmployees(
  options: { includeInactive?: boolean } = {},
): ReferenceListState & { employees: Employee[] } {
  const companyId = useActiveCompanyId()
  const includeInactive = options.includeInactive ?? false
  const { items, ...state } = useReferenceList(
    refKeys.employees(companyId, includeInactive),
    ([, , inactive]) => fetchEmployees(inactive),
  )
  return { employees: items, ...state }
}

export function useArticles(
  options: { includeInactive?: boolean } = {},
): ReferenceListState & { articles: Article[] } {
  const companyId = useActiveCompanyId()
  const includeInactive = options.includeInactive ?? false
  const { items, ...state } = useReferenceList(
    refKeys.articles(companyId, includeInactive),
    ([, , inactive]) => fetchArticles(inactive),
  )
  return { articles: items, ...state }
}
