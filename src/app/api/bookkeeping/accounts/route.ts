import { NextResponse } from 'next/server'
import { z } from 'zod'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { CreateAccountSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { createAccount } from '@/lib/bookkeeping/chart-of-accounts-service'
import { sessionFailureResponse } from '@/lib/operations/session'

// Success shapes are legacy `{ data }`: several pages (import,
// supplier-invoices, article form) consume the list directly. Create failures
// answer the canonical `{ error: { code, message } }` envelope.

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

/**
 * POST: create one account. The rules (class/type fit, VAT treatment and
 * momsruta fit, BAS prefill, duplicate vs deactivated duplicate) live in
 * lib/bookkeeping/chart-of-accounts-service.ts, shared with the v1 operation
 * accounts.create and gnubok_create_account.
 */
export const POST = withRouteContext(
  'bookkeeping.accounts.create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, CreateAccountSchema, {
      log,
      operation: 'bookkeeping.accounts.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    // The Kontoplan dialog's accounts have always been labelled k1, which
    // keeps a hand-added account out of the prune dialog's preselection.
    const outcome = await createAccount(
      { supabase, companyId, userId: user.id, log },
      { ...body, plan_type: body.plan_type ?? 'k1' },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
