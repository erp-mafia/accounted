import type { Payload } from '@/lib/documents/extract/fields'
import { FIELD_PREDICATES, PREDICATES, type FactSubjectKind } from './predicates'

/**
 * Facts an extracted record asserts, from its settled fields only. A field
 * under review or rejected by a check asserts nothing until a person settles
 * it. Pure: the store assigns subject ids and writes.
 */
export interface FactDraft {
  subjectKind: FactSubjectKind
  predicate: string
  value: string | number
  valueText: string
  singleValued: boolean
  validFrom: string | null
  validTo: string | null
  evidence: { field: string; page: number | null; quote: string | null }
}

export function deriveFacts(input: { schemaType: string; payload: Payload; reviewFields: string[] }): FactDraft[] {
  const mapping = FIELD_PREDICATES[input.schemaType]
  if (!mapping) return []
  const settled = (name: string): string | number | null => {
    const field = input.payload[name]
    if (!field || field.normalized == null || input.reviewFields.includes(name)) return null
    return field.normalized
  }
  const drafts: FactDraft[] = []
  for (const { field, predicate, validFromField, validToField } of mapping) {
    const def = PREDICATES[predicate]
    const value = settled(field)
    if (!def || value == null) continue
    const validFrom = validFromField ? settled(validFromField) : null
    const validTo = validToField ? settled(validToField) : null
    drafts.push({
      subjectKind: def.subject,
      predicate,
      value,
      valueText: String(value),
      singleValued: def.singleValued,
      validFrom: typeof validFrom === 'string' ? validFrom : null,
      validTo: typeof validTo === 'string' ? validTo : null,
      evidence: { field, page: input.payload[field].page, quote: input.payload[field].quote },
    })
  }
  return drafts
}
