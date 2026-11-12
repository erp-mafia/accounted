/**
 * The model reads mails and reports fields. These tests are about what happens
 * when it reports something it should not: an id we never offered, a filename
 * that is not there, a negative total, a date that is not a date. None of that
 * may reach the matcher, because the matcher trusts its inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))
const mockCreate = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateStructured: (...args: unknown[]) => mockCreate(...args) }),
}))

import { extractMailDocuments, mailExtractionLimitMs, MAIL_EXTRACTION_MIN_LIMIT_MS, type CandidateForReview } from '../mail-intelligence'
import { AI_CALL_LIMIT_MS, AiCallTimeoutError } from '@/lib/ai/call-limit'

/** A reply in the shape the AI service's structured call returns (unvalidated). */
function toolReply(input: unknown) {
  return {
    value: input,
    model: 'eu.anthropic.claude-sonnet-5',
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: null, cacheReadInputTokens: null },
  }
}

function candidate(overrides: Partial<CandidateForReview> = {}): CandidateForReview {
  return {
    messageId: 'msg-1',
    mailbox: 'invoice@arcim.io',
    subject: 'Fwd: Your receipt from Anthropic, PBC',
    from: 'jakob@example.com',
    receivedAt: '2026-08-01T10:00:00.000Z',
    bodyText: 'Vidarebefordrat meddelande Från: Anthropic, PBC Datum: mån 15 juni 2026 €180.00',
    attachmentNames: ['Receipt-2066.pdf'],
    ...overrides,
  }
}

