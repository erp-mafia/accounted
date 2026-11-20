/**
 * The BAS class headings of the resultatrapport, shared by its per-dimension
 * sibling and the budget grid so all three read identically. Report labels:
 * they stay Swedish in both locales. Pure, safe in the browser.
 */
export const RESULT_CLASS_LABELS: Record<number, string> = {
  3: '3 Rörelsens inkomster/intäkter',
  4: '4 Material- och varukostnader',
  5: '5 Övriga externa kostnader',
  6: '6 Övriga externa kostnader',
  7: '7 Personalkostnader',
  8: '8 Finansiella poster och bokslutsdispositioner',
}
