/**
 * The two jobs of the batched attest mail (crm#1569); the rules they apply
 * are attest-mail-plan.ts.
 *
 * The request job (every 5 minutes): a registration queues its invoice
 * (attest-notify.ts). Once a company has registered nothing new for 15
 * minutes, each attester gets ONE mail listing every queued invoice waiting
 * on them, with one link (attest-batches.ts) to a page where they approve
 * them all or reject one. An invoice nobody can attest under the current
 * rules is told to its registrant instead. The same job first tries again
 * what an earlier run did not get out (retryUnsentAttestMails).
 *
 * The follow-up job (daily, in the morning): an invoice that was asked for
 * and still waits is reminded 3 days before its due date and the day
 * before; when a due date passes after the ask without attest, or nobody can
 * attest it any more, the registrant is told once.
 *
 * Never twice, and tried again only when it certainly did not go:
 * - Each step is claimed before anything is sent (asked_at, reminded_*_at,
 *   *_told_at, each set only where it is still null).
 * - An attester's mail is one link row, stored leased in one insert with the
 *   rest of its round before anything is sent, then sent one attester at a
 *   time so one failure never skips the others. Each row is marked sent right
 *   before its mail is handed to the provider, so a run that dies mid-send or
 *   a reply that is lost or late never leads to a second mail. Only a
 *   definite refusal clears the mark, and a later request run tries the same
 *   row again with a fresh token (one conditional update), at most 6 times
 *   within a day. A run that dies before it took a row leaves a lease that
 *   lapses after 15 minutes.
 * - A registrant notice that was refused is released for the next daily run;
 *   one that may have gone out counts as told.
 * - A run stops taking new companies after ATTEST_RUN_CLAIM_BUDGET_MS and
 *   starts no send after ATTEST_RUN_SEND_BUDGET_MS, with each send capped at
 *   ATTEST_SEND_TIMEOUT_MS, so the platform's 300 s limit never cuts a run
 *   between a claim and its stored links.
 * Who is told on the registrant's side is decisionRecipients
 * (attest-decision-notify.ts), the rule of the attest answer mail.
 *
 * Deploy order: until the migration has reached the database both jobs
 * answer skipped (schema_missing) and registrations mail the old way.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isAttestRole } from '@/lib/auth/invoicer-role'
import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { AttestBatchEmailInvoice } from '@/lib/email/attest-batch-templates'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendAttestBatchMail, sendAttestNoticeMail } from '@/lib/email/send-attest-batch'
import { createLogger, type Logger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { contactName, loadAttestAudience, type AttestAudience } from './attest-audience'
import {
  ATTEST_BATCH_MAX_INVOICES,
  AttestBatchStoreError,
  ATTEST_RESEND_WINDOW_MS,
  ATTEST_SEND_MAX_ATTEMPTS,
  attestBatchUrl,
  giveBackAttestBatch,
  leaseAttestBatchRetry,
  retireHeldAttestBatch,
  retireUnsentAttestBatch,
  storeAttestBatches,
  takeAttestBatchSend,
  type AttestBatchIntent,
  type AttestBatchKind,
  type StoredAttestBatch,
  type UnsentAttestBatch,
} from './attest-batches'
import { decisionRecipients } from './attest-decision-notify'
import {
  attestMailStanding,
  attestRoundReady,
  planAttestFollowUps,
  planAttestRequests,
  type AttestMailCompany,
  type AttestMailInvoice,
  type AttestMailState,
  type AttestRequestPlan,
} from './attest-mail-plan'
import { loadAttestLimits, loadAttestPolicy, loadAttestTrails } from './attest-policy-read'

const log = createLogger('supplier-invoices/attest-mail')

/** Ids per PostgREST .in() filter. */
const IN_CHUNK = 150
/** After this long into a run, no new company (or retry) is taken: what is taken finishes well inside the 300 s limit. */
export const ATTEST_RUN_CLAIM_BUDGET_MS = 200_000
/** After this long into a run, no send starts; the rest is given back for the next run. */
export const ATTEST_RUN_SEND_BUDGET_MS = 260_000


type MailInvoice = AttestMailInvoice & {
  supplier_invoice_number: string | null
  arrival_number: number
  supplier: { name: string | null } | null
}

