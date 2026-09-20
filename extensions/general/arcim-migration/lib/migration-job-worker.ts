import { randomUUID, createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { resolveConsent, type ResolvedConsent } from '@/lib/providers/resolve-consent'
import { classifyProviderError } from '@/lib/providers/with-provider-call'
import { fetchMigrationPage, hydrateSalesInvoices, hydrateSupplierInvoices, type MigrationDto } from '@/lib/providers/provider-data-fetcher'
import { migrationRetrySeconds, type ProviderMigrationJob, type MigrationResource } from '@/lib/providers/migration-contract'
import { sealMigrationPayload, openMigrationPayload } from '@/lib/providers/migration-payload'
import type { ProviderName } from '@/lib/providers/types'
import type { CreditedInvoiceRefDto, CustomerDto, SupplierDto, SalesInvoiceDto, SupplierInvoiceDto, PartyDto } from '@/lib/providers/dto'
import { linkMigratedRegistrationVouchers, type MigratedInvoiceLinkInput } from '@/lib/invoices/link-migrated-registration-vouchers'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import { mapCustomer, mapSupplier, mapSalesInvoice, mapSupplierInvoice, buildFxRateIndex } from './entity-mapper'
import { invoiceWithinScope } from './invoice-scope'

const log = createLogger('provider-migration-worker')
const BATCH_SIZE = 10
const MAX_BATCH_BYTES = 750_000
const MAX_INVOICE_LINES = 2000
const MAX_DETAIL_BUDGET_MS = 15_000

type InvoiceDto = SalesInvoiceDto | SupplierInvoiceDto
export interface MigrationChunk {
  id: string
  resource: MigrationResource
  source_id: string
  payload: string
  target_id: string | null
  receipt: {
    link?: Omit<MigratedInvoiceLinkInput, 'invoiceId'> & {
      /** The credited invoice as the provider named it; pairMigratedCreditNotes resolves it. */
      creditedInvoiceRef?: CreditedInvoiceRefDto | null
    }
  }
}

export async function migrationRpc<T>(supabase: SupabaseClient, job: ProviderMigrationJob, name: string, args: Record<string, unknown> = {}, deadline?: number): Promise<T> {
  if (deadline !== undefined && Date.now() >= deadline) throw new Error('MIGRATION_DEADLINE')
  const request = supabase.rpc(name, {
    p_job_id: job.id, p_worker_id: job.worker_id, p_attempt: job.attempt, ...args,
  })
  const { data, error } = await (deadline === undefined ? request : withinMigrationDeadline(request, deadline))
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  return data as T
}

/** The clock bounds the entire phase, including listing and database reads. */
export async function withinMigrationDeadline<T>(promise: PromiseLike<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  // PostgREST builders expose abortSignal. Cancel the HTTP request as well
  // as returning control; an uncertain transaction is safe to replay.
  if ('abortSignal' in promise && typeof promise.abortSignal === 'function') promise.abortSignal(controller.signal)
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('MIGRATION_DEADLINE'))
        controller.abort()
      }, Math.max(0, deadline - Date.now()))
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Prefer provider identity; an unidentified party is scoped to its invoice. */
export function invoicePartySourceId(provider: string, resource: MigrationResource, dto: InvoiceDto): string {
  const sales = resource === 'salesInvoices'
  const raw = dto._raw ?? {}
  const explicit = provider === 'visma' ? raw[sales ? 'CustomerId' : 'SupplierId']
    : provider === 'fortnox' ? raw[sales ? 'CustomerNumber' : 'SupplierNumber']
    : provider === 'briox' ? raw[sales ? 'customernumber' : 'suppliernumber']
    : provider === 'bokio' ? (raw[sales ? 'customerRef' : 'supplierRef'] as { id?: unknown } | undefined)?.id
    : undefined
  if ((typeof explicit === 'string' || typeof explicit === 'number') && String(explicit).trim()) return String(explicit)
  const party = sales ? (dto as SalesInvoiceDto).customer : (dto as SupplierInvoiceDto).supplier
  const orgNumber = party.identifications.find(id => id.schemeId === 'SE:ORGNR')?.id.replace(/[^a-z0-9]/gi, '')
  if (!orgNumber && !dto.id) throw new Error('MIGRATION_PARTY_ID_MISSING')
  const identity = orgNumber ? `org:${orgNumber}` : `invoice:${dto.id}`
  return 'invoice-party:' + createHash('sha256').update(identity).digest('hex')
}

