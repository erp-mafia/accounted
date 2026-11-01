import { randomUUID, createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget'
import { resolveConsent, type ResolvedConsent } from '@/lib/providers/resolve-consent'
import { classifyProviderError, providerRefusalReason } from '@/lib/providers/with-provider-call'
import { readProviderRefusal } from '@/lib/providers/read-refusal'
import { fortnoxApiErrorCode } from '@/lib/providers/fortnox/client'
import { fetchMigrationPage, hydrateCustomers, hydrateSalesInvoices, hydrateSupplierInvoices, hydrateSuppliers, type HydrationReport, type MigrationDto } from '@/lib/providers/provider-data-fetcher'
import { migrationRetrySeconds, type ProviderMigrationJob, type MigrationResource } from '@/lib/providers/migration-contract'
import { sealMigrationPayload, openMigrationPayload } from '@/lib/providers/migration-payload'
import type { ProviderName } from '@/lib/providers/types'
import type { CreditedInvoiceRefDto, CustomerDto, SupplierDto, SalesInvoiceDto, SupplierInvoiceDto, PartyDto } from '@/lib/providers/dto'
import { linkMigratedRegistrationVouchers, type MigratedInvoiceLinkInput, type RegistrationLinkReport } from '@/lib/invoices/link-migrated-registration-vouchers'
import { supplierPayableEffectSek } from '@/lib/supplier-invoices/credit-note'
import { ORE_TOLERANCE } from '@/lib/money'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import { mapCustomer, mapSupplier, mapSalesInvoice, mapSupplierInvoice, buildFxRateIndex } from './entity-mapper'
import { bokioSupplierSource } from './bokio-supplier-source'
import { invoiceWithinScope } from './invoice-scope'
import { adoptExistingCustomers, customerRegisterFacts, salesInvoicePartyFacts, type PartyCandidate } from './customer-match'
import {
  buildCustomerMetadataEnrichment,
  buildSupplierEnrichment,
  writeCustomerEnrichment,
  writeSupplierEnrichment,
  type ExistingCustomerMetadata,
  type ExistingSupplierDetails,
} from './customer-metadata'

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
  // No `type`: the invoice does not say private or company, so a
  // personnummer-shaped number makes the stub a privatperson with the number
  // encrypted, never plaintext in org_number (isUntypedPrivatePerson).
  if (resource === 'salesInvoices') return mapCustomer({ id: '', customerNumber: '', active: true, party }, job.user_id, job.company_id)
  return mapSupplier({ id: '', supplierNumber: '', active: true, party }, job.user_id, job.company_id)
}

/**
 * The listed customer in its detail form where the provider lists a short one
 * (Fortnox, see hydrateCustomers; crm#1245). A customer is never saved from
 * the short list, which has no type, active flag, VAT number, country or
 * terms: a privatperson saved from it became a company with its personnummer
 * as org number (crm#1436). One whose detail cannot be read is a record to
 * retry, and running out of time leaves it pending.
 */
async function customerWithDetail(job: ProviderMigrationJob, listed: CustomerDto,
  connection: ResolvedConsent, deadline: number): Promise<CustomerDto> {
  const budget = Math.min(MAX_DETAIL_BUDGET_MS, Math.max(0, deadline - Date.now() - 5000))
  const hydrated = await hydrateCustomers(job.provider as ProviderName, connection.accessToken,
    connection.providerCompanyId, [listed], budget)
  if (!hydrated.unhydratedIds.has(listed.id)) return hydrated.customers[0]
  return partyWithoutDetail(hydrated, budget, job, connection, deadline)
}

/**
 * The supplier twin of customerWithDetail: Fortnox's supplier list leaves out
 * the country and the VAT number (hydrateSuppliers; crm#1436).
 */
async function supplierWithDetail(job: ProviderMigrationJob, listed: SupplierDto,
  connection: ResolvedConsent, deadline: number): Promise<SupplierDto> {
  const budget = Math.min(MAX_DETAIL_BUDGET_MS, Math.max(0, deadline - Date.now() - 5000))
  const hydrated = await hydrateSuppliers(job.provider as ProviderName, connection.accessToken,
    connection.providerCompanyId, [listed], budget)
  if (!hydrated.unhydratedIds.has(listed.id)) return hydrated.suppliers[0]
  return partyWithoutDetail(hydrated, budget, job, connection, deadline)
}

/**
 * A party the detail pass did not reach: pending when only this invocation
 * ran out of time, the provider's refusal when it refused the token, and
 * otherwise a record to retry, never its list form.
 */
async function partyWithoutDetail(hydrated: { hydration: HydrationReport; authError?: unknown },
  budget: number, job: ProviderMigrationJob, connection: ResolvedConsent, deadline: number): Promise<never> {
  if (hydrated.hydration.abortedBy === 'budget' && budget < MAX_DETAIL_BUDGET_MS) throw new Error('MIGRATION_DEADLINE')
  if (hydrated.hydration.abortedBy === 'auth') {
    throw await readMigrationRefusal(hydrated.authError ?? new Error('PROVIDER_AUTH_EXPIRED'), job, connection, deadline)
  }
  throw new Error('MIGRATION_DETAIL_RETRY')
}

