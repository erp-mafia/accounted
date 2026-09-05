/**
 * Self-service for a signed-in BankID account whose address is still
 * unproven (BankID instant login, 2026-09-05): re-send the verification mail,
 * or swap the typed address for another one.
 *
 * Both are only reachable with a session and only while
 * app_metadata.bankid_pending is set. The address change is unconfirmed on
 * purpose: nothing has been proven about the old address either, so asking
 * it to approve the change (the secure email change of /api/account/email)
 * would send the approval to the very inbox the holder cannot reach. GoTrue
 * still refuses an address that belongs to another account.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import { sendBankIdSignupConfirmation } from './bankid-confirmation-mail'

const log = createLogger('tic/bankid-pending-routes')

/** Two mails per minute per account is plenty for a lost-mail retry. */
export const RESEND_COOLDOWN_MS = 30_000

const NOT_PENDING = {
  error: 'not_pending',
  message: 'E-postadressen är redan bekräftad.',
}

const ChangeEmailSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.string().email()),
})

function forwardedHost(request: Request): string {
  return request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
}

function cooldownRemainingMs(meta: Record<string, unknown>, now: number): number {
  const last = meta.bankid_pending_mail_sent_at
  if (typeof last !== 'string') return 0
  const sentAt = Date.parse(last)
  if (Number.isNaN(sentAt)) return 0
  return Math.max(0, sentAt + RESEND_COOLDOWN_MS - now)
}

/**
 * Send the verification mail and stamp the send time (read-merge-write on
 * app_metadata: updateUserById replaces it wholesale). Shared by both routes
 * and by the signup itself.
 */
export async function sendPendingVerificationMail(
  supabase: SupabaseClient,
  user: { id: string; email: string; app_metadata?: Record<string, unknown> },
  request: Request,
): Promise<{ ok: true } | { ok: false; step: string }> {
  const sent = await sendBankIdSignupConfirmation({
    supabase,
    email: user.email,
    host: forwardedHost(request),
    proto: request.headers.get('x-forwarded-proto'),
  })
  if (!sent.ok) return { ok: false, step: sent.step }

  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...(user.app_metadata ?? {}),
      bankid_pending_mail_sent_at: new Date().toISOString(),
    },
  })
  if (error) {
    // The mail is out; a missing stamp only weakens the cooldown.
    log.warn('could not stamp bankid_pending_mail_sent_at', { userId: user.id, message: error.message })
  }
  return { ok: true }
}

async function loadPendingUser(userId: string, supabase: SupabaseClient) {
  // Fresh copy: the session's user object can lag an app_metadata write.
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error || !data?.user) return null
  return data.user
}

export const bankIdPendingRoutes = [
  {
    method: 'POST' as const,
    path: '/bankid/pending/resend',
    skipCompanyContext: true,
    handler: async (request: Request) => {
      const auth = await requireAuth()
      if (auth.error) return auth.error

      const supabase = createServiceClient()
      const user = await loadPendingUser(auth.user.id, supabase)
      if (!user?.email || user.app_metadata?.bankid_pending !== true) {
        return NextResponse.json(NOT_PENDING, { status: 400 })
      }

      const remaining = cooldownRemainingMs(user.app_metadata ?? {}, Date.now())
      if (remaining > 0) {
        return NextResponse.json(
          {
            error: 'cooldown',
            message: 'Ett mail skickades nyss. Vänta en stund innan du försöker igen.',
            retryAfterMs: remaining,
          },
          { status: 429 },
        )
      }

      const sent = await sendPendingVerificationMail(
        supabase,
        { id: user.id, email: user.email, app_metadata: user.app_metadata },
        request,
      )
      if (!sent.ok) {
        log.error('pending verification re-send failed', { userId: user.id, step: sent.step })
        return NextResponse.json(
          { error: 'internal_error', message: 'Kunde inte skicka mailet. Försök igen om en stund.' },
          { status: 500 },
        )
      }
      return NextResponse.json({ data: { sent: true, email: user.email } })
    },
  },
  {
    method: 'POST' as const,
    path: '/bankid/pending/change-email',
    skipCompanyContext: true,
    handler: async (request: Request) => {
      const auth = await requireAuth()
      if (auth.error) return auth.error

      const validation = await validateBody(request, ChangeEmailSchema)
      if (!validation.success) return validation.response
      const { email } = validation.data

      const supabase = createServiceClient()
      const user = await loadPendingUser(auth.user.id, supabase)
      if (!user?.email || user.app_metadata?.bankid_pending !== true) {
        return NextResponse.json(NOT_PENDING, { status: 400 })
      }

      if (email !== user.email.toLowerCase()) {
        // email_confirm: true keeps the password grant of the next BankID
        // login working (bankid-session-grant.ts); the pending flag, not
        // GoTrue's column, is what says the address is unproven.
        const { error } = await supabase.auth.admin.updateUserById(user.id, {
          email,
          email_confirm: true,
        })
        if (error) {
          if (error.code === 'email_exists') {
            return NextResponse.json(
              {
                error: 'account_exists',
                message: 'Det finns redan ett konto med den här e-postadressen.',
              },
              { status: 409 },
            )
          }
          log.error('pending address change failed', { userId: user.id, code: error.code, message: error.message })
          return NextResponse.json(
            { error: 'internal_error', message: 'Kunde inte byta e-postadress. Försök igen.' },
            { status: 500 },
          )
        }
      }

      // A fresh address gets its mail at once, cooldown or not: the stamp
      // belonged to the old one.
      const sent = await sendPendingVerificationMail(
        supabase,
        { id: user.id, email, app_metadata: user.app_metadata },
        request,
      )
      if (!sent.ok) {
        log.error('verification mail to the new pending address failed', { userId: user.id, step: sent.step })
        // The address is changed; the banner's re-send is the retry.
        return NextResponse.json(
          { error: 'mail_failed', message: 'Adressen är bytt men mailet kunde inte skickas. Försök skicka igen.', email },
          { status: 502 },
        )
      }
      return NextResponse.json({ data: { email, sent: true } })
    },
  },
]
