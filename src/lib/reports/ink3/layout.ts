import type { Ink3FieldDefinition, Ink3FieldTable } from './field-table'

/**
 * The arithmetic of the printed INK3 blanketter, read off a pinned field
 * table: which boxes are the balance sheet, which bookkeeping box has a
 * taxable twin in the second column, and which boxes are sums of others.
 */

/** 6.20 Årets resultat enligt bokföringen, vinst and förlust. */
export const INK3R_BOOKKEEPING_RESULT = { profit: '8663', loss: '8763' } as const
/** 6.21 Justerat resultat (the taxable column's result), vinst and förlust. */
export const INK3R_TAXABLE_RESULT = { profit: '8685', loss: '8785' } as const
/** 7.1/7.2: 6.21 carried to INK3S. */
export const INK3S_CARRIED_RESULT = { profit: '8686', loss: '8786' } as const
/** 7.9 Överskott / 7.10 Underskott, carried to the first page p. 1.1/1.2. */
export const INK3S_SURPLUS = { profit: '8695', loss: '8795' } as const
/** 7.5a Beräknad schablonintäkt på periodiseringsfonder. */
export const INK3S_PFOND_SCHABLON = '8688'

/** Sums: they follow their parts and are never overridden or entered. */
export const INK3_DERIVED_CODES: ReadonlySet<string> = new Set([
  INK3R_BOOKKEEPING_RESULT.profit,
  INK3R_BOOKKEEPING_RESULT.loss,
  INK3R_TAXABLE_RESULT.profit,
  INK3R_TAXABLE_RESULT.loss,
  INK3S_CARRIED_RESULT.profit,
  INK3S_CARRIED_RESULT.loss,
  INK3S_SURPLUS.profit,
  INK3S_SURPLUS.loss,
])

/** Pairs of boxes of which at most one may be filled (the xls "Får ej förekomma" rules on the yes/no boxes). */
export const INK3_EXCLUSIVE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['8040', '8041'],
  ['8044', '8045'],
]

export interface Ink3Layout {
  /** INK3R 5.1-5.11. */
  assetCodes: string[]
  /** INK3R 5.12-5.21. */
  equityLiabilityCodes: string[]
  /** Bookkeeping box to its taxable twin (6.1 and 6.19 have none). */
  taxableTwin: ReadonlyMap<string, string | null>
  /** INK3R income statement bookkeeping boxes 6.1-6.19 with their sign. */
  incomeStatement: ReadonlyArray<{ code: string; sign: '+' | '-' }>
  /** The terms of 7.9/7.10 (rows 7.1-7.8) with the printed sign. */
  surplusTerms: ReadonlyArray<{ code: string; factor: 1 | -1 }>
}

function rutaMinor(ruta: string): number {
  return Number(ruta.split('.')[1])
}

function isResult(field: Ink3FieldDefinition): boolean {
  return INK3_DERIVED_CODES.has(field.code)
}

const cache = new WeakMap<Ink3FieldTable, Ink3Layout>()

export function ink3Layout(table: Ink3FieldTable): Ink3Layout {
  const cached = cache.get(table)
  if (cached) return cached

  const balance = table.fields.filter((f) => f.blankett === 'INK3R' && f.ruta?.startsWith('5.'))
  const assetCodes = balance.filter((f) => rutaMinor(f.ruta!) <= 11).map((f) => f.code)
  const equityLiabilityCodes = balance.filter((f) => rutaMinor(f.ruta!) >= 12).map((f) => f.code)

  const income = table.fields.filter((f) => f.blankett === 'INK3R' && f.column !== null && !isResult(f))
  const taxableTwin = new Map<string, string | null>()
  const incomeStatement: Array<{ code: string; sign: '+' | '-' }> = []
  for (const field of income) {
    if (field.column !== 'bokforing') continue
    const twin = income.find(
      (f) => f.column === 'skattepliktig' && f.ruta === field.ruta && f.sign === field.sign,
    )
    taxableTwin.set(field.code, twin?.code ?? null)
    incomeStatement.push({ code: field.code, sign: field.sign as '+' | '-' })
  }

  const surplusTerms = table.fields
    .filter((f) => f.blankett === 'INK3S' && f.ruta !== null && /^7\.[1-8][a-d]?$/.test(f.ruta))
    .map((f) => ({ code: f.code, factor: (f.sign === '-' ? -1 : 1) as 1 | -1 }))

  const layout: Ink3Layout = { assetCodes, equityLiabilityCodes, taxableTwin, incomeStatement, surplusTerms }
  cache.set(table, layout)
  return layout
}
