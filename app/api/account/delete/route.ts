import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/account/delete')

ensureInitialized()

const DeleteAccountSchema = z.object({
  confirm_email: z.string().email(),
})

/**
 * POST /api/account/delete
 *
 * Anonymizes the calling user's account. The auth.users row is retained
 * (banned for ~100 years) as a tombstone so FKs into BFL-retained
 * bookkeeping data (companies.created_by, audit_log.user_id, etc.) stay
 * valid. Memberships are removed, profile PII is stripped, and a global
 * signout forces all sessions to end.
 *
 * Precondition: the user must own zero non-archived companies. The RPC
 * enforces this at the DB level and raises SQLSTATE P0001 with a message
 * if the precondition fails: we return 409 in that case.
 */
export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await validateBody(request, DeleteAccountSchema)
  if (!result.success) return result.response
  const { confirm_email } = result.data

  if (!user.email || confirm_email.trim().toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json(
      { error: 'E-postadressen stämmer inte överens med ditt konto.' },
      { status: 400 }
    )
  }

  // Anonymize in the DB. Runs as SECURITY DEFINER and checks auth.uid()
  // internally, so we don't need service role here.
  const { error: rpcError } = await supabase.rpc('anonymize_user_account', {
    target_user_id: user.id,
  })

  if (rpcError) {
    // P0001 = precondition violation from our RPC: user still owns active
    // companies. Re-fetch the blockers and return 409 so the UI can show
    // the list inline.
    if (rpcError.code === 'P0001') {
      const service = createServiceClient()
      const { data: blockers } = await service
        .from('company_members')
        .select('company_id, companies!inner(id, name, archived_at)')
        .eq('user_id', user.id)
        .eq('role', 'owner')
        .is('companies.archived_at', null)

      const list = (blockers ?? []).map((b) => {
        const company = (b.companies as unknown) as { id: string; name: string }
        return { id: company.id, name: company.name }
      })

      return NextResponse.json(
        {
          error: 'Du måste radera eller överlåta dina företag innan du kan radera kontot.',
          blockers: list,
        },
        { status: 409 }
      )
    }

    log.error('anonymize_user_account failed', { userId: user.id, error: rpcError.message })
    return NextResponse.json(
      { error: 'Kunde inte radera kontot. Försök igen.' },
      { status: 500 }
    )
  }

  // Wipe PII in auth.users metadata and ban the tombstone row ~100 years.
  // DB functions can't reach supabase.auth.admin, so we do it here.
  //
  // Note: auth.users.email is intentionally NOT scrubbed. The original
  // address is retained as a legitimate-interest tombstone so that:
  //   (1) re-signup with the same email is blocked by Supabase's unique
  //       constraint: deletion must feel permanent, not trivially
  //       reversible by re-registering
  //   (2) support can verify identity when a former user asks to recover
  //       BFL-retained räkenskapsinformation
  // This must be documented in the privacy policy under legitimate
  // interest (GDPR Art. 6(1)(f)). The email is never read by the app
  // after this point: login is impossible (row is banned) and the
  // profile is anonymized, so no UI ever surfaces it.
  //
  // user_metadata / app_metadata ARE wiped: they may contain display
  // name, avatar, or provider info that isn't needed for recovery.
  // The admin API replaces (not merges) these, so passing {} clears them.
  const service = createServiceClient()
  try {
    await service.auth.admin.updateUserById(user.id, {
      user_metadata: {},
      app_metadata: {},
      ban_duration: '876000h',
    })
  } catch (err) {
    log.error('Failed to wipe metadata and ban anonymized user', { userId: user.id, err })
  }

  try {
    await service.auth.admin.signOut(user.id, 'global')
  } catch (err) {
    log.error('Failed to global sign out anonymized user', { userId: user.id, err })
  }

  const deletedAt = new Date().toISOString()
  await eventBus.emit({
    type: 'account.deleted',
    payload: { userId: user.id, deletedAt },
  })

  // Best-effort: clear the caller's session cookie too.
  await supabase.auth.signOut().catch(() => {})

  // Request body is consumed; avoid unused-var lint.
  void request

  return NextResponse.json({ success: true })
}
