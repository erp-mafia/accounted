import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events'
import { validateBody } from '@/lib/api/validate'
import { SupplierImportExecuteSchema } from '@/lib/api/schemas'
import { normalizeEmail } from '@/lib/import/shared/column-utils'
import { orgNumberKey } from '@/lib/invariants/org-number'

/**
 * Dedup key for an org number: the Swedish 10-digit key when the value is
 * one (so a 12-digit CSV value finds the stored 10-digit row, #2391), else
 * the value as typed, so BE0123456789 and FR0123456789 stay two suppliers.
 */
const orgDedupKey = (value: string | null): string | null =>
  orgNumberKey(value) ?? (value?.trim() || null)
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Supplier } from '@/types'
import type { SupplierImportExecuteResult } from '@/lib/import/suppliers/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

interface ExistingSupplier {
  id: string
  name: string
  org_number: string | null
  email: string | null
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
      const existingRaw = await fetchAllRows(({ from, to }) =>
        supabase
          .from('suppliers')
          .select('id, name, org_number, email')
          .eq('company_id', companyId)
          .range(from, to),
      )
      const existing = existingRaw as unknown as ExistingSupplier[]

      const byOrg = new Map<string, ExistingSupplier>()
      const byEmail = new Map<string, ExistingSupplier>()
      for (const s of existing) {
        const org = orgDedupKey(s.org_number)
        if (org) byOrg.set(org, s)
        const email = normalizeEmail(s.email)
        if (email) byEmail.set(email, s)
      }

      const created: Supplier[] = []
      const updated: Supplier[] = []
      let skipped = 0
      const errors: { row_index: number; name: string; reason: string }[] = []

      for (const row of rows) {
        const orgKey = orgDedupKey(row.org_number)
        const emailKey = normalizeEmail(row.email)
        const match =
          (orgKey && byOrg.get(orgKey)) ||
          (emailKey && byEmail.get(emailKey)) ||
          null

        if (match) {
          if (!update_duplicates) {
            skipped++
            continue
          }

          const merged: Record<string, unknown> = {}
          if (row.name) merged.name = row.name
          if (row.supplier_type) merged.supplier_type = row.supplier_type
          if (row.org_number) merged.org_number = orgNumberKey(row.org_number) ?? row.org_number
          if (row.email) merged.email = row.email
          if (row.phone) merged.phone = row.phone
          if (row.address_line1) merged.address_line1 = row.address_line1
          if (row.address_line2) merged.address_line2 = row.address_line2
          if (row.postal_code) merged.postal_code = row.postal_code
          if (row.city) merged.city = row.city
          if (row.country) merged.country = row.country
          if (row.vat_number) merged.vat_number = row.vat_number
          if (row.bankgiro) merged.bankgiro = row.bankgiro
          if (row.plusgiro) merged.plusgiro = row.plusgiro
          if (row.bank_account) merged.bank_account = row.bank_account
          if (row.iban) merged.iban = row.iban
          if (row.bic) merged.bic = row.bic
          if (row.default_payment_terms) merged.default_payment_terms = row.default_payment_terms
          if (row.default_currency) merged.default_currency = row.default_currency
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
          if (data) updated.push(data as Supplier)
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
            default_payment_terms: row.default_payment_terms || 30,
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
          const newOrg = orgDedupKey(data.org_number)
          if (newOrg) byOrg.set(newOrg, data as ExistingSupplier)
          const newEmail = normalizeEmail(data.email)
          if (newEmail) byEmail.set(newEmail, data as ExistingSupplier)
        }
      }

      for (const s of created) {
        await eventBus.emit({
          type: 'supplier.created',
          payload: { supplier: s, companyId, userId: user.id },
        })
      }

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
