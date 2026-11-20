/**
 * What the K3 disclosure editor shows and sends, pure so the rules are
 * tested once (the component renders them).
 */
import type { EquityMovementKind } from '../equity-kinds'
import type { DisclosureAnswer, DisclosureAnswers, DisclosureEvaluation } from './types'

/**
 * The requirements the user answers: not met by a field of its own
 * (existing), not ruled out by the books, and with something to say (a
 * generated requirement only when its applicability is a question).
 */
export function editableDisclosures(evaluations: readonly DisclosureEvaluation[]): DisclosureEvaluation[] {
  return evaluations.filter(
    (e) =>
      !e.existing
      && e.applicability !== 'not_applicable'
      && (e.producer !== 'generated' || e.applicability === 'ask'),
  )
}

/** Whether the requirement's content inputs show: it applies, or the user said it does. */
export function contentApplies(evaluation: DisclosureEvaluation, answer: DisclosureAnswer | undefined): boolean {
  return evaluation.applicability === 'applies' || answer?.applies === true
}

/** Whether the requirement takes typed text for the given answer. */
export function takesText(evaluation: DisclosureEvaluation, answer: DisclosureAnswer | undefined): boolean {
  if (evaluation.producer !== 'typed') return false
  if (evaluation.choices.length === 0) return true
  const choice = evaluation.choices.find((c) => c.value === answer?.choice)
  return choice !== undefined && choice.text === null
}

function cleanAnswer(answer: DisclosureAnswer | undefined): DisclosureAnswer | null {
  if (!answer) return null
  const out: DisclosureAnswer = {}
  if (typeof answer.applies === 'boolean') out.applies = answer.applies
  if (answer.text?.trim()) out.text = answer.text
  if (answer.choice) out.choice = answer.choice
  if (answer.confirmed === true) out.confirmed = true
  return Object.keys(out).length > 0 ? out : null
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The narrative patch for the answers: only the ids that changed, null for
 * an answer cleared (the server merges, workflow-service.ts).
 */
export function disclosureAnswersPatch(
  saved: DisclosureAnswers,
  draft: Readonly<Record<string, DisclosureAnswer | undefined>>,
): Record<string, DisclosureAnswer | null> {
  const patch: Record<string, DisclosureAnswer | null> = {}
  for (const id of new Set([...Object.keys(saved), ...Object.keys(draft)])) {
    const before = cleanAnswer(saved[id])
    const after = cleanAnswer(draft[id])
    if (!same(before, after)) patch[id] = after
  }
  return patch
}

/** The narrative patch for the equity classifications, the same way. */
export function equityOverridesPatch(
  saved: Readonly<Record<string, EquityMovementKind>>,
  draft: Readonly<Record<string, EquityMovementKind | undefined>>,
): Record<string, EquityMovementKind | null> {
  const patch: Record<string, EquityMovementKind | null> = {}
  for (const id of new Set([...Object.keys(saved), ...Object.keys(draft)])) {
    const after = draft[id] ?? null
    if ((saved[id] ?? null) !== after) patch[id] = after
  }
  return patch
}
