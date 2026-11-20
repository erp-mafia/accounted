/**
 * Fond för utvecklingsutgifter (ÅRL 4 kap. 2 § andra stycket and 8 §; K3
 * 18.3A): an aktiebolag or ekonomisk förening that capitalises its own
 * development expenditure moves the same amount from free equity to a
 * restricted fund (2089), even with an ansamlad förlust, and moves it back
 * as the asset is written off, written down or disposed of.
 *
 * The fund follows the company's OWN development: the register's assets
 * marked own_development (capitalised under the K3 aktiveringsmodell, on BAS
 * kontogrupp 101). Not everything on 1010-1019: the register used to put
 * every K3 intangible there, purchased licences included, and a purchased
 * intangible carries no fund. The year-end proposal posts the year's gross
 * movements against the form's balanserat resultat (2091 for an
 * aktiebolag), the movements the equity note shows:
 *   - to the fund: the year's capitalisations, and what catches the fund up
 *     to the own development's carrying amount at the start of the year;
 *   - from the fund: ONLY the year's depreciation, write-down and disposal
 *     of marked assets (ÅRL 4 kap. 8 §), their opening carrying amount plus
 *     the year's capitalisations less their closing carrying amount. A fund
 *     larger than the own development it stands for is never released on
 *     its own: that excess is not something 8 § lets go.
 *
 * Nothing is proposed, and a warning says what to do, while the register
 * cannot say what the fund stands for: an unmarked asset on 1010-1019, an
 * amount on 1010-1019 the register does not hold (an SIE import, a voucher
 * booked by hand), or a fund on 2089 with no marked asset at all.
 *
 * K3 years only, for a company on the aktiveringsmodell (K3 18.7): under K2
 * own development may not be capitalised at all (BFNAR 2016:10 10.4).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { requiresDevelopmentFund, retainedResultAccount } from '@/lib/company/entity-type'
import { frameworkForYear } from '@/lib/bokslut/framework-for-year'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { roundOre } from '@/lib/money'
import type { ProposedDisposition } from './types'
import { isOwnDevelopmentAccount, listAssets } from './assets/asset-service'
import { componentsOf, hasComponents } from './assets/component-depreciation'
import { proposeAnnualPostings } from './assets/depreciation-engine'
import { addDaysIso } from './assets/plan-calendar'
import { loadCarryingAmountsAt } from './assets/register-carrying-amounts'
import type { Asset, CreateJournalEntryLineInput, EntityType, FiscalPeriod } from '@/types'

export const DEVELOPMENT_FUND_ACCOUNT = '2089'

/** The fund's movements for one year. */
export interface DevelopmentFundFigures {
  /** Carrying amount of the marked own development at the start of the year. */
  openingCarrying: number
  /** Carrying amount of the marked own development at the balansdag. */
  carryingAmount: number
  /** The fund on 2089 at the start of the year. */
  fund: number
  /** Own development capitalised in the year. */
  capitalised: number
  /** The year's depreciation, net write-down and disposals of the own development. */
  writtenOff: number
  /** Transferred to the fund: the capitalisations, the catch-up, a reversed write-down. */
  toFund: number
  /** Transferred back: the year's write-offs, never more (ÅRL 4 kap. 8 §). */
  fromFund: number
  /** What the fund held beyond the own development at the start of the year: kept, not released. */
  excess: number
}

/** The register's own development for one year. */
export interface OwnDevelopment {
  openingCarrying: number
  carryingAmount: number
  capitalised: number
}

type BalanceRow = {
  account_number: string
  opening_debit?: number
  opening_credit?: number
  period_debit?: number
  period_credit?: number
  closing_debit: number
  closing_credit: number
}

function credit2089(rows: ReadonlyArray<BalanceRow>, side: 'opening' | 'period' | 'closing'): number {
  let sum = 0
  for (const row of rows) {
    if (row.account_number !== DEVELOPMENT_FUND_ACCOUNT) continue
    sum += (Number(row[`${side}_credit`]) || 0) - (Number(row[`${side}_debit`]) || 0)
  }
  return roundOre(sum)
}

/** The carrying amount the ledger holds on 1010-1019 at the balansdag. */
export function ledgerDevelopmentCarrying(rows: ReadonlyArray<BalanceRow>): number {
  let carrying = 0
  for (const row of rows) {
    if (isOwnDevelopmentAccount(row.account_number)) carrying += row.closing_debit - row.closing_credit
  }
  return roundOre(carrying)
}

export function developmentFundFigures(own: OwnDevelopment, openingFund: number): DevelopmentFundFigures {
  const openingCarrying = roundOre(Math.max(0, own.openingCarrying))
  const carryingAmount = roundOre(Math.max(0, own.carryingAmount))
  const capitalised = roundOre(Math.max(0, own.capitalised))
  const fund = roundOre(openingFund)
  // What the own development lost in the year: depreciation, net write-down
  // and disposals (negative when a reversed write-down outweighs them).
  const writtenOff = roundOre(openingCarrying + capitalised - carryingAmount)
  const catchUp = roundOre(Math.max(0, openingCarrying - fund))
  return {
    openingCarrying,
    carryingAmount,
    fund,
    capitalised,
    writtenOff,
    toFund: roundOre(capitalised + catchUp + Math.max(0, -writtenOff)),
    fromFund: roundOre(Math.max(0, writtenOff)),
    excess: roundOre(Math.max(0, fund - openingCarrying)),
  }
}

