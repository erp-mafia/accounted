/**
 * Pre-filled patterns the wizard offers as one-click templates. Each names
 * the engine side (prepaid / accrued / deferred revenue / ...) that the
 * wizard maps onto the proposeManual* / proposeAccrued* helpers in
 * accrual-detector.ts. The wizard renders these as "Lägg till" buttons.
 *
 * BAS account choices follow the standard 2026 chart:
 *   - 17xx förutbetalda kostnader (prepaid expenses, asset side)
 *   - 29xx upplupna kostnader (accrued expenses + förutbetalda intäkter)
 *   - 2970 förutbetalda intäkter (deferred revenue specifically)
 *
 * Adding a new template means: 1) extend this array, 2) the wizard picks
 * it up automatically.
 */

export type PeriodiseringTemplateKind =
  | 'prepaid_rent'
  | 'prepaid_insurance'
  | 'prepaid_subscription'
  | 'deferred_revenue'
  | 'accrued_interest_expense'
  | 'accrued_utilities'

export interface PeriodiseringTemplate {
  kind: PeriodiseringTemplateKind
  /** Swedish label for the wizard card. */
  name: string
  /** One-sentence Swedish description / typical use case. */
  hint: string
  /** Engine that builds the AccrualProposal. */
  side: 'prepaid' | 'accrued' | 'deferred_revenue' | 'accrued_interest' | 'accrued_utility'
  /** Default BAS accounts pre-filled in the form. */
  prepaid_account?: string
  expense_account?: string
  deferred_account?: string
  revenue_account?: string
  accrued_account?: string
}

export const PERIODISERING_TEMPLATES: PeriodiseringTemplate[] = [
  {
    kind: 'prepaid_rent',
    name: 'Förutbetald hyra',
    hint: 'Hyra som löper över årsskiftet (t.ex. lokalhyra för januari betald i december).',
    side: 'prepaid',
    prepaid_account: '1710',
    expense_account: '5010',
  },
  {
    kind: 'prepaid_insurance',
    name: 'Förutbetald försäkring',
    hint: 'Försäkringspremie för kommande räkenskapsår, betald i förskott.',
    side: 'prepaid',
    prepaid_account: '1710',
    expense_account: '6310',
  },
  {
    kind: 'prepaid_subscription',
    name: 'Förutbetald prenumeration',
    hint: 'Mjukvara, licens eller medlemskap som löper över årsskiftet.',
    side: 'prepaid',
    prepaid_account: '1710',
    expense_account: '5800',
  },
  {
    kind: 'deferred_revenue',
    name: 'Förutbetald intäkt',
    hint: 'Kund har betalat för en tjänst eller prenumeration som avser nästa räkenskapsår.',
    side: 'deferred_revenue',
    deferred_account: '2970',
    revenue_account: '3000',
  },
  {
    kind: 'accrued_interest_expense',
    name: 'Upplupen ränta',
    hint: 'Räntekostnad som löpt under perioden men ännu inte fakturerats av banken.',
    side: 'accrued_interest',
    accrued_account: '2940',
    expense_account: '8410',
  },
  {
    kind: 'accrued_utilities',
    name: 'Upplupna förbrukningar',
    hint: 'El, vatten, sophämtning eller bredband: kostnaden har uppstått men fakturan dröjer.',
    side: 'accrued_utility',
    accrued_account: '2990',
    expense_account: '5020',
  },
]
