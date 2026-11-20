import { roundOre } from '@/lib/money'

/**
 * Pågående arbeten på balansdagen under K3 kapitel 23: successiv
 * vinstavräkning (23.17-23.27) and, for a juridisk person in a branch that
 * IL 17 kap. 23 § names, the färdigställandemetod (23.31-23.32). Pure: the
 * contracts and the register's balances come in, the positions and the
 * adjustment's journal lines come out.
 *
 * Successiv vinstavräkning, per contract:
 *   - Uppdrag på löpande räkning (23.17): the income is the work performed
 *     and material delivered at the contract's rates, stated by the company.
 *   - Uppdrag till fast pris with a reliably estimable outcome (23.18):
 *     upparbetad intäkt = uppdragsinkomst x färdigställandegrad, the grade
 *     by the method that measures the work most reliably (23.22): incurred
 *     costs over estimated total costs, or a stated survey or physical grade.
 *   - Not reliably estimable (23.23): income only up to the incurred costs
 *     that the customer will probably reimburse.
 *   - Expected loss (23.24): the whole expected loss is a cost now; the
 *     provision is what the recognised result does not yet show.
 *   - Upparbetad intäkt less fakturerat is one net position per contract
 *     (23.27): an asset (1620 Upparbetad men ej fakturerad intäkt) or a
 *     liability (2450 Fakturerad men ej upparbetad intäkt). Positions of
 *     different contracts are not netted against each other.
 *
 * Färdigställandemetoden (juridisk person): income when the work is
 * väsentligen fullgjort; until then the incurred costs are an asset and the
 * invoiced amounts a liability (23.31), the expected loss a cost at once
 * (23.32). The method applies to every such contract or none (23.31 andra
 * stycket), so it is a company choice, not a contract one.
 *
 * The adjustment is the difference between the positions and what the
 * register's own verifikat already hold on the position accounts, so the
 * same year can be recomputed and only the change is booked, and a balance
 * the register did not book (another provision on 2290, a manual posting on
 * 1620) is never moved. Every invoice in the year went
 * to revenue as usual (with its VAT); the adjustment moves revenue to or from
 * the balance sheet on `revenueAdjustment`, which must be a class 3 account
 * outside the momsdeklaration rutor: upparbetad intäkt is not a supply for
 * VAT, and an adjustment on 3001 would change ruta 05.
 */

export type ContractRevenueMethod = 'successiv' | 'fardigstallande'

export interface ContractInput {
  id: string
  name: string
  kind: 'fast_pris' | 'lopande_rakning'
  /** Uppdragsinkomst (23.19): the agreed price plus probable changes, claims and incentives. */
  uppdragsinkomst: number
  /** Estimated total uppdragsutgifter (23.20). */
  beraknade_totala_utgifter: number
  /** Uppdragsutgifter incurred to date, cumulative over the contract. */
  nedlagda_utgifter: number
  /** Invoiced to date, cumulative over the contract, excluding VAT. */
  fakturerat: number
  /** Of the invoiced amounts, held back by the customer until conditions are met (23.30 c). */
  innehallna_belopp: number
  /** 23.18 a-d all hold. Ignored for löpande räkning. */
  tillforlitligt_utfall: boolean
  /** How the grade is measured (23.22). */
  fardigstallandegrad_metod: 'utgifter' | 'undersokning' | 'fysisk'
  /** The surveyed or physical grade, 0 to 1, when the method is not 'utgifter'. */
  angiven_fardigstallandegrad: number | null
  /** 23.23: incurred costs the customer will probably reimburse; defaults to nedlagda_utgifter. */
  ersattningsbara_utgifter: number | null
  /** Löpande räkning (23.17): the value of work performed and material delivered to date. */
  upparbetat_lopande: number | null
  /** Färdigställandemetoden: the work is väsentligen fullgjort (23.31 kommentar). */
  vasentligen_fullgjort: boolean
}

export interface ContractPosition {
  id: string
  name: string
  /** Färdigställandegrad in percent (fast pris under successiv vinstavräkning), else null. */
  fardigstallandegrad_procent: number | null
  /** Income recognised to date, cumulative. */
  upparbetad_intakt: number
  /** Upparbetad intäkt less fakturerat: positive an asset, negative a liability. */
  netto: number
  /** Provision for the expected loss not yet in the recognised result. */
  befarad_forlust: number
  /** Färdigställandemetoden: capitalised costs and invoiced amounts of an unfinished contract. */
  balanserade_utgifter: number
  fakturerat_skuld: number
}

