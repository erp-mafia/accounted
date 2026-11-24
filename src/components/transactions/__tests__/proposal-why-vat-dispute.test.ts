/**
 * A suggestion whose reverse charge the assistant reads into another box
 * carries a second reason after the first. It said what the system saw
 * ("the assistant's read gives another VAT box"); it now says what the
 * person should do with it: check the VAT.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const source = fs.readFileSync(path.resolve(__dirname, '../proposal-why.ts'), 'utf8')

describe('the reason on a suggestion with a disputed VAT box', () => {
  it('tells the person to check the VAT', () => {
    expect(sv.tx_quick_review.rec_why_box_disputed).toBe('kontrollera momsen, assistenten läser den annorlunda')
    expect(en.tx_quick_review.rec_why_box_disputed).toBe('check the VAT, the assistant reads it differently')
  })

  it('is appended only when the read disputes the box', () => {
    expect(source).toMatch(/if \(reverseChargeBoxDispute\(p\)\) return `\$\{text\} · \$\{t\('rec_why_box_disputed'\)\}`/)
  })

  it('says a learned pair\'s box is unconfirmed only when no read disputes it', () => {
    expect(source).toMatch(/return p\.reverse_charge_box_unconfirmed \? `\$\{text\} · \$\{t\('rec_why_box_unconfirmed'\)\}` : text/)
    expect(sv.tx_quick_review.rec_why_box_unconfirmed).toBeTruthy()
    expect(en.tx_quick_review.rec_why_box_unconfirmed).toBeTruthy()
  })
})
