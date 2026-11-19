import type { VatDeclarationRutor } from '@/types'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import type { SkatteverketMomsuppgift } from '../types'

// Re-export shared formatting utilities
export { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'

/**
 * Every ruta of the declaration and the momsuppgift field that carries it.
 * Typed over the whole VatDeclarationRutor, so a ruta added to the declaration
 * does not compile until it has a Skatteverket field: the eSKD file and this
 * payload cannot end up with different sets of boxes. Read the other way by
 * vat-refusal.ts, to name the box a refused field belongs to.
 */
export const MOMSUPPGIFT_FIELD_BY_RUTA: Record<keyof VatDeclarationRutor, keyof SkatteverketMomsuppgift> = {
  // Taxable sales basis
  ruta05: 'momspliktigForsaljning',
  ruta06: 'momspliktigaUttag',
  ruta07: 'vinstmarginal',
  ruta08: 'hyresInkomst',
  // Output VAT on sales
  ruta10: 'momsForsaljningUtgaendeHog',
  ruta11: 'momsForsaljningUtgaendeMedel',
  ruta12: 'momsForsaljningUtgaendeLag',
  // Reverse charge purchase bases
  ruta20: 'inkopVarorEU',
  ruta21: 'inkopTjansterEU',
  ruta22: 'inkopTjansterUtanforEU',
  ruta23: 'inkopVarorSE',
  ruta24: 'inkopTjansterSE',
  // Output VAT on reverse charge purchases
  ruta30: 'momsInkopUtgaendeHog',
  ruta31: 'momsInkopUtgaendeMedel',
  ruta32: 'momsInkopUtgaendeLag',
  // EU/export sales
  ruta35: 'forsaljningVarorEU',
  ruta36: 'forsaljningVarorUtanforEU',
  ruta37: 'inkopVaror3pHandel',
  ruta38: 'forsaljningVaror3pHandel',
  ruta39: 'forsaljningTjansterEU',
  ruta40: 'ovrigForsaljningTjansterUtanforSE',
  ruta41: 'forsaljningBskKopareSE',
  ruta42: 'momsfriForsaljning',
  // Input VAT
  ruta48: 'ingaendeMomsAvdrag',
  // Net VAT
  ruta49: 'summaMoms',
  // Import
  ruta50: 'import',
  ruta60: 'momsImportUtgaendeHog',
  ruta61: 'momsImportUtgaendeMedel',
  ruta62: 'momsImportUtgaendeLag',
}

/**
 * Convert Accounted VatDeclarationRutor to Skatteverket's momsuppgift payload.
 *
 * Fields with value 0 are omitted (Skatteverket treats absent fields as 0).
 * This keeps the payload clean and avoids sending unnecessary data.
 *
 * Whole kronor: the amounts are the ones buildFiledAmounts produces, never
 * computed here. Every ruta has its öre dropped (öretal faller bort, SFF
 * 2011:1261 22 kap. 1 §: dropped, not rounded to the nearest krona) and ruta
 * 49 is the net of those whole-krona rutor. This mapper used to round each
 * ruta to the nearest krona on its own, so a declaration filed here could
 * differ by a krona or more from the eSKD file, the PDF and the net the
 * settlement verifikat books on 2650/1650 for the same period.
 *
 * summaMoms is that recomputed net, not the pre-computed öre ruta 49, so the
 * payload is internally consistent with how Skatteverket recomputes the sum
 * on their side: sum of the whole-krona output rutor minus ruta 48. Taking the
 * net from the öre figure instead drifts from the components by a krona or
 * more and triggers SKV's FK009 ("summaMoms stämmer inte överens med övriga
 * momsuppgifter") even when the underlying ledger arithmetic is correct.
 */
export function rutorToMomsuppgift(rutor: VatDeclarationRutor): SkatteverketMomsuppgift {
  const { amounts, net } = buildFiledAmounts(rutor)
  const result: SkatteverketMomsuppgift = {}

  for (const key of Object.keys(MOMSUPPGIFT_FIELD_BY_RUTA) as (keyof VatDeclarationRutor)[]) {
    // Only non-zero values are sent. A ruta holding nothing but öre truncates
    // to 0 (or -0) and is left out like an empty one.
    if (key !== 'ruta49' && amounts[key] !== 0) {
      result[MOMSUPPGIFT_FIELD_BY_RUTA[key]] = amounts[key]
    }
  }

  // Net VAT must always be present, also when it is 0.
  result.summaMoms = net

  return result
}
