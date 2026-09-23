import { describe, it, expect } from 'vitest'
import { isPaymentText, merchantKey, merchantLabel } from '../merchant-key'

describe('merchantKey', () => {
  it('makes one key of the ways a bank spells a counterparty', () => {
    expect(merchantKey('ALMI FÖRETAG Autogiro')).toBe('almi företag')
    expect(merchantKey('ALMI FÖRETAG')).toBe('almi företag')
    expect(merchantKey('MR Cake Stockholm K3667 Kortköp')).toBe('mr cake stockholm')
    expect(merchantKey('WISPR           K3667 Kortköp/')).toBe('wispr')
    expect(merchantKey('BOLAGSVERKET    K3667 Kortköp/')).toBe('bolagsverket')
    expect(merchantKey('ANTHROPIC* CLAUDE SUB SAN FRANCISCO')).toBe('anthropic')
  })

  it('drops legal suffixes so a party name and the bank text meet', () => {
    expect(merchantKey('Higgsfield Inc.')).toBe('higgsfield')
    expect(merchantKey('Apple Retail Sweden AB')).toBe('apple retail sweden')
    expect(merchantKey('Framer B.V.')).toBe('framer')
    expect(merchantKey('Anthropic, PBC')).toBe('anthropic')
  })

  it('leaves nothing for a bare reference, and keeps a real name', () => {
    expect(merchantKey('1260424603197 Pris betalning')).toBe('')
    expect(merchantKey('1511768101')).toBe('')
    expect(merchantKey(null)).toBe('')
    expect(merchantKey('SKATTEVERKET')).toBe('skatteverket')
  })

  it('labels the node from the key', () => {
    expect(merchantLabel('ALMI FÖRETAG Autogiro')).toBe('Almi Företag')
    expect(merchantLabel('MR Cake Stockholm K3667 Kortköp')).toBe('MR Cake Stockholm')
    expect(merchantLabel('WISPR           K3667 Kortköp/')).toBe('Wispr')
  })
})

describe('isPaymentText', () => {
  it('knows a salary transfer, the bank\'s own "Utbetalning" and an own withdrawal name no payee', () => {
    expect(isPaymentText(merchantKey('LÖN Juli Emil Överföring VIA Internet'))).toBe(true)
    expect(isPaymentText(merchantKey('Utbetalning'))).toBe(true)
    expect(isPaymentText(merchantKey('Eget uttag'))).toBe(true)
    expect(isPaymentText(merchantKey('Överföring 1234 56 789'))).toBe(true)
    expect(isPaymentText(merchantKey('Inbetalning AV Aktiekapital'))).toBe(true)
  })

  it('keeps a real payee, however vague', () => {
    expect(isPaymentText(merchantKey('Konsult'))).toBe(false)
    expect(isPaymentText(merchantKey('ALMI FÖRETAG Autogiro'))).toBe(false)
    expect(isPaymentText(merchantKey('SKATTEVERKET'))).toBe(false)
    expect(isPaymentText('')).toBe(false)
  })
})
