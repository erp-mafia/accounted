import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeSchema } from '@/lib/api/schemas'
import { getCompanyEntityType } from '@/lib/company/context'
import { encryptPersonnummer, extractLast4, maskEmployeeForResponse, validatePersonnummer } from '@/lib/salary/personnummer'
import { isEmploymentTypeAllowedForEntity, EF_OWNER_EMPLOYMENT_ERROR } from '@/lib/salary/employment-rules'
import { validateEmployeeBankAccount } from '@/lib/salary/payment/bank-account'
import { jamkningIssueFromDbError, touchesJamkning, validateJamkning } from '@/lib/salary/jamkning-rules'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

// Response shaping lives in the shared maskEmployeeForResponse: it drops the
// ciphertext AND personnummer_last4 (mask + last4 reassembles the full
// personnummer) and returns the mask under the read-only `personnummer_masked`
// key, never the writable `personnummer` key. This route both reads and writes
// the same object shape, so a mask under the write key would round-trip
// 'ÅÅÅÅMMDD-XXXX' straight into the encrypt path.

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.get',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: employee, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data: maskEmployeeForResponse(employee) })
  },
)

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, UpdateEmployeeSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Load existing employee for merged validation
    const { data: existing, error: fetchError } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !existing) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    // Merged validation: combine existing + updates to check full integrity
    const merged = { ...existing, ...body }
    const mergedErrors: string[] = []

    if (merged.salary_type === 'monthly' && (!merged.monthly_salary || merged.monthly_salary <= 0)) {
      mergedErrors.push('Månadslön krävs och måste vara större än 0 för månadslöneform')
    }
    if (merged.salary_type === 'hourly' && (!merged.hourly_rate || merged.hourly_rate <= 0)) {
      mergedErrors.push('Timlön krävs och måste vara större än 0 för timlöneform')
    }
    if (merged.f_skatt_status === 'a_skatt' && !merged.is_sidoinkomst && !merged.tax_table_number) {
      mergedErrors.push('Skattetabell krävs för A-skatt anställda')
    }
    // Merged-state jämkning check through the shared validator (same rule as
    // the v1 route and employee-commands): a non-null percentage needs both
    // dates, and the dates must be ordered, but the schema can only see the
    // body. Only run when the PATCH touches a jamkning field: a legacy row
    // with inconsistent jamkning_* state must not block unrelated updates
    // (fixing it requires touching those very fields). `body` is the parsed
    // patch: absent keys are absent, explicit nulls survive. #2058
    if (touchesJamkning(body)) {
      for (const issue of validateJamkning(merged)) mergedErrors.push(issue.message)
    }
    if (mergedErrors.length > 0) {
      return NextResponse.json({ error: mergedErrors.join('. ') }, { status: 400 })
    }

    // Validate bank details only when the caller actually changes them, so a
    // legacy employee with incomplete/free-text bank data (from before this
    // validation existed) can still be edited in unrelated ways. Validate the
    // merged pair so both-or-neither reflects the row's real end state.
    const clearingChanged =
      body.clearing_number !== undefined && body.clearing_number !== existing.clearing_number
    const accountChanged =
      body.bank_account_number !== undefined && body.bank_account_number !== existing.bank_account_number
    if (clearingChanged || accountChanged) {
      const bankIssues = validateEmployeeBankAccount(merged.clearing_number, merged.bank_account_number)
      if (bankIssues.length > 0) {
        return NextResponse.json({ error: bankIssues.map((i) => i.message).join('. ') }, { status: 400 })
      }
    }

    // Only when the caller is changing employment_type: block setting an EF's
    // owner/board on payroll (mirrors the enforce_ef_no_owner_employee trigger,
    // which fires on UPDATE OF employment_type: so unrelated edits to any
    // grandfathered row aren't blocked). #782
    if (body.employment_type !== undefined) {
      const entityType = await getCompanyEntityType(supabase, companyId)
      if (!isEmploymentTypeAllowedForEntity(entityType, body.employment_type)) {
        return NextResponse.json({ error: EF_OWNER_EMPLOYMENT_ERROR }, { status: 400 })
      }
    }

    // Build update object. `personnummer` is destructured OUT of the spread and
    // handled explicitly below: spreading it verbatim would let any
    // falsy-but-present value reach the row and overwrite the AES-256-GCM
    // ciphertext with it (`if (body.personnummer)` skips the encrypt branch for
    // an empty string, but `{ ...body }` has already put the empty string in
    // `updates`). The only thing that stopped that today was the 12-digit regex
    // in UpdateEmployeeSchema, i.e. a guard in another file: house style there
    // adds `.or(z.literal(''))` to optional string fields, and one such edit
    // would have turned this spread into a silent wipe of encrypted PII plus a
    // stale `personnummer_last4`. The guard belongs in the write path.
    const { personnummer: pnrInput, ...bodyWithoutPnr } = body
    const updates: Record<string, unknown> = { ...bodyWithoutPnr }

    // personnummer semantics on PATCH:
    //   • key absent / undefined → identity unchanged; ciphertext and
    //     personnummer_last4 are preserved untouched.
    //   • '' or null             → 400. There is no "clear the personnummer"
    //     operation: the column is NOT NULL, and AGI/KU filing (Skatteverket
    //     FK215) cannot be produced without it. Omit the key to leave it alone.
    //   • masked display value   → 400. Read surfaces return the mask under
    //     `personnummer_masked` so it cannot be written back by accident, but
    //     reject it here too so a hand-built round-trip fails loudly instead of
    //     encrypting 'ÅÅÅÅMMDD-XXXX' as somebody's identity. Note that
    //     validatePersonnummer() strips non-digits, so a decorated value
    //     carrying 12 real digits would otherwise pass.
    //   • 12 digits              → validate (format, date range, Luhn) and
    //     re-encrypt, refreshing personnummer_last4 in the same update.
    const rawPnr: unknown = pnrInput
    if (rawPnr !== undefined) {
      if (typeof rawPnr !== 'string' || rawPnr.trim() === '') {
        return NextResponse.json(
          {
            error:
              'Personnummer kan inte tömmas. Utelämna fältet för att lämna det oförändrat.',
          },
          { status: 400 },
        )
      }
      if (/x/i.test(rawPnr)) {
        return NextResponse.json(
          {
            error:
              'Maskerat personnummer kan inte sparas. Skicka hela personnummret (12 siffror) eller utelämna fältet.',
          },
          { status: 400 },
        )
      }
      const pnrValidation = validatePersonnummer(rawPnr)
      if (!pnrValidation.valid) {
        return NextResponse.json({ error: pnrValidation.error }, { status: 400 })
      }
      updates.personnummer = encryptPersonnummer(rawPnr)
      updates.personnummer_last4 = extractLast4(rawPnr)
    }

    const { data: updated, error } = await supabase
      .from('employees')
      .update(updates)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'En anställd med detta personnummer finns redan' }, { status: 409 })
      }
      // The database backstop caught the concurrent-PATCH race (#2256): the
      // merged-state check above passed against a snapshot another request
      // has since changed. Same 400 and sentence as that check.
      const jamkningIssue = jamkningIssueFromDbError(error)
      if (jamkningIssue) {
        return NextResponse.json({ error: jamkningIssue.message }, { status: 400 })
      }
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data: maskEmployeeForResponse(updated) })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.delete',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Soft delete only, BFL 7 kap retention
    const { data, error } = await supabase
      .from('employees')
      .update({ is_active: false })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id')
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data: { id: data.id, is_active: false } })
  },
  { requireWrite: true },
)
