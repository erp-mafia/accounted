import { createLogger } from '@/lib/logger'
import { bokioSupplierSource } from './bokio-supplier-source'
import { withinMigrationDeadline } from './migration-job-worker'
import { ISO_DATE_RE } from '@/lib/invariants'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveConsent, type ResolvedConsent } from '@/lib/providers/resolve-consent'
import { fetchSupplierInvoicesDirect, hydrateSupplierInvoices } from '@/lib/providers/provider-data-fetcher'
import type { SupplierInvoiceDto } from '@/lib/providers/dto'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withExecutionDeadline, queryInExecutionBudget, ExecutionBudgetExceeded } from '@/lib/http/execution-budget'
import { buildVoucherIndex, fetchFiscalPeriods, fetchVouchersForNumbers, resolveDatedRef } from '@/lib/documents/voucher-ref-resolver'
import { linkMigratedRegistrationVouchers, type MigratedInvoiceLinkInput } from '@/lib/invoices/link-migrated-registration-vouchers'
import { mapSupplierInvoice } from './entity-mapper'
import { refreshMigratedSupplierPaymentState } from './refresh-migrated-payment-state'

export interface BokioSupplierSnapshot {
  connection: ResolvedConsent
  invoices: SupplierInvoiceDto[]
}
export interface BokioSupplierRow {
  id: string; user_id: string; supplier_id: string; supplier_invoice_number: string | null; invoice_date: string
  total: number; total_sek: number | null; subtotal: number; vat_amount: number; currency: string; is_credit_note: boolean
  status: string; paid_at: string | null; created_at: string; updated_at: string; document_id: string | null
  registration_journal_entry_id: string | null; payment_journal_entry_id: string | null
  supplier_invoice_items: { id: string; line_total: number; vat_amount: number }[]
}
interface SourceMapping { resource: string; source_id: string; target_id: string }
interface Supplier { id: string; name: string }
interface Progress { invoice_id: string; next_attempt_at: string }
interface Receipt { outcome: string; changed: boolean; rows?: number; header_updated?: boolean; settlement?: { code?: string }; event_id?: string }

export function bokioAccountKey(connection: ResolvedConsent, consentId: string): string {
  return String(connection.consent.org_number ?? '').replace(/[^a-z0-9]/gi, '') || connection.providerCompanyId || consentId
}
export async function loadBokioSupplierSnapshot(companyId: string, consentId: string): Promise<BokioSupplierSnapshot> {
  const connection = await resolveConsent(companyId, consentId)
  if (connection.consent.provider !== 'bokio') throw new Error('BOKIO_CONSENT_REQUIRED')
  return { connection, invoices: await fetchSupplierInvoicesDirect('bokio', connection.accessToken, connection.providerCompanyId) }
}

/** Ambiguity is measured across the full population, never only pending rows. */
function unique<T>(values: T[], key: (value: T) => string | undefined): Map<string, T> {
  const result = new Map<string, T>(); const duplicates = new Set<string>()
  for (const value of values) {
    const k = key(value); if (!k || duplicates.has(k)) continue
    if (result.has(k)) { result.delete(k); duplicates.add(k) } else result.set(k, value)
  }
  return result
}
const identity = (supplier: string, number: string | null, date: string, currency: string, total: number, credit: boolean) =>
  ISO_DATE_RE.test(date) && Number.isFinite(total)
    ? JSON.stringify([supplier, number || null, date, currency, Math.round(total * 100), credit]) : undefined

