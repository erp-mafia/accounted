/**
 * Counterpart resolver, the decision: one alias row per string, planned from
 * whatever the pass, the directory, a document and the model produced.
 *
 * The order is survivorship, the way a master-data system decides which
 * source wins an attribute: a giro number or a legal-form name in the text,
 * then a document that names the supplier, then the shared directory, then
 * the model. Each source carries the confidence it has earned, and the
 * confidence sets the band:
 *
 *   link       >= 0.80  shown as the counterpart
 *   tentative  >= 0.60  shown with "läst ur texten" and a one-click "inte samma"
 *   nil        <  0.60  nothing named; the cleansed text shows, muted
 *
 * Pure: no IO, so the whole ladder is testable on strings.
 */
import type { Precleaned } from './preclean'
import type { ModelReading, ReadingKind } from './model-reading'
import type { DirectoryKind } from './directory-seed'

export type AliasBand = 'link' | 'tentative' | 'nil'
export type AliasSource = 'anchor' | 'ledger' | 'directory' | 'document' | 'model' | 'rule' | 'person'
export type AliasKind = ReadingKind

export const LINK_THRESHOLD = 0.8
export const TENTATIVE_THRESHOLD = 0.6

export interface DirectoryHit {
  name: string
  kind: DirectoryKind
  country?: string | null
  what?: string | null
  rail?: string | null
  confidence: number
  /** The party in this company's register that already carries this name, if any. */
  partyId?: string | null
  /** The hit came from a giro number, the strongest anchor there is. */
  viaGiro?: boolean
}

export interface DocumentHit {
  supplierName: string
  partyId?: string | null
  country?: string | null
}

export interface RegisterMatch {
  partyId: string
  name: string
}

/** A giro number in the text that the company's own register already knows. */
export interface IdentityHit {
  partyId: string
  name: string
}

/** A party of the company's own whose vouchers carry this text already. */
export interface LedgerHit {
  partyId: string
  name: string
  /** A confirmed party is a person's decision; a suggestion is the ledger grouping's. */
  confirmed: boolean
}

export interface PlanInput {
  pre: Precleaned
  identity?: IdentityHit | null
  ledger?: LedgerHit | null
  directory?: DirectoryHit | null
  document?: DocumentHit | null
  /** Candidates offered to the model, by id, so a pick resolves to a party. */
  candidatesById?: Map<string, RegisterMatch>
  model?: ModelReading | null
  verify?: 'yes' | 'no' | 'unsure' | null
}

export interface AliasDecision {
  aliasKey: string
  sampleText: string
  partyId: string | null
  displayName: string | null
  kind: AliasKind
  rail: string | null
  country: string | null
  what: string | null
  source: AliasSource
  confidence: number
  band: AliasBand
  model: string | null
  verified: boolean
  /** The medium-band reading should go through the verify pass before storing. */
  needsVerify: boolean
}

