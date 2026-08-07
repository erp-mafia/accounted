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
  harvestReceipts,
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

describe('harvestReceipts', () => {
  it('keeps a receipt it was actually offered', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        receipts: [
          { message_id: 'msg-1', attachment_name: 'Receipt-2066.pdf', reason: 'Kvitto från Anthropic.' },
        ],
      }),
    )
    const out = await harvestReceipts('Anthropic', [candidate()], 8)
    expect(out).toHaveLength(1)
    expect(out[0].attachmentName).toBe('Receipt-2066.pdf')
  })

  it('takes several attachments out of one batch forward', async () => {
    // "Fwd: Kvitton februari" carries five receipts for five purchases. Each
    // is its own underlag, so each must be fetched separately.
    mockCreate.mockResolvedValue(
      toolReply({
        receipts: [
          { message_id: 'msg-1', attachment_name: 'a.pdf', reason: 'a' },
          { message_id: 'msg-1', attachment_name: 'b.pdf', reason: 'b' },
        ],
      }),
    )
    const out = await harvestReceipts(
      'Anthropic',
      [candidate({ attachmentNames: ['a.pdf', 'b.pdf'] })],
      8,
    )
    expect(out).toHaveLength(2)
  })

  it('fetches the same invoice once however many times it was forwarded', async () => {
    // The original, the reminder and two forwards all carry the identical
    // attachment on four different messages. Keyed on the message we would
    // file the same invoice four times.
    mockCreate.mockResolvedValue(
      toolReply({
        receipts: [
          { message_id: 'msg-1', attachment_name: 'Invoice_13041840.pdf', reason: 'original' },
          { message_id: 'msg-2', attachment_name: 'Invoice_13041840.pdf', reason: 'påminnelse' },
          { message_id: 'msg-3', attachment_name: 'Invoice_13041840.pdf', reason: 'vidarebefordrad' },
        ],
      }),
    )
    const out = await harvestReceipts(
      'Visma',
      [
        candidate({ messageId: 'msg-1', attachmentNames: ['Invoice_13041840.pdf'] }),
        candidate({ messageId: 'msg-2', attachmentNames: ['Invoice_13041840.pdf'] }),
        candidate({ messageId: 'msg-3', attachmentNames: ['Invoice_13041840.pdf'] }),
      ],
      8,
    )
    expect(out).toHaveLength(1)
  })

  it('never fetches a message id it was not offered', async () => {
    mockCreate.mockResolvedValue(
      toolReply({ receipts: [{ message_id: 'invented', attachment_name: null, reason: 'x' }] }),
    )
    await expect(harvestReceipts('X', [candidate()], 8)).resolves.toEqual([])
  })

  it('rejects a filename that is not on the message', async () => {
    // An invented filename means it was guessing about the contents.
    mockCreate.mockResolvedValue(
      toolReply({ receipts: [{ message_id: 'msg-1', attachment_name: 'ghost.pdf', reason: 'x' }] }),
    )
    await expect(harvestReceipts('X', [candidate()], 8)).resolves.toEqual([])
  })

  it('honours the per-merchant cap so one mailbox cannot flood Underlag', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        receipts: Array.from({ length: 10 }, (_, i) => ({
          message_id: 'msg-1',
          attachment_name: `r${i}.pdf`,
          reason: 'kvitto',
        })),
      }),
    )
    const out = await harvestReceipts(
      'X',
      [candidate({ attachmentNames: Array.from({ length: 10 }, (_, i) => `r${i}.pdf`) })],
      3,
    )
    expect(out).toHaveLength(3)
  })

  it('fetches nothing when the call fails', async () => {
    mockCreate.mockRejectedValue(new Error('bedrock timeout'))
    await expect(harvestReceipts('X', [candidate()], 8)).resolves.toEqual([])
  })

  it('does not call the model when there is nothing to look at', async () => {
    await expect(harvestReceipts('X', [], 8)).resolves.toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
