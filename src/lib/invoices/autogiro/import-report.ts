/**
 * Reading a report from Bankgirot into the company's Autogiro: the person
 * downloads it in its bank and uploads it here, as with the deposit
 * specification.
 *
 * - Betalningsspecifikation: each debit becomes debited, failed (stopped in
 *   the funds check) or stays sent (Bankgirot tries again); each refund marks
 *   its debit refunded. The deposits are returned as `settlement`, shaped
 *   like a BG Max deposit, for the caller to attach to the bank rows
 *   (lib/import/bgmax/attach.ts): that is what settles the invoices, through
 *   the batch allocation the person confirms, exactly as for Bankgiro
 *   Inbetalningar. Nothing here books.
 * - Avvisade betalningar: each debit becomes rejected, with Bankgirot's reason.
 * - Medgivandeavisering and Utdrag ur Medgivanderegistret: mandates are
 *   created or change status, and a new payer is linked to the customer whose
 *   customer number is its payer number (or whose organisationsnummer it
 *   gave), when exactly one fits.
 * - Medgivanden via Internetbanken: the payers who signed in their internet
 *   bank. With the person's decisions it writes the answer file (approve or
 *   reject, TK04) for the bank; Bankgirot cancels a mandate nobody answers
 *   within 18 banking days (Bg Autogiro Användarmanual 3.5.1). The answer
 *   carries the payer's account and personnummer, so it is returned for
 *   download and never stored.
 *
 * A preview (apply false) reads and matches only. Applying records the report
 * and writes the changes, once: the same file again is refused, except a
 * payment specification, whose deposits are returned again for a bank row
 * that synced since, and the internet-bank file, which may be answered again.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatBankgiroNumber } from '@/lib/bankgiro/luhn'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { roundOre } from '@/lib/money'
import { describeCode, PAYMENT_STATUS_CODES, REFUND_REASON_CODES } from './codes'
import {
  parseAutogiroReport,
  type AutogiroIssue,
  type AutogiroMandateNoticeReport,
  type AutogiroMandateRegister,
  type AutogiroInternetBankReport,
  type AutogiroPaymentSpecification,
  type AutogiroRejectedPaymentsReport,
  type AutogiroReportKind,
} from './reports'
import { autogiroFile, mandateSection, type MandateInstruction } from './writer'
import { normalizePayerNumber } from './rules'
import {
  loadAutogiroSettings,
  payeeOf,
  type AutogiroFailure,
  type AutogiroSettings,
  type DebitStatus,
  type MandateSource,
  type MandateStatus,
} from './service'

/** A deposit of debited invoices, in the shape the BG Max attachment takes (BgMaxDeposit). */
export interface AutogiroSettlementDeposit {
  bankgiro: string
  bank_account: string | null
  date: string
  serial: string | null
  amount: number
  currency: 'SEK'
  payments: Array<{
    kind: 'payment'
    amount: number
    payer_bankgiro: null
    reference: string | null
    reference_code: string
    extra_references: string[]
    message: string | null
    payer_name: string | null
    payer_org_number: null
    bgc_serial: null
  }>
}

export interface ReportDebitLine {
  payer_number: string | null
  reference: string | null
  amount: number
  date: string | null
  /** debited/failed: the outcome written; retry: Bankgirot tries again; unknown: no debit of ours fits. */
  outcome: 'debited' | 'failed' | 'retry' | 'rejected' | 'refunded' | 'unknown'
  invoice_number: string | null
  status_text: string | null
}

export interface ReportMandateLine {
  payer_number: string | null
  payer_name: string | null
  /** The status the mandate gets (null: unchanged). */
  status: MandateStatus | null
  previous_status: MandateStatus | null
  customer_id: string | null
  customer_name: string | null
  /** A customer was matched to a payer not linked before. */
  linked: boolean
  status_text: string | null
  /** Internet-bank mandates: the decision applied, or the default the page offers. */
  decision?: 'approve' | 'reject'
  /** Internet-bank mandates: whether the file carries what an answer needs (account and personnummer). */
  answerable?: boolean
}

export interface AutogiroReportOutcome {
  kind: AutogiroReportKind
  applied: boolean
  /** The same file was read before: a payment specification only re-attaches its deposits. */
  repeat: boolean
  sealed: boolean
  issues: AutogiroIssue[]
  debits: ReportDebitLine[]
  mandates: ReportMandateLine[]
  settlement: AutogiroSettlementDeposit[]
  answer_file: { filename: string; content: string } | null
  file_id: string | null
}

