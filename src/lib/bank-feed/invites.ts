/**
 * The signatory link: a company admin, or the byrå member acting for the
 * company, sends the firmatecknare a signed, expiring link. The
 * firmatecknare opens /koppla/<token> without an Accounted login and runs the
 * bank consent for that company through Open Payments (BankID), optionally
 * followed by the payments verification form.
 *
 * The token IS the authentication on the public surface, so it is treated as
 * a credential: 32 random bytes, sha256-hashed at rest (the clear token exists
 * only in the URL and the mail that carried it), valid 7 days, consumed when
 * the accounts are selected. The public routes read the row with the service
 * role and act as the person who sent the link (bank_connections.user_id);
 * the personnummer the firmatecknare types goes to the bank and is never
 * stored.
 */

import { createHash, randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregatorOf } from '@/lib/bank-sync/aggregator'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendBankConnectInviteMail } from '@/lib/email/send-bank-connect-invite'
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { createServiceClient } from '@/lib/supabase/server'

export const BANK_CONNECT_INVITE_TTL_DAYS = 7

/**
 * Selecting the accounts consumes the link, but the same sitting still has
 * calls to make: Svea's second consent, the first sync, the verification
 * form. Those follow-up routes keep answering for this long after consumption.
 */
export const CONSUMED_INVITE_GRACE_MS = 2 * 60 * 60 * 1000

// 32 bytes base64url = 43 chars, alphabet [A-Za-z0-9_-].
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export interface BankConnectInviteRow {
  id: string
  company_id: string
  created_by: string
  bic: string | null
  replace_connection_id: string | null
  offer_payments: boolean
  recipient_email: string | null
  mail_sent_at: string | null
  expires_at: string
  consumed_at: string | null
  connection_id: string | null
  created_at: string
}

const INVITE_COLUMNS = 'id, company_id, created_by, bic, replace_connection_id, offer_payments, recipient_email, mail_sent_at, expires_at, consumed_at, connection_id, created_at'

export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashInviteToken(token) }
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isValidInviteTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token)
}

