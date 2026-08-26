/**
 * Fetchers behind the reference-data hooks. Pure async functions so they can
 * be unit-tested without React and reused by `preload()` warm-ups.
 *
 * Two transports, chosen per data set:
 *   - Browser Supabase for the trivial RLS-scoped selects (fiscal periods,
 *     cash accounts). These mirror the corresponding API routes exactly
 *     (period.list ordering, listForCompany ordering) and save the proxy +
 *     route-wrapper round trips the API path pays.
 *   - `/api/...` for lists whose route does real work the client must not
 *     reimplement: accounts (list_company_accounts RPC with the paged
 *     fallback), dimensions (ensure_company_dimensions + pagination),
 *     booking templates (team scoping + last-used ordering), customers
 *     (personal-number masking), suppliers and articles.
 *
 * Do not import lib/cash-accounts/service.ts here: it pulls lib/logger and
 * the account-sync module into the client bundle. The two order() clauses
 * are mirrored instead and pinned by a test.
 */

import { createClient } from '@/lib/supabase/client'
import type {
  Article,
  BASAccount,
  BookingTemplateLibrary,
  CashAccount,
  Customer,
  FiscalPeriod,
  Supplier,
} from '@/types'
import type { DimensionDto } from '@/components/dimensions/types'

export class ReferenceFetchError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(url: string, status: number, body: unknown) {
    super(`Reference data request failed: ${status} ${url}`)
    this.name = 'ReferenceFetchError'
    this.status = status
    this.body = body
  }
}

/** A booking_templates row as the list route returns it, with its last-used stamp. */
export type BookingTemplateWithUsage = BookingTemplateLibrary & { last_used_at: string | null }

export async function fetchFiscalPeriods(companyId: string): Promise<FiscalPeriod[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })
  if (error) throw error
  return (data ?? []) as FiscalPeriod[]
}

export async function fetchCashAccounts(companyId: string): Promise<CashAccount[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .order('is_primary', { ascending: false })
    .order('ledger_account', { ascending: true })
  if (error) throw error
  return (data ?? []) as CashAccount[]
}

async function getJson<T>(url: string, pick: (body: Record<string, unknown>) => unknown): Promise<T> {
  const res = await fetch(url)
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw new ReferenceFetchError(url, res.status, body)
  const picked = pick((body ?? {}) as Record<string, unknown>)
  return (picked ?? []) as T
}

export function fetchAccounts(activeOnly = true): Promise<BASAccount[]> {
  const url = activeOnly
    ? '/api/bookkeeping/accounts'
    : '/api/bookkeeping/accounts?active=false'
  return getJson<BASAccount[]>(url, (b) => b.data)
}

export function fetchDimensions(): Promise<DimensionDto[]> {
  return getJson<DimensionDto[]>('/api/dimensions', (b) => b.dimensions)
}

export function fetchBookingTemplates(): Promise<BookingTemplateWithUsage[]> {
  return getJson<BookingTemplateWithUsage[]>('/api/settings/booking-templates', (b) => b.data)
}

export function fetchCustomers(): Promise<Customer[]> {
  return getJson<Customer[]>('/api/customers', (b) => b.data)
}

export function fetchSuppliers(): Promise<Supplier[]> {
  return getJson<Supplier[]>('/api/suppliers', (b) => b.data)
}

export function fetchArticles(includeInactive = false): Promise<Article[]> {
  const url = includeInactive ? '/api/articles?include_inactive=1' : '/api/articles'
  return getJson<Article[]>(url, (b) => b.data)
}
