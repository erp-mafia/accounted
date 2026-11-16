/**
 * The transition to K3 (BFNAR 2012:1 kap. 35) as data and voucher lines.
 * Pure.
 *
 * Accounted supports the mindre företag route: the transition date is the
 * first day of the first K3 year (35.7 andra stycket) and the comparatives
 * are not restated (ÅRL 3 kap. 5 § fjärde stycket; the årsredovisning notes
 * the lack of comparability). The opening balance is made a K3 balance
 * sheet by one voucher in that year, dated its first day, against equity
 * (35.11), so no locked or closed year is touched:
 *   - the opening deferred tax (K3 kap. 29 at the transition), presented
 *     net on 2240 or 1370 (29.32), unless the 35.27 relief is used;
 *   - the adjustments the company states for the other principles that
 *     differ (35.8-35.10), each a balance sheet account and an amount.
 * The component split (35.18) books nothing (assets/transition-split.ts).
 */
import { roundOre } from '@/lib/money'
import { DEFERRED_TAX_ASSET_ACCOUNT, DEFERRED_TAX_EXPENSE_ACCOUNT, DEFERRED_TAX_LIABILITY_ACCOUNT } from '@/lib/bokslut/tax-provision/deferred-tax'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * The relief rules of 35.21-35.29 and 35.34 a company may apply (35.27,
 * deferred tax, is its own choice), with the wording the 35.31 note uses.
 */
export const K3_RELIEF_RULES = [
  {
    code: '35.21',
    label: 'Finansiella tillgångar och skulder som enligt K3 skulle ha tagits bort från balansräkningen redovisas fram till avyttring eller reglering (punkt 35.21).',
  },
  { code: '35.22', label: 'Koncernbidrag som inte redovisats som bokslutsdisposition har inte klassificerats om (punkt 35.22).' },
  {
    code: '35.23',
    label: 'Indirekta tillverkningskostnader har inte räknats in i anskaffningsvärdet för tillgångar från före övergången (punkt 35.23).',
  },
  { code: '35.24', label: 'Rörelseförvärv före övergången har inte räknats om enligt kapitel 19 (punkt 35.24).' },
  {
    code: '35.25',
    label: 'Kapitel 26 har inte tillämpats på egetkapitalinstrument som tilldelats före övergången (punkt 35.25).',
  },
  { code: '35.26', label: 'Ackumulerade omräkningsdifferenser har bestämts till noll vid övergången (punkt 35.26).' },
  {
    code: '35.28',
    label: 'Finansiella leasingavtal som tidigare redovisats som operationella har värderats till det återstående värdet enligt avtalet (punkt 35.28).',
  },
  {
    code: '35.29',
    label: 'Utgifter för nedmontering, bortforsling och återställande har beräknats vid tidpunkten för övergång (punkt 35.29).',
  },
  {
    code: '35.34',
    label: 'Andelar i dotter-, intresse- och gemensamt styrda företag har tagits upp till det redovisade värdet i föregående årsredovisning (punkt 35.34).',
  },
] as const

export type K3ReliefRule = (typeof K3_RELIEF_RULES)[number]['code']

export const K3_RELIEF_RULE_CODES = K3_RELIEF_RULES.map((rule) => rule.code) as [K3ReliefRule, ...K3ReliefRule[]]

/** An adjustment of the opening balance: a balance sheet account, + debit / - credit. */
export interface TransitionAdjustment {
  account_number: string
  amount: number
  description: string
}

export const TRANSITION_DESCRIPTION = 'Övergång till K3 (BFNAR 2012:1 kap. 35)'

/** Why an adjustment cannot be booked, one Swedish sentence each. */
export function adjustmentErrors(adjustments: readonly TransitionAdjustment[]): string[] {
  const errors: string[] = []
  for (const adjustment of adjustments) {
    const account = adjustment.account_number
    if (!/^[12]\d{3}$/.test(account)) {
      errors.push(`Konto ${account}: en övergångsjustering bokförs på balansräkningens konton (klass 1 och 2).`)
    } else if (account.startsWith('20')) {
      errors.push(`Konto ${account}: eget kapital är motkontot. Ange tillgången eller skulden som ändras.`)
    } else if (account === DEFERRED_TAX_LIABILITY_ACCOUNT || account === DEFERRED_TAX_ASSET_ACCOUNT) {
      errors.push(`Konto ${account}: den uppskjutna skatten vid övergången beräknas här och bokförs av sig själv.`)
    } else if (/^101\d$/.test(account)) {
      // K3 35.16: development expensed in earlier financial reports may never
      // be capitalised at the transition. A K2 company has nothing on 101x
      // (BFNAR 2016:10 punkt 10.4), so any adjustment there is that.
      errors.push(
        `Konto ${account}: utgifter för internt upparbetade immateriella anläggningstillgångar som kostnadsförts i tidigare finansiella rapporter får inte tas upp som tillgång vid övergången (K3 punkt 35.16).`,
      )
    }
    if (roundOre(adjustment.amount) === 0) {
      errors.push(`Konto ${account}: ange ett belopp.`)
    }
    if (!adjustment.description.trim()) {
      errors.push(`Konto ${account}: beskriv justeringen.`)
    }
  }
  return errors
}

/**
 * The transition voucher's lines: each adjustment against the equity
 * account, and the opening deferred tax lines (deferredTaxPosting, whose
 * result line is taken against equity instead: 35.11, not 29.22).
 */
export function transitionLines(args: {
  equityAccount: string
  adjustments: readonly TransitionAdjustment[]
  deferredTaxLines: readonly CreateJournalEntryLineInput[]
}): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  for (const line of args.deferredTaxLines) {
    lines.push(
      line.account_number === DEFERRED_TAX_EXPENSE_ACCOUNT
        ? { ...line, account_number: args.equityAccount, line_description: 'Uppskjuten skatt vid övergången till K3' }
        : line,
    )
  }
  for (const adjustment of args.adjustments) {
    const amount = roundOre(adjustment.amount)
    const description = adjustment.description.trim()
    lines.push({
      account_number: adjustment.account_number,
      debit_amount: amount > 0 ? amount : 0,
      credit_amount: amount < 0 ? -amount : 0,
      line_description: description,
    })
    lines.push({
      account_number: args.equityAccount,
      debit_amount: amount < 0 ? -amount : 0,
      credit_amount: amount > 0 ? amount : 0,
      line_description: description,
    })
  }
  return lines
}
