/**
 * Migration orchestrator: coordinates the data migration from
 * an external accounting system directly via provider APIs into gnubok.
 *
 * Bookkeeping data (accounts, balances, vouchers) is imported
 * via SIE files through the core SIE import engine. This orchestrator
 * handles only entity-level imports:
 *   1. Company info → pre-fill company_settings
 *   2. Customers → needed before sales invoices
 *   3. Suppliers → needed before supplier invoices
 *   4. Sales invoices (all statuses, duplicates skipped)
 *   5. Supplier invoices (all statuses, duplicates skipped)
 *
 * Performance note: All steps use bulk reads + chunked inserts to
 * avoid N+1 round-trips that would exhaust the Vercel function
 * timeout (300s hard cap). A typical import with a few thousand
 * entities completes in a handful of Supabase requests per step.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MigrationProgress, MigrationResults, SkipReasons } from '../types'
import type { ProviderName } from '@/lib/providers/types'
import type { CustomerDto, SupplierDto, SalesInvoiceDto, SupplierInvoiceDto, PartyDto } from '@/lib/providers/dto'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { normalizeVatNumber, isValidSwedishVatNumber } from '@/lib/vat/vat-number'
import {
  fetchCompanyInfoDirect,
  fetchCustomersDirect,
  fetchSuppliersDirect,
  fetchSalesInvoicesDirect,
  fetchSupplierInvoicesDirect,
} from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import {
  buildCustomerMetadataEnrichment,
  type CustomerMetadataEnrichment,
  type ExistingCustomerMetadata,
} from './customer-metadata'
import {
  mapCustomer,
  mapSupplier,
  mapSalesInvoice,
  mapSupplierInvoice,
  mapCompanyInfo,
  inferTypeFromParty,
  buildFxRateIndex,
  type FxUnresolved,
} from './entity-mapper'

const log = createLogger('extensions/arcim-migration/migration-orchestrator')

export interface MigrationOptions {
  consentId: string
  companyId: string
  userId: string
  supabase: SupabaseClient
  importCompanyInfo?: boolean
  importCustomers?: boolean
  importSuppliers?: boolean
  importSalesInvoices?: boolean
  importSupplierInvoices?: boolean
  /** Auto-link imported supplier invoices to GL payment vouchers. Default true. */
  reconcileVouchers?: boolean
  onProgress?: (progress: MigrationProgress) => void
}

/**
 * Chunk size for bulk inserts. 500 rows/request keeps payloads below
 * PostgREST's practical size limit while minimising round-trips.
 */
const INSERT_CHUNK_SIZE = 500
const ENRICHMENT_CONCURRENCY = 10

