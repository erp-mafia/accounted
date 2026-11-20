/**
 * The beloppsspärr of ABL 17 kap. 3 § as one comparison: a dividend may not
 * exceed the fritt eget kapital it is taken from. The årsredovisning's
 * completeness check (AR-DIVIDEND-EXCEEDS-EQUITY, the board's proposal
 * against the balance sheet) and the dividend register in Bolaget
 * (lib/bolaget/capital, the stämma's decision against the last adopted
 * balance sheet adjusted for later transfers) answer through this one
 * function, compared in whole öre so float drift never decides it.
 */
function ore(amount: number): number {
  return Math.round(amount * 100)
}

export function dividendExceedsFreeEquity(dividend: number, freeEquity: number): boolean {
  const dividendOre = ore(dividend)
  return dividendOre > 0 && dividendOre > ore(freeEquity)
}
