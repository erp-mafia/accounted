import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/**
 * POST /api/bookkeeping/accounts/activate
 *
 * Batch-activate BAS accounts for a user. Accepts { account_numbers: string[] }.
 * - Inserts rows from BAS reference for accounts not yet in the chart.
 * - Reactivates (is_active=true) accounts that already exist but are inactive.
 * - Skips anything already active.
 * - Returns { activated, reactivated, skipped, unknown } so callers can react.
 *
 * Strings that aren't known BAS numbers are reported in `unknown` (not
 * rejected) so activate-and-retry flows can surface them; the schema only
 * bounds type and size.
 */
const ActivateSchema = z.object({
  account_numbers: z.array(z.string().min(1).max(10)).min(1).max(2000),
})

export const POST = withRouteContext(
  'bookkeeping.accounts.activate',
  async (request, ctx) => {
    const { supabase, companyId, user } = ctx

    const raw = await request.json().catch(() => null)
    const parsed = ActivateSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'account_numbers array required' }, { status: 400 })
    }

    const uniqueNumbers = [...new Set(parsed.data.account_numbers)]

    // Fetch existing rows with current is_active state
    const { data: existing, error: fetchError } = await supabase
      .from('chart_of_accounts')
      .select('account_number, is_active')
      .eq('company_id', companyId)
      .in('account_number', uniqueNumbers)

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    const existingByNumber = new Map<string, boolean>(
      (existing || []).map((a) => [a.account_number, a.is_active])
    )

    const toReactivate: string[] = []
    const toInsert: Array<ReturnType<typeof buildInsertRow>> = []
    const unknown: string[] = []
    let skipped = 0

    for (const num of uniqueNumbers) {
      if (existingByNumber.has(num)) {
        if (existingByNumber.get(num) === true) {
          skipped += 1
        } else {
          toReactivate.push(num)
        }
        continue
      }
      const row = buildInsertRow(num, user.id, companyId)
      if (row) {
        toInsert.push(row)
      } else {
        unknown.push(num)
      }
    }

    let reactivatedRows: { account_number: string }[] = []
    if (toReactivate.length > 0) {
      const { data, error } = await supabase
        .from('chart_of_accounts')
        .update({ is_active: true })
        .eq('company_id', companyId)
        .in('account_number', toReactivate)
        .select('account_number')
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      reactivatedRows = data || []
    }

    let insertedRows: { account_number: string }[] = []
    if (toInsert.length > 0) {
      const { data, error } = await supabase
        .from('chart_of_accounts')
        .insert(toInsert)
        .select('account_number')
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      insertedRows = data || []
    }

    return NextResponse.json({
      data: [...insertedRows, ...reactivatedRows],
      activated: insertedRows.length,
      reactivated: reactivatedRows.length,
      skipped,
      unknown,
    })
  },
  { requireWrite: true },
)

function buildInsertRow(accountNumber: string, userId: string, companyId: string) {
  const ref = getBASReference(accountNumber)
  if (!ref) return null
  return {
    user_id: userId,
    company_id: companyId,
    account_number: ref.account_number,
    account_name: ref.account_name,
    account_class: ref.account_class,
    account_group: ref.account_group,
    account_type: ref.account_type,
    normal_balance: ref.normal_balance,
    plan_type: 'full_bas' as const,
    is_active: true,
    is_system_account: false,
    description: ref.description,
    sru_code: ref.sru_code,
    sort_order: parseInt(ref.account_number),
  }
}