export interface ContractRevenueAccounts {
  /** Class 3 account outside every momsdeklaration ruta. */
  revenueAdjustment: string
  /** 1620 Upparbetad men ej fakturerad intäkt. */
  accruedRevenue: string
  /** 2450 Fakturerad men ej upparbetad intäkt. */
  billedInAdvance: string
  /** 6330 Förluster i pågående arbeten. */
  lossExpense: string
  /** 2290 Övriga avsättningar. */
  lossProvision: string
  /** 1471 Pågående arbeten, nedlagda kostnader (färdigställandemetoden). */
  wipCosts: string
  /** 4970 Förändring av pågående arbeten, nedlagda kostnader. */
  wipCostsChange: string
  /** 2431 Pågående arbeten, fakturering (färdigställandemetoden). */
  wipBilling: string
}

export const DEFAULT_CONTRACT_REVENUE_ACCOUNTS: Omit<ContractRevenueAccounts, 'revenueAdjustment'> = {
  accruedRevenue: '1620',
  billedInAdvance: '2450',
  lossExpense: '6330',
  lossProvision: '2290',
  wipCosts: '1471',
  wipCostsChange: '4970',
  wipBilling: '2431',
}

/** What the register's own verifikat hold on the position accounts on balansdagen, before the adjustment (debit positive). */
export type PositionBalances = Readonly<Record<string, number>>

export interface ContractRevenueLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string
}

export interface ContractRevenueResult {
  method: ContractRevenueMethod
  positions: ContractPosition[]
  /** Target balances (debit positive) of the position accounts after the adjustment. */
  targets: Record<string, number>
  /** The adjustment's journal lines, balanced; empty when the ledger already holds the positions. */
  lines: ContractRevenueLine[]
  issues: ContractRevenueIssue[]
}

export type ContractRevenueIssueCode =
  | 'CONTRACT_GRADE_MISSING'
  | 'CONTRACT_ESTIMATE_BELOW_INCURRED'
  | 'CONTRACT_LOPANDE_VALUE_MISSING'

export interface ContractRevenueIssue {
  code: ContractRevenueIssueCode
  contractId: string
}

const ore = (value: number) => roundOre(value) || 0
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

function stageOfCompletion(contract: ContractInput, issues: ContractRevenueIssue[]): number | null {
  if (contract.fardigstallandegrad_metod === 'utgifter') {
    if (contract.beraknade_totala_utgifter <= 0) {
      issues.push({ code: 'CONTRACT_GRADE_MISSING', contractId: contract.id })
      return null
    }
    if (contract.nedlagda_utgifter > contract.beraknade_totala_utgifter) {
      // The estimate must cover what is already spent (23.21: revise each balansdag).
      issues.push({ code: 'CONTRACT_ESTIMATE_BELOW_INCURRED', contractId: contract.id })
    }
    return clamp01(contract.nedlagda_utgifter / contract.beraknade_totala_utgifter)
  }
  if (contract.angiven_fardigstallandegrad === null) {
    issues.push({ code: 'CONTRACT_GRADE_MISSING', contractId: contract.id })
    return null
  }
  return clamp01(contract.angiven_fardigstallandegrad)
}

/** Successiv vinstavräkning for one contract (23.17-23.27). */
export function successivPosition(contract: ContractInput, issues: ContractRevenueIssue[] = []): ContractPosition {
  let grade: number | null = null
  let upparbetad: number
  if (contract.kind === 'lopande_rakning') {
    if (contract.upparbetat_lopande === null) {
      issues.push({ code: 'CONTRACT_LOPANDE_VALUE_MISSING', contractId: contract.id })
    }
    upparbetad = contract.upparbetat_lopande ?? contract.fakturerat
  } else {
    grade = stageOfCompletion(contract, issues)
    upparbetad = contract.tillforlitligt_utfall && grade !== null
      ? contract.uppdragsinkomst * grade
      : Math.min(contract.nedlagda_utgifter, contract.ersattningsbara_utgifter ?? contract.nedlagda_utgifter)
  }
  upparbetad = ore(upparbetad)
  // 23.24: the expected final result; whatever loss the recognised result
  // (upparbetad less incurred) does not show yet is provided for now.
  const expectedResult = contract.uppdragsinkomst - Math.max(contract.beraknade_totala_utgifter, contract.nedlagda_utgifter)
  const recognisedResult = upparbetad - contract.nedlagda_utgifter
  const provision = contract.kind === 'fast_pris' && expectedResult < 0
    ? ore(Math.max(0, recognisedResult - expectedResult))
    : 0
  return {
    id: contract.id,
    name: contract.name,
    fardigstallandegrad_procent: grade === null ? null : ore(grade * 100),
    upparbetad_intakt: upparbetad,
    netto: ore(upparbetad - contract.fakturerat),
    befarad_forlust: provision,
    balanserade_utgifter: 0,
    fakturerat_skuld: 0,
  }
}

