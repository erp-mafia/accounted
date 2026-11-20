import type { Ink3Field } from './types'

/**
 * The underlag's fields grouped the way the printed blanketter lay them out,
 * for the screen and the PDF. Pure and type-only, so a client component can
 * import it.
 */

export interface Ink3IncomeRow {
  key: string
  ruta: string
  label: string
  sign: '+' | '-'
  /** "Enligt redovisningen". */
  bokforing: Ink3Field | null
  /** "Som ska tas upp/dras av"; null for 6.1 and 6.19, which have no taxable box. */
  skattepliktig: Ink3Field | null
}

export interface Ink3Sections {
  assets: Ink3Field[]
  equityLiabilities: Ink3Field[]
  incomeStatement: Ink3IncomeRow[]
  /** 6.20 and 6.21, vinst and förlust. */
  results: Ink3Field[]
  ink3s: Ink3Field[]
  sufPurposes: Ink3Field[]
  sufProperty: Ink3Field[]
  sufAmounts: Ink3Field[]
}

const RESULT_RUTOR = new Set(['6.20', '6.21'])

function rutaMinor(ruta: string): number {
  return Number(ruta.split('.')[1])
}

export function ink3Sections(fields: readonly Ink3Field[]): Ink3Sections {
  const balance = fields.filter((f) => f.blankett === 'INK3R' && f.ruta?.startsWith('5.'))
  const income = fields.filter((f) => f.blankett === 'INK3R' && f.column !== null && !RESULT_RUTOR.has(f.ruta ?? ''))

  const rows = new Map<string, Ink3IncomeRow>()
  for (const field of income) {
    const sign = field.sign === '-' ? '-' : '+'
    const key = `${field.ruta}${sign}`
    const row = rows.get(key) ?? { key, ruta: field.ruta ?? '', label: field.label, sign, bokforing: null, skattepliktig: null }
    if (field.column === 'bokforing') row.bokforing = field
    else row.skattepliktig = field
    rows.set(key, row)
  }

  const suf = fields.filter((f) => f.blankett === 'INK3SUF')
  return {
    assets: balance.filter((f) => rutaMinor(f.ruta!) <= 11),
    equityLiabilities: balance.filter((f) => rutaMinor(f.ruta!) >= 12),
    incomeStatement: [...rows.values()],
    results: fields.filter((f) => f.blankett === 'INK3R' && RESULT_RUTOR.has(f.ruta ?? '')),
    ink3s: fields.filter((f) => f.blankett === 'INK3S'),
    sufPurposes: suf.filter((f) => f.datatyp === 'Str_X' || f.datatyp === 'Str_36'),
    sufProperty: suf.filter((f) => f.ruta === null && (f.datatyp === 'Numeriskt_N' || f.datatyp === 'Numeriskt_A')),
    sufAmounts: suf.filter((f) => f.ruta !== null),
  }
}

/** The sign a row prints with on the blankett: '+' or '-' before the box. */
export function ink3SignMark(field: Pick<Ink3Field, 'sign'>): string {
  return field.sign === '+' || field.sign === '-' ? field.sign : ''
}