export type ImportAutogiroReportResult = ({ ok: true } & AutogiroReportOutcome) | AutogiroFailure

export interface ImportAutogiroReportInput {
  companyId: string
  userId: string
  content: string
  filename: string | null
  apply: boolean
  today: string
  /** Internet-bank mandates: approve or reject per payer number. Absent payers are left pending. */
  decisions?: Readonly<Record<string, 'approve' | 'reject'>>
}

const STORED_KINDS: ReadonlySet<AutogiroReportKind> = new Set(['payment_specification', 'rejected_payments'])

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function sameBankgiro(fromFile: string | null, settings: AutogiroSettings): boolean {
  return !!fromFile && digits(fromFile).replace(/^0+/, '') === settings.bankgiro.replace(/^0+/, '')
}

function bankgirosOf(report: ReturnType<typeof parseAutogiroReport>['report']): Array<string | null> {
  if (!report) return []
  switch (report.kind) {
    case 'payment_specification':
    case 'mandate_notice':
    case 'rejected_payments':
    case 'internet_bank_mandates':
      return report.sections.map((s) => s.bankgiro)
    case 'mandate_register':
      return report.mandates.map((m) => m.bankgiro)
  }
}

export async function importAutogiroReport(
  supabase: SupabaseClient,
  input: ImportAutogiroReportInput,
): Promise<ImportAutogiroReportResult> {
  const settings = await loadAutogiroSettings(supabase, input.companyId)
  if (!settings) return { ok: false, code: 'AUTOGIRO_SETTINGS_MISSING' }

  const parsed = parseAutogiroReport(input.content)
  if (!parsed.report) {
    if (parsed.detection?.kind === 'unsupported' && parsed.detection.reason === 'old_layout') {
      return { ok: false, code: 'AUTOGIRO_REPORT_OLD_LAYOUT' }
    }
    return { ok: false, code: 'AUTOGIRO_REPORT_UNKNOWN', details: parsed.detection?.kind === 'unsupported' ? { report: parsed.detection.content } : undefined }
  }
  const report = parsed.report
  const foreign = bankgirosOf(report).filter((bg) => !sameBankgiro(bg, settings))
  if (foreign.length > 0) {
    return { ok: false, code: 'AUTOGIRO_REPORT_WRONG_BANKGIRO', details: { bankgiro: foreign[0] ?? null } }
  }
  if (input.apply && report.issues.some((i) => i.severity === 'error')) {
    return { ok: false, code: 'AUTOGIRO_REPORT_HAS_ERRORS', details: { issues: report.issues.filter((i) => i.severity === 'error').slice(0, 5) } }
  }

  const hash = sha256(input.content)
  const { data: seen, error: seenError } = await supabase
    .from('autogiro_files')
    .select('id')
    .eq('company_id', input.companyId)
    .eq('direction', 'from_bankgirot')
    .eq('file_hash', hash)
    .maybeSingle()
  if (seenError) throw seenError
  const seenId = (seen as { id: string } | null)?.id ?? null
  // A payment specification read before: its statuses are written, but its
  // deposits attach as often as it takes (a bank row that synced since).
  // Any other report is read once; the internet-bank file may be answered again.
  if (input.apply && seenId && report.kind !== 'payment_specification' && report.kind !== 'internet_bank_mandates') {
    return { ok: false, code: 'AUTOGIRO_REPORT_ALREADY_IMPORTED' }
  }

  const outcome: AutogiroReportOutcome = {
    kind: report.kind,
    applied: input.apply,
    repeat: seenId !== null,
    sealed: report.sealed,
    issues: report.issues,
    debits: [],
    mandates: [],
    settlement: [],
    answer_file: null,
    file_id: null,
  }

  switch (report.kind) {
    case 'payment_specification':
      await readPaymentSpecification(supabase, input, report, outcome, seenId !== null)
      break
    case 'rejected_payments':
      await readRejectedPayments(supabase, input, report, outcome)
      break
    case 'mandate_notice':
    case 'mandate_register':
      await readMandateReport(supabase, input, report, outcome)
      break
    case 'internet_bank_mandates':
      await readInternetBankMandates(supabase, input, settings, report, outcome)
      break
  }

  if (input.apply) outcome.file_id = seenId ?? (await recordReport(supabase, input, report.kind, hash, outcome))
  return { ok: true, ...outcome }
}

