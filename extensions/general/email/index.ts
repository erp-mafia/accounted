import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { registerEmailService } from '@/lib/email/service'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createEmailService } from './lib/email-provider'
import {
  ResendDeliverySignatureError,
  isDeliveryWebhookConfigured,
  toDeliveryReport,
  verifyDeliveryWebhook,
} from './lib/delivery-webhook'
import {
  applySendingDomainStatusFromWebhook,
  checkSendingDomainVerification,
  claimSendingDomain,
  getSendingDomain,
  removeSendingDomain,
  updateSendingDomainSettings,
} from './lib/sending-domains'

// Register the implementation for this deployment immediately when the
// extension is loaded: Resend (hosted default) or SMTP (EMAIL_PROVIDER=smtp,
// the sovereign self-host path). See lib/email-provider.ts for precedence.
registerEmailService(createEmailService())

const log = createLogger('email-delivery-webhook')

// Claim body for POST /sending-domain. Length-capped only: real validation
// (punycode, hostname shape, blocklist) lives in the sending-domains module.
const ClaimSendingDomainSchema = z.object({
  domain: z.string().trim().min(1).max(255),
})

const PatchSendingDomainSchema = z
  .object({
    sender_local_part: z.string().trim().min(1).max(64).optional(),
    sender_name: z.string().trim().max(120).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

async function isCompanyAdmin(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  const role = (data as { role?: string } | null)?.role
  return role === 'owner' || role === 'admin'
}

/**
 * Shared preamble for the sending-domain routes: auth context, the opt-in
 * capability grant (403 capability_blocked when missing: the UI hides the
 * section on that), and for writes the owner/admin role plus the sandbox
 * block (anonymous demo accounts must not register domains in our Resend
 * account). Returns the response to send, or null to proceed.
 */
async function guardSendingDomainRoute(
  ctx: ExtensionContext | undefined,
  opts: { write: boolean },
): Promise<NextResponse | null> {
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const blocked = await requireCapability(ctx.supabase, ctx.companyId, CAPABILITY.custom_sender_domain)
  if (blocked) return blocked
  if (!opts.write) return null
  if (!(await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId))) {
    return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
  }
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) {
    return NextResponse.json({ error: 'Egen avsändardomän är inte tillgänglig i sandlådan.' }, { status: 403 })
  }
  return null
}