/** Cost of an asset (or of its components) acquired within the year. */
function acquiredWithin(asset: Asset, period: Pick<FiscalPeriod, 'period_start' | 'period_end'>): number {
  const within = (day: string) => day >= period.period_start && day <= period.period_end
  if (hasComponents(asset)) {
    return roundOre(
      componentsOf(asset)
        .filter((component) => within(component.acquisitionDate))
        .reduce((sum, component) => sum + component.cost, 0),
    )
  }
  return within(asset.acquisition_date) ? roundOre(Number(asset.acquisition_cost) || 0) : 0
}

/** On the books at the end of the day: acquired by it, not disposed by it. */
function onBooksAt(asset: Asset, day: string): boolean {
  return asset.acquisition_date <= day && !(asset.disposed_at && asset.disposed_at <= day)
}

export function developmentFundLines(figures: DevelopmentFundFigures, freeEquityAccount: string): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  if (figures.toFund >= 0.005) {
    lines.push(
      { account_number: freeEquityAccount, debit_amount: figures.toFund, credit_amount: 0, line_description: 'Överföring till fond för utvecklingsutgifter' },
      { account_number: DEVELOPMENT_FUND_ACCOUNT, debit_amount: 0, credit_amount: figures.toFund, line_description: 'Aktiverade utvecklingsutgifter (ÅRL 4 kap. 2 §)' },
    )
  }
  if (figures.fromFund >= 0.005) {
    lines.push(
      { account_number: DEVELOPMENT_FUND_ACCOUNT, debit_amount: figures.fromFund, credit_amount: 0, line_description: 'Avskrivna, nedskrivna eller avyttrade utvecklingsutgifter (ÅRL 4 kap. 8 §)' },
      { account_number: freeEquityAccount, debit_amount: 0, credit_amount: figures.fromFund, line_description: 'Överföring från fond för utvecklingsutgifter' },
    )
  }
  return lines
}

const kr = (amount: number) => `${amount.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr`

/**
 * The fund's year-end transfer, a warning when it cannot be proposed (with
 * what to do), or null when the fund does not apply (a form without one, a
 * K2 year, nothing on 1010-1019 and no fund).
 */
