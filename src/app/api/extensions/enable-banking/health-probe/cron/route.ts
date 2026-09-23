import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { extensionRegistry } from '@/lib/extensions/registry'
import { ensureInitialized } from '@/lib/init'
import {
  probeSessionHealth,
  REAUTH_REQUIRED_MESSAGE,
} from '@/extensions/general/enable-banking/lib/api-client'
import { sendConsentExpiryNotification } from '@/extensions/general/enable-banking/lib/consent-expiry-notification'

ensureInitialized()

export const maxDuration = 300

// 20s of maxDuration spare for teardown.
const PROBE_BUDGET_MS = 280_000
// A session that synced successfully this recently is alive: no probe needed.
const PROVEN_ALIVE_MS = 24 * 60 * 60 * 1000

/**
 * GET /api/extensions/enable-banking/health-probe/cron
 * Daily PSD2 session health probe, 04:30 UTC.
 *
 * A sync failure is the only other thing that moves a connection off
 * 'active', which leaves two silent holes: connections the sync cron never
 * touches (capability not entitled, every account deselected) and connections
 * parked in 'pending_selection'. Both kept rendering as healthy with a stale
 * last_synced_at while their PSD2 session was already dead bank-side, so the
 * user read old balances as current. Probing costs one cheap session call per
 * session and only ever acts on a definite 'dead'.
 *
 * Its own schedule, not a tail of the sync cron: that one runs hourly, and
 * the probes (and the expiry mail a dead session sends) are a daily job.
 */
export const GET = withCronContext('cron.bank_session_probe', async (_request, ctx) => {
  if (!extensionRegistry.get('enable-banking')) {
    ctx.log.warn('enable-banking extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Enable Banking extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)
  const startTime = Date.now()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const probeResults: { connectionId: string; bankName: string }[] = []

  const { data: candidates, error: candidatesError } = await supabase
    .from('bank_connections')
    .select('id, company_id, user_id, bank_name, session_id, status, last_synced_at, last_expiry_notification_at')
    .in('status', ['active', 'pending_selection'])
    .not('session_id', 'is', null)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(100)

  if (candidatesError) {
    ctx.log.error('failed to fetch connections for health probe', candidatesError, {
      message: candidatesError.message,
    })
  }

  // Probe per DISTINCT session, not per connection. One session can back
  // several companies (lib/session-sharing.ts), so probing per row would spend
  // four identical API calls on one consent and mark only one company dead at
  // a time. A session is one live-or-dead fact: the verdict applies to every
  // row holding it.
  type Candidate = NonNullable<typeof candidates>[number]
  const probeGroups = new Map<string, Candidate[]>()
  // A session that synced successfully for ANY of its companies is alive, so
  // skip the whole group rather than re-probing it through a sibling row.
  const provenAliveSessions = new Set(
    (candidates ?? [])
      .filter(c => c.last_synced_at && startTime - new Date(c.last_synced_at).getTime() < PROVEN_ALIVE_MS)
      .map(c => c.session_id as string)
  )

  for (const connection of candidates ?? []) {
    const sessionId = connection.session_id as string
    if (provenAliveSessions.has(sessionId)) continue
    const group = probeGroups.get(sessionId)
    if (group) group.push(connection)
    else probeGroups.set(sessionId, [connection])
  }

  let probed = 0
  for (const [sessionId, group] of probeGroups) {
    if (Date.now() - startTime > PROBE_BUDGET_MS) {
      ctx.log.info('probe budget reached', { probedSoFar: probed })
      break
    }

    // Per-session isolation: without it a single network blip aborts probing
    // for every remaining candidate and the gap stays silent until tomorrow.
    try {
      probed++
      const health = await probeSessionHealth(sessionId)
      if (health !== 'dead') continue

      const groupIds = group.map(c => c.id)
      const { error: updateError } = await supabase
        .from('bank_connections')
        .update({ status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE })
        .in('id', groupIds)

      // Only claim the connections were marked dead once the write landed.
      // Notifying (and counting) on an unpersisted update would tell the user
      // to re-authorize while the rows still read 'active'.
      if (updateError) {
        ctx.log.error('failed to mark probed-dead connections as expired', updateError, {
          connectionIds: groupIds,
        })
        continue
      }

      // One dead consent, one mail, however many companies share it.
      const first = group[0]
      await sendConsentExpiryNotification(supabase, first, 0, true, baseUrl)

      ctx.log.info('health probe found a dead session', {
        connectionIds: groupIds,
        sharedAcrossCompanies: group.length > 1,
        bankName: first.bank_name,
      })
      for (const connection of group) {
        probeResults.push({ connectionId: connection.id, bankName: connection.bank_name })
      }
    } catch (err) {
      ctx.log.error('health probe failed for session', err as Error, {
        connectionIds: group.map(c => c.id),
        bankName: group[0]?.bank_name,
      })
    }
  }

  ctx.log.info('bank session probe summary', {
    candidates: candidates?.length ?? 0,
    sessions: probeGroups.size,
    probed,
    probedDead: probeResults.length,
  })

  return NextResponse.json({
    candidates: candidates?.length ?? 0,
    sessions: probeGroups.size,
    probed,
    probedDead: probeResults.length,
    probeResults,
  })
})