function emitProgress(options: MigrationOptions, progress: MigrationProgress) {
  options.onProgress?.(progress)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function getOrgNumberFromParty(party: PartyDto): string | null {
  return (
    party.legalEntity?.companyId ||
    party.identifications?.find((i) => i.schemeId === 'SE:ORGNR')?.id ||
    null
  )
}

/**
 * Log a foreign-currency document that was imported WITHOUT a SEK conversion.
 *
 * It is still imported (dropping it would lose räkenskapsinformation), but it
 * carries exchange_rate = null, so every booking path refuses it loudly rather
 * than posting it as if 1 unit = 1 SEK. Counted into the step's result so the
 * migration reports it instead of passing it off as an ordinary import.
 */
function logFxUnresolved(kind: string, invoiceNumber: string, fx: FxUnresolved): void {
  // Structured logger, not console.error: the record passes the observability
  // redaction pipeline (lib/observability/redact.ts) before it can reach any
  // sink, so invoice identifiers in log output stay inside the same PII
  // controls as every other server log line.
  log.error('document imported without a SEK conversion; set an exchange rate before booking it', {
    entityType: kind,
    entityId: invoiceNumber,
    currency: fx.currency,
    documentDate: fx.date || null,
    reason: fx.reason,
  })
}

// ── Main orchestrator ─────────────────────────────────────────────

export async function executeMigration(options: MigrationOptions): Promise<MigrationResults> {
  const { consentId, companyId, userId, supabase } = options
  const results: MigrationResults = {}

  // Resolve consent to get access token and provider
  const resolved = await resolveConsent(companyId, consentId)
  const provider = resolved.consent.provider as ProviderName
  const accessToken = resolved.accessToken
  const providerCompanyId = resolved.providerCompanyId

  try {
    // ── Step 1: Company information ───────────────────────────────
    if (options.importCompanyInfo !== false) {
      emitProgress(options, { status: 'fetching', currentStep: 'Hämtar företagsinformation...', progress: 5 })
      try {
        const companyInfo = await fetchCompanyInfoDirect(provider, accessToken, providerCompanyId)
        if (companyInfo) {
          const mapped = mapCompanyInfo(companyInfo)
          const { data: existing } = await supabase
            .from('company_settings')
            .select('company_name, org_number, vat_number')
            .eq('company_id', companyId)
            .single()

          const updates: Record<string, unknown> = {}
          if (!existing?.company_name && mapped.company_name) updates.company_name = mapped.company_name
          if (!existing?.org_number && mapped.org_number) updates.org_number = mapped.org_number
          if (!existing?.vat_number && mapped.vat_number) {
            // Normalise provider input; only persist a structurally valid
            // SE+12 momsregistreringsnummer so a malformed value from an
            // external API can't enter company_settings unchecked.
            const normalizedVat = normalizeVatNumber(mapped.vat_number)
            if (isValidSwedishVatNumber(normalizedVat)) {
              updates.vat_number = normalizedVat
              updates.vat_registered = true
            } else {
              // Observability: a provider sent a VAT number we can't normalise
              // to a valid SE+12 momsregistreringsnummer. We drop it (above),
              // but surface the anomaly so consistently-bad provider data is
              // visible. Don't log the raw value: it can embed a personnummer.
              console.warn(
                `[migration] Dropped malformed VAT number from ${provider} for company ${companyId} (normalized length ${normalizedVat.length})`,
              )
            }
          }
          if (mapped.fiscal_year_start_month !== 1) {
            updates.fiscal_year_start_month = mapped.fiscal_year_start_month
          }
          if (mapped.address_line1) updates.address_line1 = mapped.address_line1
          if (mapped.postal_code) updates.postal_code = mapped.postal_code
          if (mapped.city) updates.city = mapped.city
          if (mapped.phone) updates.phone = mapped.phone
          if (mapped.email) updates.email = mapped.email

          if (Object.keys(updates).length > 0) {
            await supabase.from('company_settings').update(updates).eq('company_id', companyId)
          }
          results.companyInfo = { imported: true }
        }
      } catch (err) {
        console.error('Failed to import company info:', err)
        results.companyInfo = { imported: false }
      }
    }

    // ── Step 2: Customers (bulk) ──────────────────────────────────
    // customerIdMap: provider customer id → Accounted customer id.
    // orgNumberToCustomerId / nameToCustomerId speed up invoice lookup
    // without extra queries later.
    const customerIdMap = new Map<string, string>()
    const orgNumberToCustomerId = new Map<string, string>()
    const nameToCustomerId = new Map<string, string>()

    if (options.importCustomers !== false) {
      emitProgress(options, { status: 'importing', currentStep: 'Importerar kunder...', progress: 20 })
      try {
        const customers = await fetchCustomersDirect(provider, accessToken, providerCompanyId)

        // One bulk read instead of N `.eq('org_number', ...)` lookups.
        type ExistingCustomer = ExistingCustomerMetadata & {
          id: string
          org_number: string | null
          name: string | null
        }
        const existingCustomers = await fetchAllRows<ExistingCustomer>(
          ({ from, to }) =>
            supabase
              .from('customers')
              .select('id, org_number, name, contact_person, invoice_email_cc_addresses, invoice_email_bcc_addresses')
              .eq('company_id', companyId)
              .range(from, to)
        )
        const existingCustomerById = new Map(existingCustomers.map((row) => [row.id, row]))
        for (const row of existingCustomers) {
          if (row.org_number) orgNumberToCustomerId.set(row.org_number, row.id)
          if (row.name) nameToCustomerId.set(row.name, row.id)
        }

        let imported = 0
        let updated = 0
        let skipped = 0
        const skipReasons: SkipReasons = {}

        type PendingCustomer = {
          dto: CustomerDto
          row: Record<string, unknown>
        }
        const pending: PendingCustomer[] = []
        const pendingEnrichments: { id: string; changes: CustomerMetadataEnrichment }[] = []

        for (const customer of customers) {
          if (!customer.active) {
            skipReasons.inactive = (skipReasons.inactive ?? 0) + 1
            skipped++
            continue
          }

          // Dedup against already-imported records: prefer org-number, but fall
          // back to name when the party has no org-number. Otherwise org-less
          // customers (private persons) are re-created on every re-sync, since
          // the org-number map can never match them.
          const orgNumber = getOrgNumberFromParty(customer.party)
          const existingCustomerId = orgNumber
            ? orgNumberToCustomerId.get(orgNumber)
            : customer.party.name
              ? nameToCustomerId.get(customer.party.name)
              : undefined
          if (existingCustomerId) {
            customerIdMap.set(customer.id, existingCustomerId)
            const existingCustomer = existingCustomerById.get(existingCustomerId)
            const mapped = mapCustomer(customer, userId, companyId)
            const changes = existingCustomer
              ? buildCustomerMetadataEnrichment(existingCustomer, mapped)
              : null
            if (changes) {
              pendingEnrichments.push({ id: existingCustomerId, changes })
            } else {
              skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
              skipped++
            }
            continue
          }

          pending.push({ dto: customer, row: mapCustomer(customer, userId, companyId) })
        }

        for (const batch of chunk(pending, INSERT_CHUNK_SIZE)) {
          const rows = batch.map((p) => p.row)
          const { data: inserted, error } = await supabase
            .from('customers')
            .insert(rows)
            .select('id, org_number, name')

          if (error) {
            console.error(`[migration] Customer batch insert failed (${batch.length} rows):`, error.message)
            skipReasons.failed = (skipReasons.failed ?? 0) + batch.length
            skipped += batch.length
            continue
          }

          // PostgREST returns inserted rows in the same order as supplied,
          // so we can pair them up by index to recover the provider id.
          const insertedRows = inserted ?? []
          for (let i = 0; i < batch.length && i < insertedRows.length; i++) {
            const providerId = batch[i].dto.id
            const newId = insertedRows[i].id
            customerIdMap.set(providerId, newId)
            if (insertedRows[i].org_number) orgNumberToCustomerId.set(insertedRows[i].org_number!, newId)
            if (insertedRows[i].name) nameToCustomerId.set(insertedRows[i].name!, newId)
            imported++
          }
        }

        // A rerun can match hundreds of legacy customers. Update only rows
        // that actually have new provider metadata, with bounded concurrency,
        // so enrichment neither overwrites edits nor serializes the migration.
        for (const batch of chunk(pendingEnrichments, ENRICHMENT_CONCURRENCY)) {
          const outcomes = await Promise.all(batch.map(async ({ id, changes }) => {
            const { data, error } = await supabase
              .from('customers')
              // Object literal, not the record itself: absent keys serialize
              // away, and the phantom-column guard can resolve the columns.
              .update({
                contact_person: changes.contact_person,
                invoice_email_cc_addresses: changes.invoice_email_cc_addresses,
                invoice_email_bcc_addresses: changes.invoice_email_bcc_addresses,
              })
              .eq('id', id)
              .eq('company_id', companyId)
              .select('id')
              .maybeSingle()
            return { data, error }
          }))

          for (const outcome of outcomes) {
            if (outcome.error || !outcome.data) {
              if (outcome.error) {
                console.error('[migration] Customer metadata enrichment failed:', outcome.error.message)
              }
              skipReasons.failed = (skipReasons.failed ?? 0) + 1
              skipped++
            } else {
              updated++
            }
          }
        }

        results.customers = { total: customers.length, imported, updated, skipped, skipReasons }
      } catch (err) {
        console.error('Failed to import customers:', err)
      }
    }

    // ── Step 3: Suppliers (bulk) ──────────────────────────────────
    const supplierIdMap = new Map<string, string>()
    const orgNumberToSupplierId = new Map<string, string>()
    const nameToSupplierId = new Map<string, string>()

    if (options.importSuppliers !== false) {
      emitProgress(options, { status: 'importing', currentStep: 'Importerar leverantörer...', progress: 40 })
      try {
        const suppliers = await fetchSuppliersDirect(provider, accessToken, providerCompanyId)

        const existingSuppliers = await fetchAllRows<{ id: string; org_number: string | null; name: string | null }>(
          ({ from, to }) =>
            supabase
              .from('suppliers')
              .select('id, org_number, name')
              .eq('company_id', companyId)
              .range(from, to)
        )
        for (const row of existingSuppliers) {
          if (row.org_number) orgNumberToSupplierId.set(row.org_number, row.id)
          if (row.name) nameToSupplierId.set(row.name, row.id)
        }

        let imported = 0
        let skipped = 0
        const skipReasons: SkipReasons = {}

        type PendingSupplier = { dto: SupplierDto; row: Record<string, unknown> }
        const pending: PendingSupplier[] = []

        for (const supplier of suppliers) {
          if (!supplier.active) {
            skipReasons.inactive = (skipReasons.inactive ?? 0) + 1
            skipped++
            continue
          }

          // Same org-number-then-name dedup as customers, so org-less suppliers
          // (e.g. PostNord, IKANO BANK) aren't duplicated on every re-sync.
          const orgNumber = getOrgNumberFromParty(supplier.party)
          const existingSupplierId = orgNumber
            ? orgNumberToSupplierId.get(orgNumber)
            : supplier.party.name
              ? nameToSupplierId.get(supplier.party.name)
              : undefined
          if (existingSupplierId) {
            supplierIdMap.set(supplier.id, existingSupplierId)
            skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
            skipped++
            continue
          }

          pending.push({ dto: supplier, row: mapSupplier(supplier, userId, companyId) })
        }

        for (const batch of chunk(pending, INSERT_CHUNK_SIZE)) {
          const rows = batch.map((p) => p.row)
          const { data: inserted, error } = await supabase
            .from('suppliers')
            .insert(rows)
            .select('id, org_number, name')

          if (error) {
            console.error(`[migration] Supplier batch insert failed (${batch.length} rows):`, error.message)
            skipReasons.failed = (skipReasons.failed ?? 0) + batch.length
            skipped += batch.length
            continue
          }

          const insertedRows = inserted ?? []
          for (let i = 0; i < batch.length && i < insertedRows.length; i++) {
            const providerId = batch[i].dto.id
            const newId = insertedRows[i].id
            supplierIdMap.set(providerId, newId)
            if (insertedRows[i].org_number) orgNumberToSupplierId.set(insertedRows[i].org_number!, newId)
            if (insertedRows[i].name) nameToSupplierId.set(insertedRows[i].name!, newId)
            imported++
          }
        }

        results.suppliers = { total: suppliers.length, imported, skipped, skipReasons }
      } catch (err) {
        console.error('Failed to import suppliers:', err)
      }
    }

    // ── Step 4: Sales invoices (bulk) ─────────────────────────────
    if (options.importSalesInvoices !== false) {
      emitProgress(options, { status: 'importing', currentStep: 'Importerar kundfakturor...', progress: 60 })
      try {
        const invoices = await fetchSalesInvoicesDirect(provider, accessToken, providerCompanyId)
        console.log(`[migration] Sales invoices: ${invoices.length} total`)

        // Bulk-load existing invoice numbers once.
        const existingInvoices = await fetchAllRows<{ invoice_number: string }>(({ from, to }) =>
          supabase
            .from('invoices')
            .select('invoice_number')
            .eq('company_id', companyId)
            .range(from, to)
        )
        const existingInvoiceNumbers = new Set(existingInvoices.map((r) => r.invoice_number))

        let imported = 0
        let skipped = 0
        const skipReasons: SkipReasons = {}

        // Phase A: resolve customer for each invoice; collect those that
        // need a minimal customer record to be created on-the-fly.
        type ResolvedInvoice = { dto: SalesInvoiceDto; customerId: string }
        const resolved: ResolvedInvoice[] = []

        type NewCustomerStub = {
          key: string // dedupe key (orgNumber or lowercased name)
          row: Record<string, unknown>
          // invoices waiting for this stub's id
          waitingInvoiceIndices: number[]
        }
        const stubByKey = new Map<string, NewCustomerStub>()
        const stubsForThisBatch: { orgNumber: string | null; name: string }[] = []

        for (const inv of invoices) {
          if (existingInvoiceNumbers.has(inv.invoiceNumber)) {
            skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
            skipped++
            continue
          }

          const customerOrgNumber = getOrgNumberFromParty(inv.customer)
          let customerId: string | null = null

          if (customerOrgNumber && orgNumberToCustomerId.has(customerOrgNumber)) {
            customerId = orgNumberToCustomerId.get(customerOrgNumber)!
          } else if (nameToCustomerId.has(inv.customer.name)) {
            customerId = nameToCustomerId.get(inv.customer.name)!
          }

          if (customerId) {
            resolved.push({ dto: inv, customerId })
            continue
          }

          // Need to create a minimal customer: dedupe by org number first,
          // then by name, so invoices sharing a missing party only create
          // one stub row.
          const key = (customerOrgNumber ?? `name:${inv.customer.name.toLowerCase()}`).trim()
          let stub = stubByKey.get(key)
          if (!stub) {
            const customerType = inferTypeFromParty(inv.customer)
            const minimalCustomer = {
              user_id: userId,
              company_id: companyId,
              name: inv.customer.name,
              customer_type: customerType,
              default_payment_terms: 30,
              country:
                inv.customer.postalAddress?.countryCode ||
                (customerType === 'swedish_business' ? 'SE' : null),
              vat_number_validated: false,
              org_number: customerOrgNumber,
            }
            stub = { key, row: minimalCustomer, waitingInvoiceIndices: [] }
            stubByKey.set(key, stub)
            stubsForThisBatch.push({ orgNumber: customerOrgNumber, name: inv.customer.name })
          }
          // reserve slot; we'll backfill customerId after stubs insert
          const placeholderIndex = resolved.length
          resolved.push({ dto: inv, customerId: '' })
          stub.waitingInvoiceIndices.push(placeholderIndex)
        }

        // Phase B: insert any missing customer stubs in chunks.
        if (stubByKey.size > 0) {
          const stubList = [...stubByKey.values()]
          for (const batch of chunk(stubList, INSERT_CHUNK_SIZE)) {
            const { data: inserted, error } = await supabase
              .from('customers')
              .insert(batch.map((s) => s.row))
              .select('id, org_number, name')

            if (error) {
              console.error(
                `[migration] Sales invoice customer stub insert failed (${batch.length} rows):`,
                error.message
              )
              // Mark invoices waiting on failed stubs as no-match
              for (const s of batch) {
                for (const idx of s.waitingInvoiceIndices) {
                  resolved[idx] = { ...resolved[idx], customerId: '__FAILED__' }
                }
              }
              continue
            }

            const insertedRows = inserted ?? []
            for (let i = 0; i < batch.length && i < insertedRows.length; i++) {
              const newId = insertedRows[i].id
              if (insertedRows[i].org_number) orgNumberToCustomerId.set(insertedRows[i].org_number!, newId)
              if (insertedRows[i].name) nameToCustomerId.set(insertedRows[i].name!, newId)
              for (const idx of batch[i].waitingInvoiceIndices) {
                resolved[idx] = { ...resolved[idx], customerId: newId }
              }
            }
          }
        }

        // Drop invoices whose customer couldn't be created.
        const ready = resolved.filter((r) => {
          if (r.customerId === '__FAILED__') {
            skipReasons.noMatch = (skipReasons.noMatch ?? 0) + 1
            skipped++
            return false
          }
          return !!r.customerId
        })

        // Phase B2: resolve the SEK conversion for every foreign-currency
        // invoice, at the rate valid on its OWN issue date. The provider DTO
        // carries no rate and no SEK amount, so without this every foreign
        // invoice lands unconverted. One pass over the whole step (not per
        // chunk) so repeat (currency, date) pairs are fetched once.
        const fxRates = await buildFxRateIndex(
          supabase,
          ready.map((r) => ({ currencyCode: r.dto.currencyCode, issueDate: r.dto.issueDate }))
        )
        let fxUnresolved = 0

        // Phase C: chunk-insert invoices + their line items.
        for (const batch of chunk(ready, INSERT_CHUNK_SIZE)) {
          const mappedBatch = batch.map((r) => ({
            ...mapSalesInvoice(r.dto, userId, companyId, r.customerId, fxRates),
            dto: r.dto,
          }))

          const { data: insertedInvoices, error: invErr } = await supabase
            .from('invoices')
            .insert(mappedBatch.map((m) => m.invoice))
            .select('id')

          if (invErr) {
            console.error(`[migration] Sales invoice batch insert failed (${batch.length}):`, invErr.message)
            skipReasons.failed = (skipReasons.failed ?? 0) + batch.length
            skipped += batch.length
            continue
          }

          const invoiceRows = insertedInvoices ?? []
          const allItems: Record<string, unknown>[] = []
          for (let i = 0; i < mappedBatch.length && i < invoiceRows.length; i++) {
            const invoiceId = invoiceRows[i].id
            for (const item of mappedBatch[i].items) {
              allItems.push({ ...item, invoice_id: invoiceId })
            }
            const fx = mappedBatch[i].fxUnresolved
            if (fx) {
              fxUnresolved++
              logFxUnresolved('Sales invoice', mappedBatch[i].dto.invoiceNumber, fx)
            }
            imported++
          }

          if (allItems.length > 0) {
            for (const itemBatch of chunk(allItems, INSERT_CHUNK_SIZE)) {
              const { error: itemErr } = await supabase.from('invoice_items').insert(itemBatch)
              if (itemErr) {
                console.error(`[migration] Sales invoice items insert failed (${itemBatch.length}):`, itemErr.message)
              }
            }
          }
        }

        results.salesInvoices = { total: invoices.length, imported, skipped, skipReasons, fxUnresolved }
      } catch (err) {
        console.error('Failed to import sales invoices:', err)
      }
    }

    // ── Step 5: Supplier invoices (bulk) ──────────────────────────
    if (options.importSupplierInvoices !== false) {
      emitProgress(options, { status: 'importing', currentStep: 'Importerar leverantörsfakturor...', progress: 80 })
      try {
        const invoices = await fetchSupplierInvoicesDirect(provider, accessToken, providerCompanyId)
        console.log(`[migration] Supplier invoices: ${invoices.length} total`)

        // Load existing (supplier_invoice_number, supplier_id) pairs once.
        const existingSuppInv = await fetchAllRows<{
          supplier_invoice_number: string | null
          supplier_id: string | null
        }>(({ from, to }) =>
          supabase
            .from('supplier_invoices')
            .select('supplier_invoice_number, supplier_id')
            .eq('company_id', companyId)
            .range(from, to)
        )
        const existingSuppInvKeys = new Set(
          existingSuppInv
            .filter((r) => r.supplier_invoice_number && r.supplier_id)
            .map((r) => `${r.supplier_id}::${r.supplier_invoice_number}`)
        )

        // Compute next arrival number locally. Unique index is
        // (company_id, arrival_number); we're the only writer during
        // migration so incrementing in-memory is safe.
        const { data: maxRow } = await supabase
          .from('supplier_invoices')
          .select('arrival_number')
          .eq('company_id', companyId)
          .order('arrival_number', { ascending: false })
          .limit(1)
          .maybeSingle()
        let nextArrivalNumber = ((maxRow?.arrival_number as number | undefined) ?? 0) + 1

        let imported = 0
        let skipped = 0
        const skipReasons: SkipReasons = {}

        type ResolvedSupplierInvoice = { dto: SupplierInvoiceDto; supplierId: string }
        const resolved: ResolvedSupplierInvoice[] = []

        type NewSupplierStub = {
          key: string
          row: Record<string, unknown>
          waitingInvoiceIndices: number[]
        }
        const stubByKey = new Map<string, NewSupplierStub>()

        for (const inv of invoices) {
          const supplierOrgNumber = getOrgNumberFromParty(inv.supplier)
          let supplierId: string | null = null

          if (supplierOrgNumber && orgNumberToSupplierId.has(supplierOrgNumber)) {
            supplierId = orgNumberToSupplierId.get(supplierOrgNumber)!
          } else if (nameToSupplierId.has(inv.supplier.name)) {
            supplierId = nameToSupplierId.get(inv.supplier.name)!
          }

          if (supplierId) {
            const dupKey = `${supplierId}::${inv.invoiceNumber}`
            if (existingSuppInvKeys.has(dupKey)) {
              skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
              skipped++
              continue
            }
            resolved.push({ dto: inv, supplierId })
            continue
          }

          // Need to create a minimal supplier: dedupe the same way as customers.
          const key = (supplierOrgNumber ?? `name:${inv.supplier.name.toLowerCase()}`).trim()
          let stub = stubByKey.get(key)
          if (!stub) {
            const supplierType = inferTypeFromParty(inv.supplier)
            const minimalSupplier = {
              user_id: userId,
              company_id: companyId,
              name: inv.supplier.name,
              supplier_type: supplierType,
              default_payment_terms: 30,
              default_currency: 'SEK',
              country:
                inv.supplier.postalAddress?.countryCode ||
                (supplierType === 'swedish_business' ? 'SE' : null),
              org_number: supplierOrgNumber,
            }
            stub = { key, row: minimalSupplier, waitingInvoiceIndices: [] }
            stubByKey.set(key, stub)
          }
          const placeholderIndex = resolved.length
          resolved.push({ dto: inv, supplierId: '' })
          stub.waitingInvoiceIndices.push(placeholderIndex)
        }

        if (stubByKey.size > 0) {
          const stubList = [...stubByKey.values()]
          for (const batch of chunk(stubList, INSERT_CHUNK_SIZE)) {
            const { data: inserted, error } = await supabase
              .from('suppliers')
              .insert(batch.map((s) => s.row))
              .select('id, org_number, name')

            if (error) {
              console.error(
                `[migration] Supplier invoice supplier stub insert failed (${batch.length}):`,
                error.message
              )
              for (const s of batch) {
                for (const idx of s.waitingInvoiceIndices) {
                  resolved[idx] = { ...resolved[idx], supplierId: '__FAILED__' }
                }
              }
              continue
            }

            const insertedRows = inserted ?? []
            for (let i = 0; i < batch.length && i < insertedRows.length; i++) {
              const newId = insertedRows[i].id
              if (insertedRows[i].org_number) orgNumberToSupplierId.set(insertedRows[i].org_number!, newId)
              if (insertedRows[i].name) nameToSupplierId.set(insertedRows[i].name!, newId)
              for (const idx of batch[i].waitingInvoiceIndices) {
                resolved[idx] = { ...resolved[idx], supplierId: newId }
              }
            }
          }
        }

        // After stubs, do a final dedupe pass against existing supplier invoices
        // using the now-resolved supplierId.
        const ready = resolved.filter((r) => {
          if (r.supplierId === '__FAILED__' || !r.supplierId) {
            if (r.supplierId === '__FAILED__') {
              skipReasons.noMatch = (skipReasons.noMatch ?? 0) + 1
              skipped++
            }
            return false
          }
          const dupKey = `${r.supplierId}::${r.dto.invoiceNumber}`
          if (existingSuppInvKeys.has(dupKey)) {
            skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
            skipped++
            return false
          }
          return true
        })

        // Resolve the SEK conversion for every foreign-currency invoice at the
        // rate valid on its OWN issue date (see the sales-invoice step).
        const fxRates = await buildFxRateIndex(
          supabase,
          ready.map((r) => ({ currencyCode: r.dto.currencyCode, issueDate: r.dto.issueDate }))
        )
        let fxUnresolved = 0

        for (const batch of chunk(ready, INSERT_CHUNK_SIZE)) {
          const mappedBatch = batch.map((r) => {
            const { invoice, items, fxUnresolved: fx } = mapSupplierInvoice(
              r.dto, userId, companyId, r.supplierId, fxRates
            )
            invoice.arrival_number = nextArrivalNumber++
            return { invoice, items, fxUnresolved: fx, dto: r.dto }
          })

          const { data: insertedInvoices, error: invErr } = await supabase
            .from('supplier_invoices')
            .insert(mappedBatch.map((m) => m.invoice))
            .select('id')

          if (invErr) {
            console.error(`[migration] Supplier invoice batch insert failed (${batch.length}):`, invErr.message)
            skipReasons.failed = (skipReasons.failed ?? 0) + batch.length
            skipped += batch.length
            // Roll the counter back so we don't leave a huge gap on retry.
            nextArrivalNumber -= batch.length
            continue
          }

          const invoiceRows = insertedInvoices ?? []
          const allItems: Record<string, unknown>[] = []
          for (let i = 0; i < mappedBatch.length && i < invoiceRows.length; i++) {
            const invoiceId = invoiceRows[i].id
            for (const item of mappedBatch[i].items) {
              allItems.push({ ...item, supplier_invoice_id: invoiceId })
            }
            const fx = mappedBatch[i].fxUnresolved
            if (fx) {
              fxUnresolved++
              logFxUnresolved('Supplier invoice', mappedBatch[i].dto.invoiceNumber, fx)
            }
            imported++
          }

          if (allItems.length > 0) {
            for (const itemBatch of chunk(allItems, INSERT_CHUNK_SIZE)) {
              const { error: itemErr } = await supabase.from('supplier_invoice_items').insert(itemBatch)
              if (itemErr) {
                console.error(`[migration] Supplier invoice items insert failed (${itemBatch.length}):`, itemErr.message)
              }
            }
          }
        }

        results.supplierInvoices = { total: invoices.length, imported, skipped, skipReasons, fxUnresolved }
      } catch (err) {
        console.error('Failed to import supplier invoices:', err)
      }
    }

    // ── Step 6: Reconcile supplier invoices to GL payment vouchers ────
    // The GL (incl. the Dr 2440 / Cr 1930 bank-payment vouchers) is imported
    // separately via SIE. Supplier invoices arrive (via ?filter=unpaid) as open
    // payables with no link to those vouchers, so settled invoices would surface
    // as overdue. Auto-link the unambiguous matches. Best-effort: a failure here
    // must never fail the migration: the imported data is already persisted.
    if (options.reconcileVouchers !== false) {
      emitProgress(options, { status: 'importing', currentStep: 'Stämmer av betalningar mot verifikationer...', progress: 95 })
      try {
        const recon = await reconcileSupplierInvoiceVouchers({ supabase, companyId, userId })
        results.reconciliation = {
          scanned: recon.scanned,
          autoLinked: recon.autoLinked,
          ambiguous: recon.ambiguous,
          unmatched: recon.unmatched,
        }
        console.log(
          `[migration] Reconcile: ${recon.autoLinked} auto-linked, ${recon.ambiguous} need review, ${recon.unmatched} unmatched (${recon.scanned} scanned)`,
        )
      } catch (err) {
        console.error('Failed to reconcile supplier invoice payments:', err)
      }
    }

    emitProgress(options, { status: 'completed', progress: 100, results })
    return results
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Migration failed'
    emitProgress(options, { status: 'failed', progress: 0, error: message })
    throw error
  }
}
