/**
 * The model reads mails and reports fields. These tests are about what happens
 * when it reports something it should not: an id we never offered, a filename
 * that is not there, a negative total, a date that is not a date. None of that
 * may reach the matcher, because the matcher trusts its inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('@/lib/ai/provider', () => ({
  createAiClient: () => ({ messages: { create: (...args: unknown[]) => mockCreate(...args) } }),
  toProviderModelId: (id: string) => id,
}))

import { extractMailDocuments, type CandidateForReview } from '../mail-intelligence'

/** A reply in the shape forced tool use produces. */
function toolReply(input: unknown) {
  return { content: [{ type: 'tool_use', name: 'x', id: 'tu', input }] }
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
  })

  it('does not call the model when there is nothing to read', async () => {
    await expect(extractMailDocuments([])).resolves.toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
