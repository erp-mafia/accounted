import { describe, it, expect } from 'vitest'
import { closedByRefusalReason, personRefusalText, readApprovalRefusal, stripAgentWording } from '../approval-refusal'

describe('stripAgentWording', () => {
  it('drops a tool name in brackets and keeps its sentence', () => {
    expect(stripAgentWording('Matcha banktransaktionen mot fakturan (gnubok_match_transaction_to_invoice) i stället.')).toBe(
      'Matcha banktransaktionen mot fakturan i stället.',
    )
  })

  it('drops the sentence that names an argument, a tool or a raw code', () => {
    expect(stripAgentWording('Betalningen är redan bokförd. Kör om med allow_duplicate=true bara om det är en separat betalning.')).toBe(
      'Betalningen är redan bokförd.',
    )
    expect(stripAgentWording('Använd accounted_credit_invoice i stället.')).toBe('')
    expect(stripAgentWording('ENTRY_NOT_OPEN')).toBe('')
  })

  it('leaves a sentence for a person untouched, amounts and dates included', () => {
    const sentence = 'Fakturan på 1 234,50 kr förföll 2026-10-31. Den kan inte skickas igen.'
    expect(stripAgentWording(sentence)).toBe(sentence)
  })

  it('answers empty for nothing', () => {
    expect(stripAgentWording(null)).toBe('')
    expect(stripAgentWording(undefined)).toBe('')
  })
})

describe('personRefusalText', () => {
  it('is the Swedish sentence, or null for English and for agent wording only', () => {
    expect(personRefusalText('Underlaget är redan bokfört.')).toBe('Underlaget är redan bokfört.')
    expect(personRefusalText('Credit notes must be issued through the invoice send flow')).toBeNull()
    expect(personRefusalText('kör om med allow_duplicate=true')).toBeNull()
  })
})

describe('readApprovalRefusal', () => {
  it('reads the structured envelope: code, Swedish message, closed, details', () => {
    const refusal = readApprovalRefusal(
      { error: { code: 'INBOX_ITEM_ALREADY_BOOKED', message: 'Underlaget är redan bokfört.', details: { operation_status: 'rejected', journal_entry_id: 'je-1' } } },
      409,
    )
    expect(refusal).toMatchObject({ code: 'INBOX_ITEM_ALREADY_BOOKED', message: 'Underlaget är redan bokfört.', closed: true })
    expect(refusal.details.journal_entry_id).toBe('je-1')
  })

  it('reads the plain answer with operation_status beside the sentence', () => {
    expect(readApprovalRefusal({ error: 'Fakturan kunde inte hittas.', operation_status: 'rejected' }, 404)).toMatchObject({
      code: null,
      message: 'Fakturan kunde inte hittas.',
      closed: true,
    })
  })

  it('is not closed while the proposal is pending, or when the route did not say', () => {
    expect(readApprovalRefusal({ error: { code: 'SKATTEVERKET_NOT_CONNECTED', message: 'Sessionen har gått ut.', details: { operation_status: 'pending' } } }, 401).closed).toBe(false)
    expect(readApprovalRefusal({ error: 'Unauthorized' }, 401).closed).toBe(false)
    expect(readApprovalRefusal(null, 500).closed).toBe(false)
  })

  it('counts a partial commit as closed', () => {
    expect(readApprovalRefusal({ error: 'Något gick fel.', operation_status: 'failed_partial' }, 500).closed).toBe(true)
  })
})

describe('closedByRefusalReason', () => {
  it('is the stored reason of a proposal a refused approval closed, without agent wording', () => {
    expect(
      closedByRefusalReason({
        status: 'rejected',
        rejection_category: 'failed',
        result_data: { auto_rejected: true, reason: 'Fakturan är redan betald. Kör om med allow_duplicate=true.' },
      }),
    ).toBe('Fakturan är redan betald.')
    expect(
      closedByRefusalReason({ status: 'rejected', rejection_category: 'failed', result_data: { error: 'Underlaget kunde inte läsas.', http_status: 500 } }),
    ).toBe('Underlaget kunde inte läsas.')
  })

  it('is null for a person\'s rejection, an expiry, and an unreadable reason', () => {
    expect(closedByRefusalReason({ status: 'rejected', rejection_category: 'other', result_data: { reason: 'Fel konto.' } })).toBeNull()
    expect(closedByRefusalReason({ status: 'rejected', rejection_category: 'expired', result_data: { auto_rejected: true, reason: 'expired' } })).toBeNull()
    expect(closedByRefusalReason({ status: 'rejected', rejection_category: 'failed', result_data: { error: 'duplicate key value violates unique constraint', threw: true } })).toBeNull()
    expect(closedByRefusalReason({ status: 'committed', rejection_category: null, result_data: {} })).toBeNull()
  })
})
