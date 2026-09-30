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
 * no pending row, no call to the access point, no operator mail.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getBranding } from '@/lib/branding/service'
import { getEmailService } from '@/lib/email/service'
import {
  getPeppolAccess,
  getPeppolAccessSummary,
  requestPeppolAccess,
  type PeppolAccessSummary,
} from '@/lib/invoices/peppol-access'
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
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { getSupportRecipientEmail } from '@/lib/support'
import type { CompanySettings } from '@/types'

type ParticipantSettings = Pick<CompanySettings, 'org_number' | 'company_name' | 'vat_number' | 'city' | 'country'>

/** See PeppolDoorOptions in peppol-send-service.ts: the dashboard passes a service-role client. */
interface DoorOptions {
  service?: SupabaseClient
}

function resolveTransport(): { transport: PeppolTransport; provider: string } | null {
  const availability = getPeppolTransportAvailability()
  if (!availability.available) return null
  const transport = getPeppolTransport(availability.provider)
  return transport ? { transport, provider: availability.provider } : null
}

// ---------------------------------------------------------------------------
// Registration status
// ---------------------------------------------------------------------------

export interface PeppolRegistrationStatus {
  transport: PeppolTransportAvailability
  receiving_supported: boolean
  access: PeppolAccessSummary
  participant: PeppolParticipantEligibility
  registration: PeppolRegistrationRow | null
}

