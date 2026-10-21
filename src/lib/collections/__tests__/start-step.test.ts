import { describe, expect, it } from 'vitest'
import { resolveStartStep, startStepRefusalCode, startStepsFor } from '../start-step'

describe('start steps', () => {
  it('offers the reminder only on an invoice with an agreed reminder fee', () => {
    expect(startStepsFor(['reminder', 'collection'], true)).toEqual(['reminder', 'collection'])
    expect(startStepsFor(['reminder', 'collection'], false)).toEqual(['collection'])
    expect(startStepsFor(['reminder'], false)).toEqual([])
  })

  it('keeps the company default when the invoice may start there, else takes the first allowed step', () => {
    expect(resolveStartStep('reminder', ['reminder', 'collection'])).toBe('reminder')
    expect(resolveStartStep('reminder', ['collection'])).toBe('collection')
    expect(resolveStartStep('collection', ['reminder', 'collection'])).toBe('collection')
    expect(resolveStartStep('reminder', [])).toBeNull()
  })

  it('names why a step was refused', () => {
    expect(startStepRefusalCode('reminder', false)).toBe('COLLECTION_REMINDER_FEE_NOT_AGREED')
    expect(startStepRefusalCode('reminder', true)).toBe('COLLECTION_START_STEP_UNAVAILABLE')
    expect(startStepRefusalCode('collection', false)).toBe('COLLECTION_START_STEP_UNAVAILABLE')
  })
})
