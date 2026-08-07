/**
 * The model's answer is a suggestion, not an instruction.
 *
 * Everything here is about what happens when it is wrong: an invented message
 * id must never be fetched, an invented filename must never be trusted, and a
 * failed call must cost nothing rather than propose something. The one case
 * that must NOT be rejected is a batch forward serving several purchases, which
 * is how receipts actually arrive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: class {
    messages = { create: (...args: unknown[]) => mockCreate(...args) }
  },
}))

import {
  assignReceipts,
  planMerchantGroups,
  type CandidateForReview,
  type PurchaseDescriptor,
} from '../mail-intelligence'

/** A reply in the shape forced tool use produces. */
function toolReply(input: unknown) {
  return { content: [{ type: 'tool_use', name: 'x', id: 'tu', input }] }
}

function purchase(id: string, overrides: Partial<PurchaseDescriptor> = {}): PurchaseDescriptor {
  return {
    id,
    description: 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO Kortköp/uttag',
    amount: 2014.32,
    currency: 'SEK',
    date: '2026-06-16',
    ...overrides,
  }
}

function candidate(overrides: Partial<CandidateForReview> = {}): CandidateForReview {
  return {
    messageId: 'msg-1',
    mailbox: 'invoice@arcim.io',
    subject: 'Fwd: Your receipt from Anthropic, PBC',
    from: 'jakob@example.com',
    receivedAt: '2026-06-15T16:41:46.000Z',
    snippet: 'Forwarded message Date: mån 15 juni 2026',
    attachmentNames: ['Receipt-2066.pdf'],
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('planMerchantGroups', () => {
  it('drops groups the model marked unsearchable', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        groups: [
          { brand: 'Anthropic', aliases: ['Anthropic'], transaction_ids: ['t1'], searchable: true },
          { brand: 'Skatteverket', aliases: [], transaction_ids: ['t2'], searchable: false },
        ],
      }),
    )
    const groups = await planMerchantGroups([purchase('t1'), purchase('t2')])
    expect(groups).toHaveLength(1)
    expect(groups[0].brand).toBe('Anthropic')
  })

  it('refuses a transaction id it was never given', async () => {
    // A hallucinated id would otherwise become a query for a purchase that
    // does not exist in this run.
    mockCreate.mockResolvedValue(
      toolReply({
        groups: [
          { brand: 'Sting', aliases: ['Sting'], transaction_ids: ['t1', 'not-ours'], searchable: true },
        ],
      }),
    )
    const groups = await planMerchantGroups([purchase('t1')])
    expect(groups[0].transactionIds).toEqual(['t1'])
  })

  it('accepts an array the model sent as a JSON string', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        groups: JSON.stringify([
          { brand: 'Sting', aliases: ['Sting'], transaction_ids: ['t1'], searchable: true },
        ]),
      }),
    )
    const groups = await planMerchantGroups([purchase('t1')])
    expect(groups).toHaveLength(1)
  })

  it('proposes nothing when the call fails', async () => {
    mockCreate.mockRejectedValue(new Error('bedrock throttled'))
    await expect(planMerchantGroups([purchase('t1')])).resolves.toEqual([])
  })
})

describe('assignReceipts', () => {
  it('keeps a well-evidenced pairing', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        assignments: [
          {
            transaction_id: 't1',
            message_id: 'msg-1',
            attachment_name: 'Receipt-2066.pdf',
            amount_matches: true,
            reason: 'Originaldatumet matchar köpet.',
          },
        ],
      }),
    )
    const out = await assignReceipts('Anthropic', [purchase('t1')], [candidate()])
    expect(out).toHaveLength(1)
    expect(out[0].attachmentName).toBe('Receipt-2066.pdf')
  })

  it('lets one forwarded mail serve two purchases through different files', async () => {
    // "Fwd: Kvitton februari" carries five receipts for five purchases. Keying
    // suppression on the message would silently drop four of them.
    mockCreate.mockResolvedValue(
      toolReply({
        assignments: [
          { transaction_id: 't1', message_id: 'msg-1', attachment_name: 'a.pdf', amount_matches: true, reason: 'a' },
          { transaction_id: 't2', message_id: 'msg-1', attachment_name: 'b.pdf', amount_matches: true, reason: 'b' },
        ],
      }),
    )
    const out = await assignReceipts(
      'Anthropic',
      [purchase('t1'), purchase('t2')],
      [candidate({ attachmentNames: ['a.pdf', 'b.pdf'] })],
    )
    expect(out).toHaveLength(2)
  })

  it('still refuses to use the same file for two purchases', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        assignments: [
          { transaction_id: 't1', message_id: 'msg-1', attachment_name: 'a.pdf', amount_matches: true, reason: 'a' },
          { transaction_id: 't2', message_id: 'msg-1', attachment_name: 'a.pdf', amount_matches: true, reason: 'a' },
        ],
      }),
    )
    const out = await assignReceipts(
      'Anthropic',
      [purchase('t1'), purchase('t2')],
      [candidate({ attachmentNames: ['a.pdf'] })],
    )
    expect(out).toHaveLength(1)
  })

  it('never fetches a message id it was not offered', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        assignments: [
          { transaction_id: 't1', message_id: 'invented', attachment_name: null, amount_matches: true, reason: 'x' },
        ],
      }),
    )
    await expect(assignReceipts('X', [purchase('t1')], [candidate()])).resolves.toEqual([])
  })

  it('rejects a filename that is not on the message', async () => {
    // An invented filename means it was guessing, whatever the confidence says.
    mockCreate.mockResolvedValue(
      toolReply({
        assignments: [
          { transaction_id: 't1', message_id: 'msg-1', attachment_name: 'ghost.pdf', amount_matches: true, reason: 'x' },
        ],
      }),
    )
    await expect(assignReceipts('X', [purchase('t1')], [candidate()])).resolves.toEqual([])
  })

  it('puts an amount-verified pairing ahead of a merely plausible one', async () => {
    // The reviewer should meet the certain ones first: an amount that appears
    // in the mail is the strongest evidence available, and unlike a date it
    // does not drift.
    mockCreate.mockResolvedValue(
      toolReply({
        assignments: [
          { transaction_id: 't1', message_id: 'msg-1', attachment_name: 'a.pdf', amount_matches: false, reason: 'kanske' },
          { transaction_id: 't2', message_id: 'msg-1', attachment_name: 'b.pdf', amount_matches: true, reason: 'beloppet står i mejlet' },
        ],
      }),
    )
    const out = await assignReceipts(
      'Anthropic',
      [purchase('t1'), purchase('t2')],
      [candidate({ attachmentNames: ['a.pdf', 'b.pdf'] })],
    )
    expect(out.map((a) => a.transactionId)).toEqual(['t2', 't1'])
  })

  it('proposes nothing when the call fails', async () => {
    mockCreate.mockRejectedValue(new Error('bedrock timeout'))
    await expect(assignReceipts('X', [purchase('t1')], [candidate()])).resolves.toEqual([])
  })

  it('does not call the model when there is nothing to decide', async () => {
    await expect(assignReceipts('X', [purchase('t1')], [])).resolves.toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
