/**
 * The BAS accounts that hold the accumulated av- och nedskrivningar of the
 * immateriella and materiella anläggningstillgångar: 10x8/10x9 to 12x8/12x9
 * (1019, 1118, 1229, 1249, ...). 1080-1089, 1180-1189 and 1280-1289 are
 * förskott and pågående nyanläggningar, not contras. Read on the first four
 * digits, so a company's own sub-account counts as its BAS head.
 */
const ACCUMULATED_CONTRA = /^1[012][0-79][89]$/

export function isAccumulatedContraAccount(account: string): boolean {
  return ACCUMULATED_CONTRA.test(account.slice(0, 4))
}