export function bandFor(confidence: number): AliasBand {
  if (confidence >= LINK_THRESHOLD) return 'link'
  if (confidence >= TENTATIVE_THRESHOLD) return 'tentative'
  return 'nil'
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

const NO_COUNTERPART_LABELS = new Set(['payroll', 'adjustment', 'category'])

function kindForLabel(label: Precleaned['label']): AliasKind {
  switch (label) {
    case 'payroll':
      return 'payroll'
    case 'adjustment':
      return 'transfer'
    case 'category':
      return 'category'
    case 'authority':
      return 'authority'
    case 'bank':
      return 'bank'
    case 'intermediary':
      return 'rail'
    default:
      return 'unsure'
  }
}

function base(pre: Precleaned): Omit<AliasDecision, 'partyId' | 'displayName' | 'kind' | 'source' | 'confidence' | 'band' | 'model' | 'verified' | 'needsVerify' | 'what'> {
  return {
    aliasKey: pre.aliasKey,
    sampleText: pre.raw.slice(0, 500),
    rail: pre.rail,
    country: pre.country,
  }
}

export function planAlias(input: PlanInput): AliasDecision {
  const { pre } = input
  const b = base(pre)

  // 1. A giro number the register already knows: the company's own record wins.
  if (input.identity) {
    return { ...b, partyId: input.identity.partyId, displayName: input.identity.name, what: null, kind: pre.label === 'authority' ? 'authority' : 'invoice_supplier', source: 'anchor', confidence: 0.98, band: 'link', model: null, verified: false, needsVerify: false }
  }

  // 2. A document named the supplier: the receipt outranks every reading.
  if (input.document?.supplierName) {
    return {
      ...b,
      partyId: input.document.partyId ?? null,
      displayName: input.document.supplierName,
      what: null,
      kind: 'invoice_supplier',
      country: input.document.country ?? b.country,
      source: 'document',
      confidence: 0.95,
      band: 'link',
      model: null,
      verified: false,
      needsVerify: false,
    }
  }

  // 3. The company booked this text before, under a party of its own: what
  // it decided then outranks every reading, and keeps one row per
  // counterpart instead of a reading beside the party. A suggested party
  // (the ledger grouping's own, not a person's) is skipped when the
  // classifier says the text names no counterpart, so a salary line never
  // lands on a "Lön Jakob" suggestion.
  if (input.ledger && (input.ledger.confirmed || !NO_COUNTERPART_LABELS.has(pre.label))) {
    const l = input.ledger
    return { ...b, partyId: l.partyId, displayName: l.name, what: null, kind: pre.label === 'authority' ? 'authority' : 'merchant', source: 'ledger', confidence: l.confirmed ? 0.96 : 0.9, band: 'link', model: null, verified: false, needsVerify: false }
  }

  // 4. A giro number or the directory settles the brand, before the
  // classifier's label: "SJ biljetter" is a category by its words and SJ by
  // its brand, and "Skatt lön" to Skatteverket's giro is Skatteverket.
  if (input.directory) {
    const d = input.directory
    return {
      ...b,
      partyId: d.partyId ?? null,
      displayName: d.name,
      what: d.what ?? null,
      kind: d.kind,
      rail: d.rail ?? b.rail,
      country: d.country ?? b.country,
      source: d.viaGiro ? 'anchor' : 'directory',
      confidence: round3(d.confidence),
      band: bandFor(d.confidence),
      model: null,
      verified: false,
      needsVerify: false,
    }
  }

  // 5. The classifier says the text names no counterpart at all.
  if (NO_COUNTERPART_LABELS.has(pre.label)) {
    return { ...b, partyId: null, displayName: null, what: null, kind: kindForLabel(pre.label), source: 'anchor', confidence: 0.9, band: 'nil', model: null, verified: false, needsVerify: false }
  }

  // 6. A legal-form name written in the text ("Dustin Sverige AB").
  if (pre.legalName) {
    return {
      ...b,
      partyId: null,
      displayName: pre.legalName.name,
      what: null,
      kind: pre.label === 'authority' ? 'authority' : 'merchant',
      country: pre.legalName.country ?? b.country,
      source: 'anchor',
      confidence: 0.9,
      band: 'link',
      model: null,
      verified: false,
      needsVerify: false,
    }
  }

  // 7. The model's reading, with the candidate it picked when it picked one.
  const m = input.model
  if (m && (m.counterpart || m.pick)) {
    const picked = m.pick ? input.candidatesById?.get(m.pick) ?? null : null
    let confidence = m.confidence === 'high' ? 0.85 : m.confidence === 'medium' ? 0.65 : 0.45
    if (picked) confidence = Math.max(confidence, 0.85)
    let verified = false
    if (input.verify === 'yes' && confidence < LINK_THRESHOLD) {
      confidence = 0.8
      verified = true
    } else if (input.verify === 'no') {
      confidence = Math.min(confidence, 0.45)
      verified = true
    }
    const kind: AliasKind = m.kind === 'unsure' ? (pre.label === 'authority' ? 'authority' : 'merchant') : m.kind
    return {
      ...b,
      partyId: picked?.partyId ?? null,
      displayName: picked?.name ?? m.counterpart,
      what: m.what,
      kind,
      rail: m.rail ?? b.rail,
      country: m.country ?? b.country,
      source: 'model',
      confidence: round3(confidence),
      band: bandFor(confidence),
      model: m.model,
      verified,
      needsVerify: !verified && confidence >= TENTATIVE_THRESHOLD && confidence < LINK_THRESHOLD,
    }
  }

  // 8. Only the rail was named: the rail is what the company sees.
  if (pre.rail && !pre.subMerchant) {
    return { ...b, partyId: null, displayName: pre.rail, what: null, kind: 'rail', source: 'anchor', confidence: 0.8, band: 'link', model: null, verified: false, needsVerify: false }
  }

  // 9. Nothing named. The cleansed text shows, muted.
  return {
    ...b,
    partyId: null,
    displayName: null,
    what: null,
    kind: m ? m.kind : kindForLabel(pre.label),
    source: m ? 'model' : 'anchor',
    confidence: m ? 0.4 : 0.3,
    band: 'nil',
    model: m?.model ?? null,
    verified: false,
    needsVerify: false,
  }
}
