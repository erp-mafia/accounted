import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { defaultAccountingMethod } from '@/lib/company/entity-type'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'

// Two answers a first-time sole trader cannot be expected to know. The
// journey is not rendered in tests, so this guards the wiring in its source:
// which method carries the mark comes from the legal form's profile, and the
// start-date question does not ask a person without F-skatt for the day they
// registered.
const journey = readFileSync(path.resolve(__dirname, '..', 'OnboardingJourney.tsx'), 'utf8')

/** The source of one `case '<step>':` up to the next case. */
function stepSource(step: string): string {
  const at = journey.indexOf(`case '${step}':`)
  expect(at, `no step ${step}`).toBeGreaterThan(-1)
  const next = journey.indexOf('\n      case ', at + 1)
  return journey.slice(at, next === -1 ? undefined : next)
}

describe('the bookkeeping method question', () => {
  it('marks the method the legal form usually keeps its books by', () => {
    expect(journey).toContain('const usualMethod = isEntityType(entity) ? defaultAccountingMethod(entity) : null')
    expect(stepSource('method')).toContain("rec: usualMethod === method ? t('journey_suggested') : undefined")
  })

  it('has a usual method for each form it is asked of', () => {
    expect(defaultAccountingMethod('enskild_firma')).toBe('cash')
    expect(defaultAccountingMethod('aktiebolag')).toBe('accrual')
  })
})

describe('the start-date question for a sole trader', () => {
  it('asks for the first purchase or sale when the person has no F-skatt yet', () => {
    const step = stepSource('fystart')
    expect(step).toContain("state.settings.f_skatt === false")
    expect(step.indexOf("t('journey_fystart_ef_sub_unregistered')")).toBeGreaterThan(-1)
    expect(step.indexOf("t('journey_fystart_ef_sub_unregistered')")).toBeLessThan(step.indexOf("t('journey_fystart_ef_sub')"))
  })

  it('has the line in both languages', () => {
    expect(sv.onboarding.journey_fystart_ef_sub_unregistered).toBe('Dagen firman gjorde sitt första köp eller sin första försäljning.')
    expect(en.onboarding.journey_fystart_ef_sub_unregistered).toBe('The day the business made its first purchase or its first sale.')
  })
})