/** Färdigställandemetoden for one contract (23.31-23.32). */
export function fardigstallandePosition(contract: ContractInput): ContractPosition {
  const expectedResult = contract.uppdragsinkomst - Math.max(contract.beraknade_totala_utgifter, contract.nedlagda_utgifter)
  if (contract.vasentligen_fullgjort) {
    // Resultatavräknat: the whole income and cost are in the result.
    return {
      id: contract.id,
      name: contract.name,
      fardigstallandegrad_procent: null,
      upparbetad_intakt: ore(contract.fakturerat),
      netto: 0,
      befarad_forlust: 0,
      balanserade_utgifter: 0,
      fakturerat_skuld: 0,
    }
  }
  // Unfinished: costs are an asset, invoices a liability, and an expected
  // loss is a cost now (23.32) for the part the capitalised costs do not
  // already carry (the whole loss, as nothing is in the result yet).
  return {
    id: contract.id,
    name: contract.name,
    fardigstallandegrad_procent: null,
    upparbetad_intakt: 0,
    netto: 0,
    befarad_forlust: expectedResult < 0 ? ore(-expectedResult) : 0,
    balanserade_utgifter: ore(contract.nedlagda_utgifter),
    fakturerat_skuld: ore(contract.fakturerat),
  }
}

function line(account: string, amount: number, description: string): ContractRevenueLine | null {
  const value = ore(amount)
  if (value === 0) return null
  return value > 0
    ? { account_number: account, debit_amount: value, credit_amount: 0, line_description: description }
    : { account_number: account, debit_amount: 0, credit_amount: -value, line_description: description }
}

/**
 * The positions on balansdagen and the journal lines that move the ledger
 * there from `balances` (what the register's verifikat hold on the position accounts before it).
 */
export function computeContractRevenue(
  method: ContractRevenueMethod,
  contracts: readonly ContractInput[],
  accounts: ContractRevenueAccounts,
  balances: PositionBalances,
): ContractRevenueResult {
  const issues: ContractRevenueIssue[] = []
  const positions = contracts.map((contract) =>
    method === 'successiv' ? successivPosition(contract, issues) : fardigstallandePosition(contract))

  // Target balances, debit positive. Each contract's net position stands on
  // its own side (23.27); provisions are a liability.
  const asset = positions.reduce((sum, p) => sum + Math.max(0, p.netto), 0)
  const liability = positions.reduce((sum, p) => sum + Math.min(0, p.netto), 0)
  const provision = positions.reduce((sum, p) => sum + p.befarad_forlust, 0)
  const wipCosts = positions.reduce((sum, p) => sum + p.balanserade_utgifter, 0)
  const wipBilling = positions.reduce((sum, p) => sum + p.fakturerat_skuld, 0)
  const targets: Record<string, number> = {
    [accounts.accruedRevenue]: ore(asset),
    [accounts.billedInAdvance]: ore(liability),
    [accounts.lossProvision]: ore(-provision),
    [accounts.wipCosts]: ore(wipCosts),
    [accounts.wipBilling]: ore(-wipBilling),
  }
  const current = (account: string) => balances[account] ?? 0
  const change = (account: string) => ore(targets[account] - current(account))

  // Revenue side: the change in net positions and in invoiced amounts held
  // as a liability moves revenue (credit when the asset grows or the billing
  // liability shrinks). Cost side: the provision and the capitalised costs.
  const revenueChange = ore(
    change(accounts.accruedRevenue) + change(accounts.billedInAdvance) + change(accounts.wipBilling),
  )
  const lines = [
    line(accounts.accruedRevenue, change(accounts.accruedRevenue), 'Upparbetad men ej fakturerad intäkt'),
    line(accounts.billedInAdvance, change(accounts.billedInAdvance), 'Fakturerad men ej upparbetad intäkt'),
    line(accounts.wipBilling, change(accounts.wipBilling), 'Pågående arbeten, fakturering'),
    line(accounts.revenueAdjustment, -revenueChange, 'Förändring av upparbetade intäkter'),
    line(accounts.lossProvision, change(accounts.lossProvision), 'Befarade förluster i pågående arbeten'),
    line(accounts.lossExpense, -change(accounts.lossProvision), 'Befarade förluster i pågående arbeten'),
    line(accounts.wipCosts, change(accounts.wipCosts), 'Pågående arbeten, nedlagda kostnader'),
    line(accounts.wipCostsChange, -change(accounts.wipCosts), 'Förändring av pågående arbeten'),
  ].filter((l): l is ContractRevenueLine => l !== null)

  return { method, positions, targets, lines, issues }
}