export const emailExtension: Extension = {
  id: 'email',
  name: 'E-post',
  version: '1.0.0',

  apiRoutes: [
    // ── Company sending domain: read current state ───────────
    {
      method: 'GET',
      path: '/sending-domain',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        const denied = await guardSendingDomainRoute(ctx, { write: false })
        if (denied) return denied
        try {
          // null when the company has no sending domain: the UI renders the
          // claim form in that case.
          const row = await getSendingDomain(ctx!.supabase, ctx!.companyId)
          return NextResponse.json({ data: row })
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to load sending domain' },
            { status: 500 },
          )
        }
      },
    },

    // ── Company sending domain: claim (owner/admin only) ─────
    {
      method: 'POST',
      path: '/sending-domain',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const denied = await guardSendingDomainRoute(ctx, { write: true })
        if (denied) return denied

        let body: z.infer<typeof ClaimSendingDomainSchema>
        try {
          body = ClaimSendingDomainSchema.parse(await request.json())
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid request body' },
            { status: 400 },
          )
        }

        // Verification state is service-role only (tenant guard trigger);
        // the user client still does the insert, so RLS proves membership.
        const result = await claimSendingDomain(
          ctx!.supabase,
          createServiceClientNoCookies(),
          ctx!.companyId,
          body.domain,
        )
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
        return NextResponse.json({ data: result.data })
      },
    },

    // ── Company sending domain: re-check verification ────────
    {
      method: 'POST',
      path: '/sending-domain/verify',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        const denied = await guardSendingDomainRoute(ctx, { write: true })
        if (denied) return denied

        const result = await checkSendingDomainVerification(
          ctx!.supabase,
          createServiceClientNoCookies(),
          ctx!.companyId,
        )
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
        return NextResponse.json({ data: result.data })
      },
    },

    // ── Company sending domain: sender address/name, pause ───
    {
      method: 'PATCH',
      path: '/sending-domain',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const denied = await guardSendingDomainRoute(ctx, { write: true })
        if (denied) return denied

        let body: z.infer<typeof PatchSendingDomainSchema>
        try {
          body = PatchSendingDomainSchema.parse(await request.json())
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid request body' },
            { status: 400 },
          )
        }

        const result = await updateSendingDomainSettings(ctx!.supabase, ctx!.companyId, body)
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
        return NextResponse.json({ data: result.data })
      },
    },

    // ── Company sending domain: remove (owner/admin only) ────
    {
      method: 'DELETE',
      path: '/sending-domain',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        const denied = await guardSendingDomainRoute(ctx, { write: true })
        if (denied) return denied

        const result = await removeSendingDomain(ctx!.supabase, ctx!.companyId)
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
        return NextResponse.json({ data: result.data })
      },
    },

    // ── Resend delivery webhook (Svix-signed, no user auth) ──
    // Reports whether a sent invoice email actually arrived. Resend pushes
    // every event for the account to this endpoint, including mail that is not
    // a tracked invoice delivery: unmatched reports are acknowledged and
    // dropped so they are not retried forever.
    {
      method: 'POST',
      path: '/delivery-status',
      skipAuth: true,
      handler: async (request: Request) => {
        if (!isDeliveryWebhookConfigured()) {
          log.error('RESEND_DELIVERY_WEBHOOK_SECRET is not configured', undefined)
          return NextResponse.json({ error: 'Delivery webhook not configured' }, { status: 503 })
        }

        const rawBody = await request.text()

        let event
        try {
          event = verifyDeliveryWebhook(rawBody, request.headers)
        } catch (err) {
          if (err instanceof ResendDeliverySignatureError) {
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
          }
          log.error('delivery webhook verification failed', err)
          return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
        }

        // Resend pushes domain.* lifecycle events to the same endpoint. Apply
        // domain.updated to company sending-domain rows so verification flips
        // without the user pressing "Kontrollera igen" (requires the event
        // type to be subscribed on the Resend webhook; harmless when it isn't).
        if (event.type === 'domain.updated') {
          const outcome = await applySendingDomainStatusFromWebhook(createServiceClientNoCookies(), {
            id: event.data.id,
            status: event.data.status,
            records: event.data.records,
          })
          // A database error must not be acknowledged: Svix retries non-2xx
          // with backoff, which is exactly the recovery wanted for a
          // transient failure (same rule as the delivery status below).
          if (outcome === 'error') {
            log.error('failed to apply domain status', undefined, { domainId: event.data.id })
            return NextResponse.json({ error: 'Failed to record domain status' }, { status: 500 })
          }
          return NextResponse.json({
            data: { applied: outcome === 'applied', reason: outcome === 'no_match' ? 'no_matching_domain' : undefined },
          })
        }

        const report = toDeliveryReport(event)
        if (!report) {
          return NextResponse.json({ data: { applied: false, reason: 'ignored_event' } })
        }

        const { data, error } = await createServiceClientNoCookies().rpc(
          'apply_invoice_delivery_provider_event',
          {
            p_provider: 'resend',
            p_provider_message_id: report.providerMessageId,
            p_status: report.status,
            p_occurred_at: report.occurredAt,
            p_detail: report.detail,
            p_recipient_addresses: report.recipients,
          },
        )

        // A failed apply must not be acknowledged: Svix retries non-2xx with
        // backoff, which is exactly the recovery wanted for a transient
        // database error.
        if (error) {
          log.error('failed to apply delivery status', error, { status: report.status })
          return NextResponse.json({ error: 'Failed to record delivery status' }, { status: 500 })
        }

        if (!data) {
          return NextResponse.json({ data: { applied: false, reason: 'no_matching_delivery' } })
        }

        log.info('delivery status applied', { deliveryId: data, status: report.status })
        return NextResponse.json({ data: { applied: true } })
      },
    },
  ],
}
