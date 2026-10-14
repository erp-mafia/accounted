/**
 * The payment signing link ("Be någon annan signera"): the person who
 * prepared and approved bank payments, a byrå member, an admin or an agent
 * whose request a person approved, sends the company's firmatecknare a
 * signed, expiring link. The firmatecknare opens /betala/<token> without an
 * Accounted login, sees the basket and signs it with BankID.
 *
 * The posture of the signatory link for a bank consent
 * (lib/bank-feed/invites.ts, /koppla/<token>), reused rather than invented
 * again: the token IS the authentication on the public surface, so it is a
 * credential (32 random bytes, sha256-hashed at rest, the clear token only in
 * the URL and the mail), valid PAYMENT_SIGNING_LINK_TTL_HOURS, consumed when
 * the signing finalises. The token routes read the row with the service role
 * and run the SAME signing functions as the session routes
 * (lib/payments/orders/signing.ts), acting as the person who sent the link
 * for the company of the link; the personnummer the firmatecknare types goes
 * to the bank, is never stored, and the sender's own number on file never
 * names the signer's BankID (lookupOnFile false).
 *
 * A link covers exactly the orders it names, all approved, from one account
 * and in one currency when it was made. If any of them leaves 'approved' by
 * another way (cancelled, signed elsewhere, un-approved) the page says so and
 * nothing is signed: the claim under lock in claim_payment_orders_for_signing
 * is the last word, linkState() the page's first.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { describeInvite, generateInviteToken, hashInviteToken, isValidInviteTokenFormat } from '@/lib/bank-feed/invites'
import { getCompanyRole } from '@/lib/auth/require-write'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendPaymentSigningRequestMail } from '@/lib/email/send-payment-signing-request'
import { sumOre } from '@/lib/money'
import { COMPANY_ADMIN_ROLES } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { formatPayeeLabel } from '@/lib/payments/supplier-payee'
import { createServiceClient } from '@/lib/supabase/server'
import type { DebtorSnapshot } from './debtor'
import type { PaymentOrderStatus } from './status'
import { openPaymentsDoor } from './switched-on'
import type { PaymentOrderBatchRow, PaymentOrderRow } from './types'

export const PAYMENT_SIGNING_LINK_TTL_HOURS = 72

/**
 * Finalising the signing consumes the link, but the same sitting still reads
 * the basket and the last poll: those keep answering for this long after.
 */
export const CONSUMED_SIGNING_LINK_GRACE_MS = 60 * 60 * 1000

export const SIGNING_LINK_NOTE_MAX = 500

/** The page of a link: `/betala/<token>`; also where a signing on the bank's own page comes back. */
export function signingLinkPath(token: string): string {
  return `/betala/${encodeURIComponent(token)}`
}

