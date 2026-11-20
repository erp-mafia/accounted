import type { ContractRevenueMethod } from './calculator'

/**
 * The one Swedish name of each method for pågående arbeten, as K3 kapitel 23
 * names it: successiv vinstavräkning (23.17-23.27) and, for a juridisk
 * person, färdigställandemetoden (23.31-23.37). Huvudregeln and
 * alternativregeln are K2's names (BFNAR 2016:10 punkt 6.15-6.25) and never
 * name a K3 method. The verifikat text and the årsredovisning note read
 * these; the register page (sv.json contract_revenue.method_*) and the
 * behandlingshistorik (ledger kernel, which may not import this block) keep
 * copies that methods.test.ts holds to them.
 */
export const CONTRACT_REVENUE_METHOD_NAMES: Readonly<Record<ContractRevenueMethod, string>> = {
  successiv: 'Successiv vinstavräkning',
  fardigstallande: 'Färdigställandemetoden',
}

/** The name inside a sentence ("enligt successiv vinstavräkning"). */
export function contractRevenueMethodInText(method: ContractRevenueMethod): string {
  return CONTRACT_REVENUE_METHOD_NAMES[method].toLowerCase()
}
