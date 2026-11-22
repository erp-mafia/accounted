import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { validateBody } from '@/lib/api/validate'
import { CustomerImportExecuteSchema } from '@/lib/api/schemas'
import { createRegisterMatcher, customerMatchRow } from '@/lib/import/shared/register-match'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { diffUpdatedRows, recordRegisterImportRun, snapshotRowsForUndo } from '@/lib/import/register-runs'
import { syncDraftVatHeadersForChangedCustomers } from '@/lib/invoices/sync-draft-vat-headers'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Customer } from '@/types'
import type { CustomerImportExecuteResult } from '@/lib/import/customers/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { encryptCustomerPersonalNumber, maskCustomerRow } from '@/lib/customers/protect-personal-number'
import {
  isOrgNumberRefusedOnIndividual,
  isPersonalNumberOrgNumberDisallowed,
  normalizeReroutedPersonalNumber,
  orgNumberHoldsPersonalNumber,
} from '@/lib/invariants/personal-number-shape'
import { COUNTRY_CONSISTENCY_MESSAGES, checkCountryConsistency } from '@/lib/vat/country-codes'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { invoiceTermsFor } from '@/lib/invoices/due-date'
import { resolveDefaultPaymentTerms } from '@/lib/customers/default-payment-terms'

/**
 * A large register goes in as several requests (lib/import/register-import-flow.ts
 * executeBatches); one batch's merges and the drafts they move fit well
 * inside this, as on the article import.
 */
export const maxDuration = 300

/**
 * How far into the request the draft sync may run ahead of the run record,
 * and how far at all. Past the first the run is recorded first, so a slow
 * sync can never cost the import its undo; the customers the sync had not
 * reached are synced after the record, and the undo keeps those as used since
 * the import. Past the second nothing new is started, so the answer goes out
 * before the platform ends the request (a 504 would make the wizard send the
 * batch again, and that attempt changes nothing and so syncs nothing); the
 * customers still left are logged.
 */
const DRAFT_SYNC_BEFORE_RECORD_MS = (maxDuration - 60) * 1000
const DRAFT_SYNC_END_MS = (maxDuration - 10) * 1000

interface ExistingCustomer {
  id: string
  name: string
  customer_number: string | null
  org_number: string | null
  /** Ciphertext; read only to know whether one is stored. */
  personal_number: string | null
  email: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string
  vat_number: string | null
  default_payment_terms: number
  notes: string | null
  customer_type: string
}

/**
 * What an update does to a matched customer's type and country: the fields to
 * write, or why the row is not imported.
 *
 * It writes what the row states and nothing it does not: the parser fills a
 * type and a country in for a new customer, and an update keeps the
 * customer's own. A row that says only that the customer is a company (a no
 * in a private-person column, a word like Företag) changes a private person
 * and keeps a company's own kind. The customer form's rules (the country rule,
 * #2025; an org number on a private person; a personnummer on a foreign
 * business) are judged on the result, each only when the update touches a
 * field it reads, as in updateCustomer. When one breaks, the row's own reading
 * fills in the one of the two the row does not state from the one it does: a
 * type it names in place of the customer's takes the country the row reads
 * for it, a country it states takes the type the row reads from it, but never
 * a private person (a personnummer-shaped number may be a sole trader's org
 * number). Anything else that breaks a rule, or still does, refuses the row:
 * a VAT number or an org number alone never rewrites a type or a country.
 */
function typeAndCountryForUpdate(
  row: {
    customer_type: string
    customer_type_stated: 'type' | 'business' | null
    country: string
    country_stated: boolean
    vat_number: string | null
    org_number: string | null
    personal_number: string | null
  },
  customer: ExistingCustomer,
): { write: { customer_type?: string; country?: string } } | { refusal: string } {
  const typeNamed = row.customer_type_stated === 'type'
  const typeStated = typeNamed
    || (row.customer_type_stated === 'business' && customer.customer_type === 'individual')
  // The file's org number: the schema moves a personnummer out of it when
  // the row reads as a private person.
  const fileOrgNumber = row.org_number || row.personal_number
  const brokenRule = (customerType: string, country: string | null, writesTypeOrCountry: boolean) => {
    if (writesTypeOrCountry || row.vat_number) {
      const issue = checkCountryConsistency({ partyType: customerType, country, vatNumber: row.vat_number || customer.vat_number })
      if (issue) return COUNTRY_CONSISTENCY_MESSAGES[issue].sv
    }
    if (isOrgNumberRefusedOnIndividual(customerType, fileOrgNumber)) {
      return getErrorEntry('CUSTOMER_ORG_NUMBER_ON_INDIVIDUAL')?.message_sv ?? null
    }
    // A company keeps its org number when the file has none; that one is
    // judged only against a type the update changes.
    const orgNumber = fileOrgNumber || (customerType !== customer.customer_type ? customer.org_number : null)
    if (isPersonalNumberOrgNumberDisallowed(customerType, orgNumber)) {
      return getErrorEntry('CUSTOMER_ORG_NUMBER_IS_PERSONAL')?.message_sv ?? null
    }
    return null
  }

  const customerType = typeStated ? row.customer_type : customer.customer_type
  const country = row.country_stated ? row.country : customer.country
  const broken = brokenRule(customerType, country, typeStated || row.country_stated)
  if (!broken) {
    return {
      write: {
        ...(typeStated ? { customer_type: customerType } : {}),
        ...(row.country_stated ? { country } : {}),
      },
    }
  }
  const fillsIn = typeNamed
    ? !row.country_stated && row.customer_type !== customer.customer_type
    : row.country_stated && !typeStated && row.customer_type !== 'individual'
  if (!fillsIn) return { refusal: broken }
  const stillBroken = brokenRule(row.customer_type, row.country, true)
  if (stillBroken) return { refusal: stillBroken }
  return { write: { customer_type: row.customer_type, country: row.country } }
}

