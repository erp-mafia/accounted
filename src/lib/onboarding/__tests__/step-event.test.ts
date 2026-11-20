import { describe, expect, it } from 'vitest'
import { nextStepEvent, ONBOARDING_STEP_EVENT, type OnboardingStepInput } from '../step-event'

const company = (step: string, extra: Partial<OnboardingStepInput> = {}): OnboardingStepInput => ({
  journey: 'company',
  step,
  ready: true,
  mode: 'first',
  ...extra,
})

describe('onboarding step events', () => {
  it('uses one event name for both journeys', () => {
    expect(ONBOARDING_STEP_EVENT).toBe('onboarding_step_viewed')
  })

  it('sends nothing before the draft is restored, then the restored step', () => {
    expect(nextStepEvent(null, company('orgnr', { ready: false }))).toBeNull()
    expect(nextStepEvent(null, company('momsyn'))).toEqual({
      key: 'company:momsyn',
      properties: { journey: 'company', step: 'momsyn', mode: 'first' },
    })
  })

  it('sends once per step entry: not again for the same step, again after going back to it', () => {
    const first = nextStepEvent(null, company('orgnr'))
    expect(first?.key).toBe('company:orgnr')
    // An effect re-run (StrictMode, a re-render) with the step unchanged.
    expect(nextStepEvent('company:orgnr', company('orgnr'))).toBeNull()
    // A property that changes inside the step is not a new entry.
    expect(nextStepEvent('company:orgnr', company('orgnr', { entityType: 'aktiebolag' }))).toBeNull()
    const next = nextStepEvent('company:orgnr', company('name', { entityType: 'aktiebolag' }))
    expect(next?.properties).toEqual({ journey: 'company', step: 'name', mode: 'first', entity_type: 'aktiebolag' })
    // Tillbaka or the browser back to a step already seen is a new entry.
    expect(nextStepEvent('company:name', company('orgnr'))?.key).toBe('company:orgnr')
  })

  it('keeps the two journeys apart, with the books branch and provider', () => {
    const books = nextStepEvent('company:done', {
      journey: 'books',
      step: 'bank-accounts',
      ready: true,
      path: 'migration',
      provider: 'bjornlunden',
    })
    expect(books).toEqual({
      key: 'books:bank-accounts',
      properties: { journey: 'books', step: 'bank-accounts', path: 'migration', provider: 'bjornlunden' },
    })
  })

  it('leaves out unknown branches instead of sending empty values', () => {
    expect(nextStepEvent(null, { journey: 'books', step: 'source', ready: true, path: null, provider: null })?.properties)
      .toEqual({ journey: 'books', step: 'source' })
  })

  it('never sends a value that is not id-shaped: no org number, name or e-mail gets through', () => {
    const event = nextStepEvent(null, company('orgnr', {
      mode: '556677-8899',
      entityType: 'Anna Andersson',
      path: 'anna@example.se',
      provider: '19900101-1234',
    }))
    expect(event?.properties).toEqual({ journey: 'company', step: 'orgnr' })
    // A step id that is not id-shaped sends nothing at all.
    expect(nextStepEvent(null, company('5566778899'))).toBeNull()
  })
})
