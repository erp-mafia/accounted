import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const emailMock = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
const resolveMemberEmailMock = vi.hoisted(() => vi.fn())
const getSenderForCompanyMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/email/service', () => ({ getEmailService: () => emailMock }))
vi.mock('@/lib/notifications/member-email', () => ({
  resolveMemberEmail: (...args: unknown[]) => resolveMemberEmailMock(...args),
}))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: (...args: unknown[]) => getSenderForCompanyMock(...args),
  getBaseUrlForBrand: () => 'https://app.example.test',
}))
vi.mock('@/lib/support', () => ({ getSupportRecipientEmail: () => 'ops@example.test' }))

import { runPeppolHealthCheck } from '@/lib/invoices/peppol-health'

const NOW = new Date('2026-09-29T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const failedDelivery = {
  id: 'delivery-failed',
  company_id: 'company-1',
  invoice_id: 'invoice-1',
  user_id: 'user-1',
  status: 'failed',
  status_at: ago(HOUR),
  status_detail: 'Validation error: BR-CO-15 <Invoice total>',
  terminal_at: ago(HOUR),
  created_at: ago(2 * HOUR),
  invoice: { invoice_number: '1042', status: 'sent', customer: { name: 'Kund AB' } },
}

const stuckDelivery = {
  ...failedDelivery,
  id: 'delivery-stuck',
  invoice_id: 'invoice-2',
  status: 'submission_accepted',
  status_at: ago(3 * HOUR),
  status_detail: null,
  terminal_at: null,
  invoice: { invoice_number: '1043', status: 'sent', customer: { name: 'Kund AB' } },
}

const retryStuckDelivery = {
  ...failedDelivery,
  id: 'delivery-retry',
  invoice_id: 'invoice-3',
  status: 'retryable_failure',
  status_at: ago(2 * HOUR),
  status_detail: 'Qvalia answered 503',
  terminal_at: null,
  invoice: { invoice_number: '1044', status: 'overdue', customer: null },
}

const unroutedDocument = {
  id: 'inbound-1',
  company_id: null,
  provider_document_id: 'qv-123',
  document_type: 'Invoice',
  status: 'unrouted',
  recipient_scheme: '0007',
  recipient_identifier: '5561234567',
  sender_name: 'Leverantör AB',
  last_error: null,
  created_at: ago(45 * MINUTE),
}

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log
}

/** The alert kinds the pre-claim read asks about, in the check's order (one query per kind with rows). */
function kindsAsked(answers: { failed?: unknown[]; stuck?: unknown[]; retry?: unknown[]; inbound?: unknown[] }): string[] {
  return [
    ...((answers.failed ?? []).length ? ['delivery_failed'] : []),
    ...((answers.stuck ?? []).length ? ['delivery_stuck'] : []),
    ...((answers.retry ?? []).length ? ['delivery_retry_stuck'] : []),
    ...((answers.inbound ?? []).length ? ['inbound_unrouted'] : []),
  ]
}
const firstKind = (answers: Parameters<typeof kindsAsked>[0]) => kindsAsked(answers)[0]

/** Service mock answering the rules in the order the check asks them. */
function setup(answers: {
  failed?: unknown[]
  stuck?: unknown[]
  retry?: unknown[]
  inbound?: unknown[]
  claimed?: Array<{ kind: string; ref_id: string }>
  claimError?: { message: string }
  /** Claims earlier runs made, read before claiming (one answer per kind asked about). */
  existing?: Array<{ ref_id: string }>
}) {
  const mock = createTableMockSupabase({
    peppol_deliveries: [
      { data: answers.failed ?? [] },
      { data: answers.stuck ?? [] },
      { data: answers.retry ?? [] },
    ],
    peppol_inbound_documents: { data: answers.inbound ?? [] },
    peppol_alerts: [
      ...kindsAsked(answers).map((kind) => ({ data: kind === firstKind(answers) ? (answers.existing ?? []) : [] })),
      answers.claimError ? { error: answers.claimError } : { data: answers.claimed ?? [] },
      { data: null },
    ],
    company_settings: { data: [{ company_id: 'company-1', company_name: 'Acme AB' }] },
  })
  return { ...mock, service: mock.supabase as unknown as SupabaseClient }
}

