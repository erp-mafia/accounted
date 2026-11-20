import { describe, expect, it } from 'vitest'
import { withLineDimensions } from '../payment-line-dimensions'

describe('withLineDimensions', () => {
  it('carries a copy of a non-empty bag', () => {
    const bag = { '6': 'P1', '1': 'KS1' }
    const carried = withLineDimensions(bag)
    expect(carried).toEqual({ dimensions: bag })
    expect(carried.dimensions).not.toBe(bag)
  })

  it('leaves an empty or missing bag off, so an untagged row stays untagged', () => {
    expect(withLineDimensions({})).toEqual({})
    expect(withLineDimensions(undefined)).toEqual({})
    expect(withLineDimensions(null)).toEqual({})
    expect('dimensions' in { account_number: '1930', ...withLineDimensions({}) }).toBe(false)
  })

  it('gives every row its own copy: editing one row never retags another', () => {
    const documentBag = { '6': 'P1' }
    const rowA = { account_number: '2440', ...withLineDimensions(documentBag) }
    const rowB = { account_number: '6570', ...withLineDimensions(documentBag) }
    rowA.dimensions!['6'] = 'P2'
    expect(rowB.dimensions).toEqual({ '6': 'P1' })
    expect(documentBag).toEqual({ '6': 'P1' })
  })
})