export function matchBokioSupplierInvoices(rows: BokioSupplierRow[], invoices: SupplierInvoiceDto[], suppliers: Supplier[], mappings: SourceMapping[]) {
  const sources = unique(invoices, dto => dto.id)
  const localSuppliers = unique(suppliers, s => s.name.trim())
  const sourceParties = new Map<string, { id: string; name: string }>()
  for (const dto of invoices) {
    const ref = dto._raw?.supplierRef as { id?: string; name?: string } | undefined
    if (ref?.id && ref.name) sourceParties.set(ref.id, { id: ref.id, name: ref.name })
  }
  const uniqueSourceNames = unique([...sourceParties.values()], p => p.name.trim())
  const partyMappings = new Map(mappings.filter(m => m.resource === 'suppliers').map(m => [m.source_id, m.target_id]))
  const sourceSupplier = (dto: SupplierInvoiceDto): string | undefined => {
    const ref = dto._raw?.supplierRef as { id?: string; name?: string } | undefined
    if (!ref?.id) return undefined
    const mapped = partyMappings.get(ref.id)
    if (mapped && suppliers.some(s => s.id === mapped)) return mapped
    return ref.name && uniqueSourceNames.get(ref.name.trim())?.id === ref.id ? localSuppliers.get(ref.name.trim())?.id : undefined
  }
  const sourceKey = (dto: SupplierInvoiceDto) => {
    const supplier = sourceSupplier(dto)
    return supplier ? identity(supplier, dto.invoiceNumber, dto.issueDate, dto.currencyCode,
      Math.abs(dto.legalMonetaryTotal.payableAmount.value), dto.invoiceTypeCode === '381') : undefined
  }
  const localKey = (row: BokioSupplierRow) => identity(row.supplier_id, row.supplier_invoice_number, row.invoice_date, row.currency, row.total, row.is_credit_note)
  const sourceByKey = unique(invoices, dto => dto.invoiceNumber ? sourceKey(dto) : undefined)
  const localByKey = unique(rows, row => row.supplier_invoice_number ? localKey(row) : undefined)
  const mappedTargets = new Set(mappings.filter(m => m.resource === 'supplierInvoices').map(m => m.target_id))
  const mappedByTarget = unique(mappings.filter(m => m.resource === 'supplierInvoices'), m => m.target_id)
  const result = new Map<string, SupplierInvoiceDto>()
  for (const row of rows) {
    const mapping = mappedByTarget.get(row.id)
    if (mappedTargets.has(row.id) && !mapping) continue
    const key = localKey(row)
    const candidate = mapping ? sources.get(mapping.source_id) : key && localByKey.get(key)?.id === row.id ? sourceByKey.get(key) : undefined
    if (!key || !candidate || sources.get(candidate.id) !== candidate || sourceKey(candidate) !== key) continue
    if (mappings.some(m => m.resource === 'supplierInvoices' && m.source_id === candidate.id && m.target_id !== row.id)) continue
    result.set(row.id, candidate)
  }
  return result
}

