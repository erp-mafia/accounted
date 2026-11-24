/**
 * The company side of Peppol: its receiving registration (a participant id
 * published at the access point) and its request for Peppol access.
 *
 * One implementation behind the dashboard routes (GET/POST
 * /api/settings/peppol, POST /api/settings/peppol/access) and the operations
 * peppol.get-registration, peppol.register and peppol.request-access
 * (lib/operations/peppol.ts). The registration rules themselves (stale
 * pending rows, the receiving cap, the transport verdicts) stay in
 * lib/invoices/peppol-registration.ts; this module adds the gates in front of
 * them in the order the dashboard has always applied.
 *
 * Dry runs (the MCP staging preview too) read and never touch the network:
 * no pending row, no call to the access point, no mail.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getBaseUrlForBrand, getSenderForCompany } from '@/lib/email/brand-sender'
import {
  generatePeppolPlanRequiredEmailHtml,
  generatePeppolPlanRequiredEmailSubject,
  generatePeppolPlanRequiredEmailText,
  PEPPOL_PLAN_REQUIRED_TEMPLATE,
} from '@/lib/email/peppol-plan-required-templates'
import { getEmailService } from '@/lib/email/service'
import {
  getPeppolAccess,
  getPeppolAccessSummary,
  requestPeppolAccess,
  type PeppolAccessSummary,
} from '@/lib/invoices/peppol-access'
import { applyPeppolPlanRule, peppolCompanyPays } from '@/lib/invoices/peppol-plan-rule'
import {
  countLivePeppolRegistrations,
  describePeppolParticipantEligibility,
  getPeppolReceivingCap,
  getPeppolRegistration,
  isStalePeppolPending,
  preparePeppolParticipant,
  PEPPOL_RECEIVING_DOCUMENT_TYPES,
  registerCompanyForPeppolReceiving,
  type PeppolParticipantEligibility,
  type PeppolRegistrationRow,
} from '@/lib/invoices/peppol-registration'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
  type PeppolTransport,
  type PeppolTransportAvailability,
} from '@/lib/invoices/peppol-transport'
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { resolveMemberEmail } from '@/lib/notifications/member-email'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import type { CompanySettings } from '@/types'

type ParticipantSettings = Pick<CompanySettings, 'org_number' | 'company_name' | 'vat_number' | 'city' | 'country' | 'entity_type'>

/** See PeppolDoorOptions in peppol-send-service.ts: the dashboard passes a service-role client. */
interface DoorOptions {
  service?: SupabaseClient
}

async function resolveTransport(): Promise<{ transport: PeppolTransport; provider: string } | null> {
  const availability = await getPeppolTransportAvailability()
  if (!availability.available) return null
  const transport = await getPeppolTransport(availability.provider)
  return transport ? { transport, provider: availability.provider } : null
}

// ---------------------------------------------------------------------------
// Registration status
// ---------------------------------------------------------------------------

export interface PeppolRegistrationStatus {
  transport: PeppolTransportAvailability
  receiving_supported: boolean
  access: PeppolAccessSummary
  /**
   * The company has no Peppol yet (`none` or `requested`) and does not pay:
   * Peppol needs a paid plan first, and is switched on by itself once there
   * is one (lib/invoices/peppol-plan-rule.ts).
   */
  plan_required: boolean
  participant: PeppolParticipantEligibility
  registration: PeppolRegistrationRow | null
}

/** Whether a company without Peppol must start paying before it can have it. */
async function planRequired(service: SupabaseClient, companyId: string, access: PeppolAccessSummary): Promise<boolean> {
  if (access.status !== 'none' && access.status !== 'requested') return false
  return !(await peppolCompanyPays(service, companyId))
}

