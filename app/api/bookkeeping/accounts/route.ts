import { NextResponse } from 'next/server'
import { z } from 'zod'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { CreateAccountSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { accountClassTypeConflict } from '@/lib/pending-operations/schemas/account'
import {
  defaultRateForVatTreatment,
  isVatTreatmentAllowedForAccountClass,
} from '@/lib/vat/account-vat-treatment'

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
    // Single-round-trip path: the RPC aggregates the whole list into one json
    // scalar server-side, bypassing PostgREST's 1000-row page cap. Large
    // charts (95/1250 prod companies exceed 1000 active accounts) previously
    // paid 2-5 sequential cross-region round trips through fetchAllRows.
    const rpc = await supabase.rpc('list_company_accounts', {
      p_company_id: companyId,
      p_active_only: activeOnly,
      p_account_class: accountClass ?? null,
    })
    if (!rpc.error) return NextResponse.json({ data: rpc.data ?? [] })
    if (rpc.error.code === 'PGRST202' || rpc.error.code === '42883' || rpc.error.code === '42501') {
      // Function not deployed yet (self-hosted instance not migrated, or the
      // deploy-ordering window before the branching merge applies the
      // migration) or EXECUTE not granted: fall back to the paged fetch.
      // Mirrors the load-bearing fallback in lib/company/context.ts.
      log.warn('list_company_accounts RPC unavailable, falling back to paged fetch', {
        code: rpc.error.code,
      })
    } else {
      throw new Error(rpc.error.message)
    }

    // Same order as the RPC: account_number is the BAS sequence and unique per
    // company, which fetchAllRows needs for stable pages. sort_order is 0 on
    // every seeded account, so ordering by it put the seeded block first and
    // let rows shift between pages.
    const data = await fetchAllRows(({ from, to }) => {
      let query = supabase
        .from('chart_of_accounts')
        .select('*')
        .eq('company_id', companyId)
        .order('account_number')

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
      { error: error instanceof Error ? getUserErrorMessage(error) : 'Failed to fetch accounts' },
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
    const accountClass = parseInt(body.account_number[0])
    // Same class/type rule the MCP create path enforces: account_class is
    // derived from the first digit below, so a contradicting type (2999 +
    // expense) would put the account on the wrong side of every report.
    if (accountClassTypeConflict(body.account_number, body.account_type)) {
      return NextResponse.json(
        { error: 'Kontotypen passar inte kontoklassen för det här kontonumret.' },
        { status: 400 },
      )
    }
    if (
      body.default_vat_treatment &&
      !isVatTreatmentAllowedForAccountClass(body.default_vat_treatment, accountClass)
    ) {
      return NextResponse.json(
        { error: 'Momskoden kan inte användas för den här kontoklassen.' },
        { status: 400 },
      )
    }
    const defaultVatRate = body.default_vat_treatment && body.default_vat_rate == null
      ? defaultRateForVatTreatment(body.default_vat_treatment, accountClass)
      : body.default_vat_rate ?? null

    const { data, error } = await supabase
      .from('chart_of_accounts')
      .insert({
        user_id: user.id,
        company_id: companyId,
        account_number: body.account_number,
        account_name: body.account_name,
        account_class: accountClass,
        account_group: body.account_number.substring(0, 2),
        account_type: body.account_type,
        normal_balance: body.normal_balance,
        plan_type: body.plan_type || 'k1',
        is_system_account: false,
        description: body.description || null,
        default_vat_code: body.default_vat_code || null,
        default_vat_rate: defaultVatRate,
        default_vat_treatment: body.default_vat_treatment ?? null,
        sru_code: body.sru_code || null,
        sort_order: parseInt(body.account_number),
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        // The unique constraint counts deactivated rows, so "already exists"
        // covers two very different situations. Only look up which one it is
        // on the failing path: the happy path stays a single insert.
        const { data: existing } = await supabase
          .from('chart_of_accounts')
          .select('is_active')
          .eq('company_id', companyId)
          .eq('account_number', body.account_number)
          .maybeSingle()

        if (existing && existing.is_active === false) {
          // Re-creating can never succeed here; the caller must reactivate
          // instead. The distinct code is what AddAccountDialog keys on to
          // offer that as a one-click action rather than a dead end.
          return errorResponseFromCode('ACCOUNT_EXISTS_INACTIVE', log, {
            status: 409,
            messageSv: `Kontonummer ${body.account_number} finns redan i din kontoplan men är inaktiverat.`,
            details: { account_number: body.account_number },
          })
        }

        return NextResponse.json(
          { error: `Kontonummer ${body.account_number} finns redan i din kontoplan.` },
          { status: 409 },
        )
      }
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