/**
 * `parties` collects the source customer behind each prepared record, keyed by
 * chunk id, for adoptExistingCustomers to match before the commit.
 */
async function prepareRecord(supabase: SupabaseClient, job: ProviderMigrationJob, c: MigrationChunk,
  connection: ResolvedConsent, deadline: number, parties: Map<string, PartyCandidate>): Promise<Record<string, unknown>> {
  const dto = openMigrationPayload<MigrationDto & { migrationError?: string }>(c.payload)
  if (dto.migrationError) return { id: c.id, error: dto.migrationError }
  if (!dto.id) return { id: c.id, error: 'MIGRATION_SOURCE_ID_MISSING' }
  // Asked twice: on the list form, to spare an inactive record its detail
  // request, and on the detail form, because Fortnox's customer list carries
  // no Active at all and every listed customer read as active (crm#1436).
  if (c.resource === 'customers') {
    if (!(dto as CustomerDto).active) return { id: c.id, skip: 'inactive' }
    const customer = await customerWithDetail(job, dto as CustomerDto, connection, deadline)
    if (!customer.active) return { id: c.id, skip: 'inactive' }
    parties.set(c.id, { sourceId: c.source_id, facts: customerRegisterFacts(job.provider, customer) })
    return { id: c.id, row: mapCustomer(customer, job.user_id, job.company_id) }
  }
  if (c.resource === 'suppliers') {
    if (!(dto as SupplierDto).active) return { id: c.id, skip: 'inactive' }
    const supplier = await supplierWithDetail(job, dto as SupplierDto, connection, deadline)
    if (!supplier.active) return { id: c.id, skip: 'inactive' }
    return { id: c.id, row: mapSupplier(supplier, job.user_id, job.company_id) }
  }
  const listed = dto as InvoiceDto
  // A supplier invoice cancelled (makulerad) in Fortnox was never a payable,
  // and the supplier-invoice register has no cancelled state: it would land
  // as credited. The default listing leaves it out (fortnoxSupplierInvoiceNotOpen);
  // the whole register, listed on request (crm#1114), keeps it.
  if (c.resource === 'supplierInvoices' && job.provider === 'fortnox' && listed.status === 'cancelled') {
    return { id: c.id, skip: 'cancelled' }
  }
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
    // The provider refused the token or this detail: say which, so the job
    // stops with a code the user can act on (see readMigrationRefusal).
    if (hydrated.hydration.abortedBy === 'auth') {
      throw await readMigrationRefusal(hydrated.authError ?? new Error('PROVIDER_AUTH_EXPIRED'), job, connection, deadline)
    }
    // The provider client already retries transient errors. Isolate exhausted
    // detail failures so healthy records continue; the user can retry them.
    throw new Error('MIGRATION_DETAIL_RETRY')
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
  // Keep the legacy stand-in number on the row, so the commit adopts the
  // stored invoice by it (and checks its header) instead of inserting it again.
  if (c.resource === 'salesInvoices' && !mapped.invoice.invoice_number && invoice.id
    && await storedUnderSourceId(supabase, job, invoice.id, deadline)) {
    mapped.invoice.invoice_number = invoice.id
  }
  if (c.resource === 'supplierInvoices' && mapped.invoice.is_credit_note
    && await hasPreNormalisationCreditNote(supabase, job, mapped.invoice, deadline)) {
    return { id: c.id, skip: 'creditNoteInOldShape' }
  }
  // A supplier invoice without a number (Bokio requires none) goes on to the
  // commit, which stores it with a NULL number (20261005225009, crm#1039).
  // The supplier mapper holds its rows to the header whether or not VAT was
  // established, and hands back none when they disagree: the same refusal as
  // the check below, which a supplier invoice with no established VAT used to
  // pass with the voucher's own 2440 row among its items.
  if (mapped.rowsMismatch) return { id: c.id, error: 'MIGRATION_ROWS_MISMATCH' }
  // A sales invoice that arrives with no rows at all (its detail form has
  // none, or the provider serves no detail form) is imported as its header,
  // the shape the register import and the completion pass already handle:
  // the invoice belongs in the customer register, nothing is fabricated, and
  // the hourly completion pass fills rows the provider can still serve (one
  // it cannot is its noLinesAtProvider). It used to be refused as missing
  // lines, and every retry refused it again (PH 145). A row set the mapper
  // dropped is still refused below.
  const rowlessAtSource = c.resource === 'salesInvoices' && invoice.lines.length === 0
  // Bokio preview rows may be absent, carry no account (Bokio sends none), or
  // lack a defensible VAT allocation. Keep the invoice and let completion
  // revisit it without fabricating rows. Another provider's row set dropped
  // for a row with no account is refused here as missing lines.
  if (!mapped.items.length && !rowlessAtSource
    && !(c.resource === 'supplierInvoices' && (invoice as SupplierInvoiceDto).supplierEvidence)) {
    return { id: c.id, error: 'MIGRATION_SOURCE_LINES_MISSING' }
  }
  // Use the same tolerance as the existing completion pass. Store no row set
  // that contradicts the header established by that exact detail payload.
  if (!mapped.vatUnresolved && mapped.items.length) {
    const net = mapped.items.reduce((n, item) => n + Number(item.line_total ?? 0), 0)
    const vat = mapped.items.reduce((n, item) => n + Number(item.vat_amount ?? 0), 0)
    if (Math.abs(net - Number(mapped.invoice.subtotal)) > 1 || Math.abs(vat - Number(mapped.invoice.vat_amount)) > 1) {
      return { id: c.id, error: 'MIGRATION_ROWS_MISMATCH' }
    }
  }
  const partySourceId = invoicePartySourceId(job.provider, c.resource, invoice)
  if (c.resource === 'salesInvoices') {
    parties.set(c.id, { sourceId: partySourceId, facts: salesInvoicePartyFacts(job.provider, invoice as SalesInvoiceDto) })
  }
  return {
    id: c.id, row: mapped.invoice, items: mapped.items,
    party_source_id: partySourceId, party: mappedParty(job, c.resource, invoice),
    link: { ...(provider === 'bokio' && c.resource === 'supplierInvoices'
      ? { bokioSource: bokioSupplierSource(invoice as SupplierInvoiceDto, placeholder) } : {}), kind: c.resource === 'salesInvoices' ? 'customer' : 'supplier', sourceVoucher: invoice.sourceVoucher ?? null,
      ...((invoice as SupplierInvoiceDto).supplierEvidence?.voucherKind === 'cash_purchase'
        ? { settlement: { sourcePaid: invoice.paymentStatus.paid, userId: job.user_id } } : {}),
      invoiceDate: invoice.issueDate, currencyCode: invoice.currencyCode,
      // What the registration voucher must show: a supplier credit note is
      // stored in magnitudes but DEBITS 2440 (supplierPayableEffectSek).
      totalSek: c.resource === 'supplierInvoices'
        ? supplierPayableEffectSek(mapped.invoice.total_sek as number | null, mapped.invoice.is_credit_note as boolean)
        : mapped.invoice.total_sek,
      invoiceNumber: invoice.invoiceNumber, creditedInvoiceRef: mapped.creditedInvoiceRef },
    // A credit note whose provider named the credited invoice is paired in
    // the link phase (pairMigratedCreditNotes), so only one with no reference
    // at all is flagged unlinked here. One whose reference the link phase
    // cannot resolve is counted too, by provider_migration_counts, from the
    // row itself: credited_invoice_id still NULL once the link phase has run.
    warnings: { fxUnresolved: !!mapped.fxUnresolved, vatUnresolved: mapped.vatUnresolved,
      creditNoteUnlinked: mapped.creditNoteUnlinked && !mapped.creditedInvoiceRef,
      ...(rowlessAtSource ? { linesMissing: true } : {}) },
  }
}

