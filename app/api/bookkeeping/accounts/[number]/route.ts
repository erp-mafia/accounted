import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sparsePatchBody } from '@/lib/api/sparse-patch'
import { UpdateAccountSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  defaultRateForVatTreatment,
  isVatTreatmentAllowedForAccountClass,
} from '@/lib/vat/account-vat-treatment'

// DELETE hard-deletes an unused, non-system account; accounts referenced by
// this company's journal entries must be deactivated instead (PUT is_active).
// Response shapes are legacy `{ error: string }` — the kontoplan UI renders
// them directly.

export const DELETE = withRouteContext(
  'bookkeeping.accounts.delete',
  async (_request, ctx, { params }: { params: Promise<{ number: string }> }) => {
    const { number } = await params
    const { supabase, companyId } = ctx

    // Fetch the account to check if it's a system account
    const { data: account, error: fetchError } = await supabase
      .from('chart_of_accounts')
      .select('id, is_system_account')
      .eq('company_id', companyId)
      .eq('account_number', number)
      .single()

    if (fetchError || !account) {
      return NextResponse.json({ error: 'Kontot hittades inte' }, { status: 404 })
    }

    if (account.is_system_account) {
      return NextResponse.json(
        { error: 'Systemkonton kan inte tas bort' },
        { status: 400 }
      )
    }

    // Check if the account is referenced in THIS company's journal entries.
    // journal_entry_lines has no company_id column, so the scope has to come
    // from the parent entry: a user can be a member of several companies, and
    // another company's usage of the same BAS number must not block deletion
    // here.
    //
    // This used to be a `journal_entries!inner(company_id)` head+count query.
    // PostgREST compiles that embed into a correlated LATERAL join, so the
    // count walked the ENTIRE journal_entry_lines table across all tenants to
    // answer a single-account question (see lib/bookkeeping/entry-lines.ts).
    // fetchEntryLines cannot replace it (it returns rows, not a count), so the
    // count moves into SQL: get_account_usage_counts is the same
    // company-scoped aggregate the kontoplan usage column and the prune dialog
    // already run (migration 20260704110000, covering index 20260706120000),
    // and it counts lines on ALL entry statuses, exactly like the old query.
    const { data: usage, error: usageError } = await supabase.rpc('get_account_usage_counts', {
      p_company_id: companyId,
    })

    if (usageError) {
      return NextResponse.json({ error: getUserErrorMessage(usageError) }, { status: 500 })
    }

    const count = ((usage ?? []) as { account_number: string; usage_count: number }[]).find(
      (row) => row.account_number === number,
    )?.usage_count

    if (count && count > 0) {
      return NextResponse.json(
        { error: 'Kontot kan inte tas bort eftersom det används i bokförda verifikationer. Inaktivera det istället.' },
        { status: 400 }
      )
    }

    const { error: deleteError } = await supabase
      .from('chart_of_accounts')
      .delete()
      .eq('id', account.id)
      .eq('company_id', companyId)

    if (deleteError) {
      return NextResponse.json({ error: getUserErrorMessage(deleteError) }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

export const PUT = withRouteContext(
  'bookkeeping.accounts.update',
  async (request, ctx, { params }: { params: Promise<{ number: string }> }) => {
    const { number } = await params
    const { supabase, companyId, log } = ctx

    // The body is spread straight into .update(), so only the fields the
    // caller actually named may reach it. UpdateAccountSchema carries no
    // .default() today, so sparsePatchBody is a no-op here: it is the
    // structural guarantee that adding one later cannot make a PUT that
    // renames an account also rewrite its VAT code or SRU mapping. An
    // explicit null (clearing sru_code, VAT defaults, or descriptions)
    // still survives.
    const validation = await validateBody(request, sparsePatchBody(UpdateAccountSchema), {
      log,
      operation: 'bookkeeping.accounts.update',
    })
    if (!validation.success) return validation.response
    const body = validation.data
    const accountClass = parseInt(number[0])

    if (
      body.default_vat_treatment &&
      !isVatTreatmentAllowedForAccountClass(body.default_vat_treatment, accountClass)
    ) {
      return NextResponse.json(
        { error: 'Momskoden kan inte användas för den här kontoklassen.' },
        { status: 400 },
      )
    }
    if (body.default_vat_treatment && body.default_vat_rate === undefined) {
      const { data: current, error: currentError } = await supabase
        .from('chart_of_accounts')
        .select('default_vat_rate')
        .eq('company_id', companyId)
        .eq('account_number', number)
        .single()

      if (currentError) {
        if (currentError.code === 'PGRST116') {
          return NextResponse.json({ error: 'Kontot hittades inte' }, { status: 404 })
        }
        return NextResponse.json({ error: getUserErrorMessage(currentError) }, { status: 500 })
      }

      if (current.default_vat_rate == null) {
        body.default_vat_rate = defaultRateForVatTreatment(
          body.default_vat_treatment,
          accountClass,
        )
      }
    } else if (body.default_vat_treatment && body.default_vat_rate === null) {
      body.default_vat_rate = defaultRateForVatTreatment(
        body.default_vat_treatment,
        accountClass,
      )
    }

    if (Object.keys(body).length === 0) {
      return NextResponse.json({ error: 'Inget att uppdatera' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('chart_of_accounts')
      .update(body)
      .eq('company_id', companyId)
      .eq('account_number', number)
      .select()
      .single()

    if (error) {
      // PGRST116 = zero rows — the account doesn't exist in this company.
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Kontot hittades inte' }, { status: 404 })
      }
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
