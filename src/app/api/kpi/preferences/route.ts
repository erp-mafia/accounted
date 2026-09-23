import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sparsePatchBody } from '@/lib/api/sparse-patch'
import { mergeWithDefaults } from '@/lib/reports/kpi-definitions'
import type { KPIPreferences } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const EXTENSION_ID = 'core/kpi'
const KEY = 'preferences'

/**
 * Deliberately carries no `.default()`: the defaults belong to
 * mergeWithDefaults() on the read path, not to the parse of a write. A schema
 * default here would resurrect on every save exactly the way a `.partial()`
 * schema's defaults do. Keys are all optional so the route can tell "the
 * caller set this" from "the caller said nothing about this".
 */
const UpdateKPIPreferencesSchema = z.object({
  visibleKpis: z.array(z.string()).optional(),
  kpiOrder: z.array(z.string()).optional(),
  accountOverrides: z.record(z.string(), z.array(z.string())).optional(),
  showMonthlyTable: z.boolean().optional(),
})

export const GET = withRouteContext('kpi.preferences.get', async (_request, { supabase, companyId }) => {
  const { data } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', EXTENSION_ID)
    .eq('key', KEY)
    .single()

  const preferences = mergeWithDefaults((data?.value as Partial<KPIPreferences>) ?? {})
  return NextResponse.json({ data: preferences })
})

export const PUT = withRouteContext(
  'kpi.preferences.update',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, sparsePatchBody(UpdateKPIPreferencesSchema))
    if (!validation.success) return validation.response
    const prefs = validation.data

    // Validate account overrides: must be 4-digit numeric strings
    if (prefs.accountOverrides) {
      for (const [kpiId, accounts] of Object.entries(prefs.accountOverrides)) {
        for (const acc of accounts) {
          if (!/^\d{4}$/.test(acc)) {
            return NextResponse.json(
              { error: `Invalid account number "${acc}" in ${kpiId}: must be 4 digits` },
              { status: 400 }
            )
          }
        }
      }
    }

    // Merge over what is STORED, not over the defaults. mergeWithDefaults()
    // fills every absent key with its default value, so saving one setting
    // used to reset the other two: a PUT of `{ accountOverrides: … }` wiped
    // visibleKpis and kpiOrder back to factory settings. Defaults still apply
    // to a row that has never been written (and on the read path), but they no
    // longer overwrite a stored choice the caller never mentioned. The
    // settings dialog always sends the complete object (its reset button fills
    // the draft with getDefaultPreferences() before saving), so its behaviour
    // is unchanged; only sparse callers stop losing data.
    const { data: existing } = await supabase
      .from('extension_data')
      .select('value')
      .eq('company_id', companyId)
      .eq('extension_id', EXTENSION_ID)
      .eq('key', KEY)
      .maybeSingle()

    const stored = mergeWithDefaults((existing?.value as Partial<KPIPreferences>) ?? {})
    const merged: KPIPreferences = { ...stored, ...prefs }

    // KPI preferences are COMPANY-scoped, not per-user: the read paths (GET
    // above and the KPI report route) filter on (company_id, extension_id,
    // key) with no user filter, and the key carries no user id. user_id is
    // stored purely as "who wrote this last" attribution. The upsert must
    // therefore arbitrate on the company-scoped unique constraint: migration
    // 20260330130000 dropped UNIQUE (user_id, extension_id, key) in favor of
    // UNIQUE (company_id, extension_id, key), so naming the old column trio
    // here makes Postgres fail every save with 42P10 (no matching constraint).
    const { data, error } = await supabase
      .from('extension_data')
      .upsert(
        {
          user_id: user.id,
          company_id: companyId,
          extension_id: EXTENSION_ID,
          key: KEY,
          value: merged,
        },
        { onConflict: 'company_id,extension_id,key' }
      )
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data: data.value })
  },
  { requireWrite: true }
)
