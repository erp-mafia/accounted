import { sruIncomeYear, sruPeriodSuffix } from '@/lib/reports/sru/envelope'
import table2026P4 from './field-table-2026P4.json'

/**
 * Skatteverket's INK3 field codes, pinned per beskattningsperiod.
 *
 * Each table is derived from the field-name xls files Skatteverket publishes
 * in that period's SKV269 package (INK3R, INK3S, INK3SUF) and records the
 * file names, their sha256 and the package it came from. The engine never
 * guesses a code: a räkenskapsår whose beskattningsperiod has no table here
 * is refused with TAX_DECL_INK3_PERIOD_NOT_SUPPORTED, and the next period is
 * one more JSON file derived the same way, plus one line below.
 *
 * Labels are Skatteverket's form labels and stay Swedish in both locales.
 */

export type Ink3Blankett = 'INK3R' | 'INK3S' | 'INK3SUF'

/** INK3R's income statement has two columns: what the books say, and the taxable part. */
export type Ink3Column = 'bokforing' | 'skattepliktig'

/**
 * Value sets from the package's Vardeforrad file: Numeriskt_A is any whole
 * krona amount, Numeriskt_B a non-negative one, Numeriskt_N 0 to 100, Str_X a
 * ticked box ("X") and Str_36 at most 36 characters of text.
 */
export type Ink3Datatyp = 'Numeriskt_A' | 'Numeriskt_B' | 'Numeriskt_N' | 'Str_X' | 'Str_36'

export interface Ink3FieldDefinition {
  code: string
  blankett: Ink3Blankett
  /** The printed row, e.g. '5.1', '6.2', '7.3a', '4.12'; null for an unnumbered box. */
  ruta: string | null
  label: string
  /** The xls attribute text, whitespace collapsed. */
  attribute: string
  datatyp: Ink3Datatyp
  mandatory: boolean
  /** The printed sign: '+' adds, '-' subtracts, '*' a stated amount. */
  sign: '+' | '-' | '*' | null
  rule: string | null
  column: Ink3Column | null
}

export interface Ink3FieldTable {
  beskattningsperiod: string
  source: {
    package: string
    packageSha256: string | null
    fetchedAt: string
    files: ReadonlyArray<{ blankett: Ink3Blankett | null; file: string; sha256: string }>
  }
  datatypes: Readonly<Record<string, string>>
  notes: Readonly<Record<string, string>>
  fields: readonly Ink3FieldDefinition[]
  byCode: ReadonlyMap<string, Ink3FieldDefinition>
}

interface RawTable {
  beskattningsperiod: string
  source: Ink3FieldTable['source']
  datatypes: Record<string, string>
  notes: Record<string, string>
  fields: Array<Omit<Ink3FieldDefinition, 'blankett' | 'datatyp' | 'sign' | 'column'> & {
    blankett: string
    datatyp: string
    sign: string | null
    column: string | null
  }>
}

function buildTable(raw: RawTable): Ink3FieldTable {
  const fields = raw.fields as unknown as Ink3FieldDefinition[]
  return {
    beskattningsperiod: raw.beskattningsperiod,
    source: raw.source,
    datatypes: raw.datatypes,
    notes: raw.notes,
    fields,
    byCode: new Map(fields.map((field) => [field.code, field])),
  }
}

/** Every pinned table, keyed by beskattningsperiod. Add a period here, never a guess in code. */
export const INK3_FIELD_TABLES: Readonly<Record<string, Ink3FieldTable>> = {
  '2026P4': buildTable(table2026P4 as RawTable),
}

/** The beskattningsperiod a räkenskapsår belongs to, from its last day: '2026P4' for 2026-12-31. */
export function ink3Beskattningsperiod(periodEnd: string): string {
  return `${sruIncomeYear(periodEnd)}${sruPeriodSuffix(periodEnd)}`
}

export class Ink3PeriodNotSupportedError extends Error {
  readonly code = 'TAX_DECL_INK3_PERIOD_NOT_SUPPORTED'
  constructor(
    readonly beskattningsperiod: string,
    readonly supported: readonly string[],
  ) {
    super(
      `INK3-underlaget finns för beskattningsperiod ${supported.join(', ')}. Räkenskapsåret hör till ${beskattningsperiod}, och Skatteverkets fältkoder för den perioden är inte inlagda.`,
    )
    this.name = 'Ink3PeriodNotSupportedError'
  }
}

/** The pinned table for the räkenskapsår ending `periodEnd`; throws when there is none. */
export function resolveInk3FieldTable(periodEnd: string): Ink3FieldTable {
  const period = ink3Beskattningsperiod(periodEnd)
  const table = INK3_FIELD_TABLES[period]
  if (!table) throw new Ink3PeriodNotSupportedError(period, Object.keys(INK3_FIELD_TABLES))
  return table
}