function mappedParty(job: ProviderMigrationJob, resource: MigrationResource, dto: InvoiceDto): Record<string, unknown> {
  const party: PartyDto = resource === 'salesInvoices' ? (dto as SalesInvoiceDto).customer : (dto as SupplierInvoiceDto).supplier
  if (resource === 'salesInvoices') return mapCustomer({ id: '', customerNumber: '', active: true, party }, job.user_id, job.company_id)
  return mapSupplier({ id: '', supplierNumber: '', active: true, party }, job.user_id, job.company_id)
}

async function prepareRecord(supabase: SupabaseClient, job: ProviderMigrationJob, c: MigrationChunk,
  connection: ResolvedConsent, deadline: number): Promise<Record<string, unknown>> {
  const dto = openMigrationPayload<MigrationDto & { migrationError?: string }>(c.payload)
  if (dto.migrationError) return { id: c.id, error: dto.migrationError }
  if (!dto.id) return { id: c.id, error: 'MIGRATION_SOURCE_ID_MISSING' }
  if (c.resource === 'customers') {
    if (!(dto as CustomerDto).active) return { id: c.id, skip: 'inactive' }
    return { id: c.id, row: mapCustomer(dto as CustomerDto, job.user_id, job.company_id) }
  }
  if (c.resource === 'suppliers') {
    if (!(dto as SupplierDto).active) return { id: c.id, skip: 'inactive' }
    return { id: c.id, row: mapSupplier(dto as SupplierDto, job.user_id, job.company_id) }
  }
  const listed = dto as InvoiceDto
  if (!invoiceWithinScope(listed, job.fiscal_year_scope)) return { id: c.id, skip: 'outsideFiscalYears' }
  const provider = job.provider as ProviderName
  const budget = Math.min(MAX_DETAIL_BUDGET_MS, Math.max(0, deadline - Date.now() - 5000))
  if (budget < 1000) throw new Error('MIGRATION_DEADLINE')
  const hydrated = c.resource === 'salesInvoices'
    ? await hydrateSalesInvoices(provider, connection.accessToken, connection.providerCompanyId, [listed as SalesInvoiceDto], budget)
    : await hydrateSupplierInvoices(provider, connection.accessToken, connection.providerCompanyId, [listed as SupplierInvoiceDto], budget)
  if (hydrated.unhydratedIds.has(listed.id)) {
    // A shortened detail budget means this invocation ran out of time,
    // not that the invoice exhausted a full attempt. Leave it pending.
    if (hydrated.hydration.abortedBy === 'budget' && budget < MAX_DETAIL_BUDGET_MS) throw new Error('MIGRATION_DEADLINE')
    // The provider client already retries transient errors. Isolate exhausted
    // detail failures so healthy records continue; the user can retry them.
    throw new Error(hydrated.hydration.abortedBy === 'auth' ? 'PROVIDER_AUTH_EXPIRED' : 'MIGRATION_DETAIL_RETRY')
  }
  const invoice = hydrated.invoices[0]
  if (invoice.id !== listed.id) throw new Error('MIGRATION_SOURCE_ID_CHANGED')
  if (invoice.lines.length > MAX_INVOICE_LINES) return { id: c.id, error: 'MIGRATION_INVOICE_TOO_LARGE' }
  const fx = await withinMigrationDeadline(buildFxRateIndex(supabase, [invoice]), deadline)
  // The RPC resolves the source party and stamps its actual id atomically.
  const placeholder = '00000000-0000-0000-0000-000000000000'
  const mapped = c.resource === 'salesInvoices'
    ? mapSalesInvoice(invoice as SalesInvoiceDto, job.user_id, job.company_id, placeholder, fx)
    : mapSupplierInvoice(invoice as SupplierInvoiceDto, job.user_id, job.company_id, placeholder, fx)
  if (c.resource === 'supplierInvoices' && !invoice.legalMonetaryTotal.payableAmount.value && !invoice.lines.length) {
    return { id: c.id, skip: 'zeroTotal' }
  }
  if (!mapped.items.length) return { id: c.id, error: 'MIGRATION_SOURCE_LINES_MISSING' }
  // Use the same tolerance as the existing completion pass. Store no row set
  // that contradicts the header established by that exact detail payload.
  if (!mapped.vatUnresolved) {
    const net = mapped.items.reduce((n, item) => n + Number(item.line_total ?? 0), 0)
    const vat = mapped.items.reduce((n, item) => n + Number(item.vat_amount ?? 0), 0)
    if (Math.abs(net - Number(mapped.invoice.subtotal)) > 1 || Math.abs(vat - Number(mapped.invoice.vat_amount)) > 1) {
      return { id: c.id, error: 'MIGRATION_ROWS_MISMATCH' }
    }
  }
  return {
    id: c.id, row: mapped.invoice, items: mapped.items,
    party_source_id: invoicePartySourceId(job.provider, c.resource, invoice), party: mappedParty(job, c.resource, invoice),
    link: { kind: c.resource === 'salesInvoices' ? 'customer' : 'supplier', sourceVoucher: invoice.sourceVoucher ?? null,
      invoiceDate: invoice.issueDate, totalSek: mapped.invoice.total_sek, currencyCode: invoice.currencyCode,
      invoiceNumber: invoice.invoiceNumber, creditedInvoiceRef: mapped.creditedInvoiceRef },
    // A credit note whose provider named the credited invoice is paired in
    // the link phase (pairMigratedCreditNotes); only one with no reference
    // at all is reported as unlinked here.
    warnings: { fxUnresolved: !!mapped.fxUnresolved, vatUnresolved: mapped.vatUnresolved,
      creditNoteUnlinked: mapped.creditNoteUnlinked && !mapped.creditedInvoiceRef },
  }
}

