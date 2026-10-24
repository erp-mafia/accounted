import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { expiredCookieOptions } from '@/lib/supabase/cookie-options'
import { getMailSearchService } from '@/lib/mail-search/service'
import { getActiveCompanyId } from '@/lib/company/active-company'
import { getStripe } from '@/lib/stripe/client'
import { endCompanySubscriptions, readCompanyStripeRef } from '@/lib/stripe/company-subscription'

const log = createLogger('api/company/delete')

const DeleteCompanySchema = z.object({
  confirm_name: z.string().min(1),
})

/**
 * POST /api/company/[id]/delete
 *
 * Soft-delete a company. Sets archived_at + archived_by. The underlying
 * bookkeeping data is retained for 7 years per BFL 7 kap. 2§. All reads
 * flow through user_company_ids() which filters archived rows, so the
 * company disappears from the user's UI immediately.
 *
 * Rules:
 *  - Only callers with role='owner' in company_members may delete.
 *  - The body must include confirm_name matching the company's display name
 *    exactly as the UI shows it: company_settings.company_name, falling back
 *    to companies.name only when no settings row exists. ONLY that single
 *    name is accepted (see step 3) — accepting alternates would weaken the
 *    confirmation gate on an irreversible action.
 *  - Already-archived companies return 404 (treated as not found).
 *  - The company's Stripe subscription ends first (crm#1373); if Stripe
 *    cannot be reached the company is not archived (502).
 *
 * Response: { data: { companyId, archivedAt, nextCompanyId } }. nextCompanyId
 * is the company the user lands in now (the same resolution the middleware
 * runs on the next request), or null when they have none left: the client
 * then takes them to the delete-account action instead of a settings page
 * the middleware would bounce to onboarding (crm#1042). It is absent when
 * that resolution failed, which never reads as "no companies left".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: companyId } = await params

  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const result = await validateBody(request, DeleteCompanySchema)
  if (!result.success) return result.response
  const { confirm_name } = result.data

  // Service client for writes that must bypass RLS (audit_log insert,
  // user_preferences clearing). All queries still filter by company_id
  // and user.id for defense in depth.
  const service = createServiceClient()

  // 1. Fetch company: must exist and be active. Query via service client
  // because we need the raw row regardless of RLS visibility, but we still
  // enforce membership below.
  const { data: company, error: fetchError } = await service
    .from('companies')
    .select('id, name, archived_at')
    .eq('id', companyId)
    .maybeSingle()

  if (fetchError) {
    log.error('Failed to fetch company', { companyId, error: fetchError.message })
    return NextResponse.json({ error: 'Kunde inte hämta företag.' }, { status: 500 })
  }

  if (!company || company.archived_at) {
    return NextResponse.json({ error: 'Företaget hittades inte.' }, { status: 404 })
  }

  // 2. Caller must be an owner of this company
  const { data: membership, error: membershipError } = await service
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (membershipError) {
    log.error('Failed to fetch membership', { companyId, error: membershipError.message })
    return NextResponse.json({ error: 'Kunde inte verifiera behörighet.' }, { status: 500 })
  }

  if (!membership) {
    return NextResponse.json({ error: 'Företaget hittades inte.' }, { status: 404 })
  }

  if (membership.role !== 'owner') {
    return NextResponse.json(
      { error: 'Endast ägaren kan radera ett företag.' },
      { status: 403 }
    )
  }

  // 3. Confirm name matches the exact name the UI displays. The dashboard layout
  // resolves the displayed name as `company_settings.company_name || companies.name`
  // (companies.name may be stale) and CompanyDangerZone gates on that value, so
  // the server must accept ONLY that single name. Accepting the stale
  // companies.name as an alternative would open a confirmation path the user was
  // never shown, weakening the gate on an irreversible action (ASVS V8.2.1).
  // Case-sensitive trim, mirror of the client-side check.
  const { data: companySettings } = await service
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .maybeSingle()

  const displayName = (companySettings?.company_name || company.name).trim()
  const typed = confirm_name.trim()

  if (typed !== displayName) {
    return NextResponse.json(
      { error: 'Företagsnamnet stämmer inte överens.' },
      { status: 400 }
    )
  }

  // 3b. End the company's Stripe subscription (crm#1373). Once the company
  // is hidden nobody can open its billing page or the portal, yet the
  // subscription went on charging every period: an owner who deleted the
  // wrong company and subscribed on the right one paid for both. Ended
  // before the archive and fail closed: a company that would keep being
  // charged is not hidden. A failure after this point leaves the company
  // visible and unsubscribed, which a retry of the delete completes.
  try {
    const stripeRef = await readCompanyStripeRef(service, companyId)
    if (stripeRef) {
      const ended = await endCompanySubscriptions(getStripe(), companyId, stripeRef)
      if (ended.length > 0) {
        log.info('Ended the company subscription before archive', { companyId, subscriptionIds: ended })
      }
    }
  } catch (err) {
    log.error('Failed to end the company subscription before archive', err, { companyId })
    return NextResponse.json(
      { error: 'Kunde inte avsluta företagets abonnemang. Försök igen om en stund.' },
      { status: 502 }
    )
  }

  // 4. Soft delete
  const archivedAt = new Date().toISOString()
  const { error: updateError } = await service
    .from('companies')
    .update({ archived_at: archivedAt, archived_by: user.id })
    .eq('id', companyId)

  if (updateError) {
    log.error('Failed to archive company', { companyId, error: updateError.message })
    return NextResponse.json({ error: 'Kunde inte radera företaget.' }, { status: 500 })
  }

  // 5. Clear user_preferences.active_company_id if it pointed here so the
  // middleware falls through to another membership next request.
  await service
    .from('user_preferences')
    .update({ active_company_id: null })
    .eq('user_id', user.id)
    .eq('active_company_id', companyId)

  // 6. Revoke the company's store connections. The store-uniqueness indexes
  // (e.g. woocommerce_connections_store_active_uniq) allow a store to be
  // actively connected to at most ONE company, and user_company_ids() hides
  // archived companies, so an 'active' row left behind would block
  // reconnecting the store from any new company with no user-reachable
  // disconnect. Same status flip as the manual disconnect paths, secrets
  // nulled. Non-fatal: the archive already happened, but never silent.
  // .neq('revoked') rather than pending/active: 'error'-state rows also
  // carry credentials and are just as unreachable after the archive. Each
  // update carries its payload as an object literal so the phantom-column
  // scanner can resolve every column.
  const revokes = [
    {
      table: 'woocommerce_connections',
      result: await service
        .from('woocommerce_connections')
        .update({
          status: 'revoked',
          disconnected_at: archivedAt,
          consumer_key_encrypted: null,
          consumer_secret_encrypted: null,
          oauth_state: null,
        })
        .eq('company_id', companyId)
        .neq('status', 'revoked')
        .select('id'),
    },
    {
      table: 'shopify_connections',
      result: await service
        .from('shopify_connections')
        .update({
          status: 'revoked',
          disconnected_at: archivedAt,
          client_id_encrypted: null,
          client_secret_encrypted: null,
        })
        .eq('company_id', companyId)
        .neq('status', 'revoked')
        .select('id'),
    },
    {
      table: 'zettle_connections',
      result: await service
        .from('zettle_connections')
        .update({
          status: 'revoked',
          disconnected_at: archivedAt,
          refresh_token_encrypted: null,
          oauth_state: null,
        })
        .eq('company_id', companyId)
        .neq('status', 'revoked')
        .select('id'),
    },
    {
      table: 'stripe_connections',
      result: await service
        .from('stripe_connections')
        .update({
          status: 'revoked',
          disconnected_at: archivedAt,
          oauth_state: null,
        })
        .eq('company_id', companyId)
        .neq('status', 'revoked')
        .select('id'),
    },
  ]
  for (const { table, result } of revokes) {
    if (result.error) {
      log.error('Failed to revoke store connections on company archive', {
        companyId,
        table,
        error: result.error.message,
      })
      continue
    }
    // Credential revocation is a compliance-critical mutation: audit it like
    // the archive itself (the tables have no auto-audit trigger). Non-fatal,
    // same doctrine as the archive's own audit write below.
    for (const row of (result.data ?? []) as Array<{ id: string }>) {
      const { error: revokeAuditError } = await service.from('audit_log').insert({
        user_id: user.id,
        company_id: companyId,
        action: 'UPDATE',
        table_name: table,
        record_id: row.id,
        actor_id: user.id,
        new_state: { status: 'revoked', disconnected_at: archivedAt },
        description: `Store connection revoked on company archive: ${company.name}`,
      })
      if (revokeAuditError) {
        log.error('Failed to write audit_log row for connection revocation', {
          companyId,
          table,
          error: revokeAuditError.message,
        })
      }
    }
  }

  // 6b. End the company's mailbox grants. Nobody can disconnect them once
  // the company is hidden, and the receipt hunt would keep a live Gmail
  // grant for a company that no longer exists for its members. Each one is
  // revoked at Google (unless another company still reads that mailbox),
  // deleted and audited, exactly as a disconnect. Through the mail-search
  // seam, since core never imports the extension; best effort toward
  // Google, and the archive above stands whatever happens here.
  try {
    await (await getMailSearchService()).endCompanyGrants?.(companyId, user.id)
  } catch (err) {
    log.error('Failed to end mailbox grants on company archive', { companyId, err })
  }

  // 7. Write audit log row. companies has no auto-audit trigger, so do it
  // explicitly. Service client bypasses audit_log RLS (no INSERT policy).
  // The archive already happened — don't fail the request, but an audit
  // write failing on an irreversible action must never be silent.
  const { error: auditError } = await service.from('audit_log').insert({
    user_id: user.id,
    company_id: companyId,
    action: 'DELETE',
    table_name: 'companies',
    record_id: companyId,
    actor_id: user.id,
    old_state: { archived_at: null },
    new_state: { archived_at: archivedAt, archived_by: user.id },
    description: `Company archived: ${company.name}`,
  })
  if (auditError) {
    log.error('Failed to write audit_log row for company archive', {
      companyId,
      error: auditError.message,
    })
  }

  // 8. Emit event
  await eventBus.emit({
    type: 'company.deleted',
    payload: { companyId, userId: user.id, archivedAt },
  })

  // 9. Where the user lands now. Same resolver as the middleware (user
  // preferences, then the first non-archived membership), read through the
  // caller's own session so RLS hides the company just archived. A failed
  // read leaves the field out: unknown is not "no companies left".
  let nextCompanyId: string | null | undefined
  try {
    nextCompanyId = await getActiveCompanyId(supabase, user.id)
  } catch (err) {
    log.error('Failed to resolve the next active company after archive', { companyId, err })
  }

  // 10. Build response and clear company cookie if it matched
  const response = NextResponse.json({ data: { companyId, archivedAt, nextCompanyId } })

  const cookieCompanyId = request.headers.get('cookie')?.match(/gnubok-company-id=([^;]+)/)?.[1]
  if (cookieCompanyId === companyId) {
    response.cookies.set('gnubok-company-id', '', expiredCookieOptions())
  }

  return response
}
