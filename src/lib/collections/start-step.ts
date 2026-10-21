export type CollectionsStartStep = 'reminder' | 'collection'

/**
 * The steps a handover of one invoice may start with.
 *
 * The provider charges the customer a reminder fee on every reminder it
 * sends, and lag (1981:739) 2 § allows that fee only when it was agreed no
 * later than when the debt arose (eligibility.ts computes reminderFeeAgreed
 * per invoice from the company's terms date). Until the provider can leave
 * the fee off per claim, an invoice without an agreed reminder fee starts at
 * the inkassokrav, whose fee needs no agreement (founder decision 2026-10-20).
 */
export function startStepsFor(offered: readonly CollectionsStartStep[], reminderFeeAgreed: boolean): CollectionsStartStep[] {
  return reminderFeeAgreed ? [...offered] : offered.filter((step) => step !== 'reminder')
}

/** The step a handover starts with when nobody chose one: the company's default when the invoice may start there, else the first allowed step. */
export function resolveStartStep(preferred: CollectionsStartStep, steps: readonly CollectionsStartStep[]): CollectionsStartStep | null {
  if (steps.includes(preferred)) return preferred
  return steps[0] ?? null
}

/** Why a step was refused: the reminder needs an agreed reminder fee, anything else is a step the provider does not offer. */
export function startStepRefusalCode(step: CollectionsStartStep, reminderFeeAgreed: boolean): 'COLLECTION_REMINDER_FEE_NOT_AGREED' | 'COLLECTION_START_STEP_UNAVAILABLE' {
  return step === 'reminder' && !reminderFeeAgreed ? 'COLLECTION_REMINDER_FEE_NOT_AGREED' : 'COLLECTION_START_STEP_UNAVAILABLE'
}