/**
 * Pair each imported kreditfaktura with the invoice it credits, by the
 * reference the provider sent (receipt.link.creditedInvoiceRef).
 *
 * Runs in the link phase, once every sales invoice of the job is imported:
 * chunks import in id order, so the original may well come after its credit
 * note. The provider's id of the original resolves through this job's own
 * chunks (source_id to target_id); its number resolves through the company's
 * invoices, which also covers an original imported by an earlier run.
 * Nothing is guessed from amounts, and a number two invoices share is
 * ambiguous, so it pairs nothing. Idempotent: an already-paired row is left
 * alone, so a replay after a timeout is harmless.
 */
export async function pairMigratedCreditNotes(supabase: SupabaseClient, job: ProviderMigrationJob, chunks: MigrationChunk[], deadline: number): Promise<void> {
  for (const c of chunks) {
    const ref = c.receipt.link?.creditedInvoiceRef
    if (c.resource !== 'salesInvoices' || !ref || !c.target_id) continue
    let target: string | null = null
    if (ref.id) {
      const { data, error } = await withinMigrationDeadline(supabase.from('migration_job_chunks').select('target_id')
        .eq('job_id', job.id).eq('resource', 'salesInvoices').eq('source_id', ref.id).not('target_id', 'is', null).maybeSingle(), deadline)
      if (error) throw new Error(error.message)
      target = (data as { target_id?: string | null } | null)?.target_id ?? null
    }
    if (!target && ref.invoiceNumber) {
      const { data, error } = await withinMigrationDeadline(supabase.from('invoices').select('id')
        .eq('company_id', job.company_id).eq('invoice_number', ref.invoiceNumber).neq('id', c.target_id).limit(2), deadline)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as { id: string }[]
      target = rows.length === 1 ? rows[0].id : null
    }
    if (!target || target === c.target_id) {
      log.warn('credit note left unpaired: credited invoice not found', { jobId: job.id, chunkId: c.id, creditedInvoice: ref.invoiceNumber ?? ref.id })
      continue
    }
    const { error } = await withinMigrationDeadline(supabase.from('invoices').update({ credited_invoice_id: target })
      .eq('id', c.target_id).eq('company_id', job.company_id).is('credited_invoice_id', null), deadline)
    if (error) throw new Error(error.message)
  }
}

async function importBatch(supabase: SupabaseClient, job: ProviderMigrationJob, chunks: MigrationChunk[],
  connection: ResolvedConsent, deadline: number): Promise<void> {
  let batch: Record<string, unknown>[] = []
  let bytes = 0
  const commit = async () => {
    if (!batch.length) return
    await migrationRpc(supabase, job, 'commit_provider_migration_records', { p_records: batch }, deadline)
    batch = []; bytes = 0
  }
  try {
    for (const c of chunks) {
      if (Date.now() >= deadline - 5000) break
      let record: Record<string, unknown>
      try { record = await prepareRecord(supabase, job, c, connection, deadline) }
      catch (error) {
        const code = failureCode(error)
        if (['MIGRATION_DEADLINE', 'PROVIDER_AUTH_EXPIRED'].includes(code)
          || !code.startsWith('MIGRATION_')) throw error
        record = { id: c.id, error: code }
      }
      const size = Buffer.byteLength(JSON.stringify(record))
      if (size > MAX_BATCH_BYTES) record = { id: c.id, error: 'MIGRATION_INVOICE_TOO_LARGE' }
      if (bytes + size > MAX_BATCH_BYTES) await commit()
      batch.push(record); bytes += size
    }
  } finally {
    // Prepared healthy records survive a later provider failure. Fencing
    // rejects this call if the worker has lost ownership in the meantime.
    await commit()
  }
}

