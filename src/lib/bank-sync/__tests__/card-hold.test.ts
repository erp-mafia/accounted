import { describe, it, expect } from 'vitest'
import { isNordeaCardHold } from '../card-hold'

describe('isNordeaCardHold (crm#2076)', () => {
  it("is a Nordea row whose text starts with 'Reservation '", () => {
    expect(isNordeaCardHold('Nordea', 'Reservation Kortköp FACEBK *7K4XZ2PQ9M')).toBe(true)
    expect(isNordeaCardHold(' nordea corporate ', '  Reservation Kortköp SKOAFFAREN')).toBe(true)
    expect(isNordeaCardHold('Nordea First Card', 'Reservation Kortköp TIDNINGSBUTIKEN')).toBe(true)
  })

  it('is never a settled purchase that carries the word, nor another bank, nor an unknown one', () => {
    expect(isNordeaCardHold('Nordea', 'Kortköp 260824 Hotel Reservation')).toBe(false)
    expect(isNordeaCardHold('Nordea', 'Invoice no: 12 Reservation no: 1000001')).toBe(false)
    expect(isNordeaCardHold('Nordea', 'Reservationsavgift')).toBe(false)
    expect(isNordeaCardHold('Handelsbanken', 'Reservation Kortköp FACEBK *7K4XZ2PQ9M')).toBe(false)
    expect(isNordeaCardHold('Nordeax Bank', 'Reservation Kortköp FACEBK *7K4XZ2PQ9M')).toBe(false)
    expect(isNordeaCardHold(null, 'Reservation Kortköp FACEBK *7K4XZ2PQ9M')).toBe(false)
    expect(isNordeaCardHold(undefined, 'Reservation Kortköp FACEBK *7K4XZ2PQ9M')).toBe(false)
  })
})