export interface CompleteBokioOptions {
  supabase: SupabaseClient; companyId: string; consentId: string; dryRun?: boolean; start?: boolean
  deadline?: number; snapshot?: BokioSupplierSnapshot
}
export async function completeBokioSupplierInvoices(options: CompleteBokioOptions) {
  const { supabase, companyId, consentId, dryRun = true } = options
  const deadline = options.deadline ?? Date.now() + 180_000
  const runId = randomUUID()
  const summary = { dryRun, attempted: 0, changed: 0, rows: 0, unresolved: 0, failed: 0, deferred: 0,
    paymentRefresh: undefined as Awaited<ReturnType<typeof refreshMigratedSupplierPaymentState>> | undefined, pending: 0, partial: false, busy: false, reports: [] as { invoiceId: string; outcome: string; changed: boolean; settlementCode?: string }[] }
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await queryInExecutionBudget(supabase.rpc(name, args))
    if (error) throw new Error(`${name}: ${error.code ?? 'DB_ERROR'}`)
    return data as T
  }
  const claimArgs = { p_company_id: companyId, p_consent_id: consentId, p_run_id: runId }
  let claimed = false
  try {
    return await withExecutionDeadline(deadline, 'bokio-supplier-completion', async () => {
      if (!dryRun) {
        const claim = await rpc<{ claimed: boolean }>('claim_bokio_supplier_completion', { ...claimArgs, p_start: options.start ?? false })
        if (!claim.claimed) { summary.busy = true; return summary }
        claimed = true
      }
      const snapshot = options.snapshot ?? await loadBokioSupplierSnapshot(companyId, consentId)
      const accountKey = bokioAccountKey(snapshot.connection, consentId)
      const [rows, suppliers, mappings, progress] = await Promise.all([
        fetchAllRows<BokioSupplierRow>(({ from, to }) => queryInExecutionBudget(supabase.from('supplier_invoices')
          .select('id,user_id,supplier_id,supplier_invoice_number,invoice_date,total,total_sek,subtotal,vat_amount,currency,is_credit_note,status,paid_at,created_at,updated_at,document_id,registration_journal_entry_id,payment_journal_entry_id,supplier_invoice_items(id,line_total,vat_amount)')
          .eq('company_id', companyId).order('id').range(from, to))),
        fetchAllRows<Supplier>(({ from, to }) => queryInExecutionBudget(supabase.from('suppliers').select('id,name').eq('company_id', companyId).order('id').range(from, to))),
        fetchAllRows<SourceMapping>(({ from, to }) => queryInExecutionBudget(supabase.from('migration_source_records').select('resource,source_id,target_id')
          .eq('company_id', companyId).eq('provider', 'bokio').eq('account_key', accountKey).order('id').range(from, to))),
        fetchAllRows<Progress>(({ from, to }) => queryInExecutionBudget(supabase.from('bokio_supplier_completion_entries').select('invoice_id,next_attempt_at')
          .eq('company_id', companyId).order('id').range(from, to))),
      ])
      const matched = matchBokioSupplierInvoices(rows, snapshot.invoices, suppliers, mappings)
      // Only strongly matched identities may enter the existing payment-state
      // refresh. A source number/date pair alone cannot select this population.
      const paymentRefresh = await refreshMigratedSupplierPaymentState({ supabase, companyId, consentId, dryRun, snapshot,
        eligibleInvoiceIds: new Set(matched.keys()) })
      if (!dryRun && matched.size) {
        // Refresh changes updated_at. Read the exact state completion will
        // compare under lock, while retaining the original identity match.
        const latest = await fetchAllRows<Pick<BokioSupplierRow, 'id' | 'updated_at' | 'status' | 'paid_at'>>(({ from, to }) =>
          queryInExecutionBudget(supabase.from('supplier_invoices').select('id,updated_at,status,paid_at').eq('company_id', companyId).order('id').range(from, to)))
        const byId = new Map(latest.map(row => [row.id, row]))
        for (const row of rows) {
          const current = byId.get(row.id)
          if (current && matched.has(row.id)) Object.assign(row, current)
        }
      }
      summary.paymentRefresh = paymentRefresh
      const due = new Map(progress.map(p => [p.invoice_id, Date.parse(p.next_attempt_at)]))
      const candidates = rows.filter(row => !row.supplier_invoice_items.length || !row.document_id ||
        (row.subtotal === row.total && row.vat_amount === 0) || !row.registration_journal_entry_id || !row.paid_at ||
        row.paid_at === `${row.invoice_date}T00:00:00+00:00`)
        .filter(row => dryRun || (due.get(row.id) ?? 0) <= Date.now())
        .sort((a, b) => (due.get(a.id) ?? 0) - (due.get(b.id) ?? 0) || Number(a.status === 'paid') - Number(b.status === 'paid') || a.id.localeCompare(b.id))
      summary.pending = candidates.length
      // Reserve time for writes and receipts. Rejected invoices get a saved
      // retry time, so open unsupported rows cannot monopolize the next run.
      const batch = candidates.slice(0, 100)
      const selected = batch.flatMap(row => matched.get(row.id) ? [matched.get(row.id)!] : [])
      const hydrated = await hydrateSupplierInvoices('bokio', snapshot.connection.accessToken, snapshot.connection.providerCompanyId,
        selected, Math.max(0, Math.min(60_000, deadline - Date.now() - 30_000)))
      const hydratedById = new Map(hydrated.invoices.map(dto => [dto.id, dto]))
      const [vouchers, periods] = await withinMigrationDeadline(Promise.all([
        fetchVouchersForNumbers(supabase, companyId, hydrated.invoices.flatMap(dto => dto.sourceVoucher ? [dto.sourceVoucher.number] : [])),
        fetchFiscalPeriods(supabase, companyId),
      ]), deadline)
      const voucherIndex = buildVoucherIndex(vouchers)
      const entryClaims = new Map<string, number>()
      for (const dto of snapshot.invoices) {
        const ref = dto._raw?.journalEntryRef as { id?: string } | undefined
        if (ref?.id) entryClaims.set(ref.id, (entryClaims.get(ref.id) ?? 0) + 1)
      }
      const links: MigratedInvoiceLinkInput[] = []
      for (const row of batch) {
        if (Date.now() >= deadline - 10_000) { summary.partial = true; break }
        const original = matched.get(row.id)
        const dto = original && hydratedById.get(original.id)
        let source: Record<string, unknown> | null = null
        const plan: Record<string, unknown> = { reason: 'unmatched_or_ambiguous' }
        if (dto) {
          const ref = dto.sourceVoucher
          const evidence = dto.supplierEvidence
          const entryId = ref?.series && ref.date && (entryClaims.get(evidence?.sourceEntryId ?? '') ?? 0) === 1
            ? resolveDatedRef(voucherIndex, periods, { series: ref.series, number: ref.number, date: ref.date }) : undefined
          source = bokioSupplierSource(dto, row.supplier_id)
          plan.reason = hydrated.unhydratedIds.has(dto.id) ? 'provider_evidence_deferred' : evidence?.vatReason ?? 'unresolved'
          if (entryId) { plan.voucher_id = entryId; plan.voucher_kind = evidence?.voucherKind }
          const mapped = mapSupplierInvoice(dto, row.user_id, companyId, row.supplier_id)
          const hasSplit = evidence && evidence.vatSource !== 'unresolved' && (evidence.vatSource !== 'voucher' || entryId)
          if (hasSplit && dto.currencyCode === 'SEK' && !row.is_credit_note) {
            plan.header = { subtotal: mapped.invoice.subtotal, vat_amount: mapped.invoice.vat_amount }
            if (!row.supplier_invoice_items.length && mapped.items.length) plan.items = mapped.items
          }
          // No fallback date is introduced. Only a pre-fix, source-matched
          // Bokio row with the old exact signature may have it removed.
          plan.clear_fabricated_date = !hydrated.unhydratedIds.has(dto.id)

        }
        try {
          const receipt = await rpc<Receipt>('complete_bokio_supplier_invoice', { ...claimArgs, p_invoice_id: row.id,
            p_source: source, p_expected: { updated_at: row.updated_at, total: row.total, supplier_id: row.supplier_id }, p_plan: plan, p_dry_run: dryRun })
          if (!['concurrent_change', 'not_found'].includes(receipt.outcome) && dto?.supplierEvidence?.voucherKind === 'registration' && plan.voucher_id) {
            links.push({ invoiceId: row.id, kind: 'supplier', sourceVoucher: dto.sourceVoucher,
              invoiceDate: row.invoice_date, totalSek: row.total_sek, currencyCode: row.currency, invoiceNumber: row.supplier_invoice_number })
          }
          summary.attempted++; summary.pending--
          if (receipt.changed) summary.changed++; else summary.unresolved++
          summary.rows += receipt.rows ?? 0
          summary.reports.push({ invoiceId: row.id, outcome: receipt.outcome, changed: receipt.changed, settlementCode: receipt.settlement?.code })
        } catch {
          // A lost reply may already have committed. The receipt is stored
          // atomically, so report uncertainty and let the next run read it.
          summary.failed++
          // If the first reply was lost, the same run returns its committed
          // receipt. Otherwise checkpoint the refusal so one bad row cannot
          // starve later batches. A database outage still leaves it pending.
          try {
            const receipt = await rpc<Receipt>('complete_bokio_supplier_invoice', { ...claimArgs, p_invoice_id: row.id,
              p_source: null, p_expected: { updated_at: row.updated_at, total: row.total, supplier_id: row.supplier_id },
              p_plan: { reason: 'write_rejected' }, p_dry_run: dryRun })
            summary.attempted++; summary.pending--
            if (receipt.changed) { summary.changed++; summary.rows += receipt.rows ?? 0 }
            summary.reports.push({ invoiceId: row.id, outcome: receipt.outcome, changed: receipt.changed })
          } catch {
            summary.reports.push({ invoiceId: row.id, outcome: 'write_unconfirmed', changed: false })
          }
        }
      }
      if (Date.now() < deadline - 5000 && links.length) await withinMigrationDeadline(linkMigratedRegistrationVouchers({ supabase, companyId, invoices: links, bounded: true, dryRun }), deadline)
      summary.partial ||= summary.pending > 0
      return summary
    })
  } catch (error) {
    if (!(error instanceof ExecutionBudgetExceeded) && !(error instanceof Error && error.message === 'MIGRATION_DEADLINE')) throw error
    summary.partial = true; return summary
  } finally {
    if (claimed) await withExecutionDeadline(Date.now() + 3000, 'bokio-release', () =>
      queryInExecutionBudget(supabase.rpc('claim_bokio_supplier_completion', { ...claimArgs, p_release: true }))).catch(() => {})
  }
}

/** Only explicitly enrolled companies run. Deployment never enrolls a company. */
export async function runBokioSupplierCompletion(supabase: SupabaseClient, deadline: number) {
  const { data, error } = await withinMigrationDeadline(supabase.from('bokio_supplier_completion_work').select('company_id,consent_id')
    .not('consent_id', 'is', null).lte('next_attempt_at', new Date().toISOString()).order('next_attempt_at').limit(10), deadline)
  if (error) throw new Error('BOKIO_COMPLETION_QUEUE_READ_FAILED')
  const results = []
  for (const work of data ?? []) {
    if (Date.now() >= deadline - 15_000) break
    try {
      results.push(await completeBokioSupplierInvoices({ supabase, companyId: work.company_id, consentId: work.consent_id,
        dryRun: false, deadline: Math.min(deadline, Date.now() + 120_000) }))
    } catch {
      createLogger('bokio-supplier-completion').warn('enrolled company completion deferred', { companyId: work.company_id })
      results.push({ failed: 1, partial: true })
    }
  }
  return results
}