/** The URL the firmatecknare opens: `<base>/koppla/<token>`. */
export function signatoryLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/koppla/${token}`
}

export function inviteExpiresAt(now: number = Date.now()): string {
  return new Date(now + BANK_CONNECT_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export interface CreateSignatoryLinkInput {
  companyId: string
  /** The person sending the link; the consent is made in their name. */
  createdBy: string
  /** The bank, when the sender knows it; null lets the firmatecknare pick. */
  bic?: string | null
  /** The connection the new one takes over from (a switch from Enable Banking, or a renewal). */
  replaceConnectionId?: string | null
  /** Offer the payments verification (know your customer) after the consent, when the company may pay through the bank. */
  offerPayments: boolean
  recipientEmail?: string | null
  /**
   * The client to write with. A session route passes its RLS client so the
   * owner/admin policy is the second gate; the operations' doors and the
   * switch-campaign mail pass nothing and write as the service role after
   * their own admin check.
   */
  supabase?: SupabaseClient
  now?: number
}

export interface SignatoryLink {
  invite_id: string
  url: string
  /** The clear token. Only the URL and the mail carry it; never store or log it. */
  token: string
  expires_at: string
}

/**
 * Create a signatory link for a company. The connection a switch or a renewal
 * replaces must be one of the company's; the URL base is the brand of the
 * company (its byrå's domain when it has one, else the canonical app URL).
 */
interface ReplacedConnection {
  id: string
  status: string
  bank_name: string | null
  aggregator?: string | null
}

/** The company's live connection a link replaces, or the NOT_FOUND the mint and its preview both answer. */
async function findReplacedConnection(
  supabase: SupabaseClient,
  companyId: string,
  connectionId: string,
): Promise<ReplacedConnection | Extract<OperationOutcome<never>, { ok: false }>> {
  const { data, error } = await supabase
    .from('bank_connections')
    .select('id, status, bank_name, aggregator')
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const replaced = data as ReplacedConnection | null
  if (!replaced || replaced.status === 'revoked') return { ok: false, code: 'NOT_FOUND', details: { field: 'replace_connection_id' } }
  return replaced
}

export async function createSignatoryLink(input: CreateSignatoryLinkInput): Promise<OperationOutcome<SignatoryLink>> {
  const supabase = input.supabase ?? createServiceClient()
  if (input.replaceConnectionId) {
    const replaced = await findReplacedConnection(supabase, input.companyId, input.replaceConnectionId)
    if ('ok' in replaced) return replaced
  }
  const { token, hash } = generateInviteToken()
  const expiresAt = inviteExpiresAt(input.now)
  const { data, error } = await supabase
    .from('bank_connect_invites')
    .insert({
      company_id: input.companyId,
      created_by: input.createdBy,
      token_hash: hash,
      bic: input.bic?.toUpperCase() ?? null,
      replace_connection_id: input.replaceConnectionId ?? null,
      offer_payments: input.offerPayments,
      recipient_email: input.recipientEmail?.trim().toLowerCase() || null,
      expires_at: expiresAt,
    })
    .select('id')
    .single()
  if (error || !data) return { ok: false, code: 'INTERNAL_ERROR', error: error ?? new Error('Signatory link not stored') }
  const baseUrl = await getBaseUrlForCompany(input.companyId)
  return { ok: true, data: { invite_id: (data as { id: string }).id, url: signatoryLinkUrl(baseUrl, token), token, expires_at: expiresAt } }
}

export interface IssueSignatoryLinkInput {
  bic?: string | null
  replaceConnectionId?: string | null
  offerPayments: boolean
  recipientEmail?: string | null
  /** The bank as the sender's screen names it, for the mail only; the link itself carries the BIC. */
  bankName?: string | null
}

export interface IssuedSignatoryLink {
  invite_id: string
  url: string
  expires_at: string
  /** True when a recipient was given and the mail went out. */
  email_sent: boolean
}

/**
 * Create a signatory link for the company in the context and, when a
 * recipient is given, mail it: the one path behind the session route, the
 * operation and the switch campaign's mail. Owners and admins only: the
 * session door asks through withRouteContext's requireAdmin and the RLS
 * policy, a service-role door through `checkAdmin`.
 */
export async function issueSignatoryLink(
  ctx: OperationContext,
  input: IssueSignatoryLinkInput,
  options: { checkAdmin: boolean } = { checkAdmin: true },
): Promise<OperationOutcome<IssuedSignatoryLink>> {
  if (options.checkAdmin) {
    const refused = await requireCompanyAdmin(ctx, 'Bara företagets ägare eller en administratör kan skicka en länk till firmatecknaren.')
    if (refused) return refused
  }
  const created = await createSignatoryLink({
    companyId: ctx.companyId,
    createdBy: ctx.userId,
    bic: input.bic ?? null,
    replaceConnectionId: input.replaceConnectionId ?? null,
    offerPayments: input.offerPayments,
    recipientEmail: input.recipientEmail ?? null,
    supabase: ctx.supabase,
  })
  if (!created.ok) return created
  if (created.dryRun) return created
  const link = created.data
  let emailSent = false
  const recipient = input.recipientEmail?.trim()
  if (recipient) {
    const service = createServiceClient()
    const description = await describeInvite(service, { company_id: ctx.companyId, created_by: ctx.userId, replace_connection_id: input.replaceConnectionId ?? null })
    const sent = await sendBankConnectInviteMail({
      companyId: ctx.companyId,
      companyName: description.companyName,
      requester: description.requester,
      bankName: input.bankName?.trim() || description.replaced?.bank_name || null,
      email: recipient,
      url: link.url,
      offerPayments: input.offerPayments,
      log: ctx.log,
    })
    emailSent = sent.emailSent
    if (emailSent) await markInviteMailed(service, link.invite_id).catch((error) => ctx.log.warn('signatory link mail not logged on the row', { message: error instanceof Error ? error.message : String(error) }))
  }
  return { ok: true, data: { invite_id: link.invite_id, url: link.url, expires_at: link.expires_at, email_sent: emailSent }, created: true }
}

/**
 * What issueSignatoryLink would do, with every rule it applies (owner or
 * admin, the replaced connection one of the company's and live) and nothing
 * minted: the staging preview an approver reads, and the ?dry_run=true answer.
 * The URL is the credential, so it exists only after the real call.
 */
export async function previewSignatoryLink(ctx: OperationContext, input: IssueSignatoryLinkInput): Promise<OperationOutcome<never>> {
  const refused = await requireCompanyAdmin(ctx, 'Bara företagets ägare eller en administratör kan skicka en länk till firmatecknaren.')
  if (refused) return refused
  let replaces: { connection_id: string; bank_name: string | null; aggregator: 'enable_banking' | 'open_payments'; kind: 'switch' | 'renewal' } | null = null
  if (input.replaceConnectionId) {
    const replaced = await findReplacedConnection(ctx.supabase, ctx.companyId, input.replaceConnectionId)
    if ('ok' in replaced) return replaced
    const aggregator = aggregatorOf(replaced)
    replaces = { connection_id: replaced.id, bank_name: replaced.bank_name, aggregator, kind: aggregator === 'open_payments' ? 'renewal' : 'switch' }
  }
  const recipient = input.recipientEmail?.trim().toLowerCase() || null
  return {
    ok: true,
    dryRun: true,
    preview: {
      bic: input.bic?.toUpperCase() ?? null,
      bank_name: input.bankName?.trim() || replaces?.bank_name || null,
      replaces,
      recipient_email: recipient,
      email_will_be_sent: recipient !== null,
      offer_payments: input.offerPayments,
      valid_days: BANK_CONNECT_INVITE_TTL_DAYS,
      url: null,
    },
  }
}

export type ResolveInviteResult =
  | { ok: true; invite: BankConnectInviteRow }
  | { ok: false; reason: 'invalid_format' | 'not_found' | 'expired' | 'consumed' }

/**
 * Resolve a clear token from the public surface (service-role client; the
 * code is the only guard: strict hash equality, then expiry and consumption).
 * `allowConsumedWithinMs` lets the follow-up routes of the sitting that
 * consumed the link keep working. Never log the token.
 */
export async function resolveInviteToken(
  service: SupabaseClient,
  token: string,
  options: { allowConsumedWithinMs?: number; now?: number } = {},
): Promise<ResolveInviteResult> {
  if (!isValidInviteTokenFormat(token)) return { ok: false, reason: 'invalid_format' }
  const { data } = await service.from('bank_connect_invites').select(INVITE_COLUMNS).eq('token_hash', hashInviteToken(token)).maybeSingle()
  const invite = (data as BankConnectInviteRow | null) ?? null
  if (!invite) return { ok: false, reason: 'not_found' }
  const now = options.now ?? Date.now()
  if (new Date(invite.expires_at).getTime() <= now) return { ok: false, reason: 'expired' }
  if (invite.consumed_at) {
    const grace = options.allowConsumedWithinMs ?? 0
    if (grace <= 0 || new Date(invite.consumed_at).getTime() + grace <= now) return { ok: false, reason: 'consumed' }
  }
  return { ok: true, invite }
}

/** The accounts are selected: the link has done its work and names the connection it made. */
export async function consumeInvite(service: SupabaseClient, inviteId: string, connectionId: string, now: number = Date.now()): Promise<void> {
  const { error } = await service
    .from('bank_connect_invites')
    .update({ consumed_at: new Date(now).toISOString(), connection_id: connectionId })
    .eq('id', inviteId)
    .is('consumed_at', null)
  if (error) throw error
}

/** The link went out by mail: the row records when. */
export async function markInviteMailed(service: SupabaseClient, inviteId: string, now: number = Date.now()): Promise<void> {
  const { error } = await service.from('bank_connect_invites').update({ mail_sent_at: new Date(now).toISOString() }).eq('id', inviteId)
  if (error) throw error
}

export interface InviteDescription {
  companyName: string
  /** Who asked: the byrå's name when the sender acts through the company's team, else the company's own name. */
  requester: string
  /** The connection the link replaces, when it does: its bank and whether it is an Enable Banking row (a switch) or an Open Payments one (a renewal). */
  replaced: { connection_id: string; bank_name: string | null; bic: string | null; kind: 'switch' | 'renew' } | null
}

/** What the public page (and the mail) say about a link: the company, who asked and the bank being replaced. */
export async function describeInvite(
  service: SupabaseClient,
  invite: Pick<BankConnectInviteRow, 'company_id' | 'created_by' | 'replace_connection_id'>,
): Promise<InviteDescription> {
  const { data: companyRow } = await service.from('companies').select('name, team_id').eq('id', invite.company_id).maybeSingle()
  const company = (companyRow as { name: string | null; team_id: string | null } | null) ?? null
  const companyName = company?.name?.trim() || 'Företaget'

  let requester = companyName
  if (company?.team_id) {
    const { data: membership } = await service
      .from('team_members')
      .select('team_id, teams(name)')
      .eq('team_id', company.team_id)
      .eq('user_id', invite.created_by)
      .maybeSingle()
    const team = (membership as { teams?: { name?: string | null } | { name?: string | null }[] | null } | null)?.teams
    const teamName = (Array.isArray(team) ? team[0]?.name : team?.name)?.trim()
    if (teamName) requester = teamName
  }

  let replaced: InviteDescription['replaced'] = null
  if (invite.replace_connection_id) {
    const { data: row } = await service
      .from('bank_connections')
      .select('id, bank_name, bic, aggregator, provider, status')
      .eq('id', invite.replace_connection_id)
      .eq('company_id', invite.company_id)
      .maybeSingle()
    const connection = row as { id: string; bank_name: string | null; bic: string | null; aggregator?: string | null; provider?: string | null; status: string } | null
    if (connection && connection.status !== 'revoked') {
      replaced = {
        connection_id: connection.id,
        bank_name: connection.bank_name,
        bic: connection.bic,
        kind: aggregatorOf(connection) === 'open_payments' ? 'renew' : 'switch',
      }
    }
  }
  return { companyName, requester, replaced }
}
