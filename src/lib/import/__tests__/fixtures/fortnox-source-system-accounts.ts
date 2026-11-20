/**
 * A Fortnox year in the shape of the two imports that finished as completed
 * with bookkeeping missing (sie-amounts-without-target.ts), synthetic amounts:
 *
 *   - 0099, Fortnox's own account: X1 books the same amount in debit and
 *     credit on it and A3 holds two zero rows. Neither moves a balance.
 *   - 0999, an account the company made and books its supplier costs on:
 *     E12 and E13 pay suppliers from 1930 with ingående moms on 2641.
 *   - A6 was cancelled in Fortnox: only its struck row is left.
 *
 * #UB and #RES are what Fortnox reports for the year, so IB plus the vouchers
 * equals them on every account: 97 218,50 on 1930, 3 038,40 on 2641,
 * 2 153,60 of cost on 0999.
 */
export const FORTNOX_YEAR = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.57.11', '#FORMAT PC8', '#SIETYP 4',
  '#ORGNR 556677-8899', '#FNAMN "Exempelgården AB"', '#RAR 0 20260101 20261231',
  '#KONTO 0099 "Systemkonto"', '#KONTO 0999 "Inköp gården"',
  '#KONTO 1510 "Kundfordringar"', '#KONTO 1930 "Företagskonto"',
  '#KONTO 2081 "Aktiekapital"', '#KONTO 2099 "Årets resultat"',
  '#KONTO 2611 "Utgående moms 25 %"', '#KONTO 2641 "Debiterad ingående moms"',
  '#KONTO 3001 "Försäljning 25 %"', '#KONTO 5010 "Lokalhyra"', '#KONTO 6570 "Bankkostnader"',
  '#IB 0 1510 12500.00', '#IB 0 1930 100000.00', '#IB 0 2081 -50000.00', '#IB 0 2099 -62500.00',
  '#UB 0 1510 12500.00', '#UB 0 1930 97218.50', '#UB 0 2081 -50000.00', '#UB 0 2099 -62500.00',
  '#UB 0 2611 -2500.00', '#UB 0 2641 3038.40',
  '#RES 0 0999 2153.60', '#RES 0 3001 -10000.00', '#RES 0 5010 10000.00', '#RES 0 6570 89.50',
  '#VER A 1 20260110 "Kundfaktura 1"', '{', '#TRANS 1510 {} 12500.00', '#TRANS 3001 {} -10000.00', '#TRANS 2611 {} -2500.00', '}',
  '#VER A 2 20260115 "Bankavgift"', '{', '#TRANS 1930 {} -89.50', '#TRANS 6570 {} 89.50', '}',
  '#VER X 1 20260120 "Kundbet Testkund (259)"', '{', '#TRANS 0099 {} 2295.00', '#TRANS 0099 {} -2295.00', '}',
  '#VER A 3 20260125 "Momsrapport 2025-10-01 - 2025-12-31"', '{', '#TRANS 0099 {} 0.00', '#TRANS 0099 {} 0.00', '}',
  '#VER E 12 20260126 "Levbet Exempelfoder AB (215)"', '{', '#TRANS 1930 {} -2117.00', '#TRANS 2641 {} 423.40', '#TRANS 0999 {} 1693.60', '}',
  '#VER A 4 20260131 "Inbetalning kundfaktura 1"', '{', '#TRANS 1930 {} 12500.00', '#TRANS 1510 {} -12500.00', '}',
  '#VER E 13 20260215 "Levbet Veterinären i byn (298)"', '{', '#TRANS 1930 {} -575.00', '#TRANS 2641 {} 115.00', '#TRANS 0999 {} 460.00', '}',
  '#VER A 5 20260228 "Hyra februari"', '{', '#TRANS 1930 {} -12500.00', '#TRANS 5010 {} 10000.00', '#TRANS 2641 {} 2500.00', '}',
  '#VER A 6 20260301 "Felbokad, makulerad"', '{', '#BTRANS 1930 {} -100.00 20260301', '}',
].join('\n')

/** The year's accounts in BAS, each on its own number: what every door suggests for them. */
export const BAS_ACCOUNTS = ['1510', '1930', '2081', '2099', '2611', '2641', '3001', '5010', '6570']