const sentMails = () => emailMock.sendEmail.mock.calls.map(([mail]) => mail as { to: string; subject: string; text: string; html: string; fromName?: string; replyTo?: string })

describe('runPeppolHealthCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    emailMock.isConfigured.mockReturnValue(true)
    emailMock.sendEmail.mockResolvedValue({ success: true })
    resolveMemberEmailMock.mockResolvedValue('owner@example.test')
    getSenderForCompanyMock.mockResolvedValue({ fromName: 'Byrån', fromAddress: null, replyTo: 'support@byran.example', brand: null })
  })

  it('claims nothing and reads nothing without an e-mail service, so the backlog is reported once one exists', async () => {
    emailMock.isConfigured.mockReturnValue(false)
    const { service, supabase } = setup({ failed: [failedDelivery] })
    const log = makeLog()

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: log as unknown as Logger })

    expect(summary.skipped).toBe('email_not_configured')
    expect(supabase.from).not.toHaveBeenCalled()
    expect(emailMock.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('claims a newly failed delivery, sends the team digest, then mails the sender in Swedish with a link to the invoice', async () => {
    const { service, findCall, findCalls } = setup({
      failed: [failedDelivery],
      claimed: [{ kind: 'delivery_failed', ref_id: 'delivery-failed' }],
    })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    // The rule: failed, terminal within the last 7 days.
    expect(findCalls('peppol_deliveries', 'eq')).toContainEqual(['status', 'failed'])
    expect(findCalls('peppol_deliveries', 'gte')).toContainEqual(['terminal_at', ago(7 * DAY)])
    // The claim: one statement, ON CONFLICT (kind, ref_id) DO NOTHING RETURNING.
    expect(findCall('peppol_alerts', 'upsert')).toEqual([
      [{ kind: 'delivery_failed', ref_id: 'delivery-failed', company_id: 'company-1' }],
      { onConflict: 'kind,ref_id', ignoreDuplicates: true },
    ])
    // First the read of earlier claims, then the claim's RETURNING.
    expect(findCalls('peppol_alerts', 'select')).toEqual([['ref_id'], ['kind, ref_id']])

    const [digest, senderMail] = sentMails()
    expect(sentMails()).toHaveLength(2)
    expect(digest.to).toBe('ops@example.test')
    expect(digest.subject).toBe('[accounted peppol] 1 nytt Peppol-problem')
    expect(digest.text).toContain('Leverans misslyckades | Acme AB (company-1) | faktura 1042 (leverans delivery-failed) | 1 tim | Validation error: BR-CO-15')

    expect(resolveMemberEmailMock).toHaveBeenCalledWith(service, 'company-1', 'user-1')
    expect(senderMail.to).toBe('owner@example.test')
    expect(senderMail.subject).toBe('Faktura 1042 kunde inte levereras via Peppol')
    expect(senderMail.text).toContain('Fakturan 1042 till Kund AB kunde inte levereras via Peppol.')
    expect(senderMail.text).toContain('Orsak: Validation error: BR-CO-15 <Invoice total>')
    expect(senderMail.text).toContain('"Skicka via Peppol"')
    expect(senderMail.text).toContain('skicka PDF:en till kunden via e-post')
    expect(senderMail.text).toContain('https://app.example.test/invoices/invoice-1')
    expect(senderMail.html).toContain('BR-CO-15 &lt;Invoice total&gt;')
    expect(senderMail.html).toContain('<a href="https://app.example.test/invoices/invoice-1">')
    // Sent in the company's brand.
    expect(senderMail).toMatchObject({ fromName: 'Byrån', replyTo: 'support@byran.example' })

    expect(summary).toMatchObject({
      skipped: null,
      found: { delivery_failed: 1, delivery_stuck: 0, delivery_retry_stuck: 0, inbound_unrouted: 0 },
      claimed: { delivery_failed: 1, delivery_stuck: 0, delivery_retry_stuck: 0, inbound_unrouted: 0 },
      digest: 'sent',
      senderMails: { sent: 1, failed: 0, noRecipient: 0 },
      released: 0,
    })
  })

  it('says the operator gave no reason when the delivery carries none', async () => {
    const { service } = setup({
      failed: [{ ...failedDelivery, status_detail: null }],
      claimed: [{ kind: 'delivery_failed', ref_id: 'delivery-failed' }],
    })
    await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })
    expect(sentMails()[1].text).toContain('Orsak: Operatören angav ingen orsak.')
  })

  it('mails nobody about a problem an earlier run already claimed', async () => {
    const { service } = setup({ failed: [failedDelivery], claimed: [] })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    expect(emailMock.sendEmail).not.toHaveBeenCalled()
    expect(resolveMemberEmailMock).not.toHaveBeenCalled()
    expect(summary.found.delivery_failed).toBe(1)
    expect(summary.claimed.delivery_failed).toBe(0)
    expect(summary.digest).toBe('none')
  })

  it('releases the claim of a sender mail that failed, so the next run retries it, and pages', async () => {
    emailMock.sendEmail
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'rate limited' })
    const { service, findCalls } = setup({
      failed: [failedDelivery],
      claimed: [{ kind: 'delivery_failed', ref_id: 'delivery-failed' }],
    })
    const log = makeLog()

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: log as unknown as Logger })

    expect(findCalls('peppol_alerts', 'delete')).toHaveLength(1)
    // The release is the last delete ... eq ... in (the read of earlier claims comes first).
    expect(findCalls('peppol_alerts', 'eq').slice(-1)).toEqual([['kind', 'delivery_failed']])
    expect(findCalls('peppol_alerts', 'in').slice(-1)).toEqual([['ref_id', ['delivery-failed']]])
    expect(summary).toMatchObject({ digest: 'sent', senderMails: { sent: 0, failed: 1, noRecipient: 0 }, released: 1 })
    expect(log.error).toHaveBeenCalledWith(
      'peppol health: sender mail failed, claim released for the next run',
      expect.objectContaining({ alert: true, deliveryId: 'delivery-failed', reason: 'rate limited' }),
    )
  })

  it('treats a sender mail that throws like one that failed', async () => {
    emailMock.sendEmail
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('socket hang up'))
    const { service, findCalls } = setup({
      failed: [failedDelivery],
      claimed: [{ kind: 'delivery_failed', ref_id: 'delivery-failed' }],
    })

    const log = makeLog()

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: log as unknown as Logger })

    expect(findCalls('peppol_alerts', 'delete')).toHaveLength(1)
    expect(summary).toMatchObject({ senderMails: { failed: 1 }, released: 1 })
    expect(log.error).toHaveBeenCalledWith(
      'peppol health: sender mail failed, claim released for the next run',
      expect.objectContaining({ alert: true, reason: 'socket hang up' }),
    )
  })

  it('releases every claim and mails no sender when the team digest fails, so nobody is mailed twice', async () => {
    emailMock.sendEmail.mockResolvedValue({ success: false, error: 'provider down' })
    const { service, findCalls } = setup({
      failed: [failedDelivery],
      stuck: [stuckDelivery],
      claimed: [
        { kind: 'delivery_failed', ref_id: 'delivery-failed' },
        { kind: 'delivery_stuck', ref_id: 'delivery-stuck' },
      ],
    })
    const log = makeLog()

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: log as unknown as Logger })

    expect(emailMock.sendEmail).toHaveBeenCalledTimes(1)
    expect(resolveMemberEmailMock).not.toHaveBeenCalled()
    expect(findCalls('peppol_alerts', 'eq').slice(-2)).toEqual([['kind', 'delivery_failed'], ['kind', 'delivery_stuck']])
    expect(findCalls('peppol_alerts', 'in').slice(-2)).toEqual([['ref_id', ['delivery-failed']], ['ref_id', ['delivery-stuck']]])
    expect(summary).toMatchObject({ digest: 'failed', released: 2, senderMails: { sent: 0, failed: 0, noRecipient: 0 } })
    expect(log.error).toHaveBeenCalledWith(
      'peppol health: team digest failed, claims released for the next run',
      expect.objectContaining({ alert: true, count: 2, reason: 'provider down' }),
    )
  })

  it('keeps the claim when the sender has no member address: the digest already told the team', async () => {
    resolveMemberEmailMock.mockResolvedValue(null)
    const { service, findCalls } = setup({
      failed: [failedDelivery],
      claimed: [{ kind: 'delivery_failed', ref_id: 'delivery-failed' }],
    })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    expect(emailMock.sendEmail).toHaveBeenCalledTimes(1)
    expect(findCalls('peppol_alerts', 'delete')).toHaveLength(0)
    expect(summary).toMatchObject({ digest: 'sent', senderMails: { sent: 0, failed: 0, noRecipient: 1 }, released: 0 })
  })

  it('reports a delivery the access point never answered about to the team only', async () => {
    const { service, findCalls } = setup({
      stuck: [stuckDelivery],
      claimed: [{ kind: 'delivery_stuck', ref_id: 'delivery-stuck' }],
    })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    // The rule: handed over (a provider submission id), silent for over an
    // hour, submitted within the poll's 45-day horizon.
    expect(findCalls('peppol_deliveries', 'in')).toContainEqual(['status', ['submitting', 'submission_accepted']])
    expect(findCalls('peppol_deliveries', 'not')).toContainEqual(['provider_submission_id', 'is', null])
    expect(findCalls('peppol_deliveries', 'lt')).toContainEqual(['status_at', ago(HOUR)])
    expect(findCalls('peppol_deliveries', 'gte')).toContainEqual(['submitted_at', ago(45 * DAY)])
    expect(sentMails()).toHaveLength(1)
    expect(sentMails()[0].text).toContain('Leverans utan svar från operatören | Acme AB (company-1) | faktura 1043 (leverans delivery-stuck) | 3 tim | ingen orsak angiven')
    // No failed invoice in this digest, so no word about a sender mail.
    expect(sentMails()[0].text).not.toContain('eget mejl')
    expect(resolveMemberEmailMock).not.toHaveBeenCalled()
    expect(summary.claimed.delivery_stuck).toBe(1)
  })

  it('reports a retryable failure nobody retried on an issued invoice to the team only', async () => {
    const { service, findCalls } = setup({
      retry: [retryStuckDelivery],
      claimed: [{ kind: 'delivery_retry_stuck', ref_id: 'delivery-retry' }],
    })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    expect(findCalls('peppol_deliveries', 'eq')).toContainEqual(['status', 'retryable_failure'])
    expect(findCalls('peppol_deliveries', 'lt')).toContainEqual(['status_at', ago(HOUR)])
    expect(findCalls('peppol_deliveries', 'gte')).toContainEqual(['created_at', ago(45 * DAY)])
    expect(findCalls('peppol_deliveries', 'in')).toContainEqual(['invoice.status', ['sent', 'overdue']])
    expect(sentMails()).toHaveLength(1)
    expect(sentMails()[0].text).toContain('Tillfälligt fel som ingen skickat om | Acme AB (company-1) | faktura 1044 (leverans delivery-retry) | 2 tim | Qvalia answered 503')
    expect(summary.claimed.delivery_retry_stuck).toBe(1)
  })

  it('reports an inbound document that reached no company, claimed without a company', async () => {
    const { service, findCall, findCalls } = setup({
      inbound: [unroutedDocument],
      claimed: [{ kind: 'inbound_unrouted', ref_id: 'inbound-1' }],
    })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    expect(findCalls('peppol_inbound_documents', 'in')).toContainEqual(['status', ['unrouted', 'failed']])
    expect(findCalls('peppol_inbound_documents', 'lt')).toContainEqual(['created_at', ago(30 * MINUTE)])
    expect(findCalls('peppol_inbound_documents', 'gte')).toContainEqual(['created_at', ago(30 * DAY)])
    expect(findCall('peppol_alerts', 'upsert')?.[0]).toEqual([
      { kind: 'inbound_unrouted', ref_id: 'inbound-1', company_id: null },
    ])
    expect(sentMails()).toHaveLength(1)
    expect(sentMails()[0].text).toContain(
      'Inkommande dokument har fastnat | inget bolag | Invoice qv-123 (dokument inbound-1, unrouted, mottagare 0007:5561234567, avsändare Leverantör AB) | 45 min | ingen orsak angiven',
    )
    expect(summary.claimed.inbound_unrouted).toBe(1)
  })

  it('lists every new problem in one digest per run', async () => {
    const { service } = setup({
      failed: [failedDelivery],
      stuck: [stuckDelivery],
      retry: [retryStuckDelivery],
      inbound: [unroutedDocument],
      claimed: [
        { kind: 'delivery_failed', ref_id: 'delivery-failed' },
        { kind: 'delivery_stuck', ref_id: 'delivery-stuck' },
        { kind: 'delivery_retry_stuck', ref_id: 'delivery-retry' },
        { kind: 'inbound_unrouted', ref_id: 'inbound-1' },
      ],
    })

    await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    const digests = sentMails().filter((mail) => mail.to === 'ops@example.test')
    expect(digests).toHaveLength(1)
    expect(digests[0].subject).toBe('[accounted peppol] 4 nya Peppol-problem')
    expect(digests[0].text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(4)
    // Only the failed delivery has a sender mail.
    expect(sentMails().filter((mail) => mail.to === 'owner@example.test')).toHaveLength(1)
  })

  it('skips a problem an earlier run claimed before claiming, so it is never mailed again', async () => {
    const { service, findCall } = setup({
      failed: [failedDelivery],
      existing: [{ ref_id: 'delivery-failed' }],
    })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    expect(findCall('peppol_alerts', 'upsert')).toBeUndefined()
    expect(emailMock.sendEmail).not.toHaveBeenCalled()
    expect(summary.found.delivery_failed).toBe(1)
    expect(summary.claimed.delivery_failed).toBe(0)
    expect(summary.deferred).toBe(0)
  })

  it('reads each rule newest first with a fixed row limit, and claims at most 50 new problems per run, oldest first', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...failedDelivery,
      id: `delivery-${String(i).padStart(2, '0')}`,
      terminal_at: ago((60 - i) * MINUTE),
      status_at: ago((60 - i) * MINUTE),
    }))
    const { service, findCall, findCalls } = setup({ failed: many, claimed: [] })

    const summary = await runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })

    expect(findCalls('peppol_deliveries', 'limit')).toContainEqual([500])
    expect(findCalls('peppol_deliveries', 'order')).toContainEqual(['terminal_at', { ascending: false }])
    const [claimRows] = findCall('peppol_alerts', 'upsert') as [Array<{ ref_id: string }>]
    expect(claimRows).toHaveLength(50)
    // Oldest first: delivery-00 is the oldest failure.
    expect(claimRows[0].ref_id).toBe('delivery-00')
    expect(claimRows.at(-1)?.ref_id).toBe('delivery-49')
    expect(summary.found.delivery_failed).toBe(60)
    expect(summary.deferred).toBe(10)
  })

  it('throws, mailing nothing, when the claim cannot be written', async () => {
    const { service } = setup({ failed: [failedDelivery], claimError: { message: 'permission denied' } })

    await expect(runPeppolHealthCheck(service, { now: NOW, log: makeLog() as unknown as Logger })).rejects.toThrow(
      /Failed to claim Peppol alerts: permission denied/,
    )
    expect(emailMock.sendEmail).not.toHaveBeenCalled()
  })
})
