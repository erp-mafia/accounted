/**
 * Texts of the kontantmetoden year-end cut-off (#3440) that client code
 * renders too (the momsdeklaration checks run in the browser). No imports on
 * purpose: this module must stay safe for a client bundle.
 */

/**
 * The warning for a company with a year end closed by a legacy cut-off
 * (aggregate verifikat with a vändning on day one, self-hosted only; code
 * LEGACY_KONTANTMETOD_VANDNING). Its posted figures stand and the VAT
 * functions still exclude its vändning, so nothing filed moves. But an invoice
 * it covered and that was paid the year after booked revenue and moms again at
 * payment, and a storno of the vändning would put the excluded figures into a
 * filed period. Null when there is none.
 */
export function legacyKontantmetodVandningWarning(
  legacyCutoffs: ReadonlyArray<{ periodEnd: string }>,
): string | null {
  if (legacyCutoffs.length === 0) return null
  const ends = [...new Set(legacyCutoffs.map((c) => c.periodEnd))].sort().join(', ')
  return (
    `Räkenskapsår som slutade ${ends} stängdes med en äldre kontantmetodavgränsning med vändning. ` +
    'Makulera inte vändningarna: de bokförda och redovisade beloppen ska stå kvar. ' +
    'En faktura som den avgränsningen omfattade och som betalades året efter kan ha fått momsen redovisad ' +
    'både vid bokslutet och vid betalningen. Låt redovisningsbyrån bedöma om en rättad momsdeklaration behövs.'
  )
}
