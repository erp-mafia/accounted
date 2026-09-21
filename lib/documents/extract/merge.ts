import type { ExtractionSchemaDef, FieldKind } from './schemas'
import { isValidOrgNumber, normalizeValue, valuesAgree, type ExtractedField, type Payload, type Reading } from './fields'

/**
 * Two readings become one record. Agreement settles a field; disagreement,
 * a value only one reading found, a value that does not parse, or a failed
 * check sends that field (never the whole document) to a person. The
 * model's own confidence is never asked for.
 */
export type CheckCode = 'required' | 'orgnr_luhn' | 'non_negative' | 'percent_range' | 'date_order' | 'audit'

export interface CheckFailure {
  check: CheckCode
  field: string
}

export interface MergeResult {
  payload: Payload
  /** Failed checks; empty when every check passed. */
  checks: CheckFailure[]
  /** Fields a person must settle. */
  reviewFields: string[]
}

type Settlement = 'agreed' | 'one_reading' | 'unparsed' | 'disagreed'

const CONFIDENCE: Record<Settlement, number> = { agreed: 1, one_reading: 0.5, unparsed: 0.4, disagreed: 0.3 }

/** Date fields that must not come before another, as [earlier, later]. */
const DATE_ORDER: Array<[string, string]> = [
  ['starts_on', 'ends_on'],
  ['disbursed_on', 'maturity_on'],
]

export function mergeReadings(def: ExtractionSchemaDef, a: Record<string, unknown>, b: Record<string, unknown>): MergeResult {
  const payload: Payload = {}
  const review = new Set<string>()
  for (const f of def.fields) {
    const readings: [Reading, Reading] = [toReading(a[f.name]), toReading(b[f.name])]
    const normalized: [string | number | null, string | number | null] = [normalizeValue(f.kind, readings[0].value), normalizeValue(f.kind, readings[1].value)]
    const settlement = settle(f.kind, readings, normalized)
    // Cite the reading that found a value, reading A when both did.
    const cited = readings[0].value == null && readings[1].value != null ? readings[1] : readings[0]
    payload[f.name] = {
      value: cited.value,
      normalized: normalized[0] ?? normalized[1],
      page: cited.page,
      quote: cited.quote,
      bbox: null,
      confidence: CONFIDENCE[settlement],
      method: settlement === 'agreed' ? 'consensus' : 'single_reading',
      readings,
    } satisfies ExtractedField
    if (settlement !== 'agreed') review.add(f.name)
  }
  const checks = runChecks(def, payload)
  for (const c of checks) review.add(c.field)
  return { payload, checks, reviewFields: def.fields.map((f) => f.name).filter((name) => review.has(name)) }
}

function settle(kind: FieldKind, readings: [Reading, Reading], normalized: [string | number | null, string | number | null]): Settlement {
  if (readings.some((r, i) => r.value != null && normalized[i] == null)) return 'unparsed'
  if (valuesAgree(kind, normalized[0], normalized[1])) return 'agreed'
  return normalized[0] == null || normalized[1] == null ? 'one_reading' : 'disagreed'
}

function toReading(raw: unknown): Reading {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    value: typeof r.value === 'string' || typeof r.value === 'number' ? r.value : null,
    page: typeof r.page === 'number' && Number.isInteger(r.page) && r.page >= 1 ? r.page : null,
    quote: typeof r.quote === 'string' && r.quote.trim() ? r.quote.trim().slice(0, 200) : null,
  }
}

/** The checks a careful person would make on the record, whoever filled it in. */
export function runChecks(def: ExtractionSchemaDef, payload: Payload): CheckFailure[] {
  const failures: CheckFailure[] = []
  const value = (name: string) => payload[name]?.normalized ?? null
  for (const f of def.fields) {
    const v = value(f.name)
    if (v == null) {
      if (f.required) failures.push({ check: 'required', field: f.name })
      continue
    }
    if (f.kind === 'orgnr' && !isValidOrgNumber(String(v))) failures.push({ check: 'orgnr_luhn', field: f.name })
    if ((f.kind === 'amount' || f.kind === 'int') && Number(v) < 0) failures.push({ check: 'non_negative', field: f.name })
    if (f.kind === 'percent' && (Number(v) < 0 || Number(v) > 100)) failures.push({ check: 'percent_range', field: f.name })
  }
  for (const [earlier, later] of DATE_ORDER) {
    const from = value(earlier), to = value(later)
    if (from != null && to != null && String(from) > String(to)) failures.push({ check: 'date_order', field: later })
  }
  return failures
}