/**
 * Whether the company already holds this supplier credit note in the shape
 * the importer wrote before #2838: the provider's negative total, on a row
 * that is usually not flagged as a credit note at all.
 *
 * commit_provider_migration_records adopts an earlier import on number,
 * party, date, currency AND total. A credit note's total is now its
 * magnitude, so such a row no longer matches, and the credit note would be
 * inserted a second time: its resting status, 'credited', is outside the
 * (company, supplier, number) unique index, so nothing in the schema would
 * refuse the copy. The document IS imported; rewriting the old row into the
 * new shape is a repair of existing data and a decision of its own, so this
 * run leaves it alone and says why (the chunk is skipped with this reason).
 * Once the row is repaired it carries the magnitude and is adopted like any
 * other earlier import.
 */
async function hasPreNormalisationCreditNote(supabase: SupabaseClient, job: ProviderMigrationJob,
  row: Record<string, unknown>, deadline: number): Promise<boolean> {
  const total = Number(row.total)
  if (!row.supplier_invoice_number || !(total > 0)) return false
  const { data, error } = await withinMigrationDeadline(supabase.from('supplier_invoices').select('id')
    .eq('company_id', job.company_id).eq('supplier_invoice_number', row.supplier_invoice_number as string)
    .eq('invoice_date', row.invoice_date as string).eq('currency', row.currency as string).eq('total', -total).limit(1), deadline)
  if (error) throw new Error(error.message)
  if (!data?.length) return false
  log.warn('supplier credit note already imported in the pre-normalisation shape: left as is', { jobId: job.id, targetId: (data[0] as { id: string }).id })
  return true
}

/**
 * Is a number-less sales document already stored under its source id? Imports
 * before crm#1084 put Bokio's record id in invoice_number when a draft had no
 * number. The commit adopts a stored invoice by its number, and a number-less
 * record only by its source map, so such a draft imported by the wizard (no
 * source map) would otherwise be inserted a second time.
 */
