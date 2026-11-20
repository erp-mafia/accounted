import { describe, expect, it } from 'vitest'
import { operationNumberField, operationNumberOf } from '../operation-number'

describe('operationNumberOf', () => {
  it('reads the number the database assigned', () => {
    expect(operationNumberOf({ operation_number: 1 })).toBe(1)
    expect(operationNumberOf({ operation_number: 2357 })).toBe(2357)
  })

  it('is null on a row read before the column exists and on a proposal decided before it', () => {
    expect(operationNumberOf({})).toBeNull()
    expect(operationNumberOf({ operation_number: null })).toBeNull()
    expect(operationNumberOf(null)).toBeNull()
    expect(operationNumberOf(undefined)).toBeNull()
  })

  it('takes nothing but a positive whole number for one', () => {
    for (const value of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '128', true, {}]) {
      expect(operationNumberOf({ operation_number: value })).toBeNull()
    }
  })
})

describe('operationNumberField', () => {
  it('spreads the number into an answer, and nothing when there is none', () => {
    expect({ staged: true, ...operationNumberField({ operation_number: 128 }) }).toEqual({ staged: true, operation_number: 128 })
    expect({ staged: true, ...operationNumberField({}) }).toEqual({ staged: true })
    expect({ staged: true, ...operationNumberField({ operation_number: null }) }).toEqual({ staged: true })
  })
})
