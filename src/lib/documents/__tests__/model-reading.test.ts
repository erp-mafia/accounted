import { describe, expect, it } from 'vitest'
import { isModelExtraction, modelReadingOf, modelReadingToKeep } from '../model-reading'

const model = { supplier: { name: 'Telia' }, totals: { total: 500 } }
const person = { supplier: { name: 'Telia Sverige AB' }, totals: { total: 500 } }
const T1 = '2026-10-01T08:00:00.000Z'
const T2 = '2026-10-02T08:00:00.000Z'

describe('isModelExtraction', () => {
  it('takes a model id and refuses the skip and failure stamps', () => {
    expect(isModelExtraction('claude-sonnet')).toBe(true)
    expect(isModelExtraction('invoice-inbox')).toBe(true)
    expect(isModelExtraction('skipped:no_ai_entitlement')).toBe(false)
    expect(isModelExtraction('failed:no_raw_text')).toBe(false)
    expect(isModelExtraction('')).toBe(false)
    expect(isModelExtraction(null)).toBe(false)
  })
})

describe('modelReadingToKeep', () => {
  it("keeps the row's reading when a model wrote it and nothing is kept yet", () => {
    expect(modelReadingToKeep({ extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1, model_reading: null })).toEqual({
      extracted_data: model,
      extraction_model: 'claude-sonnet',
      extracted_at: T1,
    })
  })

  it('leaves a kept copy that belongs to the current extraction alone: the row already holds a correction', () => {
    const row = {
      extracted_data: person,
      extraction_model: 'claude-sonnet',
      extracted_at: T1,
      model_reading: { extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1 },
    }
    expect(modelReadingToKeep(row)).toBeUndefined()
  })

  it('replaces a stale copy: a new extraction wrote the row since', () => {
    const fresh = { supplier: { name: 'Telia AB' } }
    const row = {
      extracted_data: fresh,
      extraction_model: 'gemma',
      extracted_at: T2,
      model_reading: { extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1 },
    }
    expect(modelReadingToKeep(row)).toEqual({ extracted_data: fresh, extraction_model: 'gemma', extracted_at: T2 })
  })

  it('keeps nothing when no model ever read the document', () => {
    expect(modelReadingToKeep({ extracted_data: null, extraction_model: 'skipped:no_ai_entitlement', extracted_at: T1 })).toBeUndefined()
    expect(modelReadingToKeep({ extracted_data: model, extraction_model: 'failed:no_raw_text', extracted_at: T1 })).toBeUndefined()
    expect(modelReadingToKeep({ extracted_data: null, extraction_model: null, extracted_at: null })).toBeUndefined()
  })
})

describe('modelReadingOf', () => {
  it("reads the row's own reading while no correction was made", () => {
    expect(modelReadingOf({ extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1 })).toEqual({
      extracted_data: model,
      extraction_model: 'claude-sonnet',
      extracted_at: T1,
    })
  })

  it('reads the kept copy over a corrected row', () => {
    const row = {
      extracted_data: person,
      extraction_model: 'claude-sonnet',
      extracted_at: T1,
      model_reading: { extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1 },
    }
    expect(modelReadingOf(row)?.extracted_data).toBe(model)
  })

  it("ignores a stale copy and reads the newer extraction on the row", () => {
    const fresh = { supplier: { name: 'Telia AB' } }
    const row = {
      extracted_data: fresh,
      extraction_model: 'gemma',
      extracted_at: T2,
      model_reading: { extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1 },
    }
    expect(modelReadingOf(row)).toEqual({ extracted_data: fresh, extraction_model: 'gemma', extracted_at: T2 })
  })

  it('answers null when only a person read it, or for no row at all', () => {
    expect(modelReadingOf({ extracted_data: person, extraction_model: 'skipped:no_ai_entitlement', extracted_at: T1 })).toBeNull()
    expect(modelReadingOf(null)).toBeNull()
    expect(modelReadingOf({ extracted_data: model, extraction_model: 'claude-sonnet', model_reading: 'garbage' })).toMatchObject({ extracted_data: model })
  })
})
