/**
 * Tell whoever registered supplier invoices what the attester decided: the
 * hand-back from the one who attests (often a byrå's client) to the one who
 * pays (often the byrå). The attest request (attest-notify.ts) asks; this
 * answers.
 *
 * Built for a list: every invoice one attester decided in one go becomes ONE
 * mail per recipient, with the attested ones ready to pay and the rejected
 * ones with their comment. The attest service sends one decision at a time
 * (approveSupplierInvoice when the policy is satisfied, rejectSupplierInvoice
 * when a rejection is recorded); a door that decides several at once turns
 * the service's mail off and calls this once with all of them.
 *
 * Who is told: the person who registered the invoice (supplier_invoices.
 * user_id). The inbox registers mail-in invoices in the company owner's name
 * (the invoice-inbox extension's owner per company), so that is a person
 * too. When the registrant has left the company or has no address, the
 * company's owners and admins are told instead: those on the byrå team when
 * the company has a byrå, else all of them. Nobody is told about their own
 * decision, and an invoice the policy does not govern tells nobody: without
 * a policy nobody waits on the answer.
 *
 * An approval is told only once it completed the attest (the invoice's
 * approved_at is set): the first of two attesters is no answer anyone can
 * pay on. A failed read sends nothing: a settings read that failed must not
 * read as faktureringsmetoden, nor a team read that failed mail the client's
 * own owners instead of the byrå. notifyAttestDecisions throws; the doors
 * call the Safely variants, which log it. A mail that does not go leaves the
 * Att göra row and the byrå client list, which show the same.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendAttestDecisionMail } from '@/lib/email/send-attest-decision'
import type { AttestDecisionEmailInvoice } from '@/lib/email/attest-decision-templates'
import { createLogger, type Logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import { loadAttestAudience } from './attest-audience'
import { invoiceNeedsAttest, type AttestDecision, type AttestInvoiceFacts } from './attest-policy'
import { loadAttestPolicy } from './attest-policy-read'

const log = createLogger('supplier-invoices/attest-decision-notify')

export interface AttestDecisionNotice {
  invoiceId: string
  decision: AttestDecision
  /** A rejection's comment; null for an approval or a rejection without one. */
  comment: string | null
}

export interface AttestDecisionNotifyResult {
  mailed: number
  /** Invoices nobody could be told about: no registrant to reach and no owner or admin with an address. */
  skipped_no_recipient: number
}

type InvoiceRow = AttestInvoiceFacts & {
  id: string
  approved_at: string | null
  supplier_invoice_number: string | null
  arrival_number: number
  due_date: string
  supplier: { name: string | null } | null
}

/**
 * Who hears about an invoice: its registrant while they are a member who
 * keeps the books and has an address, else the fallback; never the attester.
 */
export function decisionRecipients(input: {
  registrantId: string
  attesterId: string
  /** The company's members who keep the books (owner, admin, member), by user id. */
  writers: ReadonlyMap<string, string>
  /** User ids with an address. */
  reachable: ReadonlySet<string>
  /** Byrå team members of the company's byrå; empty without one. */
  byraTeam: ReadonlySet<string>
}): { ids: string[]; reason: 'registrant' | 'fallback' } {
  const { registrantId, attesterId, writers, reachable, byraTeam } = input
  if (registrantId === attesterId) return { ids: [], reason: 'registrant' }
  if (writers.has(registrantId) && reachable.has(registrantId)) return { ids: [registrantId], reason: 'registrant' }
  const keepers = [...writers]
    .filter(([id, role]) => (role === 'owner' || role === 'admin') && id !== attesterId && reachable.has(id))
    .map(([id]) => id)
  const fromByra = keepers.filter((id) => byraTeam.has(id))
  return { ids: fromByra.length > 0 ? fromByra : keepers, reason: 'fallback' }
}

