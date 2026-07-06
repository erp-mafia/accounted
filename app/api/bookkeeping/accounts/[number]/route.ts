import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateAccountSchema } from '@/lib/api/schemas'

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
    // journal_entry_lines has no company_id column, so scope via the parent
    // entry — a user can be a member of several companies, and another
    // company's usage of the same BAS number must not block deletion here.
    const { count } = await supabase
      .from('journal_entry_lines')
      .select('id, journal_entries!inner(company_id)', { count: 'exact', head: true })
      .eq('journal_entries.company_id', companyId)
      .eq('account_number', number)

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
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
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

    const validation = await validateBody(request, UpdateAccountSchema, {
      log,
      operation: 'bookkeeping.accounts.update',
    })
    if (!validation.success) return validation.response
    const body = validation.data

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
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