async function storedUnderSourceId(supabase: SupabaseClient, job: ProviderMigrationJob,
  sourceId: string, deadline: number): Promise<boolean> {
  const { data, error } = await withinMigrationDeadline(supabase.from('invoices').select('id')
    .eq('company_id', job.company_id).eq('invoice_number', sourceId).limit(1), deadline)
  if (error) throw new Error(error.message)
  return !!data?.length
}

/** Where each register keeps a credit note's pointer at the invoice it credits. */
const CREDIT_PAIRING = {
  salesInvoices: { table: 'invoices', numberColumn: 'invoice_number' },
  supplierInvoices: { table: 'supplier_invoices', numberColumn: 'supplier_invoice_number' },
} as const

/**
 * Pair each imported kreditfaktura with the invoice it credits, by the
 * reference the provider sent (receipt.link.creditedInvoiceRef).
 *
 * Runs in the link phase, once every invoice of the job is imported:
 * chunks import in id order, so the original may well come after its credit
 * note. The provider's id of the original resolves through this job's own
 * chunks (source_id to target_id); its number resolves through the company's
 * invoices, which also covers an original imported by an earlier run.
 * Nothing is guessed from amounts, and a number two invoices share is
 * ambiguous, so it pairs nothing. Idempotent: an already-paired row is left
 * alone, so a replay after a timeout is harmless. Whatever stays unpaired is
 * counted by provider_migration_counts from the row itself
 * (credited_invoice_id still NULL once this phase has run), so this function
 * reports nothing back.
 *
 * Supplier credit notes (#2838) pair by the same rule with two differences.
 * A supplier's invoice number is unique per SUPPLIER, not per company, so the
 * number resolves only among the credit note's own supplier's invoices. And
 * supplier_invoices has no credit cap trigger to vet the pair, so the checks
 * that trigger makes on the sales side are made here before the write: the
 * original is an ordinary invoice (never another credit note) of the same
 * supplier, in the same currency, and the credit note does not exceed it.
 * provider_migration_counts derives its linked and unlinked counts for sales
 * invoices only, and the wizard shows none for supplier invoices yet: a
 * supplier credit note left unpaired here is logged, and carries the number
 * the provider named in its notes.
 *
 * Fortnox names the credited supplier invoice by its löpnummer, which the
 * company's invoices keep in fortnox_number (crm#1157); only a row imported
 * before that column holds the löpnummer as its supplier number instead.
 */
export async function pairMigratedCreditNotes(supabase: SupabaseClient, job: ProviderMigrationJob, chunks: MigrationChunk[], deadline: number): Promise<void> {
  for (const c of chunks) {
    const ref = c.receipt.link?.creditedInvoiceRef
    if ((c.resource !== 'salesInvoices' && c.resource !== 'supplierInvoices') || !ref || !c.target_id) continue
    const { table, numberColumn } = CREDIT_PAIRING[c.resource]
    let own: SupplierPairingFacts | null = null
    if (c.resource === 'supplierInvoices') {
      own = await supplierPairingFacts(supabase, job, c.target_id, deadline)
      // Only a row that IS a credit note is ever pointed at an original.
      if (!own?.is_credit_note) continue
    }
    let target: string | null = null
    if (ref.id) {
      const { data, error } = await withinMigrationDeadline(supabase.from('migration_job_chunks').select('target_id')
        .eq('job_id', job.id).eq('resource', c.resource).eq('source_id', ref.id).not('target_id', 'is', null).maybeSingle(), deadline)
      if (error) throw new Error(error.message)
      target = (data as { target_id?: string | null } | null)?.target_id ?? null
    }
    const fortnoxSupplier = own !== null && job.provider === 'fortnox'
    if (!target && fortnoxSupplier && ref.id) {
      const { data, error } = await withinMigrationDeadline(supabase.from('supplier_invoices').select('id')
        .eq('company_id', job.company_id).eq('fortnox_number', ref.id).neq('id', c.target_id).limit(1), deadline)
      if (error) throw new Error(error.message)
      target = (data as { id: string }[] | null)?.[0]?.id ?? null
    }
    if (!target && ref.invoiceNumber) {
      let query = supabase.from(table).select('id')
        .eq('company_id', job.company_id).eq(numberColumn, ref.invoiceNumber).neq('id', c.target_id)
      if (own) query = query.eq('supplier_id', own.supplier_id).eq('is_credit_note', false)
      if (fortnoxSupplier) query = query.is('fortnox_number', null)
      const { data, error } = await withinMigrationDeadline(query.limit(2), deadline)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as { id: string }[]
      target = rows.length === 1 ? rows[0].id : null
    }
    if (!target || target === c.target_id) {
      log.warn('credit note left unpaired: credited invoice not found', { jobId: job.id, chunkId: c.id, creditedInvoice: ref.invoiceNumber ?? ref.id })
      continue
    }
    if (own) {
      const original = await supplierPairingFacts(supabase, job, target, deadline)
      if (!original || original.is_credit_note || original.supplier_id !== own.supplier_id
        || original.currency !== own.currency || Math.abs(own.total) > Math.abs(original.total) + ORE_TOLERANCE) {
        log.warn('supplier credit note left unpaired: the named invoice is not one this credit note can credit', { jobId: job.id, chunkId: c.id })
        continue
      }
    }
    const { error } = await withinMigrationDeadline(supabase.from(table).update({ credited_invoice_id: target })
      .eq('id', c.target_id).eq('company_id', job.company_id).is('credited_invoice_id', null), deadline)
    // The schema refuses a pair that would over-credit the original or mix
    // currencies (enforce_credit_note_total_within_original, 23514). That is
    // a verdict on this pair, not a fault to retry: replaying it would wedge
    // the whole job on one document. The credit note stays unpaired, with the
    // number it names in its notes, and provider_migration_counts reports it.
    if (error?.code === '23514') {
      log.warn('credit note left unpaired: the pair was refused by the credit cap', { jobId: job.id, chunkId: c.id })
      continue
    }
    if (error) throw new Error(error.message)
  }
}

