import { z } from 'zod'

/**
 * Link basis: WHY two records are linked, recorded on the link itself.
 *
 * A link row (a bank line on its verifikat, an underlag on its verifikat, a
 * payment on its invoice) used to say THAT two records belong together, never
 * why: a person picked the pair, a reference matched, an amount-and-date rule
 * matched, an agent proposed it and a person approved, another system carried
 * it over. Benchmarks show agents inventing matches to make a check pass; the
 * defence is evidence on every link, the link-level counterpart of the
 * decision receipt (src/lib/suggestion-log/receipts.ts) and the actor record
 * (journal_entries.committed_actor_*).
 *
 * One closed vocabulary for every link table, mirrored by the
 * <table>_link_basis_check constraints (migration 20261016160000; a unit test
 * keeps the two equal). New links only: rows written before the columns
 * existed stay NULL, which reads as "not recorded", never as a guess.
 *
 * A door names what it knows by itself (a DoorLinkBasis); the request it runs
 * in adds who approved it (./stamp.ts): inside a pending-operation approval a
 * person-shaped pairing becomes agent_proposed_user_approved, and on a
 * machine credential it becomes client_asserted. Precedence
 * when a link could be described two ways: import_carried_over, then
 * agent_proposed_user_approved, then client_asserted, then the rule_* values,
 * then user_confirmed, user_created, system_derived.
 */
export const LINK_BASES = [
  /** A person picked or confirmed the pair among records that already existed (a suggestion confirmed by a person included: the suggesting rule goes into the evidence). */
  'user_confirmed',
  /** A person created one side from the other in the same act: booked the verifikat from the bank line, attached the underlag while booking, marked the invoice paid. */
  'user_created',
  /** A deterministic rule paired existing records on a payment reference (OCR, invoice number) without a person choosing the pair. */
  'rule_ocr_reference',
  /** A deterministic rule paired existing records on amount and date without a person choosing the pair. */
  'rule_amount_date',
  /** A deterministic rule paired existing records on the counterparty (name, alias, bankgiro) and amount without a person choosing the pair. */
  'rule_counterparty',
  /** An agent or API client staged the write as a pending operation and a person approved it. */
  'agent_proposed_user_approved',
  /** Reserved for Phase 3 grants: an agent acted alone inside a mandate the company granted. No writer sets it yet. */
  'agent_autonomous_within_grant',
  /** An API key, MCP connector, service account or the in-app agent named the pair and the write committed without a person approving it in Accounted. */
  'client_asserted',
  /** The link came over from another system's records (SIE, provider migration, bank file). */
  'import_carried_over',
  /** The system created one side from the other without anyone choosing the pair: the invoice PDF on its own verifikat, a payment sync, a sandbox seed. */
  'system_derived',
] as const

export type LinkBasis = (typeof LINK_BASES)[number]

/**
 * The bases a writer may name itself. The other three are added by the
 * request scope (./stamp.ts) or, for agent_autonomous_within_grant, by the
 * Phase 3 grant path that does not exist yet.
 */
export type DoorLinkBasis = Exclude<
  LinkBasis,
  'agent_proposed_user_approved' | 'agent_autonomous_within_grant' | 'client_asserted'
>

export const RULE_LINK_BASES = ['rule_ocr_reference', 'rule_amount_date', 'rule_counterparty'] as const
export const PERSON_LINK_BASES = ['user_confirmed', 'user_created'] as const

export function isLinkBasis(value: unknown): value is LinkBasis {
  return typeof value === 'string' && (LINK_BASES as readonly string[]).includes(value)
}

/** The largest serialised evidence the database accepts (link_evidence CHECK). */
export const MAX_LINK_EVIDENCE_BYTES = 2000

/**
 * What a writer saw when it made the link. Small and closed: every field is
 * optional, nothing else is allowed, so a reader can rely on the shape.
 */
export const LinkEvidenceSchema = z
  .object({
    rule_id: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("The rule or matcher that paired them: a matcher id such as 'auto_reference', or a mapping rule id."),
    reference: z.string().min(1).max(200).optional().describe('The reference the rule matched on (OCR, invoice number, external payment id).'),
    score: z.number().min(0).max(1).optional().describe("The matcher's recorded confidence, 0 to 1, when it scores."),
    receipt_id: z.string().uuid().optional().describe('The decision receipt (suggestion_log row) behind the link, when one exists.'),
    pending_operation_id: z.string().uuid().optional().describe('The staged operation whose approval wrote the link.'),
    source_system: z.string().min(1).max(60).optional().describe("The system the link was carried over from or synced with, e.g. 'stripe', 'sie'."),
  })
  .strict()

export type LinkEvidence = z.infer<typeof LinkEvidenceSchema>

/** What the request a link is written in says about who acted. */
export interface LinkScope {
  /** The pending operation being approved, or null outside an approval. */
  pendingOperationId: string | null
  /** The commit actor type of the request (getActor()), or undefined outside any scope. */
  actorType?: string
}

