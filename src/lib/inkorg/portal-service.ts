/**
 * A company's own supplier portals (public.company_portals): add one from a
 * purchase, change its link, take it away. The rules live here; the doors
 * (/api/inkorg/portals) only read the request and map the outcome.
 *
 *   - The supplier is never typed. It is the purchase's own counterparty: the
 *     key is the bank row folded the way the resolver matches it
 *     (portalKeyFor), the name is the one the Inkorg shows for the purchase
 *     (purchaseDisplay): the vendor's own title when its mark is known
 *     ("Telia"), else the row's name without the trailing words the same
 *     fold drops ("Ellevio AB Autogiro" is Ellevio, "Papperssladan K3667" is
 *     Papperssladan), so "Öppna Ellevio" reads as a person would say it.
 *   - Salary, tax and fees have no supplier invoice, and a bank row that
 *     names nobody ("INTERNET BET 4") has no supplier: neither gets a portal.
 *   - The link is stored only as the URL rule leaves it (normalizePortalUrl).
 *   - One portal per supplier: adding it again changes its link.
 *
 * Every query filters by company_id beside RLS, which also holds the role
 * (viewers write nothing) and the who (created_by is the signed-in person).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { namesCounterparty } from '@/lib/bookkeeping/counterparty-templates'
import { normalizeForMatch } from '@/lib/documents/core-receipt-matcher'
import { dbError } from '@/lib/errors/db-error'
import { MAX_PORTAL_VENDOR_LENGTH, normalizePortalUrl, portalKeyFor, type CompanyPortal } from '@/lib/receipt-hunt/company-portals'
import { canHaveEmailReceipt } from '@/lib/receipt-hunt/select'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { vendorLook } from '@/lib/vendor-marks'
import { purchaseDisplay } from './missing'

export type PortalFailureCode =
  | 'INKORG_PORTAL_URL_INVALID'
  | 'INKORG_PORTAL_PURCHASE_NOT_FOUND'
  | 'INKORG_PORTAL_NO_SUPPLIER'
  | 'INKORG_PORTAL_NOT_FOUND'

export type PortalOutcome<T> = { ok: true; data: T } | { ok: false; code: PortalFailureCode }

/** A company portal as the API answers it. */
export interface CompanyPortalRow extends CompanyPortal {
  created_at: string
  updated_at: string
}

/** Postgres unique_violation: the supplier has a portal already. */
const UNIQUE_VIOLATION = '23505'

/** Every portal the company added, by supplier name. */
export async function listCompanyPortals(supabase: SupabaseClient, companyId: string): Promise<CompanyPortalRow[]> {
  const rows = await fetchAllRows<CompanyPortalRow>(({ from, to }) =>
    supabase
      .from('company_portals')
      .select('id, counterparty_key, vendor_name, url, created_at, updated_at')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
  return rows.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'sv'))
}

/** A name without its trailing words that name nobody: a legal form, a payment rail, a card token. */
function withoutTrailingNoise(name: string): string {
  const words = name.trim().split(/\s+/)
  while (words.length > 1 && !normalizeForMatch(words[words.length - 1])) words.pop()
  return words.join(' ')
}

/**
 * The supplier of a purchase as a portal stores it: the key it is matched by
 * and the name it is shown by. Null when the purchase has no supplier that
 * could keep an invoice behind a login.
 */
export function portalSupplierOf(purchase: { merchant_name: string | null; description: string | null }): {
  key: string
  vendor: string
} | null {
  const descriptor = purchase.merchant_name?.trim() || purchase.description?.trim() || null
  if (!descriptor || !canHaveEmailReceipt(descriptor) || !namesCounterparty(descriptor)) return null
  const key = portalKeyFor(descriptor)
  const { name, vendor: mark } = purchaseDisplay(purchase)
  const title = mark ? vendorLook(mark)?.title : null
  const vendor = (title ?? (name ? withoutTrailingNoise(name) : '')).slice(0, MAX_PORTAL_VENDOR_LENGTH).trim()
  if (!key || !vendor) return null
  return { key, vendor }
}

