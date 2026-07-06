import { NextResponse } from 'next/server'
import { z } from 'zod'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { CreateAccountSchema } from '@/lib/api/schemas'

// Response shapes are legacy `{ data }` / `{ error: string }` — several pages
// (import, supplier-invoices, article form) consume the list directly.

const ListQuerySchema = z.object({
  class: z.coerce.number().int().min(1).max(8).optional(),
  active: z.enum(['true', 'false']).optional(),
})

export const GET = withRouteContext('bookkeeping.accounts.list', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

  const validated = validateQuery(request, ListQuerySchema, {
    log,
    operation: 'bookkeeping.accounts.list',
  })
  if (!validated.success) return validated.response
  const accountClass = validated.data.class
  const activeOnly = validated.data.active !== 'false'

  try {
    const data = await fetchAllRows(({ from, to }) => {
      let query = supabase
        .from('chart_of_accounts')
        .select('*')
        .eq('company_id', companyId)
        .order('sort_order')

      if (activeOnly) {
        query = query.eq('is_active', true)
      }

      if (accountClass !== undefined) {
        query = query.eq('account_class', accountClass)
      }

      return query.range(from, to)
    })

    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch accounts' },
      { status: 500 },
    )
  }
})

export const POST = withRouteContext(
  'bookkeeping.accounts.create',
  async (request, ctx) => {
    const { supabase, companyId, user, log } = ctx

    const validation = await validateBody(request, CreateAccountSchema, {
      log,
      operation: 'bookkeeping.accounts.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data, error } = await supabase
      .from('chart_of_accounts')
      .insert({
        user_id: user.id,
        company_id: companyId,
        account_number: body.account_number,
        account_name: body.account_name,
        account_class: parseInt(body.account_number[0]),
        account_group: body.account_number.substring(0, 2),
        account_type: body.account_type,
        normal_balance: body.normal_balance,
        plan_type: body.plan_type || 'k1',
        is_system_account: false,
        description: body.description || null,
        default_vat_code: body.default_vat_code || null,
        sru_code: body.sru_code || null,
        sort_order: parseInt(body.account_number),
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: `Kontonummer ${body.account_number} finns redan i din kontoplan.` },
          { status: 409 },
        )
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
