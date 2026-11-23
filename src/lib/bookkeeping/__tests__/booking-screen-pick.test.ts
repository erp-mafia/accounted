import { describe, expect, it } from 'vitest'
import { stagePickedProposal, takePickedProposal, type PickStorage } from '../booking-screen-pick'
import type { BookingProposal } from '../proposal'

function memory(): PickStorage & { size: () => number } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    size: () => map.size,
  }
}

const PROPOSAL = {
  template_id: 'office-supplies',
  source: 'manual',
  booking: { kind: 'template', template_id: 'office-supplies', category: 'expense_office' },
  name_sv: 'Kontorsmaterial',
  name_en: 'Office supplies',
  group: 'expense',
  debit_account: '6110',
  credit_account: '1930',
  confidence: 1,
  description_sv: '',
  risk_level: 'low',
  requires_review: false,
} as unknown as BookingProposal

describe('the proposal picked for a bank row', () => {
  it('reaches the booking screen of that row, once', () => {
    const storage = memory()
    stagePickedProposal('tx-1', PROPOSAL, storage)
    expect(takePickedProposal('tx-1', storage)).toEqual(PROPOSAL)
    expect(takePickedProposal('tx-1', storage)).toBeNull()
    expect(storage.size()).toBe(0)
  })

  it('is nothing for another row, and is gone after that read too', () => {
    const storage = memory()
    stagePickedProposal('tx-1', PROPOSAL, storage)
    expect(takePickedProposal('tx-2', storage)).toBeNull()
    expect(takePickedProposal('tx-1', storage)).toBeNull()
  })

  it('is nothing when what was stored is not a proposal', () => {
    const storage = memory()
    storage.setItem('accounted.booking-screen-pick', JSON.stringify({ transactionId: 'tx-1', proposal: { name_sv: 'x' } }))
    expect(takePickedProposal('tx-1', storage)).toBeNull()
    storage.setItem('accounted.booking-screen-pick', '{not json')
    expect(takePickedProposal('tx-1', storage)).toBeNull()
  })

  it('is nothing without storage', () => {
    expect(takePickedProposal('tx-1', null)).toBeNull()
  })
})
