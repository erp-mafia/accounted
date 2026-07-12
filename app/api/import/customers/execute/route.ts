import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events'
import { validateBody } from '@/lib/api/validate'
import { CustomerImportExecuteSchema } from '@/lib/api/schemas'
import { normalizeOrgNumber, normalizeEmail } from '@/lib/import/shared/column-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Customer } from '@/types'
import type { CustomerImportExecuteResult } from '@/lib/import/customers/types'

ensureInitialized()

interface ExistingCustomer {
  id: string
  name: string
  org_number: string | null
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
 * POST /api/import/customers/execute
 *
 * Imports validated customer rows. Duplicates (matched by org_number or email)
 * are either updated (merge: only non-empty file fields overwrite) or skipped
 * based on `update_duplicates`.
 */
export const POST = withRouteContext(
  'register_import.customers.execute',
  async (request, ctx) => {
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
      const existingRaw = await fetchAllRows(({ from, to }) =>
        supabase
          .from('customers')
          .select(
            'id, name, org_number, email, phone, address_line1, address_line2, ' +
              'postal_code, city, country, vat_number, default_payment_terms, notes, ' +
              'customer_type',
          )
          .eq('company_id', companyId)
          .range(from, to),
      )
      const existing = existingRaw as unknown as ExistingCustomer[]

      const byOrg = new Map<string, ExistingCustomer>()
      const byEmail = new Map<string, ExistingCustomer>()
      for (const c of existing) {
        const org = normalizeOrgNumber(c.org_number)
        if (org) byOrg.set(org, c)
        const email = normalizeEmail(c.email)
        if (email) byEmail.set(email, c)
      }

      const created: Customer[] = []
      const updated: Customer[] = []
      let skipped = 0
      const errors: { row_index: number; name: string; reason: string }[] = []

      for (const row of rows) {
        const orgKey = normalizeOrgNumber(row.org_number)
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

          // Merge mode: only overwrite fields where the file has a non-empty value.
          const merged: Record<string, unknown> = {}
          if (row.name) merged.name = row.name
          if (row.customer_type) merged.customer_type = row.customer_type
          if (row.org_number) merged.org_number = row.org_number
          if (row.email) merged.email = row.email
          if (row.phone) merged.phone = row.phone
          if (row.address_line1) merged.address_line1 = row.address_line1
          if (row.address_line2) merged.address_line2 = row.address_line2
          if (row.postal_code) merged.postal_code = row.postal_code
          if (row.city) merged.city = row.city
          if (row.country) merged.country = row.country
          if (row.vat_number) merged.vat_number = row.vat_number
          if (row.default_payment_terms) merged.default_payment_terms = row.default_payment_terms
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
            errors.push({ row_index: row.row_index, name: row.name, reason: error.message })
            continue
          }
          if (data) updated.push(data as Customer)
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
            email: row.email,
            phone: row.phone,
            address_line1: row.address_line1,
            address_line2: row.address_line2,
            postal_code: row.postal_code,
            city: row.city,
            country: row.country || 'Sweden',
            org_number: row.org_number,
            vat_number: row.vat_number,
            default_payment_terms: row.default_payment_terms || 30,
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
          errors.push({ row_index: row.row_index, name: row.name, reason: error.message })
          continue
        }
        if (data) {
          created.push(data as Customer)
          // Track newly inserted org/email so subsequent rows in the same batch
          // dedup against them too.
          const newOrg = normalizeOrgNumber(data.org_number)
          if (newOrg) byOrg.set(newOrg, data as ExistingCustomer)
          const newEmail = normalizeEmail(data.email)
          if (newEmail) byEmail.set(newEmail, data as ExistingCustomer)
        }
      }

      // Emit events for downstream listeners (non-blocking).
      for (const c of created) {
        await eventBus.emit({
          type: 'customer.created',
          payload: { customer: c, companyId: companyId!, userId: user.id },
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
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