/** Credentials that are not a person in front of Accounted. */
const MACHINE_ACTORS = new Set(['api_key', 'mcp_oauth', 'service_account', 'agent_chat'])
/** Scheduled and internal runs: nobody chose the pair. */
const SYSTEM_ACTORS = new Set(['cron', 'system'])

export interface LinkBasisColumns {
  link_basis: LinkBasis
  link_evidence: LinkEvidence | null
}

/**
 * The basis a link records, from what the door knows and the scope it ran
 * in. Pure, so the rules are tested without a request:
 *
 *   - inside an approval, a person-shaped door (user_confirmed,
 *     user_created) becomes agent_proposed_user_approved: the pair was staged
 *     by an agent or API client and a person approved it;
 *   - on a machine credential outside an approval, a person-shaped door
 *     becomes client_asserted: nobody in Accounted confirmed the pair;
 *   - on a cron or system scope, a person-shaped door becomes system_derived;
 *   - a rule door stays a rule wherever it runs: the rule chose the pair, and
 *     whoever started the run did not see it. A door whose pairs a person
 *     reviewed one by one names user_confirmed instead, with the rule as
 *     evidence;
 *   - import_carried_over and system_derived describe how the pair arose and
 *     stay as named;
 *   - inside an approval every basis records the operation as evidence.
 *
 * Evidence is validated and capped: a value the schema refuses is dropped
 * field by field rather than failing the write, because the link itself is
 * the bookkeeping and the evidence only describes it.
 */
export function resolveLinkBasis(door: DoorLinkBasis, evidence: LinkEvidence | undefined, scope: LinkScope): LinkBasisColumns {
  const ev: Record<string, unknown> = { ...(evidence ?? {}) }
  const isPerson = (PERSON_LINK_BASES as readonly string[]).includes(door)
  let basis: LinkBasis = door

  if (scope.pendingOperationId) {
    ev.pending_operation_id = scope.pendingOperationId
    if (isPerson) basis = 'agent_proposed_user_approved'
  } else if (isPerson && scope.actorType && MACHINE_ACTORS.has(scope.actorType)) {
    basis = 'client_asserted'
  } else if (isPerson && scope.actorType && SYSTEM_ACTORS.has(scope.actorType)) {
    basis = 'system_derived'
  }

  return { link_basis: basis, link_evidence: cleanEvidence(ev) }
}

/** The bases that do not depend on who approved the write. */
export type ScopeFreeLinkBasis = 'system_derived' | 'import_carried_over' | (typeof RULE_LINK_BASES)[number]

/**
 * The columns for code that cannot read the request scope, the ledger kernel
 * (src/lib/core may not import the pending-operation scope, see the
 * kernel-import guard). Only bases that hold whoever approved the write are
 * accepted, so a kernel writer cannot record a person's pairing without the
 * scope; the approving operation is not recorded as evidence on these.
 */
export function scopeFreeLinkBasisColumns(door: ScopeFreeLinkBasis, evidence?: LinkEvidence): LinkBasisColumns {
  return resolveLinkBasis(door, evidence, { pendingOperationId: null })
}

/** Valid fields only, null when nothing is left; never throws. */
export function cleanEvidence(raw: Record<string, unknown>): LinkEvidence | null {
  const kept: Record<string, unknown> = {}
  const shape = LinkEvidenceSchema.shape
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    const field = shape[key as keyof typeof shape]
    if (!field) continue
    const parsed = field.safeParse(value)
    if (parsed.success && parsed.data !== undefined) kept[key] = parsed.data
  }
  if (Object.keys(kept).length === 0) return null
  // Every field is bounded, so the whole is far below the cap; the check stays
  // as the contract with the database constraint.
  if (JSON.stringify(kept).length > MAX_LINK_EVIDENCE_BYTES) return null
  return kept as LinkEvidence
}

/**
 * A link basis as read back from a row: the basis when it is one of the
 * vocabulary, the evidence when it has the documented shape. Anything else
 * (a NULL legacy row, a value from a future vocabulary) reads as unknown.
 */
export interface ReadLinkBasis {
  basis: LinkBasis | null
  evidence: LinkEvidence | null
}

export function readLinkBasis(row: { link_basis?: unknown; link_evidence?: unknown } | null | undefined): ReadLinkBasis {
  const basis = isLinkBasis(row?.link_basis) ? row.link_basis : null
  const rawEvidence = row?.link_evidence
  const evidence =
    rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
      ? cleanEvidence(rawEvidence as Record<string, unknown>)
      : null
  return { basis, evidence }
}

/**
 * The bank reconciliation matcher's methods (transactions.reconciliation_method)
 * as link bases: auto_reference matched an OCR or reference token, the others
 * matched amount and date (exact, within days, or to the öre).
 */
export function linkBasisForReconciliationMethod(method: string | null | undefined): DoorLinkBasis {
  if (method === 'auto_reference') return 'rule_ocr_reference'
  if (method === 'manual') return 'user_confirmed'
  return 'rule_amount_date'
}
