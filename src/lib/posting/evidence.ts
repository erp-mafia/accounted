import { z } from 'zod'
import { LINK_BASES, LinkEvidenceSchema } from '@/lib/links/link-basis'

/**
 * What a producer saw when it posted: the evidence of a business event.
 *
 * Small and closed, like link evidence (lib/links/link-basis.ts): every field
 * is optional and nothing else is allowed, so a reader can rely on the shape.
 * References only, never names or personal data: the records they point at
 * carry those, and keep them under their own retention and erasure rules.
 */
export const BusinessEventEvidenceSchema = z
  .object({
    document_id: z.string().uuid().optional().describe('The underlag (document_attachments row) the producer saw pinned.'),
    inbox_item_id: z.string().uuid().optional().describe('The inbox item the posting started from.'),
    proposal_id: z.string().min(1).max(120).optional().describe('The suggestion acted on (suggestion_log proposal id).'),
    template_id: z.string().min(1).max(120).optional().describe('The booking template the lines came from.'),
    counterparty_template_id: z.string().uuid().optional().describe('The learned counterparty template the lines came from.'),
    rule_id: z.string().uuid().optional().describe('The mapping rule the lines came from.'),
    link_basis: z.enum(LINK_BASES).optional().describe('Why the record and its verifikat are linked (lib/links).'),
    link_evidence: LinkEvidenceSchema.optional().describe('The link evidence recorded with that basis.'),
    direction: z.enum(['in', 'out']).optional().describe('Money into or out of the business, for a bank line.'),
    file_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe('The SHA-256 of the file an import job read (sie_imports.file_hash), never its name or path.'),
    voucher_count: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('How many verifikat an import job posted, its IB and migration adjustment included.'),
  })
  .strict()

export type BusinessEventEvidence = z.infer<typeof BusinessEventEvidenceSchema>

/** The largest serialised evidence the database accepts (business_events_evidence_check). */
export const MAX_BUSINESS_EVENT_EVIDENCE_BYTES = 2000

/**
 * Valid fields only, never throws: a value the schema refuses is dropped
 * field by field, because the posting is the bookkeeping and the evidence
 * only describes it. An object over the cap keeps its references and drops
 * the nested link evidence, then everything, rather than failing the write.
 */
export function cleanBusinessEventEvidence(raw: Record<string, unknown> | null | undefined): BusinessEventEvidence {
  const kept: Record<string, unknown> = {}
  const shape = BusinessEventEvidenceSchema.shape
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue
    const field = shape[key as keyof typeof shape]
    if (!field) continue
    const parsed = field.safeParse(value)
    if (parsed.success && parsed.data !== undefined) kept[key] = parsed.data
  }
  if (jsonbTextBytes(kept) <= MAX_BUSINESS_EVENT_EVIDENCE_BYTES) return kept as BusinessEventEvidence
  delete kept.link_evidence
  if (jsonbTextBytes(kept) <= MAX_BUSINESS_EVENT_EVIDENCE_BYTES) return kept as BusinessEventEvidence
  return {}
}

/**
 * octet_length(value::text) as Postgres computes it for a jsonb value: the
 * JSON text plus the space jsonb prints after every ':' and ','. The CHECK
 * counts that text, so a JSON.stringify count would let an object through
 * here that the database refuses.
 */
export function jsonbTextBytes(value: unknown): number {
  const base = new TextEncoder().encode(JSON.stringify(value)).length
  return base + separators(value)
}

function separators(value: unknown): number {
  if (Array.isArray(value)) {
    return Math.max(0, value.length - 1) + value.reduce<number>((n, v) => n + separators(v), 0)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    return entries.length + Math.max(0, entries.length - 1) + entries.reduce<number>((n, [, v]) => n + separators(v), 0)
  }
  return 0
}
