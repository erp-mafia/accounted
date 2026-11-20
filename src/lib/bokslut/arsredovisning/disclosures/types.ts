/**
 * The disclosure matrix: every requirement the årsredovisning must meet, as
 * data. A requirement names its source (ÅRL paragraph, K3 point), when it
 * applies (framework, size class, a fact in the books, or the user's answer)
 * and how it is met:
 *   - generated: from the books, nothing to answer;
 *   - typed: the user writes the text (or picks one of the given choices);
 *   - confirmed: the user confirms a statement the product prints or relies on.
 *
 * Extension points (other phases add to the matrix without rewriting it):
 *   - a requirement list per scope, concatenated in index.ts
 *     (DISCLOSURE_REQUIREMENTS): P4 adds the större företag entries with
 *     `sizes: ['larger']`;
 *   - DisclosureFacts (facts.ts): one optional field per fact a phase can feed
 *     (P2: deferred tax movements, component and impairment figures, the
 *     development model, transition data); a requirement reads the field and
 *     a missing field means "not known from the books".
 */
import type { AccountingFramework } from '@/types'
import type { DisclosureFacts } from './facts'

export type DisclosureSize = 'smaller' | 'larger'

/** Where the requirement is met in the document. */
export type DisclosurePlacement = 'management_report' | 'principles' | 'note'

export type DisclosureProducer = 'generated' | 'typed' | 'confirmed'

/**
 * - applies: the requirement applies (from the books, the form or the profile);
 * - ask: the user must say whether it applies (answer.applies);
 * - not_applicable: nothing to disclose.
 */
export type DisclosureApplicability = 'applies' | 'ask' | 'not_applicable'

/** The user's answer for one requirement (arsredovisning_narratives.disclosure_answers). */
export interface DisclosureAnswer {
  /** The answer to the requirement's question, for 'ask' requirements. */
  applies?: boolean | null
  /** Typed text. */
  text?: string | null
  /** One of the requirement's choices. */
  choice?: string | null
  /** The user confirmed the statement. */
  confirmed?: boolean
}

export type DisclosureAnswers = Readonly<Record<string, DisclosureAnswer>>

export interface DisclosureChoice {
  value: string
  label: string
  /**
   * What the document prints for this choice. Null asks for typed text as
   * well; an empty string prints nothing (an answer, not a disclosure).
   */
  text: string | null
}

/**
 * Whether this is the first year the company applies K3 (K3 35.3), from the
 * per-year framework record and the profile (model.ts):
 *   - not_first: the previous year was prepared under K3;
 *   - new_company: the company's first financial report (no earlier year
 *     under any framework);
 *   - after_k2: the previous year was prepared under K2 (not supported yet:
 *     AR-K3-FIRST-YEAR-UNSUPPORTED);
 *   - unknown: neither the records nor the profile say.
 */
export type K3FirstYearStatus = 'not_first' | 'new_company' | 'after_k2' | 'unknown'

export interface DisclosureContext {
  framework: AccountingFramework
  size: DisclosureSize
  facts: DisclosureFacts
  answers: DisclosureAnswers
  /** K3 only; absent means not known (a requirement reading it treats it as unknown). */
  firstYear?: K3FirstYearStatus
}

export interface DisclosureRequirement {
  /** Stable id: the key of the answer, never renamed once shipped. */
  id: string
  /** Completeness code when the requirement is not met (stable). */
  code: string
  /** The heading (förvaltningsberättelse), note title or principle label, as printed. */
  title: string
  /** The K3 taxonomy (fdr) concept the printed text is tagged with in iXBRL, where one exists. */
  concept?: string
  /** The law and the K3 points behind it. */
  sources: readonly string[]
  frameworks: readonly AccountingFramework[]
  sizes: readonly DisclosureSize[]
  placement: DisclosurePlacement
  producer: DisclosureProducer
  /** Met by a field or a check that already exists (named here); the matrix lists it for completeness. */
  existing?: string
  /** The question the user answers when applicability is 'ask'. */
  question?: string
  /** What the user types (typed requirements). */
  textLabel?: string
  /** The statement the user confirms (confirmed requirements). */
  confirmation?: string
  choices?: readonly DisclosureChoice[]
  applicability: (ctx: DisclosureContext) => DisclosureApplicability
  /** A fact-based hint shown with the question. */
  hint?: (ctx: DisclosureContext) => string | null
  /**
   * Typed or confirmed: the books already answer it (a fact another phase
   * feeds), nothing to ask. Generated: whether the generator could produce
   * it from the books; false leaves the requirement missing.
   */
  satisfiedByFacts?: (ctx: DisclosureContext) => boolean
  /** The document text when met; null prints nothing. */
  render?: (ctx: DisclosureContext, answer: DisclosureAnswer) => string | null
  /** The text printed when the user answered that it does not apply (null: nothing). */
  renderNone?: string | null
  /**
   * Not supported yet: when this holds the requirement blocks the version
   * with this code, whatever the answer (fail closed).
   */
  unsupported?: {
    code: string
    message: string
    when: (ctx: DisclosureContext, answer: DisclosureAnswer) => boolean
  }
  /** Why the requirement cannot be met yet, in the user's words (unmet). */
  missingMessage: string
}

export type DisclosureStatus = 'met' | 'missing' | 'not_applicable' | 'unsupported'

export interface DisclosureEvaluation {
  id: string
  code: string
  title: string
  /** The K3 taxonomy concept of the printed text (null: none). */
  concept: string | null
  sources: readonly string[]
  placement: DisclosurePlacement
  producer: DisclosureProducer
  applicability: DisclosureApplicability
  status: DisclosureStatus
  /** What the document prints for this requirement (null: nothing of its own). */
  content: string | null
  /** The message when missing or unsupported. */
  message: string | null
  /** For the editor: what the user is asked. */
  question: string | null
  text_label: string | null
  confirmation: string | null
  choices: readonly DisclosureChoice[]
  hint: string | null
  /** Met by an existing field or check (the matrix lists it, the editor does not ask). */
  existing: string | null
}
