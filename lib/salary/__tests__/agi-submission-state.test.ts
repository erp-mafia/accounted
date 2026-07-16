import { describe, expect, it } from 'vitest'
import { deriveAgiFilingState } from '../agi-submission-state'

describe('deriveAgiFilingState', () => {
  const bare = { agi_generated_at: null, agi_submitted_at: null }
  const generated = { agi_generated_at: '2026-07-13T09:48:58Z', agi_submitted_at: null }

  it('returns none when nothing has happened', () => {
    expect(deriveAgiFilingState(bare, null)).toBe('none')
    expect(deriveAgiFilingState(bare, undefined)).toBe('none')
    expect(deriveAgiFilingState(bare, {})).toBe('none')
  })

  it('returns generated when only the XML exists', () => {
    expect(deriveAgiFilingState(generated, null)).toBe('generated')
  })

  it('follows the submission record through the filing steps', () => {
    expect(deriveAgiFilingState(generated, { status: 'underlag_submitted' })).toBe(
      'underlag_submitted',
    )
    expect(deriveAgiFilingState(generated, { status: 'awaiting_signing' })).toBe(
      'awaiting_signing',
    )
    expect(deriveAgiFilingState(generated, { status: 'signed' })).toBe('signed')
  })

  it('treats a rejected underlag as back-to-generated', () => {
    expect(deriveAgiFilingState(generated, { status: 'underlag_rejected' })).toBe('generated')
  })

  it('a rejected underlag with no generated XML falls back to none', () => {
    expect(deriveAgiFilingState(bare, { status: 'underlag_rejected' })).toBe('none')
  })

  it('run.agi_submitted_at is authoritative over a stale submission record', () => {
    const filed = { agi_generated_at: '2026-07-13T09:48:58Z', agi_submitted_at: '2026-07-13T10:02:11Z' }
    expect(deriveAgiFilingState(filed, null)).toBe('signed')
    expect(deriveAgiFilingState(filed, { status: 'awaiting_signing' })).toBe('signed')
    expect(deriveAgiFilingState(filed, { status: 'underlag_submitted' })).toBe('signed')
  })

  it('a signed submission record counts even before the run row is stamped', () => {
    expect(deriveAgiFilingState(generated, { status: 'signed', kvittensnummer: 'abc-123' })).toBe(
      'signed',
    )
  })
})