interface SupplierPairingFacts { supplier_id: string; currency: string; total: number; is_credit_note: boolean }

async function supplierPairingFacts(supabase: SupabaseClient, job: ProviderMigrationJob, id: string, deadline: number): Promise<SupplierPairingFacts | null> {
  const { data, error } = await withinMigrationDeadline(supabase.from('supplier_invoices')
    .select('supplier_id,currency,total,is_credit_note').eq('id', id).eq('company_id', job.company_id).maybeSingle(), deadline)
  if (error) throw new Error(error.message)
  return (data as SupplierPairingFacts | null) ?? null
}

type PartyResource = 'customers' | 'suppliers'
type CustomerCardDetails = ExistingCustomerMetadata & { id: string }
type SupplierCardDetails = ExistingSupplierDetails & { id: string }

/**
 * Fill in what a register record knows and the card it was committed onto
 * lacks (crm#1436). The commit resolves a record onto a card that already
 * existed (an invoice stub, an earlier import, a hand-made card) without
 * writing the record to it, so such a card kept none of the phone, e-mail
 * and address a new card gets. Only a column the card has as NULL is filled
 * (buildCustomerMetadataEnrichment); a value it has is never replaced, so a
 * re-run moves nothing. The records are committed already: a failure here
 * is logged and leaves the cards as they were.
 */
export async function enrichCommittedParties(supabase: SupabaseClient, job: ProviderMigrationJob,
  records: Record<string, unknown>[], partyChunkIds: ReadonlyMap<string, PartyResource>, deadline: number): Promise<void> {
  const rows = new Map<string, Record<string, unknown>>()
  for (const record of records) {
    if (record.row && partyChunkIds.has(record.id as string)) rows.set(record.id as string, record.row as Record<string, unknown>)
  }
  if (rows.size === 0) return
  let filled = 0
  let changed = 0
  const dbError = (error: { message: string; code?: string }) => Object.assign(new Error(error.message), { code: error.code })
  try {
    const { data, error } = await withinMigrationDeadline(supabase.from('migration_job_chunks').select('id, target_id')
      .eq('job_id', job.id).eq('state', 'done').in('id', [...rows.keys()]), deadline)
    if (error) throw dbError(error)
    const targets = new Map<string, string>()
    for (const chunk of (data ?? []) as { id: string; target_id: string | null }[]) {
      if (chunk.target_id && rows.has(chunk.id)) targets.set(chunk.id, chunk.target_id)
    }
    const idsOf = (resource: PartyResource) => [...new Set([...targets].filter(([id]) => partyChunkIds.get(id) === resource).map(([, target]) => target))]
    const customerIds = idsOf('customers')
    const supplierIds = idsOf('suppliers')
    const customers = new Map<string, CustomerCardDetails>()
    const suppliers = new Map<string, SupplierCardDetails>()
    if (customerIds.length > 0) {
      const read = await withinMigrationDeadline(supabase.from('customers')
        .select('id, org_number, customer_type, contact_person, invoice_email_cc_addresses, invoice_email_bcc_addresses, email, phone, address_line1, address_line2, postal_code, city, country, vat_number, notes')
        .eq('company_id', job.company_id).in('id', customerIds), deadline)
      if (read.error) throw dbError(read.error)
      for (const card of (read.data ?? []) as CustomerCardDetails[]) customers.set(card.id, card)
    }
    if (supplierIds.length > 0) {
      const read = await withinMigrationDeadline(supabase.from('suppliers')
        .select('id, org_number, email, phone, address_line1, address_line2, postal_code, city, country, vat_number, bankgiro, plusgiro, bank_account, clearing_number, account_number, iban, bic, notes')
        .eq('company_id', job.company_id).in('id', supplierIds), deadline)
      if (read.error) throw dbError(read.error)
      for (const card of (read.data ?? []) as SupplierCardDetails[]) suppliers.set(card.id, card)
    }
    // Two records committed onto one card in a batch: the first one fills it.
    const seen = new Set<string>()
    for (const [chunkId, target] of targets) {
      if (seen.has(target)) continue
      seen.add(target)
      const row = rows.get(chunkId)!
      let outcome: Awaited<ReturnType<typeof writeCustomerEnrichment>> | null = null
      if (partyChunkIds.get(chunkId) === 'customers') {
        const card = customers.get(target)
        const changes = card ? buildCustomerMetadataEnrichment(card, row) : null
        if (changes) outcome = await withinMigrationDeadline(writeCustomerEnrichment(supabase, job.company_id, target, changes), deadline)
      } else {
        const card = suppliers.get(target)
        const changes = card ? buildSupplierEnrichment(card, row) : null
        if (changes) outcome = await withinMigrationDeadline(writeSupplierEnrichment(supabase, job.company_id, target, changes), deadline)
      }
      if (outcome?.error) throw dbError(outcome.error)
      if (outcome?.data) filled++
      else if (outcome) changed++
    }
  } catch (error) {
    log.warn('matched cards left without the register details', { jobId: job.id, filled, changed,
      code: failureCode(error), ...failureDetails(error) })
    return
  }
  if (filled > 0 || changed > 0) log.info('matched cards filled from the register', { jobId: job.id, filled, changed })
}