async function recordReport(
  supabase: SupabaseClient,
  input: ImportAutogiroReportInput,
  kind: AutogiroReportKind,
  hash: string,
  outcome: AutogiroReportOutcome,
): Promise<string> {
  const count = (o: string) => outcome.debits.filter((d) => d.outcome === o).length
  const summary =
    kind === 'payment_specification' || kind === 'rejected_payments'
      ? {
          debited: count('debited'),
          failed: count('failed'),
          retry: count('retry'),
          rejected: count('rejected'),
          refunded: count('refunded'),
          unknown: count('unknown'),
          settled_amount: roundOre(outcome.settlement.reduce((sum, d) => sum + d.amount, 0)),
        }
      : {
          mandates: outcome.mandates.length,
          active: outcome.mandates.filter((m) => m.status === 'active').length,
          pending: outcome.mandates.filter((m) => m.status === 'pending').length,
          cancelled: outcome.mandates.filter((m) => m.status === 'cancelled').length,
          rejected: outcome.mandates.filter((m) => m.status === 'rejected').length,
          linked: outcome.mandates.filter((m) => m.linked).length,
        }
  const { data, error } = await supabase
    .from('autogiro_files')
    .insert({
      company_id: input.companyId,
      direction: 'from_bankgirot',
      kind,
      filename: input.filename,
      file_hash: hash,
      content: STORED_KINDS.has(kind) ? input.content : null,
      summary,
      created_by: input.userId,
    })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

// ── Debits ──────────────────────────────────────────────────────────────

interface OpenDebit {
  id: string
  invoice_id: string
  payer_number: string
  reference: string
  status: DebitStatus
  invoice: { invoice_number: string | null; customer: { name: string | null } | null } | null
}

/** The company's debits that a report can speak of: sent, or debited (a refund). */
async function loadReportableDebits(supabase: SupabaseClient, companyId: string): Promise<OpenDebit[]> {
  return fetchAllRows<OpenDebit>(({ from, to }) =>
    supabase
      .from('autogiro_debits')
      .select('id, invoice_id, payer_number, reference, status, invoice:invoices(invoice_number, customer:customers(name))')
      .eq('company_id', companyId)
      .in('status', ['sent', 'debited'])
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: OpenDebit[] | null; error: { message: string } | null }>,
  )
}

/** Finds our debit by payer number and reference (the invoice's OCR), in the given statuses; each is used once. */
function takeDebit(
  pool: OpenDebit[],
  used: Set<string>,
  payerNumber: string | null,
  reference: string | null,
  statuses: DebitStatus[],
): OpenDebit | null {
  const payer = normalizePayerNumber(payerNumber)
  if (!payer || !reference) return null
  const hit = pool.find((d) => !used.has(d.id) && statuses.includes(d.status) && d.payer_number === payer && d.reference === reference.trim())
  if (hit) used.add(hit.id)
  return hit ?? null
}

