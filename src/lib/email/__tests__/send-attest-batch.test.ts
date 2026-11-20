import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the batched attest mail and the registrant notice make of a send
 * (crm#1569): a send that may have gone out (no answer in time, a lost
 * reply, SendEmailResult.outcomeUnknown not false) reads as unknown, which
 * the jobs record as sent: never twice. Only a definite refusal is worth
 * another try, and without a mail service no try ever is.
 */

const sendEmail = vi.fn()
const isConfigured = vi.fn()
const getEmailService = vi.fn()
vi.mock('@/lib/email/service', () => ({ getEmailService: (...a: unknown[]) => getEmailService(...a) }))
const getSenderForCompany = vi.fn()
vi.mock('@/lib/email/brand-sender', () => ({ getSenderForCompany: (...a: unknown[]) => getSenderForCompany(...a) }))

import { ATTEST_SEND_TIMEOUT_MS, sendAttestBatchMail, sendAttestNoticeMail } from '../send-attest-batch'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never
const invoice = { supplierName: 'Möbelfirman AB', invoiceNumber: '1', arrivalNumber: 7, total: 100, currency: 'SEK', dueDate: '2026-11-05' }
const batchMail = () =>
  sendAttestBatchMail({
    companyId: 'c1',
    email: 'kim@client.example',
    log,
    data: { kind: 'request', companyName: 'Kundbolaget AB', invoices: [invoice], registeredBy: null, url: 'https://byra.accounted.se/attest/lista/t' },
  })
const notice = () =>
  sendAttestNoticeMail({
    companyId: 'c1',
    email: 'alex@byra.example',
    log,
    data: { kind: 'overdue', companyName: 'Kundbolaget AB', invoices: [invoice], url: 'https://byra.accounted.se/supplier-invoices?tab=registered', reason: 'registrant' },
  })

describe('the attest mail sender', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getEmailService.mockResolvedValue({ sendEmail: (...a: unknown[]) => sendEmail(...a), isConfigured: () => isConfigured() })
    isConfigured.mockReturnValue(true)
    getSenderForCompany.mockResolvedValue({ fromName: 'Byrån', fromAddress: 'noreply@byra.example', replyTo: null, brand: { appName: 'Byrån' } })
  })
  afterEach(() => vi.useRealTimers())

  it('answers sent when the provider took it', async () => {
    sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
    expect(await batchMail()).toEqual({ outcome: 'sent' })
  })

  it('answers unknown when the mail may have gone out: a lost or late answer, a server error, a throw', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'socket hang up', outcomeUnknown: true })
    expect(await batchMail()).toEqual({ outcome: 'unknown' })
    // The service could not tell: read as unknown.
    sendEmail.mockResolvedValue({ success: false, error: 'boom' })
    expect(await batchMail()).toEqual({ outcome: 'unknown' })
    sendEmail.mockRejectedValue(new Error('fetch failed'))
    expect(await batchMail()).toEqual({ outcome: 'unknown' })
    sendEmail.mockResolvedValue({ success: false, error: 'Gateway timeout', outcomeUnknown: true })
    expect(await notice()).toEqual({ outcome: 'unknown' })
  })

  it('answers unknown when the provider does not answer in time', async () => {
    vi.useFakeTimers()
    sendEmail.mockReturnValue(new Promise(() => {}))
    const pending = batchMail()
    await vi.advanceTimersByTimeAsync(ATTEST_SEND_TIMEOUT_MS)
    expect(await pending).toEqual({ outcome: 'unknown' })
  })

  it('answers refused only when nothing went out: the provider said no, or the mail was never handed over', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'Invalid `to` field', outcomeUnknown: false })
    expect(await batchMail()).toEqual({ outcome: 'refused' })
    expect(await notice()).toEqual({ outcome: 'refused' })
    getSenderForCompany.mockRejectedValue(new Error('brand not readable'))
    sendEmail.mockClear()
    expect(await batchMail()).toEqual({ outcome: 'refused' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('answers refused when the mail service cannot even be reached (lib/init failed): nothing went out', async () => {
    getEmailService.mockRejectedValue(new Error('init failed'))
    expect(await batchMail()).toEqual({ outcome: 'refused' })
    expect(await notice()).toEqual({ outcome: 'refused' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('answers unavailable without a mail service', async () => {
    isConfigured.mockReturnValue(false)
    expect(await batchMail()).toEqual({ outcome: 'unavailable' })
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