async function followupBatch(supabase: SupabaseClient, job: ProviderMigrationJob, chunks: MigrationChunk[], deadline: number): Promise<void> {
  let records: Record<string, unknown>[]
  if (job.phase === 'link') {
    await pairMigratedCreditNotes(supabase, job, chunks, deadline)
    const inputs = chunks.map(c => ({ ...c.receipt.link!, invoiceId: c.target_id! }))
    const linked = await linkMigratedRegistrationVouchers({ supabase, companyId: job.company_id,
      invoices: inputs, dryRun: true, bounded: true })
    records = chunks.map(c => {
      const report = linked.reports.find(r => r.invoiceId === c.target_id)
      if (!report) return { id: c.id, error: 'MIGRATION_LINK_RESULT_MISSING' }
      return { id: c.id, report, journal_entry_id: report.outcome === 'linked' ? report.journalEntryId : null,
        ...(['ambiguous', 'amountMismatch'].includes(report.outcome) ? { error: 'MIGRATION_REGISTRATION_REVIEW' } : {}) }
    })
  } else if (job.phase === 'reconcile') {
    const result = await reconcileSupplierInvoiceVouchers({ supabase, companyId: job.company_id, userId: job.user_id,
      dryRun: true, invoiceIds: chunks.map(c => c.target_id!), maxInvoices: BATCH_SIZE })
    records = chunks.map(c => ({ id: c.id, payment: result.links.find(link => link.supplier_invoice_id === c.target_id) ?? null,
      ...(result.review.some(review => review.supplier_invoice_id === c.target_id) ? { error: 'MIGRATION_PAYMENT_REVIEW' } : {}) }))
  } else records = chunks.map(c => ({ id: c.id }))
  await migrationRpc(supabase, job, 'commit_provider_migration_followup', { p_records: records }, deadline)
}

export function failureCode(error: unknown): string {
  // Consent resolution also throws structured HTTP failures, not just Errors.
  if (typeof error === 'object' && error !== null && !(error instanceof Error) && 'status' in error) {
    const status = Number(error.status)
    if ([401, 403, 404].includes(status)) return 'PROVIDER_AUTH_EXPIRED'
  }
  const classified = classifyProviderError(error)
  if (classified) return classified
  const message = error instanceof Error ? error.message : ''
  const known = message.match(/(?:MIGRATION|PROVIDER|PERSONNUMMER)_[A-Z_]+/)?.[0]
  return known ?? 'MIGRATION_RETRY'
}