async function setDebitStatus(
  supabase: SupabaseClient,
  companyId: string,
  debitId: string,
  values: { status: DebitStatus; status_text: string | null; status_date: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('autogiro_debits')
    .update({ status: values.status, status_text: values.status_text, status_date: values.status_date })
    .eq('id', debitId)
    .eq('company_id', companyId)
  if (error) throw error
}

async function readPaymentSpecification(
  supabase: SupabaseClient,
  input: ImportAutogiroReportInput,
  report: AutogiroPaymentSpecification,
  outcome: AutogiroReportOutcome,
  repeat: boolean,
): Promise<void> {
  const pool = await loadReportableDebits(supabase, input.companyId)
  const used = new Set<string>()
  const writes: Array<() => Promise<void>> = []
  // Read before: the debits it speaks of are already debited, and nothing is written again.
  const open: DebitStatus[] = repeat ? ['sent', 'debited'] : ['sent']

  for (const section of report.sections) {
    for (const deposit of section.deposits) {
      const payments: AutogiroSettlementDeposit['payments'] = []
      for (const line of deposit.debits) {
        const debit = takeDebit(pool, used, line.payer_number, line.reference, open)
        const statusText = line.completed ? null : describeCode(PAYMENT_STATUS_CODES, line.status) ?? `Statuskod ${line.status}`
        const result: ReportDebitLine['outcome'] = !debit ? 'unknown' : line.completed ? 'debited' : line.status === '9' ? 'retry' : 'failed'
        outcome.debits.push({
          payer_number: line.payer_number,
          reference: line.reference,
          amount: line.amount,
          date: line.date,
          outcome: result,
          invoice_number: debit?.invoice?.invoice_number ?? null,
          status_text: statusText,
        })
        if (debit && result !== 'unknown') {
          const values = {
            status: (result === 'retry' ? 'sent' : result) as DebitStatus,
            status_text: statusText,
            status_date: line.date,
          }
          writes.push(() => setDebitStatus(supabase, input.companyId, debit.id, values))
        }
        if (line.completed) {
          payments.push({
            kind: 'payment',
            amount: line.amount,
            payer_bankgiro: null,
            reference: line.reference,
            // A reference we wrote ourselves: the invoice's OCR, checked when written.
            reference_code: '2',
            extra_references: [],
            message: 'Autogiro',
            payer_name: debit?.invoice?.customer?.name ?? null,
            payer_org_number: null,
            bgc_serial: null,
          })
        }
      }
      if (deposit.balanced && deposit.date && section.bankgiro && payments.length > 0) {
        outcome.settlement.push({
          bankgiro: section.bankgiro,
          bank_account: deposit.bank_account,
          date: deposit.date,
          serial: deposit.serial,
          amount: deposit.amount,
          currency: 'SEK',
          payments,
        })
      }
    }
    for (const refund of section.refunds) {
      const debit = takeDebit(pool, used, refund.payer_number, refund.original_reference, ['debited', 'sent'])
      const reason = refund.reason_code ? describeCode(REFUND_REASON_CODES, refund.reason_code) : null
      const statusText = `Återbetald till betalaren${reason ? `: ${reason}` : ''}`
      outcome.debits.push({
        payer_number: refund.payer_number,
        reference: refund.original_reference,
        amount: refund.amount,
        date: refund.date,
        outcome: debit ? 'refunded' : 'unknown',
        invoice_number: debit?.invoice?.invoice_number ?? null,
        status_text: statusText,
      })
      if (debit) {
        writes.push(() => setDebitStatus(supabase, input.companyId, debit.id, { status: 'refunded', status_text: statusText, status_date: refund.date }))
      }
    }
  }
  if (input.apply && !repeat) for (const write of writes) await write()
}

async function readRejectedPayments(
  supabase: SupabaseClient,
  input: ImportAutogiroReportInput,
  report: AutogiroRejectedPaymentsReport,
  outcome: AutogiroReportOutcome,
): Promise<void> {
  const pool = await loadReportableDebits(supabase, input.companyId)
  const used = new Set<string>()
  for (const section of report.sections) {
    for (const payment of section.payments) {
      if (payment.direction !== 'debit') continue
      const debit = takeDebit(pool, used, payment.payer_number, payment.reference, ['sent'])
      const statusText = payment.comment ?? (payment.comment_code ? `Kommentarskod ${payment.comment_code}` : null)
      outcome.debits.push({
        payer_number: payment.payer_number,
        reference: payment.reference,
        amount: payment.amount,
        date: payment.date,
        outcome: debit ? 'rejected' : 'unknown',
        invoice_number: debit?.invoice?.invoice_number ?? null,
        status_text: statusText,
      })
      if (debit && input.apply) {
        await setDebitStatus(supabase, input.companyId, debit.id, { status: 'rejected', status_text: statusText, status_date: section.written_on })
      }
    }
  }
}

// ── Mandates ────────────────────────────────────────────────────────────

interface MandateState {
  id: string
  customer_id: string | null
  payer_number: string
  status: MandateStatus
  payer_name: string | null
}

interface CustomerKeys {
  names: Map<string, string>
  byPayerNumber: Map<string, string[]>
  byOrgNumber: Map<string, string[]>
  withActive: Set<string>
}

async function loadCustomerKeys(supabase: SupabaseClient, companyId: string, mandates: MandateState[]): Promise<CustomerKeys> {
  const customers = await fetchAllRows<{ id: string; name: string; customer_number: string | null; org_number: string | null }>(({ from, to }) =>
    supabase
      .from('customers')
      .select('id, name, customer_number, org_number')
      .eq('company_id', companyId)
      .is('archived_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const keys: CustomerKeys = { names: new Map(), byPayerNumber: new Map(), byOrgNumber: new Map(), withActive: new Set() }
  const push = (map: Map<string, string[]>, key: string | null, id: string) => {
    if (!key) return
    map.set(key, [...(map.get(key) ?? []), id])
  }
  for (const c of customers) {
    keys.names.set(c.id, c.name)
    push(keys.byPayerNumber, normalizePayerNumber(c.customer_number), c.id)
    push(keys.byOrgNumber, orgNumberKey(c.org_number), c.id)
  }
  for (const m of mandates) if (m.status === 'active' && m.customer_id) keys.withActive.add(m.customer_id)
  return keys
}

/** The one customer a new payer belongs to: its customer number is the payer number, or its organisationsnummer the identity given. */
function customerFor(keys: CustomerKeys, payerNumber: string, identityNumber: string | null): string | null {
  const byNumber = keys.byPayerNumber.get(payerNumber) ?? []
  if (byNumber.length === 1) return byNumber[0]!
  if (byNumber.length > 1) return null
  const orgKey = orgNumberKey(identityNumber)
  const byOrg = orgKey ? (keys.byOrgNumber.get(orgKey) ?? []) : []
  return byOrg.length === 1 ? byOrg[0]! : null
}

async function loadMandateStates(supabase: SupabaseClient, companyId: string): Promise<MandateState[]> {
  return fetchAllRows<MandateState>(({ from, to }) =>
    supabase
      .from('autogiro_mandates')
      .select('id, customer_id, payer_number, status, payer_name')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/** What a mandate notice record does to the mandate (Bg Autogiro Teknisk manual 8.3.3). */
function noticeStatus(informationCode: string | null, commentCode: string | null): MandateStatus | null {
  if (informationCode && ['03', '10', '43', '44', '46'].includes(informationCode)) return 'cancelled'
  if (informationCode === '04' || informationCode === '42') {
    // 32 new mandate; 10 it is already in the register: either way it stands.
    return commentCode === '32' || commentCode === '10' ? 'active' : 'rejected'
  }
  return null
}

interface MandateChange {
  payerNumber: string
  payerName: string | null
  identityNumber: string | null
  status: MandateStatus | null
  statusText: string | null
  changedOn: string | null
  source: MandateSource
  /** Create the mandate when it is not known yet (an active or pending one). */
  createIfMissing: boolean
}

/** Applies one mandate change to the pool (and the database when applying), and reports it. */
async function changeMandate(
  supabase: SupabaseClient,
  input: ImportAutogiroReportInput,
  pool: MandateState[],
  keys: CustomerKeys,
  change: MandateChange,
): Promise<ReportMandateLine> {
  const existing = pool.find((m) => m.payer_number === change.payerNumber) ?? null
  let customerId = existing?.customer_id ?? null
  let linked = false
  if (!customerId) {
    const candidate = customerFor(keys, change.payerNumber, change.identityNumber)
    // One active mandate per customer: a second payer for the same customer stays for the person to link.
    if (candidate && !(change.status === 'active' && keys.withActive.has(candidate))) {
      customerId = candidate
      linked = true
    }
  }
  const line: ReportMandateLine = {
    payer_number: change.payerNumber,
    payer_name: change.payerName,
    status: change.status,
    previous_status: existing?.status ?? null,
    customer_id: customerId,
    customer_name: customerId ? (keys.names.get(customerId) ?? null) : null,
    linked,
    status_text: change.statusText,
  }
  if (!existing && !change.createIfMissing) return line

  const becomesActive = change.status === 'active' && existing?.status !== 'active'
  if (becomesActive && customerId && keys.withActive.has(customerId)) {
    // The customer already has another active mandate: keep this one unlinked.
    customerId = linked ? null : customerId
    line.customer_id = customerId
    line.customer_name = customerId ? (keys.names.get(customerId) ?? null) : null
    line.linked = false
  }

  if (!input.apply) return line
  if (existing) {
    const { error } = await supabase
      .from('autogiro_mandates')
      .update({
        status: change.status ?? existing.status,
        status_text: change.statusText,
        status_changed_on: change.changedOn,
        payer_name: change.payerName ?? existing.payer_name,
        customer_id: customerId,
      })
      .eq('id', existing.id)
      .eq('company_id', input.companyId)
    if (error) throw error
    if (change.status) existing.status = change.status
    existing.customer_id = customerId
  } else {
    const { data, error } = await supabase
      .from('autogiro_mandates')
      .insert({
        company_id: input.companyId,
        payer_number: change.payerNumber,
        source: change.source,
        status: change.status ?? 'pending',
        customer_id: customerId,
        payer_name: change.payerName,
        status_text: change.statusText,
        status_changed_on: change.changedOn,
      })
      .select('id')
      .single()
    if (error) throw error
    pool.push({
      id: (data as { id: string }).id,
      customer_id: customerId,
      payer_number: change.payerNumber,
      status: change.status ?? 'pending',
      payer_name: change.payerName,
    })
  }
  if (change.status === 'active' && customerId) keys.withActive.add(customerId)
  if (change.status && change.status !== 'active' && customerId && existing?.status === 'active') keys.withActive.delete(customerId)
  return line
}

async function readMandateReport(
  supabase: SupabaseClient,
  input: ImportAutogiroReportInput,
  report: AutogiroMandateNoticeReport | AutogiroMandateRegister,
  outcome: AutogiroReportOutcome,
): Promise<void> {
  const pool = await loadMandateStates(supabase, input.companyId)
  const keys = await loadCustomerKeys(supabase, input.companyId, pool)
  const changes: MandateChange[] = []
  if (report.kind === 'mandate_notice') {
    for (const section of report.sections) {
      for (const record of section.mandates) {
        const payerNumber = normalizePayerNumber(record.payer_number)
        if (!payerNumber) continue
        const status = noticeStatus(record.information_code, record.comment_code)
        changes.push({
          payerNumber,
          payerName: null,
          identityNumber: record.identity_number,
          status,
          statusText: [record.information, record.comment].filter(Boolean).join(' ') || null,
          changedOn: record.action_date,
          source: 'notice',
          createIfMissing: status === 'active',
        })
      }
    }
  } else {
    for (const record of report.mandates) {
      const payerNumber = normalizePayerNumber(record.payer_number)
      if (!payerNumber) continue
      changes.push({
        payerNumber,
        payerName: null,
        identityNumber: record.identity_number,
        status: record.status === 'approved' ? 'active' : 'pending',
        statusText: record.status === 'approved' ? 'Godkänt i Bankgirots medgivanderegister.' : 'Under förfrågan hos Bankgirot.',
        changedOn: record.changed_on ?? record.created_on,
        source: 'register',
        createIfMissing: true,
      })
    }
  }
  for (const change of changes) outcome.mandates.push(await changeMandate(supabase, input, pool, keys, change))
}

async function readInternetBankMandates(
  supabase: SupabaseClient,
  input: ImportAutogiroReportInput,
  settings: AutogiroSettings,
  report: AutogiroInternetBankReport,
  outcome: AutogiroReportOutcome,
): Promise<void> {
  const pool = await loadMandateStates(supabase, input.companyId)
  const keys = await loadCustomerKeys(supabase, input.companyId, pool)
  const answers: MandateInstruction[] = []

  for (const section of report.sections) {
    for (const record of section.mandates) {
      const payerNumber = normalizePayerNumber(record.payer_number)
      if (!payerNumber) {
        outcome.issues.push({ line: record.line, severity: 'warning', message: 'Betalaren angav inget giltigt betalarnummer. Avvisa medgivandet i Autogiro Online.' })
        continue
      }
      const answerable =
        !!record.bank_account && record.bank_account.clearing.length === 4 && !!record.identity_number && record.identity_number.length === 12
      const decided = input.decisions?.[payerNumber]
      const already = pool.find((m) => m.payer_number === payerNumber && m.status === 'active')
      const decision = decided ?? (already ? undefined : 'approve')
      const payerName = record.name_and_address[0] ?? null
      const status: MandateStatus | null = already ? null : decided === 'approve' ? 'active' : decided === 'reject' ? 'rejected' : 'pending'
      const statusText =
        decided === 'approve'
          ? 'Godkänt i Accounted. Ladda upp svarsfilen i banken inom 18 bankdagar.'
          : decided === 'reject'
            ? 'Avvisat i Accounted. Ladda upp svarsfilen i banken.'
            : 'Tecknat i internetbanken, väntar på svar (godkänn eller avvisa inom 18 bankdagar).'
      const line = await changeMandate(supabase, input, pool, keys, {
        payerNumber,
        payerName,
        identityNumber: record.identity_number,
        status,
        statusText: already ? null : statusText,
        changedOn: section.written_on,
        source: 'internet_bank',
        createIfMissing: !already,
      })
      line.decision = decision
      line.answerable = answerable
      outcome.mandates.push(line)

      if (decided && answerable && !already) {
        answers.push({
          kind: 'answer_internet_bank',
          payerNumber,
          account: record.bank_account!,
          identity: { kind: 'person', number: record.identity_number! },
          approve: decided === 'approve',
        })
      } else if (decided && !answerable) {
        outcome.issues.push({
          line: record.line,
          severity: 'warning',
          message: `Medgivandet för betalarnummer ${payerNumber} saknar konto eller personnummer i filen och kan inte besvaras här. Svara i Autogiro Online.`,
        })
      }
    }
  }

  if (input.apply && answers.length > 0) {
    outcome.answer_file = {
      filename: `autogiro-medgivandesvar-${input.today}.txt`,
      content: autogiroFile([mandateSection(payeeOf(settings), input.today, answers)]),
    }
  }
}

// ── Settling without a report ───────────────────────────────────────────

/**
 * The debits Accounted wrote whose payment day has come, as one deposit per
 * day: what the bank row will be when every debit of that day went through
 * (Bankgirot credits one deposit per payment day and bankgiro). For a company
 * that reads Bankgirot's reports in Autogiro Online rather than on file. The
 * BG Max attachment takes such a deposit only when a bank row has exactly its
 * amount, so a day where one debit failed or moves to a retry waits for the
 * report or the person.
 */
export async function depositsFromOwnDebits(
  supabase: SupabaseClient,
  companyId: string,
  today: string,
): Promise<{ deposits: AutogiroSettlementDeposit[]; debitIds: string[][] } | AutogiroFailure> {
  const settings = await loadAutogiroSettings(supabase, companyId)
  if (!settings) return { ok: false, code: 'AUTOGIRO_SETTINGS_MISSING' }
  const debits = await fetchAllRows<{
    id: string
    amount: number
    debit_date: string
    reference: string
    invoice: { customer: { name: string | null } | null } | null
  }>(({ from, to }) =>
    supabase
      .from('autogiro_debits')
      .select('id, amount, debit_date, reference, invoice:invoices(customer:customers(name))')
      .eq('company_id', companyId)
      .eq('status', 'sent')
      .lte('debit_date', today)
      .order('debit_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: Array<{ id: string; amount: number; debit_date: string; reference: string; invoice: { customer: { name: string | null } | null } | null }> | null
      error: { message: string } | null
    }>,
  )
  const byDay = new Map<string, typeof debits>()
  for (const d of debits) byDay.set(d.debit_date, [...(byDay.get(d.debit_date) ?? []), d])
  const deposits: AutogiroSettlementDeposit[] = []
  const debitIds: string[][] = []
  for (const [date, day] of byDay) {
    deposits.push({
      bankgiro: formatBankgiroNumber(settings.bankgiro),
      bank_account: null,
      date,
      serial: null,
      amount: roundOre(day.reduce((sum, d) => sum + Number(d.amount), 0)),
      currency: 'SEK',
      payments: day.map((d) => ({
        kind: 'payment',
        amount: Number(d.amount),
        payer_bankgiro: null,
        reference: d.reference,
        reference_code: '2',
        extra_references: [],
        message: 'Autogiro',
        payer_name: d.invoice?.customer?.name ?? null,
        payer_org_number: null,
        bgc_serial: null,
      })),
    })
    debitIds.push(day.map((d) => d.id))
  }
  return { deposits, debitIds }
}

/** The debits of a day whose deposit was found on the bank account: debited, as the bank shows. */
export async function markDebitsDebited(supabase: SupabaseClient, companyId: string, debitIds: string[], date: string): Promise<void> {
  if (debitIds.length === 0) return
  const { error } = await supabase
    .from('autogiro_debits')
    .update({ status: 'debited', status_date: date, status_text: 'Insättningen finns på bankkontot med exakt dagens summa.' })
    .in('id', debitIds)
    .eq('company_id', companyId)
    .eq('status', 'sent')
  if (error) throw error
}
