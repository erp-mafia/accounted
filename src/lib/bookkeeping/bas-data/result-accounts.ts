/**
 * BAS 8990-8999, årets resultat: 8990 Resultat and 8999 Årets resultat, both
 * SRU 7450. A previous system or an owner moves the year's result to equity
 * through them by hand (Dr 899x / Cr 2099 for a profit), so their balance
 * mirrors the result instead of adding to it. Reports that compute the year's
 * result leave them out; reports that list accounts (Resultatrapport) show
 * them. One definition, so an omföring through 8990 reads like one through
 * 8999 everywhere.
 */
export function isAretsResultatAccount(account: string): boolean {
  return account >= '8990' && account <= '8999'
}

/**
 * Whether a BAS account is one a bokslut books to: 88xx bokslutsdispositioner
 * (periodiseringsfond, överavskrivningar), 89xx skatt och årets resultat, or
 * the legal form's result account (`resultAccount`, 2099 for an aktiebolag,
 * from the form profile). An SIE append flags vouchers that carry one (issue
 * #108): they change the year's closing balance, which a next year with a
 * posted IB then no longer matches.
 */
export function isYearEndAccount(account: string, resultAccount: string): boolean {
  return account.startsWith('88') || account.startsWith('89') || account === resultAccount
}
