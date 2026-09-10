import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { requireAuth } from '@/lib/auth/require-auth'
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
 * Deletes the calling user's account. The auth.users row is retained
 * (banned for ~100 years) as a tombstone so FKs into BFL-retained
 * bookkeeping data (companies.created_by, audit_log.user_id, etc.) stay
 * valid. Everything personal is erased by the anonymize_user_account RPC
 * through public.erase_user_personal_data: memberships, credentials and
 * sessions, BankID data, settings, conversations and the email address;
 * bank and mail consents the user gave are revoked.
 *
 * Precondition: the user must own zero non-archived companies. The RPC
 * enforces this at the DB level and raises SQLSTATE P0001 with a message
 * if the precondition fails: we return 409 in that case.
 *
 * Not wrapped in withRouteContext: deletion must work for users with zero
 * companies, so there is no company context to resolve. requireAuth() is
 * used directly so MFA (AAL2) is still enforced on hosted: a stolen AAL1
 * cookie must not be able to destroy the account. BankID-linked users are
 * exempt from the AAL2 gate (BankID is inherently 2FA, see shouldEnforceMfa).
 */
export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

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

  // Ban the tombstone row ~100 years. The RPC has already removed every way
  // to sign in (email, identities, sessions, refresh tokens, MFA factors), so
  // the ban is defense in depth. The DB function can't set it: bans are
  // GoTrue-managed.
  //
  // Nothing else on the auth row is written here. GoTrue's admin update
  // MERGES metadata maps, so an updateUserById(..., { user_metadata: {} })
  // wipe is a silent no-op (found on prod 2026-07-24), and
  // auth.admin.signOut() takes the user's JWT, not a user id, so the former
  // signOut(user.id, 'global') call ended no session (13 were still live on
  // prod tombstones on 2026-09-10). Both jobs live in the RPC.
  const service = createServiceClient()
  try {
    const { error: banError } = await service.auth.admin.updateUserById(user.id, {
      ban_duration: '876000h',
    })
    if (banError) {
      log.error('Failed to ban anonymized user', { userId: user.id, error: banError.message })
    }
  } catch (err) {
    log.error('Failed to ban anonymized user', { userId: user.id, err })
  }

  const deletedAt = new Date().toISOString()
  await eventBus.emit({
    type: 'account.deleted',
    payload: { userId: user.id, deletedAt },
  })

  // Best-effort: clear the caller's session cookie too.
  await supabase.auth.signOut().catch(() => {})

  return NextResponse.json({ success: true })
}
