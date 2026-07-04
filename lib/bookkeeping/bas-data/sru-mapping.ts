/**
 * SRU Code Computation
 *
 * Replicates the range-based SRU code assignment logic from
 * supabase/migrations/20240101000021_sru_codes.sql.
 *
 * SRU codes are used for NE (enskild firma) and INK2 (aktiebolag) tax forms
 * filed with Skatteverket.
 */

/**
 * Compute the SRU code for a given BAS account number.
 *
 * The logic applies NE-form codes first (higher priority for revenue/expense
 * accounts), then falls back to INK2 balance sheet codes.
 */
export function computeSRUCode(accountNumber: string): string | null {
  const num = accountNumber

  // ---------------------------------------------------------------------------
  // NE form codes (enskild firma): fields 7310-7325
  // ---------------------------------------------------------------------------

  // NE: R1 - Försäljning med moms (3000-3499 excl 3100)
  if (num >= '3000' && num <= '3499' && num !== '3100') return '7310'

  // NE: R2 - Momsfria intäkter (3100, 3900, 3970-3980)
  if (num === '3100' || num === '3900' || (num >= '3970' && num <= '3980')) return '7311'

  // NE: R3 - Bil/bostadsförmån (3200-3299): overlaps with R1, R1 wins
  if (num >= '3200' && num <= '3299') return '7312'

  // NE: R4 - Ränteintäkter (8310-8330)
  if (num >= '8310' && num <= '8330') return '7313'

  // NE: R5 - Varuinköp (4000-4990)
  if (num >= '4000' && num <= '4990') return '7320'

  // NE: R6 - Övriga kostnader (5000-6990, 7970)
  if ((num >= '5000' && num <= '6990') || num === '7970') return '7321'

  // NE: R7 - Lönekostnader (7000-7699)
  if (num >= '7000' && num <= '7699') return '7322'

  // NE: R8 - Räntekostnader (8400-8499)
  if (num >= '8400' && num <= '8499') return '7323'

  // NE: R9 - Avskrivningar fastighet (7820)
  if (num === '7820') return '7324'

  // NE: R10 - Avskrivningar övrigt (7700-7899 excl 7820)
  if (num >= '7700' && num <= '7899' && num !== '7820') return '7325'

  // ---------------------------------------------------------------------------
  // INK2 form codes (aktiebolag): fields 7201-7380
  // ---------------------------------------------------------------------------

  // INK2: Immateriella anläggningstillgångar (1000-1099)
  if (num >= '1000' && num <= '1099') return '7201'

  // INK2: Materiella anläggningstillgångar (1100-1299)
  if (num >= '1100' && num <= '1299') return '7202'

  // INK2: Finansiella anläggningstillgångar (1300-1399)
  if (num >= '1300' && num <= '1399') return '7203'

  // INK2: Varulager (1400-1499)
  if (num >= '1400' && num <= '1499') return '7210'

  // INK2: Kundfordringar (1500-1599)
  if (num >= '1500' && num <= '1599') return '7211'

  // INK2: Övriga omsättningstillgångar (1600-1999)
  if (num >= '1600' && num <= '1999') return '7212'

  // INK2: Aktiekapital (2081)
  if (num === '2081') return '7220'

  // INK2: Övrigt eget kapital (2085-2098)
  if (num >= '2085' && num <= '2098') return '7221'

  // INK2: Årets resultat (2099)
  if (num === '2099') return '7222'

  // INK2: Skulder (2100-2499)
  if (num >= '2100' && num <= '2499') return '7230'

  // INK2: Övriga skulder (2500-2999)
  if (num >= '2500' && num <= '2999') return '7231'

  // ---------------------------------------------------------------------------
  // INK2 remaining income statement (fallback for class 3-8 not covered by NE)
  // ---------------------------------------------------------------------------

  if (num >= '3000' && num <= '3999') return '7310'
  if (num >= '4000' && num <= '4999') return '7320'
  if (num >= '5000' && num <= '6999') return '7330'
  if (num >= '7000' && num <= '7699') return '7340'
  if (num >= '7700' && num <= '7899') return '7350'
  if (num >= '7900' && num <= '7999') return '7360'
  if (num >= '8000' && num <= '8499') return '7370'
  if (num >= '8500' && num <= '8999') return '7380'

  // Equity accounts not covered above (2000-2084)
  if (num >= '2000' && num <= '2084') return '7221'

  return null
}
