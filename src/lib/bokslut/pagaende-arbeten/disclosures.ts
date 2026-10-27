import { roundOre } from '@/lib/money'
import type { ContractInput, ContractRevenueResult } from './calculator'

/**
 * The note facts of pågående arbeten, as the K3 disclosure matrix (P1) reads
 * them:
 *   - 23.29 a, every company: the principle (successiv vinstavräkning or the
 *     färdigställandemetod a juridisk person may use, 23.31);
 *   - 23.29 b, every company: the methods used for the färdigställandegrad;
 *   - 23.30, större företag: upparbetade intäkter, fakturerade belopp and
 *     belopp innehållna av beställaren on the balansdag;
 *   - ÅRL 5 kap. 5 § andra stycket: the gross amounts netted per contract
 *     (upparbetad intäkt against fakturerat, 23.27 kommentar).
 */

export interface ContractRevenueDisclosures {
  /** 23.29 a. */
  principle: 'successiv_vinstavrakning' | 'fardigstallandemetoden'
  /** 23.29 b: the methods in use, each once, in a fixed order. */
  completionMethods: Array<'utgifter' | 'undersokning' | 'fysisk'>
  /** 23.30 a-c, summed over the contracts in progress on balansdagen. */
  inProgress: {
    upparbetade_intakter: number
    fakturerade_belopp: number
    innehallna_belopp: number
  }
  /** ÅRL 5:5: the gross amounts behind the net assets and the net liabilities. */
  nettedGross: {
    assets: { upparbetat: number; fakturerat: number }
    liabilities: { upparbetat: number; fakturerat: number }
  }
  /** The expected losses provided for (23.24, 23.32). */
  befarade_forluster: number
}

const ore = (value: number) => roundOre(value) || 0

export function contractRevenueDisclosures(
  result: ContractRevenueResult,
  contracts: readonly ContractInput[],
): ContractRevenueDisclosures {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]))
  const inProgress = result.positions.filter((position) => !byId.get(position.id)?.vasentligen_fullgjort)
  const methods = new Set(
    inProgress
      .map((position) => byId.get(position.id))
      .filter((contract): contract is ContractInput => contract?.kind === 'fast_pris')
      .map((contract) => contract.fardigstallandegrad_metod),
  )
  const sum = (values: number[]) => ore(values.reduce((total, value) => total + value, 0))
  const assets = inProgress.filter((position) => position.netto > 0)
  const liabilities = inProgress.filter((position) => position.netto < 0)
  const invoiced = (id: string) => byId.get(id)?.fakturerat ?? 0
  return {
    principle: result.method === 'successiv' ? 'successiv_vinstavrakning' : 'fardigstallandemetoden',
    completionMethods: (['utgifter', 'undersokning', 'fysisk'] as const).filter((method) => methods.has(method)),
    inProgress: {
      upparbetade_intakter: sum(inProgress.map((position) => position.upparbetad_intakt)),
      fakturerade_belopp: sum(inProgress.map((position) => invoiced(position.id))),
      innehallna_belopp: sum(inProgress.map((position) => byId.get(position.id)?.innehallna_belopp ?? 0)),
    },
    nettedGross: {
      assets: {
        upparbetat: sum(assets.map((position) => position.upparbetad_intakt)),
        fakturerat: sum(assets.map((position) => invoiced(position.id))),
      },
      liabilities: {
        upparbetat: sum(liabilities.map((position) => position.upparbetad_intakt)),
        fakturerat: sum(liabilities.map((position) => invoiced(position.id))),
      },
    },
    befarade_forluster: sum(result.positions.map((position) => position.befarad_forlust)),
  }
}
