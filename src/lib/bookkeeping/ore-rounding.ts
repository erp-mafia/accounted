/**
 * Öresavrundning on a bank settlement: the one rule every payment builder
 * uses to decide "is this rounding, and which side of 3740".
 *
 * A whole-krona Bankgiro/Swish payment of an öre-bearing amount leaves a
 * sub-krona gap between what was owed and what moved through the bank. The
 * bank leg books what actually moved (so 1930 follows the bank statement),
 * the debt or revenue side books what was owed, and 3740 Öres- och
 * kronutjämning carries the gap. 3740 carries no VAT, so the revenue and moms
 * lines never move.
 *
 * The rule used to live in a copy per path (customer accrual clearing,
 * customer payment dialog, supplier clearing and cash, the invoice payment
 * plan), and the customer kontantmetoden entry had none at all: it booked the
 * exact invoice on 1930 while the plan absorbed the gap (cash-bank-match-ore).
 * Only the 3740 side differs between the two ledgers, so that is the one
 * parameter.
 *
 * SEK only: a cross-currency settlement carries a kursdiff (3960/7960)
 * instead, and öresavrundning is meaningful only in whole Swedish kronor.
 * Callers decide that before asking.
 */
import { roundOre, ORE_ROUNDING_ACCOUNT, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * The öresavrundning residual of a SEK settlement: roundOre(owedSek - bankSek)
 * when it is non-zero and strictly inside ORE_ROUNDING_SETTLEMENT_MAX, else 0
 * (an exact settlement, or a genuine difference of a krona or more, which is
 * never rounding).
 *
 *   > 0: the bank moved LESS than owed
 *   < 0: the bank moved MORE than owed
 */
export function oreSettlementResidual(owedSek: number, bankSek: number): number {
  const diff = roundOre(roundOre(owedSek) - roundOre(bankSek))
  return diff !== 0 && Math.abs(diff) < ORE_ROUNDING_SETTLEMENT_MAX ? diff : 0
}

/**
 * The öresavrundning a SEK customer invoice's own verifikat already booked:
 * what the reskontra says is still owed less what 1510 carries for it, when
 * that gap is inside the öre band. It is there when the issue verifikat put
 * 1510 at the rounded "Att betala" and the öre on 3740 (an issuance edited by
 * hand, the way Fortnox books it). A settlement of that invoice clears what
 * 1510 carries and books only the rest of the öre: otherwise the rounding
 * lands on 3740 twice and 1510 keeps the öre.
 *
 *   > 0: 1510 carries LESS than owed (the issue verifikat debited 3740)
 *   < 0: 1510 carries MORE than owed (the issue verifikat credited 3740)
 *   0:   1510 carries the remainder, the ledger cannot say (null), or the
 *        gap is a krona or more, which is never rounding
 */
export function bookedOreRounding(remainingSek: number, carriedSek: number | null | undefined): number {
  return carriedSek == null ? 0 : oreSettlementResidual(remainingSek, carriedSek)
}

/**
 * The öresavrundning a SEK customer document's issue verifikat put on 1510:
 * what the verifikat carries on 151x (1513 aside) less the document's own
 * receivable (its total less the ROT/RUT share), when that gap is inside the
 * öre band. bookedOreRounding read from the issue side: the same gap, signed
 * the way the verifikat booked it.
 *
 *   > 0: rounded up (1510 carries more, 3740 credited)
 *   < 0: rounded down (1510 carries less, 3740 debited)
 *   0:   the exact total, the ledger cannot say (null), or a krona or more
 */
export function registrationOreRounding(receivableSek: number, registeredSek: number | null | undefined): number {
  const booked = bookedOreRounding(receivableSek, registeredSek)
  return booked === 0 ? 0 : -booked
}

/**
 * Which ledger the settlement clears. It decides the 3740 side:
 *
 *   customer (1510 or revenue credited, bank debited):
 *     paid short (residual > 0) -> öresavrundningsförlust -> Dr 3740
 *     paid over  (residual < 0) -> öresavrundningsvinst   -> Cr 3740
 *   supplier (2440 or cost debited, bank credited):
 *     paid short (residual > 0) -> öresavrundningsvinst   -> Cr 3740
 *     paid over  (residual < 0) -> öresavrundningsförlust -> Dr 3740
 */
export type OreRoundingSide = 'customer' | 'supplier'

/** The 3740 line for a non-zero `oreSettlementResidual`. */
export function oreRoundingLine(
  residual: number,
  side: OreRoundingSide,
): CreateJournalEntryLineInput {
  const amount = Math.abs(residual)
  const debit = side === 'customer' ? residual > 0 : residual < 0
  return {
    account_number: ORE_ROUNDING_ACCOUNT,
    debit_amount: debit ? amount : 0,
    credit_amount: debit ? 0 : amount,
    line_description: 'Öresavrundning',
  }
}

/** 3960 Valutakursvinster. */
export const FX_GAIN_ACCOUNT = '3960'
/** 7960 Valutakursförluster. */
export const FX_LOSS_ACCOUNT = '7960'

/**
 * The kursdiff leg of a cross-currency settlement or revaluation: a gain
 * (gainSek > 0) credits 3960, a loss (gainSek <= 0) debits 7960, with the
 * amount öre-rounded (roundOre). The leg every generator builds the same way;
 * only the texts differ, so they are the one option (the defaults are the
 * realised texts, currency-revaluation passes the orealiserade ones).
 *
 * Callers decide whether there is a difference at all before asking.
 */
export function fxDifferenceLine(
  gainSek: number,
  texts: { gain: string; loss: string } = { gain: 'Valutakursvinst', loss: 'Valutakursförlust' },
): CreateJournalEntryLineInput {
  const amount = roundOre(Math.abs(gainSek))
  return gainSek > 0
    ? { account_number: FX_GAIN_ACCOUNT, debit_amount: 0, credit_amount: amount, line_description: texts.gain }
    : { account_number: FX_LOSS_ACCOUNT, debit_amount: amount, credit_amount: 0, line_description: texts.loss }
}
