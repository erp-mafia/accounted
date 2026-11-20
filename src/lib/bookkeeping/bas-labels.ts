/**
 * BAS class labels. Split from bas-reference.ts, whose index helpers import
 * the full ~1,276-account chart (a 315 KB chunk): code that only needs a
 * label must not pay for the data.
 */

/** Swedish labels for each BAS account class (1-8) */
export const ACCOUNT_CLASS_LABELS: Record<number, string> = {
  1: 'Tillgångar',
  2: 'Eget kapital och skulder',
  3: 'Rörelseintäkter',
  4: 'Varuinköp och material',
  5: 'Övriga externa kostnader',
  6: 'Övriga externa kostnader',
  7: 'Personalkostnader och avskrivningar',
  8: 'Finansiella poster och resultat',
}
