import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { syncSystemPacks } from '@/lib/packs/sync'

/**
 * GET /api/settings/booking-templates/sync/cron
 *
 * Reconciles the system booking templates in the database with `packs/*.yaml`
 * (schedule in vercel.json). The packs ship with the deploy; this is what makes
 * the deployed catalogue the one companies actually see, so editing a template
 * is a file change plus a deploy rather than a migration.
 *
 * Idempotent by construction: a database already matching the packs performs
 * zero writes, so running it more often than needed costs one SELECT.
 *
 * Deliberately a cron rather than boot-time work: a sync on every cold start
 * would have every serverless instance racing to write the same rows, and a
 * bad catalogue would be re-applied continuously instead of once a day where
 * it is visible in the logs.
 *
 * Service-role client, no company context: system templates belong to no
 * company and RLS forbids writing them from a user session (btl_insert /
 * btl_update both exclude is_system rows).
 */

// The catalogue is small (tens of rows); this never approaches the budget.
export const maxDuration = 60

export const GET = withCronContext('cron.booking_templates_sync', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const result = await syncSystemPacks(supabase)

  if (result.errors.length) {
    // A catalogue that fails to load is a deploy problem, not a data problem:
    // syncSystemPacks writes nothing in that case, so the previous state stands.
    ctx.log.error('pack sync aborted: catalogue invalid', { errors: result.errors })
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Pack catalogue invalid', errors: result.errors },
    })
  }

  return NextResponse.json({
    data: {
      inserted: result.inserted.length,
      updated: result.updated.length,
      unchanged: result.unchanged.length,
      retired: result.retired.length,
      retired_slugs: result.retired,
    },
  })
})
