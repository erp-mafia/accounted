import type { VatDeclarationRutor } from '@/types'
import type { SkatteverketMomsuppgift } from '../types'

// Re-export shared formatting utilities
export { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'

/**
 * Convert Accounted VatDeclarationRutor to Skatteverket's momsuppgift payload.
 *
 * Fields with value 0 are omitted (Skatteverket treats absent fields as 0).
 * This keeps the payload clean and avoids sending unnecessary data.
 *
 * Rounding: every ruta is rounded to whole kronor (SKV's schema is integers).
 * summaMoms is recomputed from the rounded VAT-amount rutor: not from the
 * pre-rounding ruta49: so the payload is internally consistent with how
 * Skatteverket recomputes the sum on their side. Rounding ruta49 separately
 * from the components causes ±1 SEK drift on fractional-öres inputs and
 * triggers SKV's FK009 ("summaMoms stämmer inte överens med övriga
 * momsuppgifter") even when the underlying ledger arithmetic is correct.
 */
export function rutorToMomsuppgift(rutor: VatDeclarationRutor): SkatteverketMomsuppgift {
  const result: SkatteverketMomsuppgift = {}

  // Helper: only set non-zero values, rounded to whole kronor (SKV expects integers)
  const set = (key: keyof SkatteverketMomsuppgift, value: number) => {
    if (value !== 0) result[key] = Math.round(value)
  }

  // Taxable sales basis
  set('momspliktigForsaljning', rutor.ruta05)
  set('momspliktigaUttag', rutor.ruta06)
  set('vinstmarginal', rutor.ruta07)
  set('hyresInkomst', rutor.ruta08)

  // Output VAT on sales
  set('momsForsaljningUtgaendeHog', rutor.ruta10)
  set('momsForsaljningUtgaendeMedel', rutor.ruta11)
  set('momsForsaljningUtgaendeLag', rutor.ruta12)

  // Reverse charge purchase bases
  set('inkopVarorEU', rutor.ruta20)
  set('inkopTjansterEU', rutor.ruta21)
  set('inkopTjansterUtanforEU', rutor.ruta22)
  set('inkopVarorSE', rutor.ruta23)
  set('inkopTjansterSE', rutor.ruta24)

  // Output VAT on reverse charge purchases
  set('momsInkopUtgaendeHog', rutor.ruta30)
  set('momsInkopUtgaendeMedel', rutor.ruta31)
  set('momsInkopUtgaendeLag', rutor.ruta32)

  // EU/export sales
  set('forsaljningVarorEU', rutor.ruta35)
  set('forsaljningVarorUtanforEU', rutor.ruta36)
  set('inkopVaror3pHandel', rutor.ruta37)
  set('forsaljningVaror3pHandel', rutor.ruta38)
  set('forsaljningTjansterEU', rutor.ruta39)
  set('ovrigForsaljningTjansterUtanforSE', rutor.ruta40)
  set('forsaljningBskKopareSE', rutor.ruta41)
  set('momsfriForsaljning', rutor.ruta42)

  // Input VAT
  set('ingaendeMomsAvdrag', rutor.ruta48)

  // Import
  set('import', rutor.ruta50)
  set('momsImportUtgaendeHog', rutor.ruta60)
  set('momsImportUtgaendeMedel', rutor.ruta61)
  set('momsImportUtgaendeLag', rutor.ruta62)

  // Net VAT must always be present, whole kronor. Compute from the already-
  // rounded VAT-amount rutor so SKV's reconciliation (sum of integer rutor)
  // never disagrees with our summaMoms by ±1 SEK.
  result.summaMoms =
    (result.momsForsaljningUtgaendeHog ?? 0) +
    (result.momsForsaljningUtgaendeMedel ?? 0) +
    (result.momsForsaljningUtgaendeLag ?? 0) +
    (result.momsInkopUtgaendeHog ?? 0) +
    (result.momsInkopUtgaendeMedel ?? 0) +
    (result.momsInkopUtgaendeLag ?? 0) +
    (result.momsImportUtgaendeHog ?? 0) +
    (result.momsImportUtgaendeMedel ?? 0) +
    (result.momsImportUtgaendeLag ?? 0) -
    (result.ingaendeMomsAvdrag ?? 0)

  return result
}