type StateColumn = 'asked_at' | 'reminded_early_at' | 'reminded_last_at' | 'overdue_told_at' | 'blocked_told_at'

/** The run's time: its logical now (what the rows record) and how long it has been running (for the budget). */
interface RunClock {
  now: number
  elapsed: () => number
  logger: Logger
}

export interface AttestMailRunOptions {
  /** The run's logical time (what the rows record). */
  now?: number
  /** The wall clock the time budget reads; Date.now by default. */
  clock?: () => number
}

function runClock(options: AttestMailRunOptions, logger: Logger): RunClock {
  const clock = options.clock ?? Date.now
  const started = clock()
  return { now: options.now ?? Date.now(), elapsed: () => clock() - started, logger }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The table is there (the migration reached this database). */
async function mailStateReady(service: SupabaseClient): Promise<boolean> {
  const { error } = await service.from('supplier_invoice_attest_mail_state').select('supplier_invoice_id').limit(1)
  if (isMissingTableError(error)) return false
  if (error) throw error
  return true
}

/**
 * One chunk of a claim: set `column` where it is still null and answer the
 * rows this call set. Each column is its own literal statement, so the
 * schema guard checks it.
 */
function claimChunk(service: SupabaseClient, companyId: string, ids: string[], column: StateColumn, at: string) {
  switch (column) {
    case 'asked_at':
      return service.from('supplier_invoice_attest_mail_state').update({ asked_at: at }).eq('company_id', companyId).in('supplier_invoice_id', ids).is('asked_at', null).select('supplier_invoice_id')
    case 'reminded_early_at':
      return service.from('supplier_invoice_attest_mail_state').update({ reminded_early_at: at }).eq('company_id', companyId).in('supplier_invoice_id', ids).is('reminded_early_at', null).select('supplier_invoice_id')
    case 'reminded_last_at':
      return service.from('supplier_invoice_attest_mail_state').update({ reminded_last_at: at }).eq('company_id', companyId).in('supplier_invoice_id', ids).is('reminded_last_at', null).select('supplier_invoice_id')
    case 'overdue_told_at':
      return service.from('supplier_invoice_attest_mail_state').update({ overdue_told_at: at }).eq('company_id', companyId).in('supplier_invoice_id', ids).is('overdue_told_at', null).select('supplier_invoice_id')
    case 'blocked_told_at':
      return service.from('supplier_invoice_attest_mail_state').update({ blocked_told_at: at }).eq('company_id', companyId).in('supplier_invoice_id', ids).is('blocked_told_at', null).select('supplier_invoice_id')
  }
}

/** One chunk of a release: clear `column` where it still holds this run's claim (`at`). Literal per column, as claimChunk. */
function releaseChunk(service: SupabaseClient, companyId: string, ids: string[], column: StateColumn, at: string) {
  switch (column) {
    case 'asked_at':
      return service.from('supplier_invoice_attest_mail_state').update({ asked_at: null }).eq('company_id', companyId).in('supplier_invoice_id', ids).eq('asked_at', at)
    case 'reminded_early_at':
      return service.from('supplier_invoice_attest_mail_state').update({ reminded_early_at: null }).eq('company_id', companyId).in('supplier_invoice_id', ids).eq('reminded_early_at', at)
    case 'reminded_last_at':
      return service.from('supplier_invoice_attest_mail_state').update({ reminded_last_at: null }).eq('company_id', companyId).in('supplier_invoice_id', ids).eq('reminded_last_at', at)
    case 'overdue_told_at':
      return service.from('supplier_invoice_attest_mail_state').update({ overdue_told_at: null }).eq('company_id', companyId).in('supplier_invoice_id', ids).eq('overdue_told_at', at)
    case 'blocked_told_at':
      return service.from('supplier_invoice_attest_mail_state').update({ blocked_told_at: null }).eq('company_id', companyId).in('supplier_invoice_id', ids).eq('blocked_told_at', at)
  }
}

/**
 * Mark `column` on the rows not marked yet and answer the ones this call
 * marked: the run sends only what it claimed. When a later chunk fails, the
 * earlier chunks go back.
 */
async function claim(
  service: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
  column: StateColumn,
  at: string,
  logger: Logger,
): Promise<string[]> {
  const claimed: string[] = []
  try {
    for (const part of chunk(invoiceIds, IN_CHUNK)) {
      const { data, error } = await claimChunk(service, companyId, part, column, at)
      if (error) throw error
      claimed.push(...((data ?? []) as Array<{ supplier_invoice_id: string }>).map((row) => row.supplier_invoice_id))
    }
    return claimed
  } catch (error) {
    // A later chunk failed: the earlier chunks go back, or those invoices would never be asked about.
    if (claimed.length > 0) await release(service, companyId, claimed, column, at, logger)
    throw error
  }
}

/** Give back a claim this run took (`column` = `at`) but could not act on; only logs when even that fails. */
async function release(
  service: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
  column: StateColumn,
  at: string,
  logger: Logger,
): Promise<void> {
  try {
    for (const part of chunk(invoiceIds, IN_CHUNK)) {
      const { error } = await releaseChunk(service, companyId, part, column, at)
      if (error) throw error
    }
  } catch (error) {
    logger.warn('attest mail claim not released', { companyId, column, message: message(error) })
  }
}

/** Load what the rules read about one company and its invoices. */
async function loadMailCompany(
  service: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<{ company: AttestMailCompany; invoices: MailInvoice[] }> {
  const [policy, limits, { data: settingsRow, error: settingsError }, { data: memberRows, error: memberError }, attestations] = await Promise.all([
    loadAttestPolicy(service, companyId),
    loadAttestLimits(service, companyId),
    service.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
    service.from('company_members').select('user_id, role').eq('company_id', companyId),
    loadAttestTrails(service, companyId, invoiceIds),
  ])
  if (settingsError) throw settingsError
  if (memberError) throw memberError

  const invoices: MailInvoice[] = []
  for (const part of chunk(invoiceIds, IN_CHUNK)) {
    const { data: invoiceRows, error: invoiceError } = await service
      .from('supplier_invoices')
      .select('id, user_id, status, approved_at, is_credit_note, currency, total, total_sek, exchange_rate, supplier_invoice_number, arrival_number, due_date, supplier:suppliers(name)')
      .eq('company_id', companyId)
      .in('id', part)
    if (invoiceError) throw invoiceError
    for (const row of (invoiceRows ?? []) as unknown as MailInvoice[]) invoices.push({ ...row, total: Number(row.total) })
  }

  const optedOut = new Set<string>()
  if (policy.enabled && policy.attesters.length > 0) {
    const { data: prefRows, error: prefError } = await service
      .from('notification_settings')
      .select('user_id, attest_request_email_enabled')
      .in('user_id', policy.attesters)
    if (prefError) throw prefError
    for (const row of (prefRows ?? []) as Array<{ user_id: string; attest_request_email_enabled: boolean | null }>) {
      if (row.attest_request_email_enabled === false) optedOut.add(row.user_id)
    }
  }

  const attesters = new Set(
    ((memberRows ?? []) as Array<{ user_id: string; role: string }>).filter((m) => isAttestRole(m.role)).map((m) => m.user_id),
  )
  const accountingMethod = (settingsRow as { accounting_method?: string | null } | null)?.accounting_method ?? null
  return { company: { policy, accountingMethod, attesters, limits, attestations, optedOut }, invoices }
}

function mailInvoice(invoice: MailInvoice): AttestBatchEmailInvoice {
  return {
    supplierName: invoice.supplier?.name?.trim() || 'Leverantören',
    invoiceNumber: invoice.supplier_invoice_number,
    arrivalNumber: invoice.arrival_number,
    total: invoice.total,
    currency: invoice.currency,
    dueDate: invoice.due_date,
  }
}

/** One mail per attester with an address (several when the list is long), invoices soonest due first. */
function attesterIntents(asks: ReadonlyMap<string, string[]>, kind: AttestBatchKind, audience: AttestAudience): AttestBatchIntent[] {
  const intents: AttestBatchIntent[] = []
  for (const [attesterUserId, ids] of asks) {
    if (!audience.people.get(attesterUserId)?.email) continue
    for (const part of chunk(ids, ATTEST_BATCH_MAX_INVOICES)) intents.push({ attesterUserId, kind, invoiceIds: part })
  }
  return intents
}

export interface AttestMailDelivery {
  /** Sent, or may have been (counted as sent: never twice). */
  sent: number
  /** Not handed to the provider this run (refused, out of time, a failure before the send): on record for a later try. */
  failed: number
  /** Taken for sending, then the run failed around the send: kept as sent, never tried again. */
  unconfirmed: number
}

/**
 * Send the leased mails, one attester at a time. Each is marked sent right
 * before it is handed to the provider (takeAttestBatchSend): sent or maybe
 * sent stays so, a definite refusal is given back for a later try, a mail
 * that can never go is retired. One failure never skips the next attester.
 * Past the send budget the rest is given back untried.
 */
async function deliverAttesterMails(
  service: SupabaseClient,
  input: { companyId: string; stored: readonly StoredAttestBatch[]; invoices: readonly MailInvoice[]; audience: AttestAudience; baseUrl: string; run: RunClock },
): Promise<AttestMailDelivery> {
  const { companyId, audience, run } = input
  const byId = new Map(input.invoices.map((i) => [i.id, i]))
  const delivery: AttestMailDelivery = { sent: 0, failed: 0, unconfirmed: 0 }
  for (const mail of input.stored) {
    let taken = false
    try {
      if (run.elapsed() >= ATTEST_RUN_SEND_BUDGET_MS) {
        await giveBackAttestBatch(service, mail, null)
        delivery.failed++
        continue
      }
      const email = audience.people.get(mail.attesterUserId)?.email
      const listed = mail.invoiceIds.map((id) => byId.get(id)).filter((i): i is MailInvoice => !!i)
      if (!email || listed.length === 0) {
        await retireHeldAttestBatch(service, mail, { now: run.now })
        continue
      }
      const mark = await takeAttestBatchSend(service, mail, { now: run.now })
      if (!mark) {
        // The lease lapsed and another run has the row.
        delivery.failed++
        continue
      }
      taken = true
      // "Registered by" only when one person registered them all, and not when that is the attester.
      const registrants = [...new Set(listed.map((i) => i.user_id))]
      const registeredBy = registrants.length === 1 && registrants[0] !== mail.attesterUserId ? contactName(audience.people, registrants[0]!) : null
      const { outcome } = await sendAttestBatchMail({
        companyId,
        email,
        log: run.logger,
        data: { kind: mail.kind, companyName: audience.companyName, invoices: listed.map(mailInvoice), registeredBy, url: attestBatchUrl(input.baseUrl, mail.token) },
      })
      if (outcome === 'sent' || outcome === 'unknown') {
        delivery.sent++
      } else if (outcome === 'refused') {
        delivery.failed++
        await giveBackAttestBatch(service, mail, mark, { now: run.now })
      } else {
        await retireHeldAttestBatch(service, mail, { now: run.now })
      }
    } catch (error) {
      // Taken: it stays marked sent (never twice). Not taken: its lease lapses and a later run tries it.
      if (taken) delivery.unconfirmed++
      else delivery.failed++
      run.logger.error('attest batch mail not finished', error instanceof Error ? error : new Error(message(error)), { companyId, attestBatchId: mail.batch_id })
    }
  }
  return delivery
}

/**
 * Tell the registrants (or the owners and admins in their place) about
 * invoices past their due date without attest, or that nobody can attest:
 * one mail per recipient. Answers the invoices the step is done for (told,
 * maybe told, or nobody to tell); the caller releases the rest, refused
 * everywhere, for the next run.
 */
async function tellRegistrants(
  service: SupabaseClient,
  input: { companyId: string; kind: 'overdue' | 'blocked'; invoices: MailInvoice[]; audience: AttestAudience; baseUrl: string; run: RunClock },
): Promise<{ sent: number; told: Set<string> }> {
  const { companyId, kind, audience, run } = input
  const byRecipient = new Map<string, { reason: 'registrant' | 'fallback'; invoices: MailInvoice[] }>()
  const told = new Set<string>()
  for (const invoice of input.invoices) {
    // Nobody attested anything here: no attester to leave out.
    const recipients = decisionRecipients({
      registrantId: invoice.user_id,
      attesterId: '',
      writers: audience.writers,
      reachable: audience.reachable,
      byraTeam: audience.byraTeam,
    })
    // Nobody to tell: the step is done, there is nothing to try again.
    if (recipients.ids.length === 0) told.add(invoice.id)
    for (const id of recipients.ids) {
      const entry = byRecipient.get(id) ?? { reason: recipients.reason, invoices: [] }
      if (recipients.reason === 'registrant') entry.reason = 'registrant'
      entry.invoices.push(invoice)
      byRecipient.set(id, entry)
    }
  }
  const base = input.baseUrl.replace(/\/+$/, '')
  const url = kind === 'overdue' ? `${base}/supplier-invoices?tab=registered` : `${base}/settings/attest`
  let sent = 0
  for (const [recipientId, entry] of byRecipient) {
    // Out of time: what is not told yet goes back for the next run.
    if (run.elapsed() >= ATTEST_RUN_SEND_BUDGET_MS) break
    const email = audience.people.get(recipientId)?.email
    if (!email) continue
    const { outcome } = await sendAttestNoticeMail({
      companyId,
      email,
      log: run.logger,
      data: { kind, companyName: audience.companyName, invoices: entry.invoices.map(mailInvoice), url, reason: entry.reason },
    })
    if (outcome === 'sent' || outcome === 'unknown') sent++
    // Only a refusal is worth another try: sent, maybe sent or impossible here are done.
    if (outcome !== 'refused') for (const invoice of entry.invoices) told.add(invoice.id)
  }
  return { sent, told }
}

/** Claim a notice step, tell, and give back the invoices nobody was told about. */
async function noticeStep(
  service: SupabaseClient,
  input: {
    companyId: string
    kind: 'overdue' | 'blocked'
    column: 'overdue_told_at' | 'blocked_told_at'
    invoiceIds: readonly string[]
    invoices: readonly MailInvoice[]
    audience: AttestAudience
    baseUrl: string
    at: string
    run: RunClock
  },
): Promise<number> {
  // Out of time: nothing is claimed, so the next run takes the step.
  if (input.invoiceIds.length === 0 || input.run.elapsed() >= ATTEST_RUN_SEND_BUDGET_MS) return 0
  const claimed = await claim(service, input.companyId, input.invoiceIds, input.column, input.at, input.run.logger)
  if (claimed.length === 0) return 0
  let told = new Set<string>()
  let sent = 0
  try {
    ;({ sent, told } = await tellRegistrants(service, {
      companyId: input.companyId,
      kind: input.kind,
      invoices: byIds(input.invoices, claimed),
      audience: input.audience,
      baseUrl: input.baseUrl,
      run: input.run,
    }))
  } finally {
    const untold = claimed.filter((id) => !told.has(id))
    if (untold.length > 0) await release(service, input.companyId, untold, input.column, input.at, input.run.logger)
  }
  return sent
}

function byIds(invoices: readonly MailInvoice[], ids: readonly string[]): MailInvoice[] {
  const map = new Map(invoices.map((i) => [i.id, i]))
  return ids.map((id) => map.get(id)).filter((i): i is MailInvoice => !!i)
}

function groupByCompany<T extends { company_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const list = out.get(row.company_id) ?? []
    list.push(row)
    out.set(row.company_id, list)
  }
  return out
}

export interface AttestRetryResult {
  /** Stored mails that had not gone out and were free to try. */
  unsent: number
  /** Tried again and sent (or maybe sent). */
  resent: number
  /** Nothing listed waits on the attester any more: retired. */
  retired: number
  /** Taken by another run, refused again, or not finished. */
  failed: number
}

/**
 * Try again what an earlier run stored but did not get out: a free row (no
 * live lease) under 6 tries and a day old gets a fresh token, the invoices
 * still waiting and this run's lease in one conditional update, then is
 * sent. A row nothing waits for any more is retired.
 */
export async function retryUnsentAttestMails(service: SupabaseClient, logger: Logger = log, options: AttestMailRunOptions = {}): Promise<AttestRetryResult> {
  return retryUnsent(service, runClock(options, logger))
}

async function retryUnsent(service: SupabaseClient, run: RunClock): Promise<AttestRetryResult> {
  const result: AttestRetryResult = { unsent: 0, resent: 0, retired: 0, failed: 0 }
  const nowIso = new Date(run.now).toISOString()
  const rows = await fetchAllRows<UnsentAttestBatch>(({ from, to }) =>
    service
      .from('supplier_invoice_attest_batches')
      .select('id, company_id, attester_user_id, kind, invoice_ids, send_attempts')
      .is('mail_sent_at', null)
      .is('consumed_at', null)
      .gte('created_at', new Date(run.now - ATTEST_RESEND_WINDOW_MS).toISOString())
      .lt('send_attempts', ATTEST_SEND_MAX_ATTEMPTS)
      .lt('send_lease_until', nowIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  result.unsent = rows.length
  for (const [companyId, companyRows] of groupByCompany(rows)) {
    if (run.elapsed() >= ATTEST_RUN_CLAIM_BUDGET_MS) break
    try {
      const { company, invoices } = await loadMailCompany(service, companyId, [...new Set(companyRows.flatMap((r) => r.invoice_ids))])
      const byId = new Map(invoices.map((i) => [i.id, i]))
      const audience = await loadAttestAudience(service, companyId, [...companyRows.map((r) => r.attester_user_id), ...invoices.map((i) => i.user_id)])
      const baseUrl = await getBaseUrlForCompany(companyId)
      for (const row of companyRows) {
        // Out of time: the rest is left as it is, so no try is spent untried.
        if (run.elapsed() >= ATTEST_RUN_SEND_BUDGET_MS) break
        try {
          const still = row.invoice_ids.filter((id) => {
            const invoice = byId.get(id)
            if (!invoice || company.optedOut.has(row.attester_user_id)) return false
            const standing = attestMailStanding(company, invoice)
            return standing.kind === 'waiting' && standing.attesters.includes(row.attester_user_id)
          })
          if (still.length === 0 || !audience.people.get(row.attester_user_id)?.email) {
            if (await retireUnsentAttestBatch(service, row, { now: run.now })) result.retired++
            continue
          }
          const leased = await leaseAttestBatchRetry(service, row, still, { now: run.now })
          if (!leased) {
            result.failed++
            continue
          }
          const delivery = await deliverAttesterMails(service, { companyId, stored: [leased], invoices, audience, baseUrl, run })
          result.resent += delivery.sent + delivery.unconfirmed
          result.failed += delivery.failed
        } catch (error) {
          result.failed++
          run.logger.error('attest mail retry failed', error instanceof Error ? error : new Error(message(error)), { companyId, attestBatchId: row.id })
        }
      }
    } catch (error) {
      result.failed += companyRows.length
      run.logger.error('attest mail retry failed for a company', error instanceof Error ? error : new Error(message(error)), { companyId })
    }
  }
  return result
}

type PreparedRound =
  | { kind: 'nothing' }
  | { kind: 'send'; invoices: MailInvoice[]; plan: AttestRequestPlan; audience: AttestAudience; baseUrl: string }

/** Read what one company's round needs before anything is sent. */
async function prepareRound(service: SupabaseClient, companyId: string, invoiceIds: readonly string[]): Promise<PreparedRound> {
  const { company, invoices } = await loadMailCompany(service, companyId, invoiceIds)
  const plan = planAttestRequests(company, invoices)
  if (plan.asks.size === 0 && plan.blocked.length === 0) return { kind: 'nothing' }
  const audience = await loadAttestAudience(service, companyId, [...plan.asks.keys(), ...invoices.map((i) => i.user_id)])
  return { kind: 'send', invoices, plan, audience, baseUrl: await getBaseUrlForCompany(companyId) }
}

export interface AttestRequestRunResult {
  skipped: 'schema_missing' | null
  /** Invoices in the queue when the run started. */
  queued: number
  /** Companies whose round was complete and taken this run. */
  companies: number
  /** Complete rounds left queued for the next run: the run was out of time. */
  companies_deferred: number
  invoices_asked: number
  /** Sent, or may have been. */
  request_mails_sent: number
  /** Not handed to the provider this run (refused, out of time, a failure before the send): on record for a later try. */
  request_mails_failed: number
  /** Taken for sending, then the run failed around the send: kept as sent, never tried again. */
  request_mails_unconfirmed: number
  blocked_notices_sent: number
  failed_companies: number
  /** What an earlier run stored but did not get out, tried again first. */
  retry: AttestRetryResult
}

/** The request job: see the module comment. */
export async function runAttestRequestRound(
  service: SupabaseClient,
  logger: Logger = log,
  options: AttestMailRunOptions = {},
): Promise<AttestRequestRunResult> {
  const run = runClock(options, logger)
  const result: AttestRequestRunResult = {
    skipped: null,
    queued: 0,
    companies: 0,
    companies_deferred: 0,
    invoices_asked: 0,
    request_mails_sent: 0,
    request_mails_failed: 0,
    request_mails_unconfirmed: 0,
    blocked_notices_sent: 0,
    failed_companies: 0,
    retry: { unsent: 0, resent: 0, retired: 0, failed: 0 },
  }
  if (!(await mailStateReady(service))) return { ...result, skipped: 'schema_missing' }

  result.retry = await retryUnsent(service, run).catch((error) => {
    logger.error('attest mail retry failed', error instanceof Error ? error : new Error(message(error)))
    return result.retry
  })

  const queue = await fetchAllRows<{ supplier_invoice_id: string; company_id: string; queued_at: string }>(({ from, to }) =>
    service
      .from('supplier_invoice_attest_mail_state')
      .select('supplier_invoice_id, company_id, queued_at')
      .is('asked_at', null)
      .order('queued_at', { ascending: true })
      .order('supplier_invoice_id', { ascending: true })
      .range(from, to),
  )
  result.queued = queue.length

  for (const [companyId, rows] of groupByCompany(queue)) {
    if (!attestRoundReady(rows.map((r) => r.queued_at), run.now)) continue
    // Out of time: the round stays queued, untouched, for the next run.
    if (run.elapsed() >= ATTEST_RUN_CLAIM_BUDGET_MS) {
      result.companies_deferred++
      continue
    }
    result.companies++
    try {
      const at = new Date(run.now).toISOString()
      const claimed = await claim(
        service,
        companyId,
        rows.map((r) => r.supplier_invoice_id),
        'asked_at',
        at,
        logger,
      )
      if (claimed.length === 0) continue
      // Up to the stored links nothing is sent: when it fails, the rows go back to the queue for the next run,
      // unless links the failed insert may have written could not be retired (then a re-claim could mail twice).
      let prepared: { round: PreparedRound; stored: StoredAttestBatch[] } | null = null
      let giveBack = true
      try {
        const round = await prepareRound(service, companyId, claimed)
        const stored = round.kind === 'send' ? await storeAttestBatches(service, companyId, attesterIntents(round.plan.asks, 'request', round.audience), { now: run.now }) : []
        prepared = { round, stored }
      } catch (error) {
        if (error instanceof AttestBatchStoreError && !error.retired) giveBack = false
        throw error
      } finally {
        if (!prepared && giveBack) await release(service, companyId, claimed, 'asked_at', at, logger)
      }
      result.invoices_asked += claimed.length
      if (prepared.round.kind === 'nothing') continue
      const { invoices, plan, audience, baseUrl } = prepared.round
      const delivery = await deliverAttesterMails(service, { companyId, stored: prepared.stored, invoices, audience, baseUrl, run })
      result.request_mails_sent += delivery.sent
      result.request_mails_failed += delivery.failed
      result.request_mails_unconfirmed += delivery.unconfirmed
      result.blocked_notices_sent += await noticeStep(service, {
        companyId,
        kind: 'blocked',
        column: 'blocked_told_at',
        invoiceIds: plan.blocked,
        invoices,
        audience,
        baseUrl,
        at,
        run,
      })
    } catch (error) {
      result.failed_companies++
      logger.error('attest request round failed for a company', error instanceof Error ? error : new Error(message(error)), { companyId })
    }
  }
  return result
}

export interface AttestFollowUpRunResult {
  skipped: 'schema_missing' | null
  /** Invoices asked for and still waiting for attest when the run started. */
  waiting: number
  /** Companies left for the next day: the run was out of time. */
  companies_deferred: number
  /** Sent, or may have been. */
  reminder_mails_sent: number
  /** Not handed to the provider this run (refused, out of time, a failure before the send): on record for the request job to try again. */
  reminder_mails_failed: number
  /** Taken for sending, then the run failed around the send: kept as sent, never tried again. */
  reminder_mails_unconfirmed: number
  overdue_notices_sent: number
  blocked_notices_sent: number
  failed_companies: number
}

type FollowUpRow = AttestMailState & { supplier_invoice_id: string; company_id: string }

/** The follow-up job: see the module comment. */
export async function runAttestFollowUps(
  service: SupabaseClient,
  logger: Logger = log,
  options: AttestMailRunOptions = {},
): Promise<AttestFollowUpRunResult> {
  const run = runClock(options, logger)
  const today = todayIsoStockholm(new Date(run.now))
  const result: AttestFollowUpRunResult = {
    skipped: null,
    waiting: 0,
    companies_deferred: 0,
    reminder_mails_sent: 0,
    reminder_mails_failed: 0,
    reminder_mails_unconfirmed: 0,
    overdue_notices_sent: 0,
    blocked_notices_sent: 0,
    failed_companies: 0,
  }
  if (!(await mailStateReady(service))) return { ...result, skipped: 'schema_missing' }

  // Only invoices that were asked for and still wait for attest: the rest has nothing left to send.
  const rows = await fetchAllRows<FollowUpRow>(({ from, to }) =>
    service
      .from('supplier_invoice_attest_mail_state')
      .select(
        'supplier_invoice_id, company_id, asked_at, reminded_early_at, reminded_last_at, overdue_told_at, blocked_told_at, supplier_invoices!inner(status, approved_at)',
      )
      .not('asked_at', 'is', null)
      .is('supplier_invoices.approved_at', null)
      .in('supplier_invoices.status', ['registered', 'overdue'])
      .order('supplier_invoice_id', { ascending: true })
      .range(from, to),
  )
  result.waiting = rows.length

  for (const [companyId, companyRows] of groupByCompany(rows)) {
    if (run.elapsed() >= ATTEST_RUN_CLAIM_BUDGET_MS) {
      result.companies_deferred++
      continue
    }
    try {
      const at = new Date(run.now).toISOString()
      const state = new Map(companyRows.map((r) => [r.supplier_invoice_id, r]))
      const { company, invoices } = await loadMailCompany(service, companyId, [...state.keys()])
      const plan = planAttestFollowUps(
        company,
        invoices.map((invoice) => {
          const row = state.get(invoice.id)!
          return { invoice, state: row, askedOn: row.asked_at ? todayIsoStockholm(new Date(row.asked_at)) : null }
        }),
        today,
      )
      const anything = plan.slots.early.length + plan.slots.last.length + plan.overdue.length + plan.blocked.length > 0
      if (!anything) continue
      const audience = await loadAttestAudience(service, companyId, [...plan.reminders.keys(), ...invoices.map((i) => i.user_id)])
      const baseUrl = await getBaseUrlForCompany(companyId)

      // Reminders: claim the slots and store every attester's mail in one go; when any of it fails, every slot taken goes back.
      let early: string[] = []
      let last: string[] = []
      let stored: StoredAttestBatch[] | null = null
      let giveBack = true
      try {
        early = await claim(service, companyId, plan.slots.early, 'reminded_early_at', at, logger)
        last = await claim(service, companyId, plan.slots.last, 'reminded_last_at', at, logger)
        const reminded = new Set([...early, ...last])
        const asks = new Map<string, string[]>()
        for (const [attesterId, ids] of plan.reminders) {
          const mine = ids.filter((id) => reminded.has(id))
          if (mine.length > 0) asks.set(attesterId, mine)
        }
        stored = await storeAttestBatches(service, companyId, attesterIntents(asks, 'reminder', audience), { now: run.now })
      } catch (error) {
        if (error instanceof AttestBatchStoreError && !error.retired) giveBack = false
        throw error
      } finally {
        if (!stored && giveBack) {
          if (early.length > 0) await release(service, companyId, early, 'reminded_early_at', at, logger)
          if (last.length > 0) await release(service, companyId, last, 'reminded_last_at', at, logger)
        }
      }
      const delivery = await deliverAttesterMails(service, { companyId, stored, invoices, audience, baseUrl, run })
      result.reminder_mails_sent += delivery.sent
      result.reminder_mails_failed += delivery.failed
      result.reminder_mails_unconfirmed += delivery.unconfirmed

      const notice = { companyId, invoices, audience, baseUrl, at, run }
      result.overdue_notices_sent += await noticeStep(service, { ...notice, kind: 'overdue', column: 'overdue_told_at', invoiceIds: plan.overdue })
      result.blocked_notices_sent += await noticeStep(service, { ...notice, kind: 'blocked', column: 'blocked_told_at', invoiceIds: plan.blocked })
    } catch (error) {
      result.failed_companies++
      logger.error('attest follow-up failed for a company', error instanceof Error ? error : new Error(message(error)), { companyId })
    }
  }
  return result
}
