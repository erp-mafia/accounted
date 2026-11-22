import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { validateBody } from '@/lib/api/validate'
import { SupplierImportExecuteSchema } from '@/lib/api/schemas'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { createRegisterMatcher } from '@/lib/import/shared/register-match'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { recordRegisterImportRun, snapshotRowsForUndo } from '@/lib/import/register-runs'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Supplier } from '@/types'
import type { SupplierImportExecuteResult } from '@/lib/import/suppliers/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { supplierPaymentTermsDays } from '@/lib/supplier-invoices/due-date'
import { typeAndCountryForUpdate } from '@/lib/import/shared/stated-fields'
import { checkCountryConsistency } from '@/lib/vat/country-codes'

interface ExistingSupplier {
  id: string
  name: string
  org_number: string | null
  email: string | null
  supplier_type: string
  country: string
  vat_number: string | null
}

export const POST = withRouteContext(
  'register_import.suppliers.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, SupplierImportExecuteSchema, {
      log,
      operation: 'register_import.suppliers.execute',
    })
    if (!result.success) return result.response

    const { rows, update_duplicates } = result.data
    const opLog = log.child({ rowCount: rows.length, updateDuplicates: update_duplicates })

    if (rows.length === 0) {
      return errorResponseFromCode('REG_IMPORT_NO_ROWS', opLog, { requestId })
    }

    try {
      const beforeImport = await snapshotRowsForUndo(supabase, companyId, 'suppliers', update_duplicates)
      const existingRaw = await fetchAllRows(({ from, to }) =>
        supabase
          .from('suppliers')
          .select('id, name, org_number, email, supplier_type, country, vat_number')
          .eq('company_id', companyId)
          .range(from, to),
      )
      const existing = existingRaw as unknown as ExistingSupplier[]

      // Org number, then e-mail, or a same-name supplier the user confirmed
      // (lib/import/shared/register-match.ts).
      const matcher = createRegisterMatcher(existing)

      const created: Supplier[] = []
      const updated: Supplier[] = []
      let skipped = 0
      const errors: { row_index: number; name: string; reason: string }[] = []

      for (const row of rows) {
        const match = matcher.resolve(row, row.confirmed_duplicate_of)

        if (match) {
          if (!update_duplicates) {
            skipped++
            continue
          }

          // Merge mode: only overwrite fields where the file has a value. The
          // parser fills the type, country and currency in for a new
          // supplier; an update writes them only when the file states them,
          // the type and country by the customer import's rule
          // (lib/import/shared/stated-fields.ts) judged on whether the pair
          // agrees. The supplier register refuses no pair, so one the row's
          // own reading cannot make agree is written as the row states it.
          const typeAndCountry = typeAndCountryForUpdate(
            { type: row.supplier_type, type_stated: row.supplier_type_stated, country: row.country, country_stated: row.country_stated },
            { type: match.supplier_type, country: match.country },
            (type, country, writesTypeOrCountry) => writesTypeOrCountry
              ? checkCountryConsistency({ partyType: type, country, vatNumber: row.vat_number || match.vat_number })
              : null,
          )
          const typeAndCountryWrite = 'write' in typeAndCountry ? typeAndCountry.write : typeAndCountry.stated
          const merged: Record<string, unknown> = {}
          if (row.name) merged.name = row.name
          if (typeAndCountryWrite.type !== undefined) merged.supplier_type = typeAndCountryWrite.type
          if (row.org_number) merged.org_number = orgNumberKey(row.org_number) ?? row.org_number
          if (row.email) merged.email = row.email
          if (row.phone) merged.phone = row.phone
          if (row.address_line1) merged.address_line1 = row.address_line1
          if (row.address_line2) merged.address_line2 = row.address_line2
          if (row.postal_code) merged.postal_code = row.postal_code
          if (row.city) merged.city = row.city
          if (typeAndCountryWrite.country !== undefined) merged.country = typeAndCountryWrite.country
          if (row.vat_number) merged.vat_number = row.vat_number
          if (row.bankgiro) merged.bankgiro = row.bankgiro
          if (row.plusgiro) merged.plusgiro = row.plusgiro
          if (row.bank_account) merged.bank_account = row.bank_account
          if (row.iban) merged.iban = row.iban
          if (row.bic) merged.bic = row.bic
          if (row.default_payment_terms !== null) merged.default_payment_terms = row.default_payment_terms
          if (row.default_currency_stated) merged.default_currency = row.default_currency
          if (row.notes) merged.notes = row.notes

          if (Object.keys(merged).length === 0) {
            skipped++
            continue
          }

          const { data, error } = await supabase
            .from('suppliers')
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
            updated.push(data as Supplier)
            matcher.add(data as ExistingSupplier)
          }
          continue
        }

        const { data, error } = await supabase
          .from('suppliers')
          .insert({
            user_id: user.id,
            company_id: companyId,
            name: row.name,
            supplier_type: row.supplier_type,
            email: row.email,
            phone: row.phone,
            address_line1: row.address_line1,
            address_line2: row.address_line2,
            postal_code: row.postal_code,
            city: row.city,
            country: row.country || 'SE',
            // Stored as the 10-digit key like every other write path (#2391).
            org_number: row.org_number ? (orgNumberKey(row.org_number) ?? row.org_number) : row.org_number,
            vat_number: row.vat_number,
            bankgiro: row.bankgiro,
            plusgiro: row.plusgiro,
            bank_account: row.bank_account,
            iban: row.iban,
            bic: row.bic,
            default_payment_terms: supplierPaymentTermsDays(row.default_payment_terms),
            default_currency: row.default_currency || 'SEK',
            notes: row.notes,
          })
          .select()
          .single()

        if (error) {
          if (error.code === '23505') {
            skipped++
            continue
          }
          errors.push({ row_index: row.row_index, name: row.name, reason: getUserErrorMessage(error) })
          continue
        }
        if (data) {
          created.push(data as Supplier)
          matcher.add(data as ExistingSupplier)
        }
      }

      for (const s of created) {
        await eventBus.emit({
          type: 'supplier.created',
          payload: { supplier: s, companyId, userId: user.id },
        })
      }

      await recordRegisterImportRun(supabase, { companyId, userId: user.id, kind: 'suppliers', created, updated, before: beforeImport }, opLog)

      const response: SupplierImportExecuteResult = {
        success: errors.length === 0,
        created: created.length,
        updated: updated.length,
        skipped,
        failed: errors.length,
        errors,
      }

      opLog.info('supplier import complete', response)

      return NextResponse.json({ data: response })
    } catch (err) {
      opLog.error('supplier import execute failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