/** Receiving status for the company: transport, access grant, eligibility and the registration row. */
export async function getPeppolRegistrationStatus(
  ctx: OperationContext,
  options: DoorOptions = {},
): Promise<OperationOutcome<PeppolRegistrationStatus>> {
  const { supabase, companyId } = ctx
  const service = options.service ?? supabase
  const availability = getPeppolTransportAvailability()
  const resolved = resolveTransport()
  try {
    const registration = resolved
      ? await getPeppolRegistration({ supabase, companyId, provider: resolved.provider })
      : null
    // Eligibility is answered up front so a company that cannot be
    // registered (personnummer, missing org number) sees why before it
    // asks the operators for a receiving slot.
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('org_number, company_name, vat_number, city, country')
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

  const resolved = resolveTransport()
  if (!resolved) return { ok: false, code: 'PEPPOL_TRANSPORT_UNAVAILABLE' }
  if (await isSandboxCompany(supabase, companyId)) return { ok: false, code: 'PEPPOL_SANDBOX_NOT_ALLOWED' }

  // Receiving consumes a contracted tenant slot: operators grant it per company.
  const access = await getPeppolAccess(service, companyId)
  if (!access || access.status !== 'enabled') return { ok: false, code: 'PEPPOL_ACCESS_REQUIRED' }
  if (!access.receive_enabled) return { ok: false, code: 'PEPPOL_RECEIVING_NOT_ENABLED' }

  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('org_number, company_name, vat_number, city, country')
    .eq('company_id', companyId)
    .single()
  if (settingsError || !settings) return { ok: false, code: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' }
  const participantSettings = settings as unknown as ParticipantSettings

  try {
    if (options.dryRun) return await previewRegistration(service, companyId, resolved, participantSettings)

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
  note: z.string().trim().max(1800).optional().describe('Free text for the operators (what the company needs Peppol for).'),
  /** The company also wants to receive (one of the contracted tenant slots). */
  wants_receiving: z.boolean().optional().describe('True when the company also wants to receive e-invoices (a receiving slot).'),
})

export type PeppolAccessRequestInput = z.infer<typeof PeppolAccessRequestSchema>

export interface PeppolAccessRequestResult {
  access: PeppolAccessSummary
  created: boolean
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The company asks the operators for Peppol access: writes the request row
 * (service role; nobody can grant themselves anything) and tells the
 * operators by e-mail. The e-mail is best-effort: the row is the source of
 * truth and the operators' script lists open requests. `requesterEmail` is
 * the reply-to address when the door knows it (the dashboard session).
 */
export async function requestPeppolAccessForCompany(
  ctx: OperationContext,
  input: PeppolAccessRequestInput,
  options: DoorOptions & { dryRun?: boolean; requesterEmail?: string | null } = {},
): Promise<OperationOutcome<PeppolAccessRequestResult>> {
  const { supabase, companyId, userId } = ctx
  const service = options.service ?? supabase
  const wantsReceiving = input.wants_receiving === true
  const userNote = input.note?.trim() || null
  // The receiving wish travels in the request note so the operators see it
  // in `access.ts list` and in the mail, and grant it with --receive.
  const note = [wantsReceiving ? '[vill ta emot e-fakturor]' : null, userNote]
    .filter((part): part is string => !!part)
    .join(' ') || null

  if (await isSandboxCompany(supabase, companyId)) return { ok: false, code: 'PEPPOL_SANDBOX_NOT_ALLOWED' }

  try {
    if (options.dryRun) {
      const existing = await getPeppolAccess(service, companyId)
      if (existing?.status === 'enabled') return { ok: false, code: 'PEPPOL_ACCESS_ALREADY_ENABLED' }
      return {
        ok: true,
        dryRun: true,
        preview: {
          current_status: existing?.status ?? 'none',
          would_create_request: existing?.status !== 'requested',
          wants_receiving: wantsReceiving,
          note,
          // The operators are told by e-mail on commit, and only for a new request.
          notifies_operators: existing?.status !== 'requested',
        },
      }
    }

    const result = await requestPeppolAccess({ service, companyId, userId, note })
    if (!result.ok) return { ok: false, code: result.code }
    if (result.created) await notifyOperators(ctx, { note, wantsReceiving, requesterEmail: options.requesterEmail ?? null })

    const summary = await getPeppolAccessSummary({ supabase: service, service, companyId })
    return { ok: true, created: result.created, data: { access: summary, created: result.created } }
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', error: err }
  }
}

async function notifyOperators(
  ctx: OperationContext,
  args: { note: string | null; wantsReceiving: boolean; requesterEmail: string | null },
): Promise<void> {
  const { supabase, companyId, userId, log } = ctx
  const { note, wantsReceiving, requesterEmail } = args
  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('company_name, org_number, vat_number, city, country')
    .eq('company_id', companyId)
    .maybeSingle()
  // The request is already recorded; a failed settings read must not
  // masquerade as "no organisation number" in the operator mail.
  if (companyError) log.error('peppol access request: company settings read failed', { companyId, reason: companyError.message })
  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('peppol access request: e-mail service not configured, request recorded only', { companyId })
    return
  }
  const companyName = (company as { company_name?: string | null } | null)?.company_name ?? 'okänt bolag'
  const orgNumber = (company as { org_number?: string | null } | null)?.org_number ?? 'saknas'
  // Whether a receiving grant could be used at all (#2483): a
  // personnummer-based company cannot publish a Peppol id.
  const eligibility = companyError
    ? null
    : company
      ? describePeppolParticipantEligibility(company as unknown as ParticipantSettings)
      : { ok: false as const, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' as const }
  const eligibilityLine = eligibility === null
    ? 'okänd (bolagsinställningarna kunde inte läsas)'
    : eligibility.ok ? 'ja' : `nej (${eligibility.code})`
  const requester = requesterEmail ?? ''
  const enableCommand = `npx tsx --env-file=.env.local scripts/peppol/access.ts enable ${companyId} --max-sends 10${wantsReceiving ? ' --receive' : ''}`
  const sent = await emailService.sendEmail({
    to: getSupportRecipientEmail(),
    subject: `[${getBranding().appName.toLowerCase()} peppol] Åtkomstbegäran${wantsReceiving ? ' (+ mottagning)' : ''}: ${companyName}`,
    ...(requesterEmail ? { replyTo: requesterEmail } : {}),
    html: [
      `<p><strong>Bolag:</strong> ${escapeHtml(companyName)} (${escapeHtml(orgNumber)})</p>`,
      `<p><strong>Company ID:</strong> ${companyId}</p>`,
      `<p><strong>Begärd av:</strong> ${escapeHtml(requester)} (${userId})</p>`,
      `<p><strong>Kan registreras för mottagning:</strong> ${escapeHtml(eligibilityLine)}</p>`,
      note ? `<hr /><p>${escapeHtml(note).replace(/\n/g, '<br />')}</p>` : '',
      `<hr /><p>Aktivera: <code>${enableCommand}</code></p>`,
    ].join('\n'),
    text: `Bolag: ${companyName} (${orgNumber})\nCompany ID: ${companyId}\nBegärd av: ${requester} (${userId})\nKan registreras för mottagning: ${eligibilityLine}\n\n${note ?? ''}\n\nAktivera: ${enableCommand}`,
  })
  if (!sent.success) log.warn('peppol access request e-mail failed', { companyId, reason: sent.error })
}