async function importBatch(supabase: SupabaseClient, job: ProviderMigrationJob, chunks: MigrationChunk[],
  connection: ResolvedConsent, deadline: number, onCommit: () => void): Promise<void> {
  let batch: Record<string, unknown>[] = []
  let bytes = 0
  const parties = new Map<string, PartyCandidate>()
  const partyChunkIds = new Map<string, PartyResource>()
  for (const c of chunks) if (c.resource === 'customers' || c.resource === 'suppliers') partyChunkIds.set(c.id, c.resource)
  const commit = async () => {
    if (!batch.length) return
    // A customer the company already has a card for is mapped onto that card
    // first, so the commit reuses it instead of creating a stub (crm#1294).
    const written = batch.flatMap(record => {
      const party = record.row ? parties.get(record.id as string) : undefined
      return party ? [party] : []
    })
    await adoptExistingCustomers(supabase, job, written, promise => withinMigrationDeadline(promise, deadline))
    await migrationRpc(supabase, job, 'commit_provider_migration_records', { p_records: batch }, deadline)
    onCommit()
    const committed = batch
    batch = []; bytes = 0
    await enrichCommittedParties(supabase, job, committed, partyChunkIds, deadline)
  }
  try {
    for (const c of chunks) {
      if (Date.now() >= deadline - 5000) break
      let record: Record<string, unknown>
      try { record = await prepareRecord(supabase, job, c, connection, deadline, parties) }
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
        // The review keeps what was found (receipt.review), so the wizard can
        // say why the voucher was not linked instead of only that it was not.
        ...(['ambiguous', 'amountMismatch'].includes(report.outcome) ? { error: 'MIGRATION_REGISTRATION_REVIEW',
          review: { kind: 'registration', outcome: report.outcome,
            bookedSek: report.bookedSek ?? null, expectedSek: report.expectedSek ?? null } } : {}) }
    })
  } else if (job.phase === 'reconcile') {
    const result = await reconcileSupplierInvoiceVouchers({ supabase, companyId: job.company_id, userId: job.user_id,
      dryRun: true, invoiceIds: chunks.map(c => c.target_id!), maxInvoices: BATCH_SIZE })
    records = chunks.map(c => {
      const review = result.review.find(item => item.supplier_invoice_id === c.target_id)
      return { id: c.id, payment: result.links.find(link => link.supplier_invoice_id === c.target_id) ?? null,
        ...(review ? { error: 'MIGRATION_PAYMENT_REVIEW', review: { kind: 'payment', reason: review.reason } } : {}) }
    })
  } else records = chunks.map(c => ({ id: c.id }))
  await commitFollowup(supabase, job, records, deadline)
}

/**
 * A link batch in which a foreign-currency invoice takes the SEK amount its
 * verifikat books (report.sourceRate, crm#1039) commits through
 * commit_provider_migration_source_rate_links: the followup itself, then that
 * amount onto each invoice the followup linked, in one transaction. Until
 * migration 20261005230200 is applied the function is missing (PGRST202):
 * such an invoice then stops for review as it did before, and a retry links
 * it once the function exists.
 *
 * Silent like the SIE import it follows: the settle phase reaches
 * link_supplier_invoice_to_voucher inside SQL, and a kursdifferens verifikat
 * it posts there emits no journal_entry.committed. A migration brings in
 * history whose own vouchers were never announced (DECISIONS.md 2026-10-08).
 */
