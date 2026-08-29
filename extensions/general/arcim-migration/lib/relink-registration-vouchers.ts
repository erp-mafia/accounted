/**
 * Re-run the registration-voucher link for a company that was migrated
 * before the migration wrote it (or whose GL landed via SIE after the
 * invoices did).
 *
 * The imported invoice rows do not store the provider's voucher ref, so the
 * only way to recover it is to ask the provider again: the registers are
 * re-fetched (hydrated, so Fortnox detail payloads carry VoucherSeries /
 * VoucherNumber), joined to the invoices that are still unlinked, and handed
 * to the core linker, which decides and writes with the same guarantees the
 * migration itself uses. Nothing is inserted: an invoice the provider knows
 * but this company does not is skipped, not imported.
 *
 * Join keys are deliberately strict. Sales invoices join on invoice_number
 * (UNIQUE per company). Supplier invoices join on the supplier's invoice
 * number AND the invoice date, and only when that pair is unique on both
 * sides: two suppliers can legitimately issue "1001" in the same year, and a
 * wrong join here would hand the linker a plausible but wrong candidate.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderName } from '@/lib/providers/types'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import {
  fetchSalesInvoicesHydrated,
  fetchSupplierInvoicesHydrated,
} from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  linkMigratedRegistrationVouchers,
  type MigratedInvoiceLinkInput,
  type RegistrationLinkResult,
} from '@/lib/invoices/link-migrated-registration-vouchers'

export interface RelinkRegistrationVouchersOptions {
  supabase: SupabaseClient
  companyId: string
  consentId: string
  dryRun?: boolean
}

export interface RelinkRegistrationVouchersResult extends RegistrationLinkResult {
  /** Invoices the provider returned (both registers). */
  providerInvoices: number
  /** Provider invoices that joined to an unlinked invoice here and were scanned. */
  matched: number
  /** Provider invoices with no unlinked counterpart here (already linked, never imported, or ambiguous join). */
  unmatched: number
}

interface UnlinkedSalesRow {
  id: string
  invoice_number: string | null
  invoice_date: string
  total_sek: number | null
}

interface UnlinkedSupplierRow {
  id: string
  supplier_invoice_number: string | null
  invoice_date: string
  total_sek: number | null
}

function supplierJoinKey(number: string | null | undefined, date: string | null | undefined): string | null {
  return number && date ? `${number}::${date}` : null
}

/** A map that remembers keys seen more than once, so those are never joined on. */
function uniqueByKey<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T> {
  const out = new Map<string, T>()
  const dupes = new Set<string>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    if (out.has(key) || dupes.has(key)) {
      out.delete(key)
      dupes.add(key)
      continue
    }
    out.set(key, row)
  }
  return out
}

export async function relinkRegistrationVouchers(
  options: RelinkRegistrationVouchersOptions,
): Promise<RelinkRegistrationVouchersResult> {
  const { supabase, companyId, consentId, dryRun = false } = options

  const resolved = await resolveConsent(companyId, consentId)
  const provider = resolved.consent.provider as ProviderName

  const [{ invoices: providerSales }, { invoices: providerSupplier }] = await Promise.all([
    fetchSalesInvoicesHydrated(provider, resolved.accessToken, resolved.providerCompanyId),
    fetchSupplierInvoicesHydrated(provider, resolved.accessToken, resolved.providerCompanyId),
  ])

  const [unlinkedSales, unlinkedSupplier] = await Promise.all([
    fetchAllRows<UnlinkedSalesRow>(({ from, to }) =>
      supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, total_sek')
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<UnlinkedSupplierRow>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, invoice_date, total_sek')
        .eq('company_id', companyId)
        .is('registration_journal_entry_id', null)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  const salesByNumber = uniqueByKey(unlinkedSales, (row) => row.invoice_number || null)
  const supplierByKey = uniqueByKey(unlinkedSupplier, (row) =>
    supplierJoinKey(row.supplier_invoice_number, row.invoice_date),
  )
  const providerSalesUnique = uniqueByKey(providerSales, (dto) => dto.invoiceNumber || null)
  const providerSupplierUnique = uniqueByKey(providerSupplier, (dto) =>
    supplierJoinKey(dto.invoiceNumber, dto.issueDate),
  )

  const inputs: MigratedInvoiceLinkInput[] = []
  for (const [number, dto] of providerSalesUnique) {
    const row = salesByNumber.get(number)
    if (!row) continue
    inputs.push({
      invoiceId: row.id,
      kind: 'customer',
      sourceVoucher: dto.sourceVoucher ?? null,
      invoiceDate: row.invoice_date,
      totalSek: row.total_sek,
      invoiceNumber: number,
    })
  }
  for (const [key, dto] of providerSupplierUnique) {
    const row = supplierByKey.get(key)
    if (!row) continue
    inputs.push({
      invoiceId: row.id,
      kind: 'supplier',
      sourceVoucher: dto.sourceVoucher ?? null,
      invoiceDate: row.invoice_date,
      totalSek: row.total_sek,
      invoiceNumber: dto.invoiceNumber || null,
    })
  }

  const links = await linkMigratedRegistrationVouchers({ supabase, companyId, invoices: inputs, dryRun })
  const providerInvoices = providerSales.length + providerSupplier.length

  return {
    ...links,
    providerInvoices,
    matched: inputs.length,
    unmatched: providerInvoices - inputs.length,
  }
}
