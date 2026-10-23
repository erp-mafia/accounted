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
