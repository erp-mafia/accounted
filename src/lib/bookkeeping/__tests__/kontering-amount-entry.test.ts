import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { balancingProposalSide, negativeAmountMove } from '../kontering-amount-entry'

describe('negativeAmountMove', () => {
  it('moves a minus debit to kredit as a positive figure', () => {
    expect(negativeAmountMove('debit_amount', '-80')).toEqual({ side: 'credit_amount', value: '80' })
  })

  it('moves a minus credit to debet and keeps the decimals as typed', () => {
    expect(negativeAmountMove('credit_amount', ' -80.50 ')).toEqual({ side: 'debit_amount', value: '80.50' })
  })

  it.each(['', '80', '0', '-0', '-', 'abc'])('leaves %j where it is', (text) => {
    expect(negativeAmountMove('debit_amount', text)).toBeNull()
  })
})

describe('balancingProposalSide', () => {
  it('proposes in debet when the debit side is short and focus is there', () => {
    expect(balancingProposalSide('debit_amount', 80)).toBe('debit_amount')
  })

  it('proposes in kredit when the credit side is short, from either column', () => {
    expect(balancingProposalSide('debit_amount', -80)).toBe('credit_amount')
    expect(balancingProposalSide('credit_amount', -80)).toBe('credit_amount')
  })

  it('proposes nothing in debet for someone standing in kredit', () => {
    expect(balancingProposalSide('credit_amount', 80)).toBeNull()
  })

  it('proposes nothing when the other rows balance', () => {
    expect(balancingProposalSide('debit_amount', 0)).toBeNull()
  })
})

describe('the doors', () => {
  const root = path.resolve(__dirname, '../../../')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

  it('the shared editor moves a minus figure when the field is left, for every dialog', () => {
    expect(read('components/bookkeeping/KonteringLinesEditor.tsx')).toContain('negativeAmountMove(')
  })

  it('the verifikat form proposes through balancingProposalSide', () => {
    expect(read('components/bookkeeping/JournalEntryForm.tsx')).toContain('balancingProposalSide(')
  })
})