/**
 * Adds the portal for the supplier of the company's purchase `transactionId`,
 * or changes its link when the supplier has one already.
 */
export async function createCompanyPortal(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: { transactionId: string; url: string },
): Promise<PortalOutcome<CompanyPortalRow>> {
  const link = normalizePortalUrl(input.url)
  if (!link.ok) return { ok: false, code: 'INKORG_PORTAL_URL_INVALID' }

  const { data: purchase, error: readError } = await supabase
    .from('transactions')
    .select('id, merchant_name, description')
    .eq('company_id', companyId)
    .eq('id', input.transactionId)
    .maybeSingle()
  if (readError) throw dbError(readError, 'company portal: purchase read failed')
  if (!purchase) return { ok: false, code: 'INKORG_PORTAL_PURCHASE_NOT_FOUND' }

  const supplier = portalSupplierOf(purchase as { merchant_name: string | null; description: string | null })
  if (!supplier) return { ok: false, code: 'INKORG_PORTAL_NO_SUPPLIER' }

  const { data: created, error: insertError } = await supabase
    .from('company_portals')
    .insert({
      company_id: companyId,
      counterparty_key: supplier.key,
      vendor_name: supplier.vendor,
      url: link.url,
      created_by: userId,
    })
    .select('id, counterparty_key, vendor_name, url, created_at, updated_at')
    .single()
  if (!insertError) return { ok: true, data: created as CompanyPortalRow }
  if ((insertError as { code?: string }).code !== UNIQUE_VIOLATION) {
    throw dbError(insertError, 'company portal: insert failed')
  }

  // The supplier has a portal already (another tab, another person): the new link is its link now.
  const { data: updated, error: updateError } = await supabase
    .from('company_portals')
    .update({ url: link.url })
    .eq('company_id', companyId)
    .eq('counterparty_key', supplier.key)
    .select('id, counterparty_key, vendor_name, url, created_at, updated_at')
    .maybeSingle()
  if (updateError) throw dbError(updateError, 'company portal: update failed')
  if (!updated) return { ok: false, code: 'INKORG_PORTAL_NOT_FOUND' }
  return { ok: true, data: updated as CompanyPortalRow }
}

/** A new link for one of the company's portals; which supplier it is stays. */
export async function updateCompanyPortal(
  supabase: SupabaseClient,
  companyId: string,
  portalId: string,
  url: string,
): Promise<PortalOutcome<CompanyPortalRow>> {
  const link = normalizePortalUrl(url)
  if (!link.ok) return { ok: false, code: 'INKORG_PORTAL_URL_INVALID' }
  const { data, error } = await supabase
    .from('company_portals')
    .update({ url: link.url })
    .eq('company_id', companyId)
    .eq('id', portalId)
    .select('id, counterparty_key, vendor_name, url, created_at, updated_at')
    .maybeSingle()
  if (error) throw dbError(error, 'company portal: update failed')
  if (!data) return { ok: false, code: 'INKORG_PORTAL_NOT_FOUND' }
  return { ok: true, data: data as CompanyPortalRow }
}

/** Takes the portal away: its supplier's purchases fall back to the directory, or to no portal. */
export async function deleteCompanyPortal(
  supabase: SupabaseClient,
  companyId: string,
  portalId: string,
): Promise<PortalOutcome<{ id: string }>> {
  const { data, error } = await supabase
    .from('company_portals')
    .delete()
    .eq('company_id', companyId)
    .eq('id', portalId)
    .select('id')
    .maybeSingle()
  if (error) throw dbError(error, 'company portal: delete failed')
  if (!data) return { ok: false, code: 'INKORG_PORTAL_NOT_FOUND' }
  return { ok: true, data: { id: (data as { id: string }).id } }
}