function doc(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'msg-1',
    attachment_name: 'Receipt-2066.pdf',
    is_receipt: true,
    vendor: 'Anthropic, PBC',
    date: '2026-06-15',
    amount: 180,
    currency: 'eur',
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('extractMailDocuments', () => {
  it('reports the fields a matcher needs', async () => {
    mockCreate.mockResolvedValue(toolReply({ documents: [doc()] }))
    const [out] = await extractMailDocuments([candidate()])

    expect(out).toMatchObject({
      messageId: 'msg-1',
      attachmentName: 'Receipt-2066.pdf',
      vendor: 'Anthropic, PBC',
      date: '2026-06-15',
      amount: 180,
      currency: 'EUR',
    })
  })

  it('takes the purchase date from the mail, not the forwarding date', async () => {
    // The mail was forwarded in August; the purchase was in June. Matching on
    // the forwarding date is what made the old design miss five of six repeat
    // subscriptions.
    mockCreate.mockResolvedValue(toolReply({ documents: [doc()] }))
    const [out] = await extractMailDocuments([candidate({ receivedAt: '2026-08-01T10:00:00.000Z' })])
    expect(out.date).toBe('2026-06-15')
  })

  it('drops mail that is not an underlag', async () => {
    mockCreate.mockResolvedValue(
      toolReply({ documents: [doc({ is_receipt: false, vendor: null, amount: null })] }),
    )
    await expect(extractMailDocuments([candidate()])).resolves.toEqual([])
  })

  it('never reports a message id it was not given', async () => {
    mockCreate.mockResolvedValue(toolReply({ documents: [doc({ message_id: 'invented' })] }))
    await expect(extractMailDocuments([candidate()])).resolves.toEqual([])
  })

  it('rejects a filename that is not on the message', async () => {
    // An invented filename means it was guessing about the contents.
    mockCreate.mockResolvedValue(toolReply({ documents: [doc({ attachment_name: 'ghost.pdf' })] }))
    await expect(extractMailDocuments([candidate()])).resolves.toEqual([])
  })

  it('treats a missing amount as unknown rather than as zero', async () => {
    // Most receipts state their total only inside the PDF. Null must stay null:
    // a zero would score as an amount that disagrees with every transaction.
    mockCreate.mockResolvedValue(toolReply({ documents: [doc({ amount: null })] }))
    const [out] = await extractMailDocuments([candidate()])
    expect(out.amount).toBeNull()
  })

  it('discards a non-positive total as a misread', async () => {
    mockCreate.mockResolvedValue(toolReply({ documents: [doc({ amount: -180 })] }))
    const [out] = await extractMailDocuments([candidate()])
    expect(out.amount).toBeNull()
  })

  it('discards a date that is not a date', async () => {
    mockCreate.mockResolvedValue(toolReply({ documents: [doc({ date: 'juni 2026' })] }))
    const [out] = await extractMailDocuments([candidate()])
    expect(out.date).toBeNull()
  })

  it('reports one document per attachment in a batch forward', async () => {
    // "Fwd: Kvitton februari" carries five receipts for five purchases.
    mockCreate.mockResolvedValue(
      toolReply({
        documents: [
          doc({ attachment_name: 'a.pdf', amount: 162.02 }),
          doc({ attachment_name: 'b.pdf', amount: 425 }),
        ],
      }),
    )
    const out = await extractMailDocuments([candidate({ attachmentNames: ['a.pdf', 'b.pdf'] })])
    expect(out.map((d) => d.amount)).toEqual([162.02, 425])
  })

  it('refuses to guess which file, when the mail carries several', async () => {
    // Without a filename the caller would fetch attachment number one and hope.
    // On a batch forward that is a coin flip, so the document is dropped.
    mockCreate.mockResolvedValue(toolReply({ documents: [doc({ attachment_name: null })] }))
    await expect(
      extractMailDocuments([candidate({ attachmentNames: ['a.pdf', 'b.pdf', 'c.pdf'] })]),
    ).resolves.toEqual([])
  })

  it('still accepts a body-only receipt, where there is nothing to choose', async () => {
    mockCreate.mockResolvedValue(toolReply({ documents: [doc({ attachment_name: null })] }))
    const out = await extractMailDocuments([candidate({ attachmentNames: [] })])
    expect(out).toHaveLength(1)
  })

  it('accepts an array the model sent as a JSON string', async () => {
    mockCreate.mockResolvedValue(toolReply({ documents: JSON.stringify([doc()]) }))
    await expect(extractMailDocuments([candidate()])).resolves.toHaveLength(1)
  })

  it('reports nothing when the call fails', async () => {
    mockCreate.mockRejectedValue(new Error('bedrock timeout'))
    await expect(extractMailDocuments([candidate()])).resolves.toEqual([])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('brings a limit of its own that fits its 8 192-token answer: the service default would cut a healthy call', async () => {
    mockCreate.mockResolvedValue(toolReply({ documents: [doc()] }))
    await extractMailDocuments([candidate()])
    const [request] = mockCreate.mock.calls[0] as [{ signal?: AbortSignal; maxTokens: number }]
    expect(request.maxTokens).toBe(8192)
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(MAIL_EXTRACTION_MIN_LIMIT_MS).toBeGreaterThan(150_000)
    expect(mailExtractionLimitMs()).toBe(MAIL_EXTRACTION_MIN_LIMIT_MS)
    expect(mailExtractionLimitMs()).toBeGreaterThan(AI_CALL_LIMIT_MS)
  })

  it('takes the deployment\'s own limit when it is longer: a slow self-hosted model gets what every call gets', () => {
    vi.stubEnv('AI_CALL_TIMEOUT_SECONDS', '600')
    try {
      expect(mailExtractionLimitMs()).toBe(600_000)
      vi.stubEnv('AI_CALL_TIMEOUT_SECONDS', '60')
      expect(mailExtractionLimitMs()).toBe(MAIL_EXTRACTION_MIN_LIMIT_MS)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports a batch the model gave no answer on in time as an error: the same mails would be sent, and cut, every press', async () => {
    mockCreate.mockRejectedValue(new AiCallTimeoutError('call_limit', 180_000))
    await expect(extractMailDocuments([candidate()], 'company-1')).resolves.toEqual([])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ran out of time'), expect.objectContaining({ mails: 1, companyId: 'company-1' }))
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('only warns when the press\'s own time ran out first: the next press starts with a whole budget', async () => {
    mockCreate.mockRejectedValue(new AiCallTimeoutError('run_deadline', 40_000))
    await expect(extractMailDocuments([candidate()], 'company-1')).resolves.toEqual([])
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('end of the press'), expect.objectContaining({ mails: 1 }))
  })

  it('reports its own limit running out the same way', async () => {
    vi.useFakeTimers()
    try {
      mockCreate.mockImplementation(
        (req: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')))),
      )
      const call = extractMailDocuments([candidate()])
      await vi.advanceTimersByTimeAsync(MAIL_EXTRACTION_MIN_LIMIT_MS)
      await expect(call).resolves.toEqual([])
      expect(log.error).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call the model when there is nothing to read', async () => {
    await expect(extractMailDocuments([])).resolves.toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('goes through the metered AI service, labelled with the company it read for', async () => {
    // A direct SDK call is invisible in ai_usage_events: a pass over someone's
    // mailbox would cost money nobody could attribute.
    mockCreate.mockResolvedValue(toolReply({ documents: [doc()] }))
    await extractMailDocuments([candidate()], 'company-1')

    const [request] = mockCreate.mock.calls[0] as [Record<string, unknown>]
    expect(request).toMatchObject({
      tier: 'extraction',
      meter: { feature: 'receipt_hunt_mail', companyId: 'company-1' },
      schema: expect.objectContaining({ name: 'documents_in_mail' }),
    })
  })
})
