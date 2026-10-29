/**
 * The disclosure matrix (see types.ts): every requirement of the
 * årsredovisning with its source, when it applies and how it is met, and
 * the one evaluation the document, the completeness check and the editor
 * read.
 *
 * Extension point for later phases: add a requirement list (P4: the större
 * företag entries, `sizes: ['larger']`; an ekonomisk förening K3 list) to
 * DISCLOSURE_REQUIREMENTS, and feed facts through DisclosureFacts (facts.ts).
 * Ids and codes are stable: answers are stored under the id, agents and the
 * UI match on the code.
 */
import type { AccountingFramework } from '@/types'
import type { AnnualReportComplianceIssue } from '../compliance-types'
import { K3_MINDRE_REQUIREMENTS } from './k3-mindre'
import type {
  DisclosureAnswer,
  DisclosureAnswers,
  DisclosureContext,
  DisclosureEvaluation,
  DisclosureRequirement,
  DisclosureSize,
} from './types'

export type * from './types'
export { collectDisclosureFacts, temporaryDifferenceSignals, type DisclosureFacts } from './facts'

/** Every requirement the product knows, in document order within each placement. */
export const DISCLOSURE_REQUIREMENTS: readonly DisclosureRequirement[] = [...K3_MINDRE_REQUIREMENTS]

/** The requirements for a framework and size class. */
export function requirementsFor(framework: AccountingFramework, size: DisclosureSize): DisclosureRequirement[] {
  return DISCLOSURE_REQUIREMENTS.filter((r) => r.frameworks.includes(framework) && r.sizes.includes(size))
}

const EMPTY: DisclosureAnswer = {}

function hasText(answer: DisclosureAnswer): boolean {
  return Boolean(answer.text?.trim())
}

/** Whether what the requirement asks for (beyond "does it apply") is given. */
function contentGiven(requirement: DisclosureRequirement, answer: DisclosureAnswer, ctx: DisclosureContext): boolean {
  // A generated requirement is met unless the books say the generator
  // could not produce it (satisfiedByFacts false).
  if (requirement.producer === 'generated') return requirement.satisfiedByFacts?.(ctx) ?? true
  if (requirement.satisfiedByFacts?.(ctx)) return true
  if (requirement.producer === 'confirmed') return answer.confirmed === true
  // typed: a choice (one that prints no text of its own also needs the
  // typed text), or the typed text.
  if (requirement.choices && requirement.choices.length > 0) {
    const choice = requirement.choices.find((c) => c.value === answer.choice)
    if (!choice) return false
    return choice.text !== null || hasText(answer)
  }
  return hasText(answer)
}

/** Evaluate one requirement. */
export function evaluateRequirement(requirement: DisclosureRequirement, ctx: DisclosureContext): DisclosureEvaluation {
  const answer = ctx.answers[requirement.id] ?? EMPTY
  const applicability = requirement.applicability(ctx)
  const base = {
    id: requirement.id,
    code: requirement.code,
    title: requirement.title,
    concept: requirement.concept ?? null,
    sources: requirement.sources,
    placement: requirement.placement,
    producer: requirement.producer,
    applicability,
    question: requirement.question ?? null,
    text_label: requirement.textLabel ?? null,
    confirmation: requirement.confirmation ?? null,
    choices: requirement.choices ?? [],
    hint: requirement.hint?.(ctx) ?? null,
    existing: requirement.existing ?? null,
  }
  if (applicability === 'not_applicable') {
    return { ...base, status: 'not_applicable', content: null, message: null }
  }
  if (requirement.unsupported?.when(ctx, answer)) {
    return { ...base, status: 'unsupported', content: null, message: requirement.unsupported.message, code: requirement.unsupported.code }
  }
  // Met by a field or check of its own; the matrix lists it, nothing to ask.
  if (requirement.existing) return { ...base, status: 'met', content: null, message: null }
  if (applicability === 'ask') {
    if (answer.applies === null || answer.applies === undefined) {
      return { ...base, status: 'missing', content: null, message: requirement.missingMessage }
    }
    if (answer.applies === false) {
      return { ...base, status: 'met', content: requirement.renderNone ?? null, message: null }
    }
  }
  if (!contentGiven(requirement, answer, ctx)) {
    return { ...base, status: 'missing', content: null, message: requirement.missingMessage }
  }
  return { ...base, status: 'met', content: requirement.render?.(ctx, answer) ?? null, message: null }
}

/** Evaluate the matrix for a report. */
export function evaluateDisclosures(ctx: DisclosureContext): DisclosureEvaluation[] {
  return requirementsFor(ctx.framework, ctx.size).map((requirement) => evaluateRequirement(requirement, ctx))
}

/** Completeness issues: one error per requirement that is missing or not supported. */
export function disclosureIssues(evaluations: readonly DisclosureEvaluation[]): AnnualReportComplianceIssue[] {
  return evaluations
    .filter((e) => e.status === 'missing' || e.status === 'unsupported')
    .map((e) => ({
      code: e.code,
      severity: 'error' as const,
      section: e.placement === 'management_report' ? ('management_report' as const) : ('notes' as const),
      message: e.message ?? `${e.title}: uppgift saknas.`,
      remediation:
        e.status === 'unsupported'
          ? undefined
          : 'Besvara frågan under K3-upplysningar på årsredovisningssidan och klicka på Spara texten.',
    }))
}

/** Stored answers, keeping only known ids and the four answer fields. */
export function normalizeDisclosureAnswers(value: unknown): DisclosureAnswers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const known = new Set(DISCLOSURE_REQUIREMENTS.map((r) => r.id))
  const out: Record<string, DisclosureAnswer> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(id) || !raw || typeof raw !== 'object') continue
    const answer = raw as Record<string, unknown>
    const normalized: DisclosureAnswer = {}
    if (typeof answer.applies === 'boolean') normalized.applies = answer.applies
    if (typeof answer.text === 'string' && answer.text.trim()) normalized.text = answer.text
    if (typeof answer.choice === 'string' && answer.choice) normalized.choice = answer.choice
    if (answer.confirmed === true) normalized.confirmed = true
    if (Object.keys(normalized).length > 0) out[id] = normalized
  }
  return out
}