async function commitFollowup(supabase: SupabaseClient, job: ProviderMigrationJob, records: Record<string, unknown>[],
  deadline: number): Promise<void> {
  const atSourceRate = (r: Record<string, unknown>) => !!(r.report as RegistrationLinkReport | undefined)?.sourceRate
  if (job.phase !== 'link' || !records.some(atSourceRate)) {
    await migrationRpc(supabase, job, 'commit_provider_migration_followup', { p_records: records }, deadline)
    return
  }
  try {
    await migrationRpc(supabase, job, 'commit_provider_migration_source_rate_links', { p_records: records }, deadline)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'PGRST202') throw error
    log.warn('source-rate links left for review: commit_provider_migration_source_rate_links is not deployed', { jobId: job.id })
    await migrationRpc(supabase, job, 'commit_provider_migration_followup', {
      p_records: records.map(r => atSourceRate(r) ? { id: r.id, error: 'MIGRATION_REGISTRATION_REVIEW' } : r),
    }, deadline)
  }
}

export function failureCode(error: unknown): string {
  // The worker's own deadline is a deferral, never a provider failure.
  if (error instanceof ExecutionBudgetExceeded) return 'MIGRATION_DEADLINE'
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

/**
 * Structured facts only. A raw message can quote the row a database error
 * rejected, so it stays out of the log; the class, SQLSTATE or PostgREST
 * code, HTTP status and the provider's numeric error code say which layer
 * failed and how. The provider code tells a missing Fortnox licence (2001101)
 * from a missing permission (2000663) apart, which the status alone does not.
 */
function failureDetails(error: unknown): { errorName: string; dbCode?: string; httpStatus?: number; providerCode?: string } {
  // The consent resolver throws plain objects with a status, not Errors.
  const { code, statusCode, status } = (typeof error === 'object' && error !== null ? error : {}) as
    { code?: unknown; statusCode?: unknown; status?: unknown }
  const http = typeof statusCode === 'number' ? statusCode : typeof status === 'number' ? status : undefined
  const providerCode = fortnoxApiErrorCode(error)
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code) ? { dbCode: code } : {}),
    ...(http !== undefined && Number.isInteger(http) && http >= 100 && http <= 599 ? { httpStatus: http } : {}),
    ...(providerCode ? { providerCode } : {}),
  }
}

/**
 * Reads only a 403 that classifyProviderError would call a dead grant
 * (PROVIDER_AUTH_EXPIRED): a job spans invocations and reconnects, so the
 * token is asked instead of a run's history (crm#1081). Running out of time
 * defers the step.
 */
async function readMigrationRefusal(error: unknown, job: ProviderMigrationJob, connection: ResolvedConsent,
  deadline: number): Promise<unknown> {
  if (failureCode(error) !== 'PROVIDER_AUTH_EXPIRED') return error
  return withinMigrationDeadline(readProviderRefusal(error, job.provider as ProviderName, connection, deadline), deadline)
}

/**
 * One page of a register, or null when the provider refused the register.
 *
 * A refusal is the provider's verdict on the register, not a fault: Fortnox
 * answers 2001101 when the company's plan lacks the module (customers and
 * invoices need Kundfaktura or Order) and 2000663 or a 403 when the user who
 * connected lacks the right. Every retry gets the same answer, so the job
 * records the register with why and moves on to the next one: the others
 * still import, and the wizard names the refused one with its remedy. Pages
 * of the register already saved stay and import.
 */