export async function notifyAttestDecisions(
  service: SupabaseClient,
  companyId: string,
  attesterId: string,
  decisions: readonly AttestDecisionNotice[],
  logger: Logger = log,
): Promise<AttestDecisionNotifyResult> {
  const result: AttestDecisionNotifyResult = { mailed: 0, skipped_no_recipient: 0 }
  if (decisions.length === 0) return result
  const policy = await loadAttestPolicy(service, companyId)
  if (!policy.enabled) return result

  const [{ data: invoiceRows, error: invoiceError }, { data: settingsRow, error: settingsError }] = await Promise.all([
    service
      .from('supplier_invoices')
      .select('id, user_id, approved_at, is_credit_note, currency, total, total_sek, exchange_rate, supplier_invoice_number, arrival_number, due_date, supplier:suppliers(name)')
      .eq('company_id', companyId)
      .in('id', [...new Set(decisions.map((d) => d.invoiceId))]),
    service.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
  ])
  const readError = invoiceError ?? settingsError
  if (readError) throw readError
  const accountingMethod = (settingsRow as { accounting_method?: string | null } | null)?.accounting_method ?? null
  const invoices = new Map(
    ((invoiceRows ?? []) as unknown as InvoiceRow[])
      .map((row) => ({ ...row, total: Number(row.total) }))
      .filter((row) => invoiceNeedsAttest(policy, accountingMethod, row))
      .map((row) => [row.id, row] as const),
  )
  // An approval that did not complete the attest (the first of two attesters) is no answer yet.
  const told = decisions.filter((d) => {
    const invoice = invoices.get(d.invoiceId)
    return !!invoice && (d.decision !== 'approved' || !!invoice.approved_at)
  })
  if (told.length === 0) return result

  const { companyName, writers, byraTeam, people, reachable } = await loadAttestAudience(service, companyId, [
    attesterId,
    ...[...invoices.values()].map((i) => i.user_id),
  ])

  // One mail per recipient, carrying every invoice of theirs in this answer.
  const byRecipient = new Map<string, { reason: 'registrant' | 'fallback'; invoices: AttestDecisionEmailInvoice[] }>()
  for (const decision of told) {
    const invoice = invoices.get(decision.invoiceId)!
    const recipients = decisionRecipients({ registrantId: invoice.user_id, attesterId, writers, reachable, byraTeam })
    if (recipients.ids.length === 0) {
      if (invoice.user_id !== attesterId) result.skipped_no_recipient++
      continue
    }
    for (const id of recipients.ids) {
      const entry = byRecipient.get(id) ?? { reason: recipients.reason, invoices: [] }
      if (recipients.reason === 'registrant') entry.reason = 'registrant'
      entry.invoices.push({
        supplierName: invoice.supplier?.name?.trim() || 'Leverantören',
        invoiceNumber: invoice.supplier_invoice_number,
        arrivalNumber: invoice.arrival_number,
        total: invoice.total,
        currency: invoice.currency,
        dueDate: invoice.due_date,
        decision: decision.decision,
        comment: decision.decision === 'rejected' ? decision.comment : null,
      })
      byRecipient.set(id, entry)
    }
  }
  if (byRecipient.size === 0) return result

  const baseUrl = (await getBaseUrlForCompany(companyId)).replace(/\/+$/, '')
  const attester = people.get(attesterId)
  const attesterName = attester?.name ?? attester?.email ?? 'Attestanten'
  for (const [recipientId, entry] of byRecipient) {
    const email = people.get(recipientId)?.email
    if (!email) continue
    const anyApproved = entry.invoices.some((i) => i.decision === 'approved')
    const sent = await sendAttestDecisionMail({
      companyId,
      email,
      log: logger,
      data: {
        companyName,
        attesterName,
        invoices: entry.invoices,
        listUrl: `${baseUrl}/supplier-invoices?tab=${anyApproved ? 'to_pay' : 'registered'}`,
        reason: entry.reason,
      },
    })
    if (sent.emailSent) result.mailed++
  }
  return result
}

/**
 * A door's call: tell the registrants about decisions already committed, and
 * never let a failure reach them. A failed read or send is logged and sends
 * nothing more.
 */
export async function notifyAttestDecisionsSafely(
  service: SupabaseClient,
  companyId: string,
  attesterId: string,
  decisions: readonly AttestDecisionNotice[],
): Promise<void> {
  try {
    await notifyAttestDecisions(service, companyId, attesterId, decisions)
  } catch (error) {
    log.warn('attest decision mail not sent', {
      companyId,
      invoiceIds: decisions.map((d) => d.invoiceId),
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** The attest service's call for its one decision (see notifyAttestDecisionsSafely). */
export async function notifyAttestDecisionSafely(
  service: SupabaseClient,
  companyId: string,
  attesterId: string,
  decision: AttestDecisionNotice,
): Promise<void> {
  await notifyAttestDecisionsSafely(service, companyId, attesterId, [decision])
}

/**
 * Decisions a door makes one at a time but the people behind them answered
 * in one go, such as a bulk approval of staged attests: the door passes the
 * batch to every attest call (AttestDecisionInput in attest-service.ts), the
 * service adds each answer the moment it is stored instead of mailing, and
 * the door flushes once, in a finally: one mail per company and attester.
 */
export interface AttestDecisionBatch {
  add(companyId: string, attesterId: string, notice: AttestDecisionNotice): void
  /** How many decisions wait to be told. */
  readonly size: number
  /** Tell every registrant, one notifyAttestDecisions per company and attester; never throws. */
  flush(service?: SupabaseClient): Promise<void>
}

export function createAttestDecisionBatch(): AttestDecisionBatch {
  const groups = new Map<string, { companyId: string; attesterId: string; notices: AttestDecisionNotice[] }>()
  return {
    add(companyId, attesterId, notice) {
      const key = `${companyId}:${attesterId}`
      const group = groups.get(key) ?? { companyId, attesterId, notices: [] }
      group.notices.push(notice)
      groups.set(key, group)
    },
    get size() {
      return [...groups.values()].reduce((sum, g) => sum + g.notices.length, 0)
    },
    async flush(service) {
      if (groups.size === 0) return
      const client = service ?? createServiceClient()
      const pending = [...groups.values()]
      groups.clear()
      for (const group of pending) {
        await notifyAttestDecisionsSafely(client, group.companyId, group.attesterId, group.notices)
      }
    },
  }
}