export async function buildDevelopmentFundProposal(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  entityType: EntityType,
): Promise<{ proposal: ProposedDisposition | null; warning?: string; figures: DevelopmentFundFigures } | null> {
  if (!requiresDevelopmentFund(entityType)) return null
  if ((await frameworkForYear(supabase, companyId, fiscalPeriodId)) !== 'k3') return null

  const [trialBalance, period, assets] = await Promise.all([
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw new Error(`Kunde inte läsa räkenskapsåret: ${error.message}`)
        return data as Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'> | null
      }),
    listAssets(supabase, companyId),
  ])
  if (!period?.period_start || !period.period_end) return null

  const openingDay = addDaysIso(period.period_start, -1)
  // The register's assets on 1010-1019 during the year.
  const inYear = assets.filter(
    (asset) =>
      isOwnDevelopmentAccount(asset.bas_asset_account) &&
      asset.acquisition_date <= period.period_end &&
      !(asset.disposed_at && asset.disposed_at < period.period_start),
  )
  const own = inYear.filter((asset) => asset.own_development === true)
  const unmarked = inYear.filter((asset) => asset.own_development !== true)
  const atClose = inYear.filter((asset) => onBooksAt(asset, period.period_end))
  const ownAtOpening = own.filter((asset) => onBooksAt(asset, openingDay))
  const [closing, opening] = await Promise.all([
    loadCarryingAmountsAt(supabase, companyId, atClose, period.period_end),
    loadCarryingAmountsAt(supabase, companyId, ownAtOpening, openingDay),
  ])
  const sum = (list: readonly Asset[], amounts: ReadonlyMap<string, number>) =>
    roundOre(list.reduce((total, asset) => total + (amounts.get(asset.id) ?? 0), 0))

  const openingFund = credit2089(trialBalance.rows, 'opening')
  const closingFund = credit2089(trialBalance.rows, 'closing')
  const figures = developmentFundFigures(
    {
      openingCarrying: sum(ownAtOpening, opening),
      carryingAmount: sum(atClose.filter((asset) => asset.own_development === true), closing),
      capitalised: own.reduce((total, asset) => total + acquiredWithin(asset, period), 0),
    },
    openingFund,
  )
  const ledger = ledgerDevelopmentCarrying(trialBalance.rows)
  const registered = sum(atClose, closing)
  const noFund = Math.abs(openingFund) < 0.005 && Math.abs(closingFund) < 0.005
  if (Math.abs(ledger) < 0.005 && inYear.length === 0 && noFund) return null

  const blocked = (warning: string) => ({ proposal: null, figures, warning })

  // The register cannot say what is own development: hold everything back.
  if (unmarked.length > 0) {
    const names = unmarked.map((asset) => asset.name).join(', ')
    return blocked(
      `Anläggningsregistret har tillgångar på konto 1010-1019 som inte är markerade som eget utvecklingsarbete: ${names}. ` +
        'Fonden för utvecklingsutgifter följer bara eget utvecklingsarbete (ÅRL 4 kap. 2 §) och föreslås inte förrän det är utrett. ' +
        'Öppna tillgången i anläggningsregistret och markera den som eget utvecklingsarbete om den är det; är den förvärvad hör den hemma på konto 1090.',
    )
  }
  if (Math.abs(roundOre(ledger - registered)) >= 0.005) {
    return blocked(
      `Konto 1010-1019 har ett redovisat värde på ${kr(ledger)} men anläggningsregistret förklarar ${kr(registered)}. ` +
        'Fonden för utvecklingsutgifter föreslås bara när hela beloppet på kontona finns i anläggningsregistret och är markerat som eget utvecklingsarbete (ÅRL 4 kap. 2 och 8 §§). ' +
        'Registrera tillgångarna i anläggningsregistret och markera det egna utvecklingsarbetet.',
    )
  }
  if (own.length === 0) {
    if (noFund) return null
    return blocked(
      `Konto 2089 har en fond för utvecklingsutgifter på ${kr(closingFund)} men anläggningsregistret har inget eget utvecklingsarbete. ` +
        'Fonden minskas bara i takt med att det egna utvecklingsarbetet skrivs av, skrivs ned eller avyttras (ÅRL 4 kap. 8 §), så inget föreslås. ' +
        'Registrera tillgångarna och markera dem som eget utvecklingsarbete, eller rätta fonden för hand om den är fel.',
    )
  }

  const { data: company, error } = await supabase
    .from('companies')
    .select('development_expenditure_model')
    .eq('id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa redovisningsprinciperna: ${error.message}`)
  const model = (company as { development_expenditure_model?: string | null } | null)?.development_expenditure_model ?? null
  if (model !== 'capitalise') {
    return blocked(
      'Eget utvecklingsarbete finns i anläggningsregistret men aktiveringsmodellen för internt upparbetade immateriella tillgångar är inte vald (K3 punkt 18.7). Välj modell under Inställningar, Bokföring; fonden för utvecklingsutgifter föreslås därefter.',
    )
  }

  // The year's planenlig avskrivning goes first: the fund follows the
  // carrying amount after it.
  const depreciation = await proposeAnnualPostings(supabase, companyId, fiscalPeriodId)
  if (depreciation.items.some((item) => isOwnDevelopmentAccount(item.asset.bas_asset_account) && !item.existingJournalEntryId)) {
    return blocked('Bokför årets avskrivningar på utvecklingsutgifterna först; fonden för utvecklingsutgifter föreslås därefter.')
  }

  const excessWarning =
    figures.excess >= 0.005
      ? `Fonden för utvecklingsutgifter var vid årets början ${kr(figures.excess)} större än det egna utvecklingsarbetets redovisade värde. ` +
        'Det beloppet förs inte tillbaka automatiskt: fonden minskas bara när det egna utvecklingsarbetet skrivs av, skrivs ned eller avyttras (ÅRL 4 kap. 8 §). Kontrollera fonden.'
      : undefined

  // What the year's transfer already moved on 2089, by this flow or by hand.
  const change = roundOre(figures.toFund - figures.fromFund)
  const moved = roundOre(closingFund - openingFund)
  if (Math.abs(moved) >= 0.005) {
    if (Math.abs(roundOre(moved - change)) < 0.005) return { proposal: null, figures, warning: excessWarning }
    return blocked(
      `Konto 2089 har redan bokförts med ${kr(moved)} under året, men årets överföring ska vara ${kr(change)}. ` +
        'Kontrollera verifikationerna på konto 2089 och rätta dem; fonden föreslås inte ovanpå det som redan är bokfört.',
    )
  }

  const lines = developmentFundLines(figures, retainedResultAccount(entityType))
  if (lines.length === 0) return { proposal: null, figures, warning: excessWarning }
  return {
    figures,
    warning: excessWarning,
    proposal: {
      kind: 'fond_for_utvecklingsutgifter',
      label: 'Fond för utvecklingsutgifter',
      description:
        `Till fonden ${figures.toFund} kr (årets aktiverade egna utvecklingsutgifter ${figures.capitalised} kr), ` +
        `från fonden ${figures.fromFund} kr (årets avskrivningar, nedskrivningar och avyttringar av eget utvecklingsarbete, ÅRL 4 kap. 8 §), mot balanserat resultat.`,
      amount: Math.abs(change),
      signedAmount: change,
      lines,
      warnings: [],
      computation: { ...figures },
    },
  }
}
