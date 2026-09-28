/** Swedbank requires a BGNR debtor account when the payee uses Bankgiro. */
export function requiresBankgiroDebtorForBankgiroPayee(bic: string): boolean {
  return bic.trim().toUpperCase().startsWith('SWEDSESS')
}