export function signingLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${signingLinkPath(token)}`
}

export function signingLinkExpiresAt(now: number = Date.now()): string {
  return new Date(now + PAYMENT_SIGNING_LINK_TTL_HOURS * 60 * 60 * 1000).toISOString()
}

export interface PaymentSigningLinkRow {
  id: string
  company_id: string
  created_by: string
  recipient_email: string | null
  note: string | null
  order_ids: string[]
  total_amount: number
  currency: string
  expires_at: string
  mail_sent_at: string | null
  batch_id: string | null
  consumed_at: string | null
  cancelled_at: string | null
  created_at: string
}

/** Named columns, never token_hash (the browser session has no grant for it either). */
const LINK_COLUMNS = 'id, company_id, created_by, recipient_email, note, order_ids, total_amount, currency, expires_at, mail_sent_at, batch_id, consumed_at, cancelled_at, created_at'

type LinkOrderRow = Pick<
  PaymentOrderRow,
  | 'id'
  | 'user_id'
  | 'status'
  | 'batch_id'
  | 'amount'
  | 'currency'
  | 'cash_account_id'
  | 'requested_execution_date'
  | 'payee_type'
  | 'payee_bankgiro'
  | 'payee_plusgiro'
  | 'payee_clearing'
  | 'payee_account'
  | 'payee_iban'
  | 'payee_name'
  | 'reference_type'
  | 'reference'
  | 'outcome_unknown_at'
  | 'created_at'
> & { debtor_snapshot: Partial<DebtorSnapshot> | null }

const ORDER_COLUMNS =
  'id, user_id, status, batch_id, amount, currency, cash_account_id, requested_execution_date, payee_type, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban, payee_name, reference_type, reference, outcome_unknown_at, created_at, debtor_snapshot'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

async function loadLinkOrders(supabase: SupabaseClient, companyId: string, ids: readonly string[]): Promise<LinkOrderRow[]> {
  const { data, error } = await supabase
    .from('payment_orders')
    .select(ORDER_COLUMNS)
    .eq('company_id', companyId)
    .in('id', [...ids])
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as LinkOrderRow[]
}

/**
 * Who may send a link: an owner or an admin, or the person who prepared every
 * order in it. A viewer never; another member only for their own orders.
 */
async function senderRefusal(ctx: OperationContext, orders: readonly Pick<LinkOrderRow, 'user_id'>[]): Promise<Failure | null> {
  const role = await getCompanyRole(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  if (role.ok && (COMPANY_ADMIN_ROLES as readonly string[]).includes(role.role)) return null
  if (role.ok && role.role !== 'viewer' && orders.length > 0 && orders.every((o) => o.user_id === ctx.userId)) return null
  return {
    ok: false,
    code: 'FORBIDDEN',
    messageSv: 'Bara företagets ägare, en administratör eller den som förberedde betalningarna kan be någon annan signera dem.',
    details: { required_roles: [...COMPANY_ADMIN_ROLES], or: 'preparer_of_every_order' },
  }
}

/** The open links of the company that cover any of these orders. */
async function openLinksCovering(supabase: SupabaseClient, companyId: string, ids: readonly string[], now: number): Promise<Array<{ id: string }>> {
  const { data, error } = await supabase
    .from('payment_signing_links')
    .select('id')
    .eq('company_id', companyId)
    .is('consumed_at', null)
    .is('cancelled_at', null)
    .gt('expires_at', new Date(now).toISOString())
    .overlaps('order_ids', [...ids])
  if (error) throw error
  return (data ?? []) as Array<{ id: string }>
}

export interface IssuePaymentSigningLinkInput {
  orderIds: string[]
  recipientEmail?: string | null
  note?: string | null
  now?: number
}

export interface IssuedPaymentSigningLink {
  signing_link_id: string
  url: string
  expires_at: string
  /** True when a recipient was given and the mail went out. */
  email_sent: boolean
  order_count: number
  total_amount: number
  currency: string
}

interface CheckedBasket {
  ids: string[]
  orders: LinkOrderRow[]
  total: number
  currency: string
}

/**
 * Every rule a link is made under, shared by the mint and its dry run:
 * bank payments switched on, the orders the company's, the sender allowed,
 * every order approved and from one account in one currency, no other open
 * link over any of them.
 */
async function checkBasket(ctx: OperationContext, input: IssuePaymentSigningLinkInput): Promise<{ ok: true; basket: CheckedBasket } | Failure> {
  const ids = [...new Set(input.orderIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  if (ids.length > 100) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'payment_order_ids', max: 100 } }
  if ((input.note ?? '').trim().length > SIGNING_LINK_NOTE_MAX) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'note', max: SIGNING_LINK_NOTE_MAX } }
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }

  const orders = await loadLinkOrders(ctx.supabase, ctx.companyId, ids)
  if (orders.length !== ids.length) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const refused = await senderRefusal(ctx, orders)
  if (refused) return refused
  const notApproved = orders.filter((o) => o.status !== 'approved' || o.outcome_unknown_at)
  if (notApproved.length > 0) {
    return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { orders: notApproved.map((o) => ({ id: o.id, status: o.status })) } }
  }
  if (new Set(orders.map((o) => o.cash_account_id)).size > 1) return { ok: false, code: 'PAYMENT_ORDERS_MIXED_ACCOUNTS' }
  if (new Set(orders.map((o) => o.currency)).size > 1) return { ok: false, code: 'PAYMENT_ORDERS_MIXED_CURRENCY' }
  const open = await openLinksCovering(ctx.supabase, ctx.companyId, ids, input.now ?? Date.now())
  if (open.length > 0) return { ok: false, code: 'PAYMENT_SIGNING_LINK_ALREADY_OPEN', details: { signing_link_ids: open.map((l) => l.id) } }
  return {
    ok: true,
    basket: { ids, orders, total: sumOre(orders.map((o) => Number(o.amount))), currency: orders[0]!.currency },
  }
}

function normalizedEmail(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null
}

function normalizedNote(value: string | null | undefined): string | null {
  return value?.trim() || null
}

/**
 * Create a signing link for approved orders and, when a recipient is given,
 * mail it: the one path behind the session route, the v1 door and the
 * approval of an agent's request. The row is written by the service role
 * after the rules above; the URL base is the brand of the company.
 */
export async function issuePaymentSigningLink(ctx: OperationContext, input: IssuePaymentSigningLinkInput): Promise<OperationOutcome<IssuedPaymentSigningLink>> {
  const checked = await checkBasket(ctx, input)
  if (!checked.ok) return checked
  const { basket } = checked
  const service = createServiceClient()
  const { token, hash } = generateInviteToken()
  const expiresAt = signingLinkExpiresAt(input.now)
  const recipient = normalizedEmail(input.recipientEmail)
  const note = normalizedNote(input.note)
  const { data, error } = await service
    .from('payment_signing_links')
    .insert({
      company_id: ctx.companyId,
      created_by: ctx.userId,
      token_hash: hash,
      recipient_email: recipient,
      note,
      order_ids: basket.ids,
      total_amount: basket.total,
      currency: basket.currency,
      expires_at: expiresAt,
    })
    .select('id')
    .single()
  if (error || !data) return { ok: false, code: 'INTERNAL_ERROR', error: error ?? new Error('Signing link not stored') }
  const linkId = (data as { id: string }).id
  const url = signingLinkUrl(await getBaseUrlForCompany(ctx.companyId), token)

  let emailSent = false
  if (recipient) {
    const sender = await describeSender(service, { company_id: ctx.companyId, created_by: ctx.userId })
    const sent = await sendPaymentSigningRequestMail({
      companyId: ctx.companyId,
      companyName: sender.companyName,
      requester: sender.requester,
      orderCount: basket.orders.length,
      totalAmount: basket.total,
      currency: basket.currency,
      email: recipient,
      url,
      expiresAt,
      note,
      log: ctx.log,
    })
    emailSent = sent.emailSent
    if (emailSent) {
      await markSigningLinkMailed(service, linkId).catch((err) =>
        ctx.log.warn('payment signing link mail not logged on the row', { message: err instanceof Error ? err.message : String(err) }),
      )
    }
  }
  return {
    ok: true,
    created: true,
    data: { signing_link_id: linkId, url, expires_at: expiresAt, email_sent: emailSent, order_count: basket.orders.length, total_amount: basket.total, currency: basket.currency },
  }
}

/**
 * What issuePaymentSigningLink would do, with every rule it applies and
 * nothing minted: the staging preview an approver reads and the
 * ?dry_run=true answer. The URL is the credential, so it exists only after
 * the real call.
 */
export async function previewPaymentSigningLink(ctx: OperationContext, input: IssuePaymentSigningLinkInput): Promise<OperationOutcome<never>> {
  const checked = await checkBasket(ctx, input)
  if (!checked.ok) return checked
  const { basket } = checked
  const recipient = normalizedEmail(input.recipientEmail)
  return {
    ok: true,
    dryRun: true,
    preview: {
      payment_order_ids: basket.ids,
      order_count: basket.orders.length,
      total_amount: basket.total,
      currency: basket.currency,
      payees: basket.orders.map((o) => o.payee_name),
      recipient_email: recipient,
      email_will_be_sent: recipient !== null,
      note: normalizedNote(input.note),
      valid_hours: PAYMENT_SIGNING_LINK_TTL_HOURS,
      url: null,
    },
  }
}

export type ResolveSigningLinkResult =
  | { ok: true; link: PaymentSigningLinkRow }
  | { ok: false; reason: 'invalid_format' | 'not_found' | 'expired' | 'consumed' | 'cancelled' }

/**
 * Resolve a clear token from the public surface (service-role client; the
 * code is the only guard: strict hash equality, then cancellation,
 * consumption and expiry). `allowConsumedWithinMs` lets the follow-up calls
 * of the sitting that consumed the link keep answering. Never log the token.
 */
export async function resolvePaymentSigningLink(
  service: SupabaseClient,
  token: string,
  options: { allowConsumedWithinMs?: number; now?: number } = {},
): Promise<ResolveSigningLinkResult> {
  if (!isValidInviteTokenFormat(token)) return { ok: false, reason: 'invalid_format' }
  const { data } = await service.from('payment_signing_links').select(LINK_COLUMNS).eq('token_hash', hashInviteToken(token)).maybeSingle()
  const link = (data as PaymentSigningLinkRow | null) ?? null
  if (!link) return { ok: false, reason: 'not_found' }
  const now = options.now ?? Date.now()
  if (link.cancelled_at) return { ok: false, reason: 'cancelled' }
  if (link.consumed_at) {
    const grace = options.allowConsumedWithinMs ?? 0
    if (grace > 0 && new Date(link.consumed_at).getTime() + grace > now) return { ok: true, link }
    return { ok: false, reason: 'consumed' }
  }
  if (new Date(link.expires_at).getTime() <= now) return { ok: false, reason: 'expired' }
  return { ok: true, link }
}

/** The signing the link started at the bank (a restart may move the payments to a new one). */
export async function recordSigningLinkBatch(service: SupabaseClient, linkId: string, batchId: string): Promise<void> {
  const { error } = await service.from('payment_signing_links').update({ batch_id: batchId }).eq('id', linkId).is('consumed_at', null).is('cancelled_at', null)
  if (error) throw error
}

/** The signing finalised: the link has done its work. */
export async function consumePaymentSigningLink(service: SupabaseClient, linkId: string, now: number = Date.now()): Promise<void> {
  const { error } = await service
    .from('payment_signing_links')
    .update({ consumed_at: new Date(now).toISOString() })
    .eq('id', linkId)
    .is('consumed_at', null)
    .is('cancelled_at', null)
  if (error) throw error
}

export async function markSigningLinkMailed(service: SupabaseClient, linkId: string, now: number = Date.now()): Promise<void> {
  const { error } = await service.from('payment_signing_links').update({ mail_sent_at: new Date(now).toISOString() }).eq('id', linkId)
  if (error) throw error
}

/**
 * Cancel an open link: owners, admins and the person who sent it. Cancelling
 * twice answers the same; a consumed link cannot be cancelled (the signing
 * happened). A BankID signing already running from the link is not stopped
 * at the bank: the orders stay where the bank leaves them, as on Betalningar.
 */
export async function cancelPaymentSigningLink(
  ctx: OperationContext,
  input: { signingLinkId: string; now?: number },
): Promise<OperationOutcome<{ signing_link_id: string; cancelled: true }>> {
  const { data, error } = await ctx.supabase
    .from('payment_signing_links')
    .select(LINK_COLUMNS)
    .eq('company_id', ctx.companyId)
    .eq('id', input.signingLinkId)
    .maybeSingle()
  if (error) throw error
  const link = data as PaymentSigningLinkRow | null
  if (!link) return { ok: false, code: 'PAYMENT_SIGNING_LINK_NOT_FOUND' }
  if (link.created_by !== ctx.userId) {
    const role = await getCompanyRole(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
    if (!role.ok || !(COMPANY_ADMIN_ROLES as readonly string[]).includes(role.role)) {
      return { ok: false, code: 'FORBIDDEN', messageSv: 'Bara den som skickade länken, företagets ägare eller en administratör kan avbryta den.' }
    }
  }
  if (link.cancelled_at) return { ok: true, data: { signing_link_id: link.id, cancelled: true } }
  if (link.consumed_at) return { ok: false, code: 'PAYMENT_SIGNING_LINK_NOT_OPEN' }
  const { data: updated, error: updateError } = await createServiceClient()
    .from('payment_signing_links')
    .update({ cancelled_at: new Date(input.now ?? Date.now()).toISOString() })
    .eq('id', link.id)
    .eq('company_id', ctx.companyId)
    .is('consumed_at', null)
    .is('cancelled_at', null)
    .select('id')
  if (updateError) throw updateError
  if ((updated ?? []).length !== 1) return { ok: false, code: 'PAYMENT_SIGNING_LINK_NOT_OPEN' }
  return { ok: true, data: { signing_link_id: link.id, cancelled: true } }
}

export interface OpenSigningLink {
  signing_link_id: string
  recipient_email: string | null
  payment_order_ids: string[]
  expires_at: string
  created_by: string
  created_at: string
  email_sent: boolean
}

/** The company's links still open (not consumed, cancelled or expired): what the Betalningar rows show. */
export async function listOpenPaymentSigningLinks(ctx: Pick<OperationContext, 'supabase' | 'companyId'>, now: number = Date.now()): Promise<OpenSigningLink[]> {
  const { data, error } = await ctx.supabase
    .from('payment_signing_links')
    .select('id, recipient_email, order_ids, expires_at, created_by, created_at, mail_sent_at')
    .eq('company_id', ctx.companyId)
    .is('consumed_at', null)
    .is('cancelled_at', null)
    .gt('expires_at', new Date(now).toISOString())
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return ((data ?? []) as Array<Pick<PaymentSigningLinkRow, 'id' | 'recipient_email' | 'order_ids' | 'expires_at' | 'created_by' | 'created_at' | 'mail_sent_at'>>).map((row) => ({
    signing_link_id: row.id,
    recipient_email: row.recipient_email,
    payment_order_ids: row.order_ids,
    expires_at: row.expires_at,
    created_by: row.created_by,
    created_at: row.created_at,
    email_sent: row.mail_sent_at !== null,
  }))
}

// ---------------------------------------------------------------------------
// The public page
// ---------------------------------------------------------------------------

/**
 * Where the basket of a link stands, for the page and the start route:
 *   ready:      every order approved, nothing at the bank: sign.
 *   in_signing: the link started a signing and every order is still in it,
 *               unsigned: resume it (poll, or BankID again).
 *   done:       the link's signing finalised (or every order moved past it).
 *   changed:    an order left 'approved' another way (cancelled, signed or
 *               un-approved elsewhere): nothing is signed here.
 */
export type SigningLinkState = 'ready' | 'in_signing' | 'done' | 'changed'

const WAITING_AT_BANK: ReadonlySet<PaymentOrderStatus> = new Set(['submitted', 'awaiting_signature'])
const PAST_SIGNING: ReadonlySet<PaymentOrderStatus> = new Set(['awaiting_second_signer', 'accepted', 'executed', 'rejected'])

export function linkState(
  link: Pick<PaymentSigningLinkRow, 'order_ids' | 'batch_id' | 'consumed_at'>,
  orders: ReadonlyArray<Pick<LinkOrderRow, 'id' | 'status' | 'batch_id'>>,
  batch: Pick<PaymentOrderBatchRow, 'id' | 'status'> | null,
): SigningLinkState {
  if (link.consumed_at) return 'done'
  if (orders.length !== new Set(link.order_ids).size) return 'changed'
  if (orders.every((o) => o.status === 'approved')) return 'ready'
  const inLinkBatch = link.batch_id !== null && orders.every((o) => o.batch_id === link.batch_id)
  if (inLinkBatch && batch && (batch.status === 'created' || batch.status === 'awaiting_signature') && orders.every((o) => WAITING_AT_BANK.has(o.status))) {
    return 'in_signing'
  }
  if (inLinkBatch && orders.every((o) => PAST_SIGNING.has(o.status))) return 'done'
  return 'changed'
}

export interface SigningLinkPageOrder {
  payment_order_id: string
  payee_name: string
  payee_label: string
  amount: number
  currency: string
  requested_execution_date: string
  reference_type: 'ocr' | 'message'
  reference: string
  status: PaymentOrderStatus
}

export interface SigningLinkPageData {
  state: SigningLinkState
  company_name: string
  /** Who asked: the byrå's name when the sender acts through the company's team, else the sender's name, else the company's. */
  requester: string
  note: string | null
  expires_at: string
  bank_name: string | null
  /** The paying account: its name and a masked IBAN, from the orders' debtor snapshot. */
  account: { name: string | null; iban: string | null }
  order_count: number
  total_amount: number
  currency: string
  orders: SigningLinkPageOrder[]
  /** The signing the link started, when it did: where it stands. */
  signing: { batch_id: string; status: PaymentOrderBatchRow['status'] } | null
}

function payeeLabelOf(order: LinkOrderRow): string {
  switch (order.payee_type) {
    case 'bankgiro':
      return order.payee_bankgiro ? formatPayeeLabel({ type: 'bankgiro', bankgiro: order.payee_bankgiro }) : ''
    case 'plusgiro':
      return order.payee_plusgiro ? formatPayeeLabel({ type: 'plusgiro', plusgiro: order.payee_plusgiro }) : ''
    case 'bank_account':
      return formatPayeeLabel({ type: 'bank_account', clearing: order.payee_clearing ?? '', account: order.payee_account ?? '' })
    case 'iban':
      return order.payee_iban ?? ''
  }
}

function maskedIban(iban: string | null | undefined): string | null {
  const compact = (iban ?? '').replace(/\s/g, '')
  if (!compact) return null
  return compact.length < 8 ? '****' : `${compact.slice(0, 4)} **** ${compact.slice(-4)}`
}

/** Who asked, for the page and the mail: the byrå, else the sender by name, else the company. */
export async function describeSender(
  service: SupabaseClient,
  link: Pick<PaymentSigningLinkRow, 'company_id' | 'created_by'>,
): Promise<{ companyName: string; requester: string }> {
  const described = await describeInvite(service, { company_id: link.company_id, created_by: link.created_by, replace_connection_id: null })
  if (described.requester !== described.companyName) return { companyName: described.companyName, requester: described.requester }
  const { data } = await service.from('profiles').select('full_name').eq('id', link.created_by).maybeSingle()
  const name = (data as { full_name?: string | null } | null)?.full_name?.trim()
  return { companyName: described.companyName, requester: name || described.companyName }
}

/** The orders of a link and the signing it started, read with the service role. */
export async function loadSigningLinkBasket(
  service: SupabaseClient,
  link: PaymentSigningLinkRow,
): Promise<{ orders: LinkOrderRow[]; batch: Pick<PaymentOrderBatchRow, 'id' | 'status'> | null; state: SigningLinkState }> {
  const orders = await loadLinkOrders(service, link.company_id, link.order_ids)
  let batch: Pick<PaymentOrderBatchRow, 'id' | 'status'> | null = null
  if (link.batch_id) {
    const { data } = await service.from('payment_order_batches').select('id, status').eq('id', link.batch_id).eq('company_id', link.company_id).maybeSingle()
    batch = (data as Pick<PaymentOrderBatchRow, 'id' | 'status'> | null) ?? null
  }
  return { orders, batch, state: linkState(link, orders, batch) }
}

/** What the page shows: the basket, who asked, the account paying and where the signing stands. */
export async function describePaymentSigningLink(service: SupabaseClient, link: PaymentSigningLinkRow): Promise<SigningLinkPageData> {
  const [basket, sender] = await Promise.all([loadSigningLinkBasket(service, link), describeSender(service, link)])
  const { orders, batch, state } = basket
  const debtor = orders[0]?.debtor_snapshot ?? null
  return {
    state,
    company_name: sender.companyName,
    requester: sender.requester,
    note: link.note,
    expires_at: link.expires_at,
    bank_name: debtor?.bank_name ?? null,
    account: { name: debtor?.name ?? null, iban: maskedIban(debtor?.iban) },
    order_count: link.order_ids.length,
    total_amount: Number(link.total_amount),
    currency: link.currency,
    orders: orders.map((o) => ({
      payment_order_id: o.id,
      payee_name: o.payee_name,
      payee_label: payeeLabelOf(o),
      amount: Number(o.amount),
      currency: o.currency,
      requested_execution_date: o.requested_execution_date,
      reference_type: o.reference_type,
      reference: o.reference,
      status: o.status,
    })),
    signing: batch ? { batch_id: batch.id, status: batch.status } : null,
  }
}

/**
 * Whether a signing (payment_order_batches.id) is this link's to poll or sign
 * again: the one the link recorded, or one whose payments are all the link's
 * (a restart moved them, and recording the new id failed). Anything else of
 * the company is not reachable through the link.
 */
export async function signingBelongsToLink(service: SupabaseClient, link: Pick<PaymentSigningLinkRow, 'company_id' | 'order_ids' | 'batch_id'>, batchId: string): Promise<boolean> {
  if (link.batch_id === batchId) return true
  const { data, error } = await service.from('payment_orders').select('id').eq('company_id', link.company_id).eq('batch_id', batchId)
  if (error) throw error
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  const own = new Set(link.order_ids)
  return ids.length > 0 && ids.every((id) => own.has(id))
}

/** The batch statuses after which the link has done its work: the BankID signing finalised. */
export const SIGNING_LINK_FINAL_BATCH_STATUSES: ReadonlySet<PaymentOrderBatchRow['status']> = new Set(['signed', 'awaiting_second_signer', 'rejected'])