/**
 * POST /api/import/customers/execute
 *
 * Imports validated customer rows. Duplicates (matched by customer number,
 * org number or e-mail, or a same-name customer the user confirmed: see
 * lib/import/shared/register-match.ts) are either updated (merge: only
 * non-empty file fields overwrite, and the type and country only when the
 * file states them) or skipped based on `update_duplicates`.
 *
 * An individual's personnummer arrives in the org number column; the schema
 * moves it into personal_number and this route stores it encrypted, with
 * org_number empty. It is never a match key, here as in the preview
 * (customerMatchRow): an individual is found by customer number, e-mail or a
 * confirmed name only, and never in a business that has an org number.
 */
export const POST = withRouteContext(
  'register_import.customers.execute',
  async (request, ctx) => {
    const startedAt = Date.now()
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, CustomerImportExecuteSchema, {
      log,
      operation: 'register_import.customers.execute',
    })
    if (!result.success) return result.response

    const { rows, update_duplicates } = result.data
    const opLog = log.child({ rowCount: rows.length, updateDuplicates: update_duplicates })

    if (rows.length === 0) {
      return errorResponseFromCode('REG_IMPORT_NO_ROWS', opLog, { requestId })
    }

    try {
      const beforeImport = await snapshotRowsForUndo(supabase, companyId, 'customers', update_duplicates)
      const existingRaw = await fetchAllRows(({ from, to }) =>
        supabase
          .from('customers')
          .select(
            'id, name, customer_number, org_number, email, phone, address_line1, address_line2, ' +
              'postal_code, city, country, vat_number, default_payment_terms, notes, ' +
              'customer_type, personal_number',
          )
          .eq('company_id', companyId)
          .range(from, to),
      )
      const existing = existingRaw as unknown as ExistingCustomer[]

      const matcher = createRegisterMatcher(existing)
      // A row without terms puts a new card on the company default: read once.
      const companyDefaultTerms = rows.some((row) => row.default_payment_terms === null)
        ? await resolveDefaultPaymentTerms(supabase, companyId, undefined)
        : null

      const created: Customer[] = []
      const updated: Customer[] = []
      let skipped = 0
      const errors: { row_index: number; name: string; reason: string }[] = []

      for (const row of rows) {
        const match = matcher.resolve(customerMatchRow(row), row.confirmed_duplicate_of)

        if (match) {
          if (!update_duplicates) {
            skipped++
            continue
          }

          const typeAndCountry = typeAndCountryForUpdate(row, match)
          if ('refusal' in typeAndCountry) {
            errors.push({ row_index: row.row_index, name: row.name, reason: typeAndCountry.refusal })
            continue
          }
          // Merge mode: only overwrite fields where the file has a non-empty value.
          const merged: Record<string, unknown> = { ...typeAndCountry.write }
          const customerType = typeAndCountry.write.customer_type ?? match.customer_type
          if (row.name) merged.name = row.name
          if (row.customer_number) merged.customer_number = row.customer_number
          if (customerType === 'individual') {
            // An individual has no org number, so whatever the matched row
            // carried there goes. A personnummer an earlier import stored
            // there is kept, encrypted in personal_number, unless the file
            // brings one or the row already holds one.
            if (match.org_number?.trim()) merged.org_number = null
            const personalNumber = row.personal_number
              ?? (!match.personal_number && orgNumberHoldsPersonalNumber('individual', match.org_number)
                ? normalizeReroutedPersonalNumber(match.org_number!)
                : null)
            if (personalNumber) merged.personal_number = encryptCustomerPersonalNumber(personalNumber)
          } else {
            // A business's org number may be a personnummer (an enskild
            // firma's): one the schema moved out because the file did not
            // type the row and it read as a private person goes back.
            const orgNumber = row.org_number || row.personal_number
            if (orgNumber) merged.org_number = orgNumber
          }
          if (row.email) merged.email = row.email
          if (row.phone) merged.phone = row.phone
          if (row.address_line1) merged.address_line1 = row.address_line1
          if (row.address_line2) merged.address_line2 = row.address_line2
          if (row.postal_code) merged.postal_code = row.postal_code
          if (row.city) merged.city = row.city
          if (row.vat_number) merged.vat_number = row.vat_number
          if (row.default_payment_terms !== null) merged.default_payment_terms = row.default_payment_terms
          if (row.notes) merged.notes = row.notes

          if (Object.keys(merged).length === 0) {
            skipped++
            continue
          }

          const { data, error } = await supabase
            .from('customers')
            .update(merged)
            .eq('id', match.id)
            .eq('company_id', companyId)
            .select()
            .single()

          if (error) {
            errors.push({ row_index: row.row_index, name: row.name, reason: getUserErrorMessage(error) })
            continue
          }
          if (data) {
            updated.push(data as Customer)
            matcher.add(data as ExistingCustomer)
          }
          continue
        }

        // No match, create.
        const { data, error } = await supabase
          .from('customers')
          .insert({
            user_id: user.id,
            company_id: companyId,
            name: row.name,
            customer_type: row.customer_type,
            customer_number: row.customer_number || null,
            email: row.email,
            phone: row.phone,
            address_line1: row.address_line1,
            address_line2: row.address_line2,
            postal_code: row.postal_code,
            city: row.city,
            country: row.country || 'SE',
            org_number: row.org_number,
            // Stored as ciphertext (customers_personal_number_check).
            personal_number: encryptCustomerPersonalNumber(row.personal_number),
            vat_number: row.vat_number,
            default_payment_terms: invoiceTermsFor(row.default_payment_terms, companyDefaultTerms),
            notes: row.notes,
          })
          .select()
          .single()

        if (error) {
          // Treat unique-violation as a soft skip (race with concurrent import).
          if (error.code === '23505') {
            skipped++
            continue
          }
          errors.push({ row_index: row.row_index, name: row.name, reason: getUserErrorMessage(error) })
          continue
        }
        if (data) {
          created.push(data as Customer)
          // Later rows in the same batch dedup against it too.
          matcher.add(data as ExistingCustomer)
        }
      }

      // Emit events for downstream listeners (non-blocking).
      // Masked like POST /api/customers: the row carries personal_number
      // ciphertext, which no listener needs.
      for (const c of created) {
        await eventBus.emit({
          type: 'customer.created',
          payload: { customer: maskCustomerRow(c), companyId: companyId!, userId: user.id },
        })
      }

      // A personnummer the merge moved out of a legacy individual's
      // org_number stays out of the undo record: register_import_runs would
      // hold it in plaintext and the undo would put it back in org_number.
      // The undo restores the row's other fields and leaves it encrypted.
      for (const c of updated) {
        const prev = beforeImport.get(c.id)
        if (
          prev?.customer_type === 'individual'
          && c.customer_type === 'individual'
          && orgNumberHoldsPersonalNumber('individual', prev.org_number as string | null)
        ) {
          beforeImport.set(c.id, { ...prev, org_number: c.org_number, personal_number: c.personal_number })
        }
      }

      // A merge that changed a field the VAT header is derived from moves the
      // header of that customer's open drafts, as the customer form does
      // (updateCustomer). Before the run is recorded: the undo reads a draft
      // written after the run as the customer used since the import. Within
      // DRAFT_SYNC_BEFORE_RECORD_MS, so the run is always recorded.
      const draftSync = await syncDraftVatHeadersForChangedCustomers(
        supabase,
        companyId,
        diffUpdatedRows(beforeImport, new Set(created.map((c) => c.id)), updated),
        { deadline: startedAt + DRAFT_SYNC_BEFORE_RECORD_MS },
      )

      const runId = await recordRegisterImportRun(supabase, { companyId, userId: user.id, kind: 'customers', created, updated, before: beforeImport }, opLog)

      if (draftSync.unsynced.length > 0) {
        const late = await syncDraftVatHeadersForChangedCustomers(
          supabase,
          companyId,
          draftSync.unsynced,
          { deadline: startedAt + DRAFT_SYNC_END_MS },
        )
        opLog.warn('draft VAT sync ran past the import run record', {
          registerImportRunId: runId,
          // Their customers' undo keeps them, as used since the import.
          draftsUpdatedAfterRecord: late.updated,
          // Their open drafts keep the header they had before the import.
          customersNotSynced: late.unsynced.map((change) => change.id),
        })
      }

      const response: CustomerImportExecuteResult = {
        success: errors.length === 0,
        created: created.length,
        updated: updated.length,
        skipped,
        failed: errors.length,
        errors,
      }

      opLog.info('customer import complete', response)

      return NextResponse.json({ data: response })
    } catch (err) {
      opLog.error('customer import execute failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
