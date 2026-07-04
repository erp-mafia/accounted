import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId, requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'
import { AccountingFrameworkSchema } from '@/lib/api/schemas'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { createLogger } from '@/lib/logger'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const log = createLogger('api/company/current')

// BAS 2026 accounts required for K3's uppskjuten skatt (latent tax) entries.
// Both rows carry k2_excluded=true in lib/bookkeeping/bas-data so they are
// NOT seeded by seed_chart_of_accounts() for K2 companies. When a company
// opts into K3 we backfill them here so the engine can resolve them by
// account_number when the first latent-tax entry is posted.
const K3_LATENT_TAX_ACCOUNTS = ['2240', '8940'] as const

/**
 * GET /api/company/current
 *
 * Returns the active company id for the authenticated user. Used by the
 * client-side CompanyTabSync listener to detect cross-tab divergence (e.g.
 * when a tab was hidden/backgrounded during a switch in another tab) and
 * force a hard reload on mismatch.
 *
 * Never cached: the whole point is that the response reflects the current
 * authoritative value in user_preferences.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  }

  const companyId = await getActiveCompanyId(supabase, user.id)

  return NextResponse.json(
    { companyId },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

/**
 * Body shape for PATCH /api/company/current.
 *
 * Currently only carries `accounting_framework` (K2 / K3). Adding more
 * companies-level fields here is fine but anything that belongs on
 * company_settings should go to /api/settings instead.
 */
const PatchBodySchema = z.object({
  accounting_framework: AccountingFrameworkSchema.optional(),
})

/**
 * PATCH /api/company/current
 *
 * Updates company-level fields (in the `companies` table) for the active
 * company. Separate from /api/settings (which writes to `company_settings`)
 * because the columns live on different tables.
 *
 * Currently scoped to `accounting_framework` (K2 / K3), only meaningful for
 * entity_type='aktiebolag'. The handler rejects K3 for non-AB to prevent
 * impossible chart-of-accounts states downstream.
 */
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, PatchBodySchema)
  if (!validation.success) return validation.response

  const updates: Record<string, unknown> = {}

  if (validation.data.accounting_framework !== undefined) {
    // Only AB can opt in to K3; EF stays on the simpler EF rules and never
    // touches K2/K3. Fetch the entity_type before applying.
    const { data: company } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (!company) {
      return NextResponse.json(
        { error: 'Företaget kunde inte hittas' },
        { status: 404 },
      )
    }
    if (
      validation.data.accounting_framework === 'k3'
      && company.entity_type !== 'aktiebolag'
    ) {
      return NextResponse.json(
        { error: 'K3 (BFNAR 2012:1) gäller endast aktiebolag.' },
        { status: 400 },
      )
    }
    updates.accounting_framework = validation.data.accounting_framework
  }

  if (Object.keys(updates).length === 0) {
    // Nothing to write: surface the current row so the client can refresh
    // its local state without a no-op write.
    const { data } = await supabase
      .from('companies')
      .select('id, accounting_framework, entity_type')
      .eq('id', companyId)
      .single()
    return NextResponse.json({ data })
  }

  const { data, error } = await supabase
    .from('companies')
    .update(updates)
    .eq('id', companyId)
    .select('id, accounting_framework, entity_type')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // When opting in to K3, ensure the two latent-tax (uppskjuten skatt)
  // accounts exist in the company's chart of accounts. The base seed skips
  // them for K2 companies via k2_excluded=true, so without this backfill
  // the engine cannot resolve account_id for the first latent-tax post.
  // Wrapped in try/catch so a CoA insert failure does not block the
  // framework update: the user can still re-trigger the seed later.
  // The reverse switch (K3 → K2) intentionally keeps the rows for audit
  // history; the legal record of past K3 postings must remain intact.
  if (data.accounting_framework === 'k3') {
    try {
      const rows = K3_LATENT_TAX_ACCOUNTS.map(accountNumber => {
        const basRef = getBASReference(accountNumber)
        if (!basRef) return null
        return {
          user_id: user.id,
          company_id: companyId,
          account_number: basRef.account_number,
          account_name: basRef.account_name,
          account_class: basRef.account_class,
          account_group: basRef.account_group,
          account_type: basRef.account_type,
          normal_balance: basRef.normal_balance,
          sru_code: basRef.sru_code,
          k2_excluded: basRef.k2_excluded,
          plan_type: 'full_bas',
          is_active: true,
          is_system_account: true,
          description: basRef.description,
        }
      }).filter((row): row is NonNullable<typeof row> => row !== null)

      if (rows.length > 0) {
        const { error: seedError } = await supabase
          .from('chart_of_accounts')
          .upsert(rows, { onConflict: 'company_id,account_number', ignoreDuplicates: true })
        if (seedError) {
          log.error('Failed to seed K3 latent-tax accounts', {
            companyId,
            error: seedError.message,
          })
        }
      }
    } catch (err) {
      log.error('Unexpected error seeding K3 latent-tax accounts', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return NextResponse.json({ data })
}