/** Receiving status for the company: transport, access grant, eligibility and the registration row. */
export async function getPeppolRegistrationStatus(
  ctx: OperationContext,
  options: DoorOptions = {},
): Promise<OperationOutcome<PeppolRegistrationStatus>> {
  const { supabase, companyId } = ctx
  const service = options.service ?? supabase
  const availability = await getPeppolTransportAvailability()
  const resolved = await resolveTransport()
  try {
    const registration = resolved
      ? await getPeppolRegistration({ supabase, companyId, provider: resolved.provider })
      : null
    // Eligibility is answered up front so a company that cannot be a
    // participant (personnummer, missing org number) sees why instead of
    // an access request it could never use.
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('org_number, company_name, vat_number, city, country, entity_type')
      .eq('company_id', companyId)
      .maybeSingle()
    // A failed read is a server error, never "no organisation number":
    // that verdict would hide the receiving offer from an eligible company.
    if (settingsError) throw new Error(`Failed to read company settings: ${settingsError.message}`)
    const participant: PeppolParticipantEligibility = settings
      ? describePeppolParticipantEligibility(settings as unknown as ParticipantSettings)
      : { ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' }
    const access = await getPeppolAccessSummary({ supabase, service, companyId })
    return {
      ok: true,
      data: {
        transport: availability,
        receiving_supported: !!resolved?.transport.registerRecipient,
        access,
        plan_required: await planRequired(service, companyId, access),
        participant,
        registration,
      },
    }
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', error: err }
  }
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface PeppolRegisterResult {
  registration: PeppolRegistrationRow
}

/**
 * Publish the company's participant id (0007 + organisation number) at the
 * access point so other parties can send it e-invoices. `requireAdmin`
 * reserves it for owners and admins: the v1 and MCP doors set it (publishing
 * the company in the Peppol directory is a company-level decision on a
 * service-role door); the dashboard keeps its member-level gate for now.
 */
export async function registerPeppolParticipant(
  ctx: OperationContext,
  options: DoorOptions & { dryRun?: boolean; requireAdmin?: boolean } = {},
): Promise<OperationOutcome<PeppolRegisterResult>> {
  const { supabase, companyId, userId } = ctx
  const service = options.service ?? supabase

  if (options.requireAdmin) {
    const denied = await requireCompanyAdmin(
      ctx,
      'Bara ägare och administratörer kan registrera bolaget för Peppol-mottagning.',
    )
    if (denied) return denied
  }

  const resolved = await resolveTransport()
  if (!resolved) return { ok: false, code: 'PEPPOL_TRANSPORT_UNAVAILABLE' }
  if (await isSandboxCompany(supabase, companyId)) return { ok: false, code: 'PEPPOL_SANDBOX_NOT_ALLOWED' }

  // Receiving comes with access (a paid plan): whether to use it is the
  // company's own choice, recorded below when it switches receiving on.
  const access = await getPeppolAccess(service, companyId)
  if (!access || access.status !== 'enabled') return { ok: false, code: 'PEPPOL_ACCESS_REQUIRED' }

  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('org_number, company_name, vat_number, city, country, entity_type')
    .eq('company_id', companyId)
    .single()
  if (settingsError || !settings) return { ok: false, code: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' }
  const participantSettings = settings as unknown as ParticipantSettings

  try {
    if (options.dryRun) return await previewRegistration(service, companyId, resolved, participantSettings)

    // The choice is kept on the access row, where the inbound cron reads it:
    // a plan that ends withdraws the identifier, and one that comes back
    // keeps the choice. Guarded on `enabled` so a pause in between wins.
    if (!access.receive_enabled) {
      const { error } = await service
        .from('peppol_access')
        .update({ receive_enabled: true })
        .eq('company_id', companyId)
        .eq('status', 'enabled')
      if (error) throw new Error(`Failed to record the receiving choice: ${error.message}`)
    }

    const result = await registerCompanyForPeppolReceiving({
      service,
      companyId,
      userId,
      transport: resolved.transport,
      settings: participantSettings,
    })
    if (!result.ok) {
      if ('reason' in result) {
        // A transport verdict: the hosted detail and code travel in details.
        return { ok: false, code: result.code, details: { reason: result.detail, code: result.reason } }
      }
      return { ok: false, code: result.code }
    }
    return { ok: true, created: true, data: { registration: result.registration } }
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', error: err }
  }
}

/** What a registration would do, as reads: the same refusals the commit answers before its network call. */
async function previewRegistration(
  service: SupabaseClient,
  companyId: string,
  resolved: { transport: PeppolTransport; provider: string },
  settings: ParticipantSettings,
): Promise<OperationOutcome<PeppolRegisterResult>> {
  if (!resolved.transport.registerRecipient) return { ok: false, code: 'PEPPOL_RECEIVING_UNSUPPORTED' }
  const prepared = preparePeppolParticipant(settings)
  if (!prepared.ok) return { ok: false, code: prepared.code }

  const existing = await getPeppolRegistration({ supabase: service, companyId, provider: resolved.provider })
  const live = existing && (existing.status === 'pending' || existing.status === 'registered') ? existing : null
  const stale = live !== null && isStalePeppolPending(live)
  if (!live || stale) {
    const cap = getPeppolReceivingCap()
    if (cap !== null) {
      const liveCount = await countLivePeppolRegistrations({ supabase: service, provider: resolved.provider })
      if (liveCount - (stale ? 1 : 0) >= cap) return { ok: false, code: 'PEPPOL_REGISTRATION_CAP_REACHED' }
    }
  }
  return {
    ok: true,
    dryRun: true,
    preview: {
      participant: prepared.participant,
      participant_id: `${prepared.participant.scheme}:${prepared.participant.identifier}`,
      business_card: prepared.businessCard,
      document_types: PEPPOL_RECEIVING_DOCUMENT_TYPES.map((d) => d.documentTypeId),
      transport_provider: resolved.provider,
      existing_registration_status: existing?.status ?? null,
      action: live && !stale ? 'republish' : stale ? 'retry_stale_attempt' : 'register',
      // Publishing at the access point is a network call: commit only.
      network_call: 'on_commit',
    },
  }
}

// ---------------------------------------------------------------------------
// Access request
// ---------------------------------------------------------------------------

/** The access request body, shared by the dashboard route and the operation. */
export const PeppolAccessRequestSchema = z.object({
  note: z.string().trim().max(1800).optional().describe('Free text kept with the request (what the company needs Peppol for).'),
  /** The company also wants to receive: published as soon as access is on. */
  wants_receiving: z.boolean().optional().describe('True when the company also wants to receive e-invoices via Peppol (opt-in; can also be switched on later).'),
})

export type PeppolAccessRequestInput = z.infer<typeof PeppolAccessRequestSchema>

export interface PeppolAccessRequestResult {
  access: PeppolAccessSummary
  created: boolean
  /** The company does not pay: Peppol is switched on by itself once it does. */
  plan_required: boolean
}

/**
 * The company asks for Peppol. The request row is written (service role;
 * nobody can grant themselves anything) and the plan rule decides at once
 * (lib/invoices/peppol-plan-rule.ts): a paying company has Peppol when this
 * returns; one that does not pay keeps its request, the answer says a paid
 * plan is needed, and the person who asked is mailed the same. Nobody at
 * Accounted is mailed: the daily Peppol report lists what happened.
 *
 * Sending and receiving both identify the company by its 0007 participant
 * id, so a company that cannot be one (a personnummer, no org number, no
 * name) is refused with the eligibility code instead of a request nobody
 * could grant.
 */
export async function requestPeppolAccessForCompany(
  ctx: OperationContext,
  input: PeppolAccessRequestInput,
  options: DoorOptions & { dryRun?: boolean } = {},
): Promise<OperationOutcome<PeppolAccessRequestResult>> {
  const { supabase, companyId, userId, log } = ctx
  const service = options.service ?? supabase
  const wantsReceiving = input.wants_receiving === true
  const note = input.note?.trim() || null

  if (await isSandboxCompany(supabase, companyId)) return { ok: false, code: 'PEPPOL_SANDBOX_NOT_ALLOWED' }

  try {
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('org_number, company_name, vat_number, city, country, entity_type')
      .eq('company_id', companyId)
      .maybeSingle()
    // A failed read is a server error, never "no organisation number".
    if (settingsError) throw new Error(`Failed to read company settings: ${settingsError.message}`)
    if (!settings) return { ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' }
    const company = settings as unknown as ParticipantSettings
    const eligibility = describePeppolParticipantEligibility(company)
    if (!eligibility.ok) return { ok: false, code: eligibility.code }

    if (options.dryRun) {
      const existing = await getPeppolAccess(service, companyId)
      if (existing?.status === 'enabled') return { ok: false, code: 'PEPPOL_ACCESS_ALREADY_ENABLED' }
      if (existing?.status === 'disabled') return { ok: false, code: 'PEPPOL_ACCESS_DISABLED' }
      const pays = await peppolCompanyPays(service, companyId)
      return {
        ok: true,
        dryRun: true,
        preview: {
          current_status: existing?.status ?? 'none',
          would_create_request: existing?.status !== 'requested',
          wants_receiving: wantsReceiving,
          note,
          // A paying company has Peppol on commit; one that does not pay
          // keeps the request and is told a paid plan is needed.
          switches_on_now: pays,
          plan_required: !pays,
        },
      }
    }

    const result = await requestPeppolAccess({ service, companyId, userId, note, wantsReceiving })
    if (!result.ok) return { ok: false, code: result.code }

    const rule = await applyPeppolPlanRule({ service, companyIds: [companyId] })
    // Not the caller's failure: the request is recorded, and the inbound
    // cron applies the rule again within ten minutes.
    if (rule.failed.length > 0) log.error('peppol plan rule failed after a request', { companyId, failed: rule.failed })

    const summary = await getPeppolAccessSummary({ supabase: service, service, companyId })
    const plan_required = await planRequired(service, companyId, summary)
    if (plan_required && result.created) await mailPlanRequired(ctx, service, company)
    return { ok: true, created: result.created, data: { access: summary, created: result.created, plan_required } }
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', error: err }
  }
}

/**
 * Tells the person who asked, at once, that Peppol needs a paid plan, and
 * where to get one. Best-effort: the answer to the request and the settings
 * page say the same, so a mail that fails is logged and nothing else.
 */
async function mailPlanRequired(ctx: OperationContext, service: SupabaseClient, company: ParticipantSettings): Promise<void> {
  const { companyId, userId, log } = ctx
  try {
    const email = await getEmailService()
    if (!email.isConfigured()) return
    const address = await resolveMemberEmail(service, companyId, userId)
    if (!address) return
    const sender = await getSenderForCompany(companyId)
    const data = {
      companyName: company.company_name?.trim() || 'bolaget',
      billingUrl: `${getBaseUrlForBrand(sender.brand)}/settings/billing`,
      appName: sender.brand?.appName,
    }
    const sent = await email.sendEmail({
      to: address,
      subject: generatePeppolPlanRequiredEmailSubject(),
      html: generatePeppolPlanRequiredEmailHtml(data),
      text: generatePeppolPlanRequiredEmailText(data),
      fromName: sender.fromName ?? undefined,
      fromAddress: sender.fromAddress ?? undefined,
      replyTo: sender.replyTo ?? undefined,
      idempotencyKey: `${PEPPOL_PLAN_REQUIRED_TEMPLATE}:${companyId}:${userId}`,
    })
    // The address is the recipient's: not logged.
    if (!sent.success) log.warn('peppol plan-required mail failed', { companyId, template: PEPPOL_PLAN_REQUIRED_TEMPLATE, reason: sent.error })
  } catch (err) {
    log.warn('peppol plan-required mail failed', { companyId, template: PEPPOL_PLAN_REQUIRED_TEMPLATE, reason: err instanceof Error ? err.message : String(err) })
  }
}
