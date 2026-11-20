/**
 * The onboarding step funnel: one `onboarding_step_viewed` event each time a
 * step of the company journey (/onboarding) or the books act
 * (/onboarding/books) is shown, so a funnel per question shows where people
 * leave. Pure on purpose (lib/analytics/properties.ts explains why); the
 * hook in lib/hooks/use-onboarding-step-event.ts only calls nextStepEvent.
 *
 * Properties are ids and enums only: the journey, the step and the branch
 * the person is on, never an answer. Event properties carry no PII
 * (lib/analytics/properties.ts, rule 1), so every value must look like an
 * id: lowercase letters, `_` and `-`, no digits. An org number, a name or an
 * e-mail that ever reached a field here is dropped, not sent.
 */
export const ONBOARDING_STEP_EVENT = 'onboarding_step_viewed'

export type OnboardingJourneyName = 'company' | 'books'

export interface OnboardingStepInput {
  journey: OnboardingJourneyName
  /** The step id, as the journey's navigation records it. */
  step: string
  /** False until the tab's draft is restored (useOnboardingNavigation): no step is shown before that. */
  ready: boolean
  /** Company journey: the first company or another one. */
  mode?: string | null
  /** Company journey: the company form, once known. */
  entityType?: string | null
  /** Books act: migration or a fresh start, once chosen. */
  path?: string | null
  /** Books act: the provider picked, once picked. */
  provider?: string | null
}

export interface OnboardingStepEvent {
  /** The step entry this event stands for; the next event needs a different one. */
  key: string
  properties: Record<string, string>
}

const ID_SHAPE = /^[a-z][a-z_-]{0,39}$/

function idOrNull(value: string | null | undefined): string | null {
  return value && ID_SHAPE.test(value) ? value : null
}

/**
 * The event this render should send, or null. Once per step entry: nothing
 * before the draft is restored (the pre-restore first step was never shown),
 * nothing when only a property changed within the step, and nothing when an
 * effect runs again with the step unchanged (StrictMode, a re-render). Going
 * back to a step, by Tillbaka or the browser, is a new entry and sends again.
 */
export function nextStepEvent(lastKey: string | null, input: OnboardingStepInput): OnboardingStepEvent | null {
  const step = idOrNull(input.step)
  if (!input.ready || !step) return null
  const key = `${input.journey}:${step}`
  if (key === lastKey) return null
  const properties: Record<string, string> = { journey: input.journey, step }
  const optional = {
    mode: idOrNull(input.mode),
    entity_type: idOrNull(input.entityType),
    path: idOrNull(input.path),
    provider: idOrNull(input.provider),
  }
  for (const [name, value] of Object.entries(optional)) {
    if (value) properties[name] = value
  }
  return { key, properties }
}