/** Cron owns recovery. A browser nudge only reduces latency, including in local dev. */
export async function runProviderMigrationWorker(options: {
  jobId?: string; budgetMs?: number; supabase?: SupabaseClient
} = {}): Promise<{ jobs: number; batches: number }> {
  const supabase = options.supabase ?? createServiceClientNoCookies()
  const deadline = Date.now() + Math.min(options.budgetMs ?? 210_000, 210_000)
  const worker = randomUUID()
  let jobs = 0; let batches = 0
  while (Date.now() < deadline - 10_000) {
    const claim = await withinMigrationDeadline(supabase.rpc('claim_provider_migration_job',
      { p_worker_id: worker, p_job_id: options.jobId ?? null }), deadline - 5000).catch(error => {
        if (failureCode(error) !== 'MIGRATION_DEADLINE') throw error
        return { data: null, error: null }
      })
    const { data, error } = claim
    if (error) throw new Error(error.message)
    if (!data?.id) break
    let job = data as ProviderMigrationJob
    jobs++
    try {
      if (!job.consent_id) throw new Error('PROVIDER_AUTH_EXPIRED')
      const connection = await withinMigrationDeadline(resolveConsent(job.company_id, job.consent_id), deadline - 5000)
      const sourceAccount = String(connection.consent.org_number ?? '').replace(/[^a-z0-9]/gi, '') || connection.providerCompanyId
      if (connection.consent.provider !== job.provider || sourceAccount !== job.account_key) {
        throw new Error('MIGRATION_SOURCE_IDENTITY_CHANGED')
      }
      while (Date.now() < deadline - 10_000 && job.state === 'running') {
        const started = Date.now()
        log.info('migration phase started', { jobId: job.id, phase: job.phase, resource: job.resources[job.resource_index - 1], page: job.next_page })
        if (job.phase === 'discover') {
          const resource = job.resources[job.resource_index - 1]
          const page = await withinMigrationDeadline(fetchMigrationPage(job.provider as ProviderName, connection.accessToken,
            connection.providerCompanyId, resource, job.next_page), deadline - 5000)
          const records = page.items.map((dto, i) => ({ source_id: dto.id || `missing:${job.next_page}:${i}`,
            ...sealMigrationPayload(Buffer.byteLength(JSON.stringify(dto)) > MAX_BATCH_BYTES / 2
              ? { id: dto.id, migrationError: 'MIGRATION_INVOICE_TOO_LARGE' } : dto) }))
          // Persist bounded segments even when an unpaged upstream returns its
          // entire register. Only the final segment advances the page cursor.
          let segment: typeof records = []; let bytes = 0
          for (const record of records) {
            const size = Buffer.byteLength(JSON.stringify(record))
            if (segment.length >= 250 || bytes + size > MAX_BATCH_BYTES) {
              if (Date.now() >= deadline - 5000) throw new Error('MIGRATION_DEADLINE')
              await migrationRpc(supabase, job, 'save_provider_migration_page', { p_resource: resource, p_page: job.next_page,
                p_records: segment, p_next_page: 0 }, deadline - 5000)
              segment = []; bytes = 0
            }
            segment.push(record); bytes += size
          }
          if (Date.now() >= deadline - 5000) throw new Error('MIGRATION_DEADLINE')
          await migrationRpc(supabase, job, 'save_provider_migration_page', { p_resource: resource, p_page: job.next_page,
            p_records: segment, p_next_page: page.nextPage }, deadline - 5000)
          log.info('migration page persisted', { jobId: job.id, resource, page: job.next_page, rows: records.length, total: page.total })
        } else {
          const state = { import: 'pending', link: 'imported', reconcile: 'linked', settle: 'planned', completed: 'done' }[job.phase]
          const { data: rows, error: readError } = await withinMigrationDeadline(supabase.from('migration_job_chunks')
            .select('id,resource,source_id,payload,target_id,receipt').eq('company_id', job.company_id).eq('job_id', job.id)
            .eq('state', state).order('resource_order').order('id').limit(BATCH_SIZE), deadline - 5000)
          if (readError) throw new Error(readError.message)
          const chunks = (rows ?? []) as MigrationChunk[]
          if (!chunks.length) await migrationRpc(supabase, job, 'advance_provider_migration_job', {}, deadline - 5000)
          else if (job.phase === 'import') await importBatch(supabase, job, chunks, connection, deadline - 5000)
          else await withinMigrationDeadline(followupBatch(supabase, job, chunks, deadline - 5000), deadline - 5000)
        }
        batches++
        log.info('migration phase checkpointed', { jobId: job.id, phase: job.phase, elapsedMs: Date.now() - started })
        const { data: current, error: currentError } = await withinMigrationDeadline(supabase.from('migration_jobs').select('*')
          .eq('id', job.id).eq('company_id', job.company_id)
          .eq('worker_id', job.worker_id).eq('attempt', job.attempt).maybeSingle(), deadline - 5000)
        if (currentError) throw new Error(currentError.message)
        if (!current) return { jobs, batches }
        job = current as ProviderMigrationJob
      }
      if (job.state === 'running') await migrationRpc(supabase, job, 'release_provider_migration_job', {}, deadline)
    } catch (error) {
      const code = failureCode(error)
      const attention = ['PROVIDER_AUTH_EXPIRED','PROVIDER_LICENSE_MISSING','PROVIDER_API_MODULE_INACTIVE',
        'MIGRATION_WRITE_FORBIDDEN','MIGRATION_SOURCE_IDENTITY_CHANGED','PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED'].includes(code) || job.failures >= 4
      await migrationRpc(supabase, job, 'release_provider_migration_job', {
        p_error_code: code === 'MIGRATION_DEADLINE' ? null : code,
        p_retry_seconds: code === 'MIGRATION_DEADLINE' ? 0 : attention ? -1 : migrationRetrySeconds(job.failures + 1),
      }, deadline).catch(releaseError => {
        // An unreachable database must not hold the invocation open. The
        // lease expires and the next worker replays any uncertain commit.
        log.warn('migration release deferred to lease expiry', { jobId: job.id, code: failureCode(releaseError) })
      })
      log.warn('migration yielded', { jobId: job.id, code, needsAttention: attention })
      break
    }
    if (options.jobId) break
  }
  return { jobs, batches }
}