async function fetchRegisterPage(supabase: SupabaseClient, job: ProviderMigrationJob, connection: ResolvedConsent,
  resource: MigrationResource, deadline: number): Promise<Awaited<ReturnType<typeof fetchMigrationPage>> | null> {
  try {
    // The budget scope reaches the provider client, its rate limiter and
    // withRetry: at the deadline the request aborts and no retry starts.
    // The outer race alone only stops waiting, and left up to three 60 s
    // attempts running on in a long-lived (self-hosted) process.
    return await withinMigrationDeadline(withExecutionDeadline(deadline, 'migration-list',
      () => fetchMigrationPage(job.provider as ProviderName, connection.accessToken,
        connection.providerCompanyId, resource, job.next_page,
        { allSupplierInvoices: job.fiscal_year_scope?.allSupplierInvoices === true })), deadline)
  } catch (error) {
    if (failureCode(await readMigrationRefusal(error, job, connection, deadline)) !== 'PROVIDER_RESOURCE_FORBIDDEN') throw error
    const reason = providerRefusalReason(error)
    await migrationRpc(supabase, job, 'skip_provider_migration_resource',
      { p_resource: resource, p_page: job.next_page, p_reason: reason }, deadline)
    log.warn('migration register refused by the provider: skipped', { jobId: job.id, resource, page: job.next_page,
      reason, ...failureDetails(error) })
    return null
  }
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
    let started = Date.now()
    // This claim moved the job: a checkpoint, or records an import batch
    // committed before the deadline cut it short. Running out of time is a
    // deferral only then (see the catch).
    let moved = false
    try {
      if (!job.consent_id) throw new Error('PROVIDER_AUTH_EXPIRED')
      const connection = await withinMigrationDeadline(resolveConsent(job.company_id, job.consent_id), deadline - 5000)
      const sourceAccount = String(connection.consent.org_number ?? '').replace(/[^a-z0-9]/gi, '') || connection.providerCompanyId
      if (connection.consent.provider !== job.provider || sourceAccount !== job.account_key) {
        throw new Error('MIGRATION_SOURCE_IDENTITY_CHANGED')
      }
      while (Date.now() < deadline - 10_000 && job.state === 'running') {
        started = Date.now()
        log.info('migration phase started', { jobId: job.id, phase: job.phase, resource: job.resources[job.resource_index - 1], page: job.next_page })
        if (job.phase === 'discover') {
          const resource = job.resources[job.resource_index - 1]
          const page = await fetchRegisterPage(supabase, job, connection, resource, deadline - 5000)
          if (page) {
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
            log.info('migration page persisted', { jobId: job.id, resource, page: job.next_page, rows: records.length, total: page.total,
              ...(page.declined ? { declined: page.declined } : {}) })
          }
        } else {
          const state = { import: 'pending', link: 'imported', reconcile: 'linked', settle: 'planned', completed: 'done' }[job.phase]
          const { data: rows, error: readError } = await withinMigrationDeadline(supabase.from('migration_job_chunks')
            .select('id,resource,source_id,payload,target_id,receipt').eq('company_id', job.company_id).eq('job_id', job.id)
            .eq('state', state).order('resource_order').order('id').limit(BATCH_SIZE), deadline - 5000)
          if (readError) throw new Error(readError.message)
          const chunks = (rows ?? []) as MigrationChunk[]
          if (!chunks.length) {
            await migrationRpc(supabase, job, 'advance_provider_migration_job', {}, deadline - 5000)
          }
          else if (job.phase === 'import') await importBatch(supabase, job, chunks, connection, deadline - 5000, () => { moved = true })
          else await withinMigrationDeadline(followupBatch(supabase, job, chunks, deadline - 5000), deadline - 5000)
        }
        batches++
        moved = true
        log.info('migration phase checkpointed', { jobId: job.id, phase: job.phase, elapsedMs: Date.now() - started })
        const { data: current, error: currentError } = await withinMigrationDeadline(supabase.from('migration_jobs').select('*')
          .eq('id', job.id).eq('company_id', job.company_id)
          .eq('worker_id', job.worker_id).eq('attempt', job.attempt).maybeSingle(), deadline - 5000)
        if (currentError) throw new Error(currentError.message)
        if (!current) return { jobs, batches }
        job = current as ProviderMigrationJob
      }
      if (job.state === 'running') {
        if (!moved) throw new Error('MIGRATION_STALLED')
        await migrationRpc(supabase, job, 'release_provider_migration_job', {}, deadline)
      }
    } catch (error) {
      const failedAt = Date.now()
      // Out of time after moving the job is a deferral: the next claim resumes
      // where this one stopped. Out of time with nothing moved is a stall and
      // counts like a failure. A release without a code resets the streak, so
      // a step that always overran the budget looped as "running" every
      // minute and never asked the user to act (#115).
      const failed = failureCode(error)
      const code = failed === 'MIGRATION_DEADLINE' && !moved ? 'MIGRATION_STALLED' : failed
      const deferred = code === 'MIGRATION_DEADLINE'
      const attention = !deferred && (['PROVIDER_AUTH_EXPIRED','PROVIDER_RESOURCE_FORBIDDEN','PROVIDER_LICENSE_MISSING','PROVIDER_API_MODULE_INACTIVE',
        'BOKIO_PLAN_NO_API','MIGRATION_WRITE_FORBIDDEN','MIGRATION_SOURCE_IDENTITY_CHANGED','PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED'].includes(code) || job.failures >= 4)
      await migrationRpc(supabase, job, 'release_provider_migration_job', {
        p_error_code: deferred ? null : code,
        p_retry_seconds: deferred ? 0 : attention ? -1 : migrationRetrySeconds(job.failures + 1),
      }, deadline).catch(releaseError => {
        // An unreachable database must not hold the invocation open. The
        // lease expires and the next worker replays any uncertain commit.
        log.warn('migration release deferred to lease expiry', { jobId: job.id, code: failureCode(releaseError) })
      })
      // The code alone hid a 15 s timeout behind MIGRATION_RETRY for hours:
      // name the step and the error so the next one reads itself.
      // A stall that parks the job reaches error tracking; the user sees the retry card.
      const report = code === 'MIGRATION_STALLED' && attention ? log.error : log.warn
      report('migration yielded', { jobId: job.id, code, needsAttention: attention, phase: job.phase,
        resource: job.resources[job.resource_index - 1], page: job.next_page, elapsedMs: failedAt - started,
        ...failureDetails(error) })
      break
    }
    if (options.jobId) break
  }
  return { jobs, batches }
}
