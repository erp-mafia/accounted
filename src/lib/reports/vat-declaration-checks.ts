import { formatAmount } from '@/lib/utils'
import type {
  KontantmetodCutoffVatFacts,
  VatAccountWithoutRuta,
  VatDeclarationRutor,
  VatRevenueAccountWithoutRuta,
} from '@/types'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { legacyKontantmetodVandningWarning } from '@/lib/core/bookkeeping/kontantmetod-cutoff-texts'

/**
 * Local pre-flight checks for the momsdeklaration, run BEFORE the SKV
 * /kontrollera or /utkast calls.
 *
 * Why we need this: Skatteverket's "validering" only confirms that the
 * payload is internally arithmetically consistent: it does NOT confirm
 * that the declaration reflects reality. A declaration of all zeros
 * validates fine; one with output VAT but no underlying purchases
 * validates fine too, until the gateway-level FK004 rule fires.
 *
 * The checks below catch the patterns we have seen in practice where
 * "Validera" returned OK but the declaration was wrong:
 *
 * - Reverse charge: ruta 30-32 populated but ruta 20-24 empty. Caused by
 *   supplier invoices flagged as reverse charge that booked the fiktiv
 *   moms (2614/2624/2634) without the parallel basis lines on 44xx/45xx.
 *   Fixed at the data layer by generateReverseChargePurchaseLines, but we
 *   keep the check here as a safety net for legacy verifikat and direct
 *   journal entries that bypass the supplier invoice flow.
 *
 * - Reverse charge: ruta 20-24 populated but ruta 30-32 empty. The mirror
 *   case, basis booked but fiktiv moms missing. Less common but equally
 *   broken.
 *
 * - Skatteverket's formal pair checks FK001-FK006 by presence: one side of
 *   a pair (sales 05-08 / 10-12, reverse charge 20-24 / 30-32, import 50 /
 *   60-62) files an amount and the other none, whatever the sign. The
 *   proportional checks only see positive sides; a credit or correction that
 *   moved one half leaves a negative side the declaration is refused for.
 *
 * - Mismatch between output RC VAT (ruta 30-32) and the offsetting input
 *   VAT on 2645/2647. The 2614/2645 (or 2647) pair must net to zero in the
 *   buyer's input deduction, so a shortfall means one half of the pair was
 *   booked without the other. Compared against those two accounts when the
 *   caller supplies per-account totals, and against the ruta 48 aggregate
 *   otherwise.
 *
 * Output is consumed by the UI; ERROR findings should block "Skicka",
 * WARNING findings should surface but allow the user to proceed if they
 * understand the reason.
 */

export type VatDeclarationCheckStatus = 'ERROR' | 'WARNING'

export interface VatDeclarationCheck {
  /** Stable identifier so the UI can render specific guidance per rule. */
  code:
    | 'RC_BASIS_MISSING'
    | 'RC_OUTPUT_MISSING'
    | 'RC_INPUT_VAT_MISMATCH'
    | 'SUMMA_MOMS_DRIFT'
    | 'TAXABLE_SALES_WITHOUT_OUTPUT'
    | 'IMPORT_BASE_WITHOUT_OUTPUT'
    | 'IMPORT_OUTPUT_WITHOUT_BASE'
    | 'OUTPUT_VAT_WITHOUT_SALES_BASE'
    | 'SALES_OUTPUT_VAT_SHORTFALL'
    | 'REVENUE_ACCOUNT_WITHOUT_RUTA'
    | 'VAT_ACCOUNT_WITHOUT_RUTA'
    | 'KONTANTMETOD_CUTOFF_INCOMPLETE'
    | 'LEGACY_KONTANTMETOD_VANDNING'
  status: VatDeclarationCheckStatus
  /** Swedish user-facing message; safe to render directly in the UI. */
  message: string
  /** The figures and the rule behind the message, for whoever wants them; the UI keeps it behind a "?". */
  detail?: string
  /** Optional rutor that the user should investigate. */
  rutor?: Array<keyof VatDeclarationRutor>
  /**
   * Set when the moms side of a pair is booked but holds öre only, so it files
   * as 0 kr and the pair check (FK001, FK003, FK005) refuses the declaration:
   * the books are not missing anything and no verifikat is to be corrected.
   * Readers that add their own advice to a finding (the close check's hint)
   * must not send the user to the ledger for it (crm#1822).
   */
  belowOneKrona?: true
  /**
   * Set only on a WARNING a person has reviewed for this period while its
   * figures still match the review (applyVatCheckReviews,
   * src/lib/vat/check-reviews.ts). Never set on an ERROR.
   */
  review?: VatCheckReviewMark
}

/** Every finding code, for validating a code that arrives over the wire (a review names one). */
export const VAT_DECLARATION_CHECK_CODES = [
  'RC_BASIS_MISSING',
  'RC_OUTPUT_MISSING',
  'RC_INPUT_VAT_MISMATCH',
  'SUMMA_MOMS_DRIFT',
  'TAXABLE_SALES_WITHOUT_OUTPUT',
  'IMPORT_BASE_WITHOUT_OUTPUT',
  'IMPORT_OUTPUT_WITHOUT_BASE',
  'OUTPUT_VAT_WITHOUT_SALES_BASE',
  'SALES_OUTPUT_VAT_SHORTFALL',
  'REVENUE_ACCOUNT_WITHOUT_RUTA',
  'VAT_ACCOUNT_WITHOUT_RUTA',
] as const satisfies ReadonlyArray<VatDeclarationCheck['code']>

/** Who accepted a WARNING for the period, when, and why. */
export interface VatCheckReviewMark {
  reviewed_at: string
  /** auth user id of the person who marked it, or who approved the agent's proposal. */
  reviewed_by: string
  /** Display name or e-mail, when the reader could resolve it. */
  reviewed_by_label?: string | null
  note: string | null
  /** web: marked in the momsdeklaration view; agent: an approved gnubok_mark_vat_check_reviewed. */
  source: 'web' | 'agent'
}

/**
 * Self-assessed utgående moms (rutor 30-32, 60-62) with no deductible input
 * VAT in the period at all (ruta 48 zero). With full avdragsrätt that is never
 * right, and the close check escalates RC_INPUT_VAT_MISMATCH to a blocker in
 * exactly this case, so such a finding is not one a review may quiet.
 */
export function selfAssessedVatWithoutAnyInputVat(rutor: VatDeclarationRutor): boolean {
  const eps = 0.5
  const selfAssessed =
    rutor.ruta30 + rutor.ruta31 + rutor.ruta32 + rutor.ruta60 + rutor.ruta61 + rutor.ruta62
  return selfAssessed > eps && rutor.ruta48 <= eps
}

/**
 * Per-account debit/credit totals for the declared period, keyed by BAS account
 * number. Exactly the shape `fetchVatAccountTotals()` returns
 * (`VatAccountTotals.totals`) and `rutorFromTotals()` consumes, so a caller that
 * already has the totals passes them straight through without deriving anything
 * of its own.
 */
export type VatCheckAccountTotals = ReadonlyMap<string, { debit: number; credit: number }>

/**
 * Account-level facts about the declared period that the rutor alone cannot
 * carry. Every field is optional: an absent field keeps its check silent
 * rather than reading as "nothing found".
 */
export interface VatDeclarationCheckContext {
  /**
   * Class 3 accounts with a balance that reach no ruta, exactly as
   * `revenueAccountsWithoutRuta()` (lib/reports/vat-declaration.ts) derives
   * them from the declaration's own account resolution, or as
   * `VatDeclaration.revenueAccountsWithoutRuta` carries them over HTTP.
   */
  revenueAccountsWithoutRuta?: readonly VatRevenueAccountWithoutRuta[]
  /**
   * Moms accounts (2610-2649) with a balance that reach no ruta, exactly as
   * `vatAccountsWithoutRuta()` (lib/reports/vat-declaration.ts) derives them,
   * or as `VatDeclaration.vatAccountsWithoutRuta` carries them over HTTP.
   */
  vatAccountsWithoutRuta?: readonly VatAccountWithoutRuta[]
  /**
   * The kontantmetoden year-end cut-off facts of the period
   * (`fetchKontantmetodCutoffVatFacts()`, or `VatDeclaration.kontantmetodCutoff`
   * over HTTP). Feeds KONTANTMETOD_CUTOFF_INCOMPLETE and
   * LEGACY_KONTANTMETOD_VANDNING; absent keeps both silent.
   */
  kontantmetodCutoff?: KontantmetodCutoffVatFacts
}

/** How many accounts REVENUE_ACCOUNT_WITHOUT_RUTA and VAT_ACCOUNT_WITHOUT_RUTA name before summarising the rest. */
const ACCOUNTS_NAMED_MAX = 5

function describeAccount(account: VatRevenueAccountWithoutRuta | VatAccountWithoutRuta): string {
  const label = account.account_name
    ? `${account.account_number} ${account.account_name}`
    : account.account_number
  return `${label} (${formatAmount(account.amount)} kr)`
}

/**
 * KONTANTMETOD_CUTOFF_INCOMPLETE and LEGACY_KONTANTMETOD_VANDNING (#3440).
 *
 * Under kontantmetoden the moms on invoices unpaid at the fiscal year end
 * belongs to the VAT period that contains the year end (BFL 5 kap 2 §: they
 * are booked at räkenskapsårets utgång). Filed before the cut-off is posted,
 * that moms is missing from the declaration and a rättad momsdeklaration is
 * needed afterwards. WARNING, never ERROR (product decision 2026-10-03):
 * there is no cut-off door in the dashboard yet, and manual filing stays
 * ungated whatever the tier.
 */
export function kontantmetodCutoffFindings(facts: KontantmetodCutoffVatFacts | undefined): VatDeclarationCheck[] {
  if (!facts) return []
  const findings: VatDeclarationCheck[] = []
  const rutor: Array<keyof VatDeclarationRutor> = ['ruta05', 'ruta10', 'ruta11', 'ruta12', 'ruta48']
  if (facts.unavailable) {
    findings.push({
      code: 'KONTANTMETOD_CUTOFF_INCOMPLETE',
      status: 'WARNING',
      message:
        'Kontrollen av kontantmetodens bokslutsavgränsning kunde inte köras, så vi vet inte om ' +
        'momsen på fakturor som var obetalda vid räkenskapsårets slut finns med i perioden. ' +
        'Ladda om sidan för att försöka igen.',
      rutor,
    })
  }
  for (const yearEnd of facts.incompleteYearEnds) {
    findings.push({
      code: 'KONTANTMETOD_CUTOFF_INCOMPLETE',
      status: 'WARNING',
      message:
        `Perioden innehåller räkenskapsårets slut ${yearEnd.period_end}, och kontantmetodens ` +
        'bokslutsavgränsning för året är inte klar. Momsen på kund- och leverantörsfakturor som ' +
        'var obetalda vid årets slut ska redovisas i den här perioden. Bokför avgränsningen före ' +
        'inlämning; bokförs den efteråt behöver en rättad momsdeklaration lämnas för perioden.',
      detail:
        'Med kontantmetoden (bokslutsmetoden) bokförs obetalda fakturor vid räkenskapsårets utgång ' +
        '(BFL 5 kap 2 §), och momsen på dem hör till den sista momsperioden det året. ' +
        'Varningen hindrar inte inlämning.',
      rutor,
    })
  }
  const legacy = legacyKontantmetodVandningWarning(
    facts.legacyCutoffPeriodEnds.map((periodEnd) => ({ periodEnd })),
  )
  if (legacy) {
    findings.push({ code: 'LEGACY_KONTANTMETOD_VANDNING', status: 'WARNING', message: legacy, rutor })
  }
  return findings
}

/**
 * REVENUE_ACCOUNT_WITHOUT_RUTA (#3387): revenue booked on a class 3 account the
 * declaration cannot classify reaches no ruta at all, while the output VAT
 * booked with it on 2611/2621/2631 still reaches rutor 10-12 by account number.
 * Ruta 49 stays right and ruta 05 is understated, and when the company has any
 * other ruta 05 sales none of the rutor-level checks can see it: the base is
 * missing from both sides of their comparison.
 *
 * WARNING, never ERROR: the account may just as well be momsfri or not a sale
 * at all, and the declaration deliberately does not infer ruta 05 for it (an
 * open product decision). The user is told which accounts and how much, and
 * where to fix it: the momskod on the account in Kontoplan.
 */
export function revenueAccountWithoutRutaFinding(
  accounts: readonly VatRevenueAccountWithoutRuta[],
): VatDeclarationCheck {
  const list = namedAccounts(accounts)
  const lead =
    accounts.length === 1
      ? `Intäktskontot ${list} saknar momskod och momssats, så beloppet kommer inte med i någon ruta.`
      : `${accounts.length} intäktskonton saknar momskod och momssats, så beloppen kommer inte med ` +
        `i någon ruta: ${list}.`
  return {
    code: 'REVENUE_ACCOUNT_WITHOUT_RUTA',
    status: 'WARNING',
    message:
      `${lead} Är det momspliktig försäljning blir ruta 05 för låg, medan momsen på ` +
      '2611/2621/2631 ändå redovisas i ruta 10-12. Ange momskod på kontot i Kontoplanen, ' +
      'till exempel Försäljning Sverige, 25 % (ruta 05) eller Momsfri försäljning (ruta 42). ' +
      'Avser kontot inte försäljning, sätt momssats 0 % på kontot.',
    detail:
      'Deklarationen tar med ett intäktskonto (klass 3) när kontot har en momskod, en ' +
      'momssats på 25, 12 eller 6 % eller en fast ruta enligt BAS, till exempel 3001 i ' +
      'ruta 05. De här kontona ' +
      'har ingetdera, och deklarationen gissar inte ruta 05 eftersom kontot lika gärna kan ' +
      'avse momsfri försäljning. Utgående moms följer däremot kontonumret (2611/2621/2631 ' +
      'till ruta 10-12), så moms att betala (ruta 49) påverkas inte, bara ' +
      'försäljningsunderlaget. Varningen hindrar inte inlämning.',
    rutor: ['ruta05', 'ruta42'],
  }
}

/** The first ACCOUNTS_NAMED_MAX accounts with their amounts, then how many more. */
function namedAccounts(accounts: readonly (VatRevenueAccountWithoutRuta | VatAccountWithoutRuta)[]): string {
  const named = accounts.slice(0, ACCOUNTS_NAMED_MAX).map(describeAccount)
  const rest = accounts.length - named.length
  return rest > 0 ? `${named.join(', ')} och ${rest} till` : named.join(', ')
}

/**
 * VAT_ACCOUNT_WITHOUT_RUTA: moms booked on a moms account (2610-2649) that no
 * ruta reads, because the account is not in the BAS 2026 map and the company
 * gave it no momsruta of its own. The moms then misses the rutor, the
 * momsredovisning and, unless another such account offsets it, ruta 49. No
 * rutor-level check can see it. Typically 2617/2627/2637 (utgående moms,
 * omvänd skattskyldighet) or 2643/2644 (ingående moms) from a chart that
 * predates BAS 2026, brought in by an import.
 *
 * WARNING, never ERROR: the right ruta depends on what the account is used
 * for (names vary between charts), and moms that is declared elsewhere (OSS)
 * belongs on no ruta at all. The user is told which accounts and how much,
 * and where to fix it: the momsruta on the account in Kontoplan.
 */
export function vatAccountWithoutRutaFinding(
  accounts: readonly VatAccountWithoutRuta[],
): VatDeclarationCheck {
  const list = namedAccounts(accounts)
  const lead =
    accounts.length === 1
      ? `Momskontot ${list} hör inte till någon ruta, så momsen på kontot kommer inte med i deklarationen.`
      : `${accounts.length} momskonton hör inte till någon ruta, så momsen på dem kommer inte med i ` +
        `deklarationen: ${list}.`
  return {
    code: 'VAT_ACCOUNT_WITHOUT_RUTA',
    status: 'WARNING',
    message:
      `${lead} Ange momsruta på kontot i Kontoplanen, till exempel ruta 30 för utgående moms vid ` +
      'omvänd betalningsskyldighet 25 % eller ruta 48 för ingående moms. Ska momsen på kontot ' +
      'inte redovisas i momsdeklarationen, till exempel OSS, markera varningen som granskad.',
    detail:
      'Deklarationen läser momskontona i BAS 2026 (till exempel 2611, 2614 och 2641) och de ' +
      'momskonton som har en egen momsruta. De här kontona finns i äldre kontoplaner, ofta med ' +
      'från en import, och har ingetdera. Momsen på dem kommer därför varken med i rutorna eller ' +
      'i momsredovisningen, och moms att betala (ruta 49) blir fel med beloppet om det inte tar ' +
      'ut sig mot ett annat sådant konto. Varningen hindrar inte inlämning.',
    rutor: ['ruta49'],
  }
}

/**
 * The import pair as Skatteverket's FK005/FK006 see it: one side filed, the
 * other empty, whatever the sign. Reached only when the proportional rule for
 * the same direction stays silent, which in practice means a negative side: a
 * later-period credit or correction of an import that moved only one of its
 * two halves (crm#1348). `amount` is ruta 50 for FK005 and the sum of rutor
 * 60-62 for FK006.
 */
function importPairPresenceFinding(
  code: 'IMPORT_BASE_WITHOUT_OUTPUT' | 'IMPORT_OUTPUT_WITHOUT_BASE',
  amount: number,
  /** FK005 only: the importmoms as booked when it is öre only (vatBelowOneKronaText). */
  momsBelowOneKrona: string | null = null,
): VatDeclarationCheck {
  const kr = Math.trunc(amount).toLocaleString('sv-SE')
  const negative = amount < 0
  if (code === 'IMPORT_BASE_WITHOUT_OUTPUT' && momsBelowOneKrona) {
    return {
      code,
      status: 'ERROR',
      message:
        `Ruta 50 (beskattningsunderlag vid import) är ${kr} kr. Importmomsen på beloppet är bokförd ` +
        `(${momsBelowOneKrona}) men är under en krona. ${BELOW_ONE_KRONA_FILED_AS_ZERO} rutorna 60-62 ` +
        '(utgående moms på import) blir tomma i det som lämnas. Då tar Skatteverket inte emot ' +
        'deklarationen (kontroll FK005): finns ett belopp i ruta 50 måste det finnas ett i någon av ' +
        `rutorna 60-62. ${BELOW_ONE_KRONA_WHAT_NOW}`,
      rutor: ['ruta50', 'ruta60', 'ruta61', 'ruta62'],
      belowOneKrona: true,
    }
  }
  const message =
    code === 'IMPORT_BASE_WITHOUT_OUTPUT'
      ? `Ruta 50 (beskattningsunderlag vid import) är ${kr} kr men rutorna 60-62 (utgående ` +
        'moms på import) är tomma. Då tar Skatteverket inte emot deklarationen (kontroll ' +
        'FK005): finns ett belopp i ruta 50 måste det finnas ett i någon av rutorna 60-62.' +
        (negative
          ? ' Ett negativt underlag uppstår när ett tidigare importköp krediteras eller ' +
            'flyttas från 4545/4546/4547 till ett annat konto utan att importmomsen på ' +
            '2615/2625/2635 och 2645 rättas i samma verifikation. Var importen rätt bokförd, ' +
            'återför rättelsen med storno. Var köpet aldrig en import, rätta hela importen, ' +
            'underlag och importmoms, i den period där den redovisades och lämna en rättad ' +
            'momsdeklaration för den perioden.'
          : ' Kontrollera att importmoms är bokförd på 2615/2625/2635 för varje import.')
      : `Rutorna 60-62 (utgående moms på import) har belopp, sammanlagt ${kr} kr, men ruta 50 (beskattningsunderlag ` +
        'vid import) är tom. Då tar Skatteverket inte emot deklarationen (kontroll FK006): ' +
        'finns ett belopp i någon av rutorna 60-62 måste det finnas ett i ruta 50.' +
        (negative
          ? ' Negativ importmoms utan underlag uppstår när importmomsen på 2615/2625/2635 ' +
            'krediteras eller rättas utan att underlaget på 4545/4546/4547 följer med. Rätta ' +
            'underlag och importmoms i samma verifikation, i den period där importen redovisades.'
          : ' Kontrollera att tullvärdesunderlaget är bokfört på 4545/4546/4547 för varje import.')
  return { code, status: 'ERROR', message, rutor: ['ruta50', 'ruta60', 'ruta61', 'ruta62'] }
}

/**
 * Whether a ruta files an amount: Skatteverket's formal checks FK001-FK006
 * read "om belopp anges", any amount the declaration files, negative
 * included (Tjänstebeskrivning API Momsdeklaration, 4.1.1.5). Read on whole
 * kronor as filed (buildFiledAmounts drops the öre), so 0.80 kr is no amount.
 */
function filesAmount(amount: number): boolean {
  return Math.trunc(amount) !== 0
}

/** The filed whole-krona amounts of the rutor that carry one, e.g. "ruta 30 -1 000 kr". */
function filedRutorText(rutor: VatDeclarationRutor, keys: ReadonlyArray<keyof VatDeclarationRutor>): string {
  return keys
    .filter((key) => filesAmount(rutor[key]))
    .map((key) => `ruta ${key.slice(4)} ${Math.trunc(rutor[key]).toLocaleString('sv-SE')} kr`)
    .join(', ')
}

/**
 * The moms rutor of a pair as booked, e.g. "ruta 30 0,75 kr", when the moms is
 * there but files as nothing: every ruta holds öre only, and the base agrees
 * with it (basbelopp = moms / sats, inside the 1 kr floor the proportional
 * checks use). Null otherwise, which keeps the finding's ordinary cause: moms
 * that is absent, or far too small for the base, is a bookkeeping matter.
 *
 * Only the base-filed, moms-empty direction can be this case (FK001, FK003,
 * FK005). The mirror cannot: moms of a whole krona implies a base of at least
 * four, so a base of öre only beside it is wrong in the books.
 *
 * `momsRutor` is ordered 25 %, 12 %, 6 %, as every moms group on the form is.
 */
function vatBelowOneKronaText(
  rutor: VatDeclarationRutor,
  base: number,
  momsRutor: readonly [keyof VatDeclarationRutor, keyof VatDeclarationRutor, keyof VatDeclarationRutor],
): string | null {
  const held = momsRutor.filter((key) => Math.round(rutor[key] * 100) !== 0)
  if (held.length === 0 || momsRutor.some((key) => filesAmount(rutor[key]))) return null
  const impliedBase = rutor[momsRutor[0]] / 0.25 + rutor[momsRutor[1]] / 0.12 + rutor[momsRutor[2]] / 0.06
  if (Math.abs(base - impliedBase) > 1) return null
  return held.map((key) => `ruta ${key.slice(4)} ${formatAmount(rutor[key])} kr`).join(', ')
}

/** Why moms under a krona files as nothing. Ends where the sentence names the rutor it empties. */
const BELOW_ONE_KRONA_FILED_AS_ZERO =
  'Momsdeklarationen lämnas i hela kronor och öretal faller bort, så'

/**
 * What the user is told to do, and not to do, when the whole-krona rule
 * empties the moms side of a pair. Deliberately no advice on which amounts to
 * file instead: that is a tax judgment the product has not made (crm#1822).
 */
const BELOW_ONE_KRONA_WHAT_NOW =
  'Det är avrundningen till hela kronor som tömmer rutorna: momsen saknas inte i bokföringen, och ' +
  'inget verifikat ska rättas för det här. Perioden kan inte lämnas till Skatteverket från Accounted ' +
  'med de här beloppen. Kontakta Skatteverket om hur perioden ska redovisas.'

const SALES_BASE_RUTOR = ['ruta05', 'ruta06', 'ruta07', 'ruta08'] as const
const SALES_OUTPUT_RUTOR = ['ruta10', 'ruta11', 'ruta12'] as const
const RC_BASIS_RUTOR = ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24'] as const
const RC_OUTPUT_RUTOR = ['ruta30', 'ruta31', 'ruta32'] as const
const IMPORT_OUTPUT_RUTOR = ['ruta60', 'ruta61', 'ruta62'] as const

/**
 * One pair of FK001-FK004 as Skatteverket checks it: one side files an
 * amount, the other files none, whatever the sign. Reached only when the
 * existing check for the same direction stays silent, which in practice means
 * a negative side (a credit or correction that moved only one half of a sale
 * or a reverse-charge purchase), two rutor of one side that net to zero, or a
 * counterpart of öre only, which files as 0. `rule` names the check,
 * `filed` and `empty` the two sides, `cause` the likely cause and its fix.
 */
function pairPresenceFinding(
  code: 'TAXABLE_SALES_WITHOUT_OUTPUT' | 'OUTPUT_VAT_WITHOUT_SALES_BASE' | 'RC_OUTPUT_MISSING' | 'RC_BASIS_MISSING',
  rule: 'FK001' | 'FK002' | 'FK003' | 'FK004',
  filed: { label: string; rutor: string; text: string },
  empty: { label: string; rutor: string },
  cause: string,
  rutor: Array<keyof VatDeclarationRutor>,
  /** FK001 and FK003 only: the moms as booked when it is öre only (vatBelowOneKronaText). */
  momsBelowOneKrona: string | null = null,
): VatDeclarationCheck {
  const detail =
    `Skatteverkets formella kontroll ${rule} prövar om ett belopp anges, oavsett tecken, i hela ` +
    'kronor så som deklarationen lämnas (Tjänstebeskrivning API Momsdeklaration, avsnitt 4.1.1.5). ' +
    'Öretal faller bort, så ett belopp under en krona räknas inte.'
  if (momsBelowOneKrona) {
    return {
      code,
      status: 'ERROR',
      message:
        `${filed.label} (ruta ${filed.rutor}) har belopp (${filed.text}). Momsen på beloppet är bokförd ` +
        `(${momsBelowOneKrona}) men är under en krona. ${BELOW_ONE_KRONA_FILED_AS_ZERO} ${empty.label} ` +
        `(ruta ${empty.rutor}) blir tomma i det som lämnas. Då tar Skatteverket inte emot deklarationen ` +
        `(kontroll ${rule}): finns ett belopp i någon av rutorna ${filed.rutor} måste det finnas ett i ` +
        `någon av rutorna ${empty.rutor}. ${BELOW_ONE_KRONA_WHAT_NOW}`,
      detail,
      rutor,
      belowOneKrona: true,
    }
  }
  return {
    code,
    status: 'ERROR',
    message:
      `${filed.label} (ruta ${filed.rutor}) har belopp (${filed.text}), men ${empty.label} ` +
      `(ruta ${empty.rutor}) är tomma. Då tar Skatteverket inte emot deklarationen (kontroll ${rule}): ` +
      `finns ett belopp i någon av rutorna ${filed.rutor} måste det finnas ett i någon av rutorna ` +
      `${empty.rutor}. ${cause}`,
    detail,
    rutor,
  }
}

/**
 * The two BAS accounts that carry the deductible input half of an omvänd-
 * skattskyldighet purchase, per BAS 2026:
 *
 *   2645 Beräknad ingående moms på förvärv från utlandet (EU + non-EU)
 *   2647 Ingående moms, omvänd betalningsskyldighet i Sverige (ML 16 kap:
 *        byggtjänster, skrot, guld, mobiler/datorer över 100 000 kr)
 *
 * The other five accounts ACCOUNT_RUTA maps to ruta 48 are NOT reverse charge
 * and are deliberately excluded: 2641 (debiterad ingående moms, i.e. VAT
 * actually invoiced to us, which a reverse-charge invoice by definition never
 * carries; also where the import flow books its deductible import VAT), 2640
 * (the summary parent), 2642 (frivillig betalningsskyldighet), 2646 (uthyrning)
 * and 2649 (blandad verksamhet, the deductible portion of shared costs in
 * general). Counting 2649 as RC input would reintroduce exactly the aggregation
 * this check exists to remove. Read as the account roles
 * input_vat_reverse_charge_foreign and input_vat_reverse_charge_domestic.
 */
const RC_INPUT_ACCOUNTS: readonly string[] = [
  resolveAccountRole(PINNED_JURISDICTION, 'input_vat_reverse_charge_foreign'),
  resolveAccountRole(PINNED_JURISDICTION, 'input_vat_reverse_charge_domestic'),
]

/** Period debit balance (debit minus credit) of 2645 + 2647. */
function reverseChargeInputVat(accountTotals: VatCheckAccountTotals): number {
  let sum = 0
  for (const account of RC_INPUT_ACCOUNTS) {
    const t = accountTotals.get(account)
    if (t) sum += t.debit - t.credit
  }
  return Math.round(sum * 100) / 100
}

/**
 * Run all local checks against a calculated VatDeclarationRutor.
 *
 * `accountTotals` is optional and only sharpens `RC_INPUT_VAT_MISMATCH`: with it
 * the check compares the reverse-charge output against the reverse-charge INPUT
 * accounts, without it against the ruta 48 aggregate (see there).
 *
 * `context` is optional and only feeds `REVENUE_ACCOUNT_WITHOUT_RUTA`,
 * `VAT_ACCOUNT_WITHOUT_RUTA` and the kontantmetoden cut-off findings, which
 * need facts the rutor cannot carry.
 * Every other check reads the rutor alone.
 *
 * Returns an empty array when the declaration looks consistent. Order
 * within the returned array is stable so the UI can rely on it for
 * snapshot tests.
 */
export function runVatDeclarationChecks(
  rutor: VatDeclarationRutor,
  accountTotals?: VatCheckAccountTotals,
  context: VatDeclarationCheckContext = {},
): VatDeclarationCheck[] {
  const findings: VatDeclarationCheck[] = []

  const rcOutput = rutor.ruta30 + rutor.ruta31 + rutor.ruta32
  const rcBasis =
    rutor.ruta20 + rutor.ruta21 + rutor.ruta22 + rutor.ruta23 + rutor.ruta24

  // Use a 0.5 SEK epsilon: values are rounded to öres in the calculator
  // and we don't want a 0.01 rounding scrap to trip a sanity check.
  const eps = 0.5

  // The basis the per-rate output boxes imply (basbelopp = fiktiv moms / sats).
  // The RC checks compare reported basis against this instead of testing mere
  // presence: a binary present/absent test clears as soon as ONE voucher in
  // the period carries a basis pair, silently passing a declaration where the
  // remaining vouchers still under-report rutor 20-24 (FK004).
  const expectedRcBasis =
    rutor.ruta30 / 0.25 + rutor.ruta31 / 0.12 + rutor.ruta32 / 0.06
  // Per-voucher öre rounding (basis derived as moms/sats vs the invoiced
  // amount) accumulates with voucher count; 0.5% with a 1 kr floor absorbs
  // that without hiding a genuinely missing voucher.
  const rcTolerance = Math.max(1, expectedRcBasis * 0.005)

  // FK001-FK004 by presence, as Skatteverket reads them (pairPresenceFinding).
  // The proportional and binary checks below only ever see a POSITIVE side;
  // each is followed by a presence fallback for the same direction, the
  // mechanism the import pair got for FK005/FK006 (crm#1348).
  const anyFiled = (keys: ReadonlyArray<keyof VatDeclarationRutor>) => keys.some((key) => filesAmount(rutor[key]))
  const salesBaseFiled = anyFiled(SALES_BASE_RUTOR)
  const salesOutputFiled = anyFiled(SALES_OUTPUT_RUTOR)
  const rcBasisFiled = anyFiled(RC_BASIS_RUTOR)
  const rcOutputFiled = anyFiled(RC_OUTPUT_RUTOR)
  const rcRutor: Array<keyof VatDeclarationRutor> = [...RC_BASIS_RUTOR, ...RC_OUTPUT_RUTOR]
  const salesRutor: Array<keyof VatDeclarationRutor> = [...SALES_BASE_RUTOR, ...SALES_OUTPUT_RUTOR]

  // FK004 mirror: output RC VAT exists, basis missing or too low.
  if (rcOutput > eps && rcBasis + rcTolerance < expectedRcBasis) {
    const shortfall = Math.round(expectedRcBasis - rcBasis)
    findings.push({
      code: 'RC_BASIS_MISSING',
      status: 'ERROR',
      message:
        'Omvänd moms utan underlag: momsen finns i ruta 30-32 men cirka ' +
        `${shortfall.toLocaleString('sv-SE')} kr saknas i ruta 20-24. Korrigera ` +
        'verifikationerna nedan så läggs underlaget till, inga belopp ändras ' +
        '(Skatteverkets felkod FK004).',
      detail:
        'Den utgående momsen på inköp (ruta 30-32) motsvarar ett basbelopp ' +
        `på cirka ${Math.round(expectedRcBasis).toLocaleString('sv-SE')} kr, ` +
        'men ruta 20-24 innehåller bara ' +
        `${Math.round(rcBasis).toLocaleString('sv-SE')} kr. Skatteverket ` +
        'kräver att båda sidor finns med (ML 13 kap; SKV felkod FK004): ' +
        'leverantörsfakturor med omvänd skattskyldighet bokförs med ' +
        'basbelopp på 44xx/45xx-konton.',
      rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
    })
  } else if (rcOutputFiled && !rcBasisFiled) {
    findings.push(pairPresenceFinding(
      'RC_BASIS_MISSING',
      'FK004',
      { label: 'Utgående moms på inköp', rutor: '30-32', text: filedRutorText(rutor, RC_OUTPUT_RUTOR) },
      { label: 'rutorna för inköp med omvänd betalningsskyldighet', rutor: '20-24' },
      rcOutput < 0
        ? 'Negativ fiktiv moms utan underlag uppstår när den fiktiva momsen på 2614/2624/2634 ' +
          'krediteras eller rättas utan att underlaget på 44xx/45xx följer med. Rätta underlag och ' +
          'fiktiv moms i samma verifikation, i den period där inköpet redovisades.'
        : 'Kontrollera att varje inköp med fiktiv moms på 2614/2624/2634 har sitt underlag på 44xx/45xx.',
      rcRutor,
    ))
  }

  // Mirror: more basis than the output VAT accounts for, fiktiv moms missing
  // for some vouchers. Covers both the all-output-missing case and a partial
  // one; often a half-finished manual posting, or a purchase whose basis is
  // counted twice: a 44xx/45xx pair beside a cost account whose momskod
  // already reports ruta 20-24 (crm#1096).
  if (rcBasis > eps && rcBasis > expectedRcBasis + rcTolerance) {
    findings.push({
      code: 'RC_OUTPUT_MISSING',
      status: 'ERROR',
      message:
        'Basbeloppet för omvänd skattskyldighet (ruta 20-24) är större än ' +
        'vad den utgående momsen (ruta 30-32) motsvarar. Vid omvänd ' +
        'skattskyldighet måste köparen redovisa både underlag och fiktiv ' +
        'moms (ML 13 kap). Kontrollera att fiktiv moms är bokförd på ' +
        '2614/2624/2634 för varje inköp, och att inget inköp har ett ' +
        'basbelopp på 44xx/45xx bredvid ett konto vars momskod i kontoplanen ' +
        'redan redovisar ruta 20-24: då räknas inköpet två gånger och ' +
        'basbeloppet ska bort med rättelse eller storno.',
      rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
    })
  } else if (rcBasisFiled && !rcOutputFiled) {
    // FK003 by presence. A presence finding here also keeps the per-voucher
    // gap fold on its blocking tier (vat-filing-gate.ts refuses the downgrade
    // beside an RC_OUTPUT_MISSING), which is right: the rutor are refused.
    findings.push(pairPresenceFinding(
      'RC_OUTPUT_MISSING',
      'FK003',
      { label: 'Inköpen med omvänd betalningsskyldighet', rutor: '20-24', text: filedRutorText(rutor, RC_BASIS_RUTOR) },
      { label: 'rutorna för utgående moms på inköp', rutor: '30-32' },
      rcBasis < 0
        ? 'Ett negativt underlag uppstår när ett tidigare inköp med omvänd skattskyldighet krediteras ' +
          'eller flyttas från 44xx/45xx till ett annat konto utan att den fiktiva momsen på ' +
          '2614/2624/2634 och 2645/2647 rättas i samma verifikation. Var inköpet rätt bokfört, återför ' +
          'rättelsen med storno. Var köpet aldrig omvänd skattskyldighet, rätta hela inköpet, underlag ' +
          'och fiktiv moms, i den period där det redovisades och lämna en rättad momsdeklaration för den perioden.'
        : 'Kontrollera att fiktiv moms är bokförd på 2614/2624/2634 för varje inköp med omvänd skattskyldighet.',
      rcRutor,
      // Fiktiv moms booked but under a krona: the whole-krona rule empties
      // rutor 30-32, the books are not short (crm#1822).
      vatBelowOneKronaText(rutor, rcBasis, RC_OUTPUT_RUTOR),
    ))
  }

  // The fiktiv-moms pair must net to zero in the buyer's input deduction when
  // the buyer has full avdragsrätt: the engine debits 2645 (or 2647) with
  // exactly the amount it credits to 2614/2624/2634 inside the same verifikat
  // (vat-entries.ts), so the two period sums match öre for öre and need no
  // percentage tolerance.
  //
  // Compared against the RC INPUT ACCOUNTS, not against ruta 48, whenever the
  // caller hands us the per-account totals. Ruta 48 aggregates 2640 + 2641 +
  // 2642 + 2645 + 2646 + 2647 + 2649, so ordinary debiterad ingående moms hides a
  // missing RC input entirely: 50 000 kr of utgående moms on ruta 30 with
  // nothing on 2645, alongside 60 000 kr of ordinary 2641, leaves ruta 48 above
  // rcOutput and the aggregate test silent while the company pays in 50 000 kr
  // it was entitled to deduct, recoverable only through omprövning.
  //
  // Without the totals we fall back to the weaker necessary condition
  // ruta 48 >= rutor 30-32. Still sound (ruta 48 contains the RC input, so a
  // total below rcOutput proves the RC input is short) but blind to any
  // shortfall smaller than the ordinary input VAT sitting in the same box.
  const rcInputVat = accountTotals ? reverseChargeInputVat(accountTotals) : null
  const rcInputFloor = rcInputVat ?? rutor.ruta48
  if (rcOutput > eps && rcInputFloor + eps < rcOutput) {
    const shortfall = Math.round(rcOutput - rcInputFloor)
    findings.push({
      code: 'RC_INPUT_VAT_MISMATCH',
      status: 'WARNING',
      message:
        rcInputVat === null
          ? 'Utgående moms på omvänd skattskyldighet (ruta 30-32) är högre än ' +
            'avdragsgill ingående moms (ruta 48). Vid full avdragsrätt ska ' +
            'beräknad ingående moms (2645/2647) nolla ut den fiktiva utgående ' +
            'momsen. Kontrollera att 2645/2647 är bokförd för varje 2614/2624/2634-rad.'
          : 'Utgående moms på omvänd skattskyldighet (ruta 30-32) är ' +
            `${Math.round(rcOutput).toLocaleString('sv-SE')} kr, men den beräknade ` +
            'ingående momsen på 2645/2647 är bara ' +
            `${Math.round(rcInputVat).toLocaleString('sv-SE')} kr: cirka ` +
            `${shortfall.toLocaleString('sv-SE')} kr saknas. Vid full avdragsrätt ` +
            'ska 2645 (förvärv från utlandet) eller 2647 (omvänd skattskyldighet ' +
            'i Sverige) nolla ut den fiktiva utgående momsen; annars betalar du ' +
            'in moms som du hade rätt att dra av. Kontrollera att en ingående rad ' +
            'finns för varje 2614/2624/2634-rad. Är avdragsrätten begränsad ' +
            '(blandad verksamhet, personbil, representation) är skillnaden ' +
            'korrekt och kan lämnas som den är.',
      rutor: ['ruta30', 'ruta31', 'ruta32', 'ruta48'],
    })
  }

  // SKV §4.1.1.4 rule 1: taxable sales base requires output VAT.
  // If user has booked revenue (3001-3003, uttag, VMB, frivillig uthyrning)
  // without any output VAT (2611-2638), the declaration will be rejected.
  // Common cause: revenue posted but VAT line forgotten, or revenue on a
  // zero-rated account that should have been ruta 35/36/39/40.
  //
  // DELIBERATELY BINARY, unlike the RC and import pairs. The proportional form
  // (rutor 05-08 vs ruta10/0.25 + ruta11/0.12 + ruta12/0.06) is NOT sound on
  // the sales side as a filing-blocking ERROR, because ACCOUNT_RUTA's two
  // halves are not a closed set:
  //   - ruta 07 (VMB) has NO source accounts at all, and ruta 08 (frivillig
  //     uthyrning) only BAS 3913 plus accounts with that momskod, while their
  //     output VAT (2616/2626/2636, 2613/2623/2633) does feed rutor 10-12, so
  //     the implied base can exceed the reported one;
  //   - ruta 05 recognises only 3001/3002/3003, but an invoice line may carry
  //     any revenue_account override (3590, 3910, ...) while its moms still
  //     lands on 2611/2621/2631;
  //   - an upplupen intäkt credits 17xx on the invoice with the full moms on
  //     2611, its months having credited 3001 with no moms before it, so both
  //     directions drift. (A förutbetald intäkt on 29xx no longer does: the
  //     declaration reads its 29xx line as the sale in the invoice's period,
  //     and a release nets to nothing, crm#1919.)
  // Any of those would turn a proportional check into a permanent filing-
  // blocking ERROR (isFilingBlocked) on a correct declaration. Making ruta 07
  // mappable and reconciling the revenue_account override is the
  // prerequisite; see the report accompanying this change.
  //
  // ONE direction is proportionally checkable without blocking: see
  // SALES_OUTPUT_VAT_SHORTFALL below.
  const taxableSalesBase = rutor.ruta05 + rutor.ruta06 + rutor.ruta07 + rutor.ruta08
  const taxableSalesOutput = rutor.ruta10 + rutor.ruta11 + rutor.ruta12
  if (taxableSalesBase > eps && taxableSalesOutput <= eps) {
    findings.push({
      code: 'TAXABLE_SALES_WITHOUT_OUTPUT',
      status: 'ERROR',
      message:
        'Du har redovisat momspliktig försäljning (ruta 05-08) men ingen ' +
        'utgående moms (ruta 10-12). Skatteverket kräver att momspliktig ' +
        'försäljning kombineras med utgående moms. Kontrollera att VAT-rader ' +
        'är bokförda på 2611/2621/2631, eller flytta intäkterna till rätt ' +
        'momsfri ruta (35/36/39/40) om de inte är momspliktiga.',
      rutor: ['ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12'],
    })
  } else if (salesBaseFiled && !salesOutputFiled) {
    // FK001 by presence. Still binary, so the reasons the sales pair is not
    // proportional (above) do not apply: it fires only where Skatteverket's
    // own check refuses the declaration.
    findings.push(pairPresenceFinding(
      'TAXABLE_SALES_WITHOUT_OUTPUT',
      'FK001',
      { label: 'Den momspliktiga försäljningen', rutor: '05-08', text: filedRutorText(rutor, SALES_BASE_RUTOR) },
      { label: 'rutorna för utgående moms', rutor: '10-12' },
      taxableSalesBase < 0
        ? 'Negativ försäljning utan utgående moms uppstår när en tidigare försäljning krediteras eller ' +
          'flyttas från försäljningskontot utan att momsen på 2611/2621/2631 följer med, till exempel ' +
          'en kreditfaktura bokförd utan moms. Rätta försäljning och moms i samma verifikation, i den ' +
          'period där försäljningen redovisades.'
        : 'Kontrollera att utgående moms är bokförd på 2611/2621/2631, eller flytta intäkterna till rätt ' +
          'momsfri ruta (35/36/39/40/42) om de inte är momspliktiga.',
      salesRutor,
      vatBelowOneKronaText(rutor, taxableSalesBase, SALES_OUTPUT_RUTOR),
    ))
  }

  // Mirror: output VAT without taxable sales base. Output VAT booked
  // standalone (e.g. manual correction without matching revenue posting)
  // would also fail SKV's contract.
  if (taxableSalesOutput > eps && taxableSalesBase <= eps) {
    findings.push({
      code: 'OUTPUT_VAT_WITHOUT_SALES_BASE',
      status: 'ERROR',
      message:
        'Du har redovisat utgående moms (ruta 10-12) men ingen momspliktig ' +
        'försäljning (ruta 05-08). Skatteverket kräver att utgående moms ' +
        'matchas med ett försäljningsunderlag. Kontrollera att momspliktiga ' +
        'intäktskonton är bokförda för varje momsrad. Om ett försäljningskonto ' +
        'saknas i ruta 05, kontrollera att kontots "Standard moms" är rätt ' +
        'inställd i kontoplanen.',
      rutor: ['ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12'],
    })
  } else if (salesOutputFiled && !salesBaseFiled) {
    findings.push(pairPresenceFinding(
      'OUTPUT_VAT_WITHOUT_SALES_BASE',
      'FK002',
      { label: 'Den utgående momsen', rutor: '10-12', text: filedRutorText(rutor, SALES_OUTPUT_RUTOR) },
      { label: 'rutorna för momspliktig försäljning', rutor: '05-08' },
      taxableSalesOutput < 0
        ? 'Negativ utgående moms utan försäljning uppstår när momsen på 2611/2621/2631 krediteras eller ' +
          'rättas utan att försäljningen på intäktskontot följer med, eller när en kreditfaktura bokförs ' +
          'på ett intäktskonto som inte redovisas i ruta 05. Rätta försäljning och moms i samma ' +
          'verifikation, eller ange momskod på intäktskontot i Kontoplanen.'
        : 'Kontrollera att momspliktiga intäktskonton är bokförda för varje momsrad och att kontots ' +
          '"Standard moms" är rätt inställd i kontoplanen.',
      salesRutor,
    ))
  }

  // Proportional tightening of the sales pair, WARNING tier only. The binary
  // ERROR above clears as soon as ANY output VAT exists, so at a 400 000 kr
  // sales base 2 000 kr of missing utgående moms still rendered a green
  // "Inga fel hittades" banner: undeclared moms and skattetillägg exposure
  // under SFL 49 kap 4 §.
  //
  // Only THIS direction (reported base implies more output VAT than rutor
  // 10-12 carry) is proportionally checkable: every unmapped drift source
  // listed above (VMB, frivillig uthyrning, revenue_account overrides,
  // periodisering in the invoice month) inflates the OUTPUT side and can only
  // suppress this finding, never trigger it. The one legitimate trigger is
  // periodiserade invoice lines dissolving (3001 credited with the moms
  // already declared in the invoice month), which is why this is a WARNING
  // that names that cause and never blocks filing (isFilingBlocked reads
  // ERROR only), following the RC_INPUT_VAT_MISMATCH precedent.
  //
  // The base comparison is exact per rate (basbelopp = moms/sats summed over
  // 25/12/6), so legitimate mixed-rate declarations net to zero drift; the
  // shared max(1 kr, 0.5%) tolerance absorbs per-voucher öre rounding.
  const expectedSalesBase =
    rutor.ruta10 / 0.25 + rutor.ruta11 / 0.12 + rutor.ruta12 / 0.06
  const salesTolerance = Math.max(1, expectedSalesBase * 0.005)
  if (taxableSalesOutput > eps && taxableSalesBase > expectedSalesBase + salesTolerance) {
    const shortfall = Math.round(taxableSalesBase - expectedSalesBase)
    findings.push({
      code: 'SALES_OUTPUT_VAT_SHORTFALL',
      status: 'WARNING',
      message:
        'Den momspliktiga försäljningen (ruta 05-08) är ' +
        `${Math.round(taxableSalesBase).toLocaleString('sv-SE')} kr, men den ` +
        'utgående momsen (ruta 10-12) motsvarar bara ett underlag på cirka ' +
        `${Math.round(expectedSalesBase).toLocaleString('sv-SE')} kr: cirka ` +
        `${shortfall.toLocaleString('sv-SE')} kr av försäljningen saknar ` +
        'utgående moms. Kontrollera att momsrader (2611/2621/2631) är ' +
        'bokförda för varje intäktsrad, eller flytta momsfri försäljning till ' +
        'rätt ruta (35/36/39/40). Använder du periodisering av fakturarader ' +
        'är skillnaden korrekt (momsen redovisas i fakturamånaden, intäkten ' +
        'löpande) och varningen kan lämnas utan åtgärd.',
      rutor: ['ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12'],
    })
  }

  // Revenue that reaches no ruta at all is invisible to every sales check above:
  // it is missing from rutor 05-08 while its output VAT sits in rutor 10-12, so
  // the binary pair clears and the proportional one only gets MORE lenient.
  const revenueWithoutRuta = context.revenueAccountsWithoutRuta ?? []
  if (revenueWithoutRuta.length > 0) {
    findings.push(revenueAccountWithoutRutaFinding(revenueWithoutRuta))
  }

  // Moms on an account no ruta reads is missing from the rutor and ruta 49
  // alike, so no rutor-level check above can see it either.
  const vatWithoutRuta = context.vatAccountsWithoutRuta ?? []
  if (vatWithoutRuta.length > 0) {
    findings.push(vatAccountWithoutRutaFinding(vatWithoutRuta))
  }

  findings.push(...kontantmetodCutoffFindings(context.kontantmetodCutoff))

  // SKV FK005 and FK006: import base and import output VAT require each
  // other. Compared PROPORTIONALLY, not by presence alone, for the same reason the
  // RC pair above is: a binary test clears as soon as ONE import voucher
  // carries both halves, so a period where the rest still miss their utgående
  // importmoms passes silently and the difference is undeclared moms.
  //
  // The implied base is exact here. ruta 50 is fed only by 4545/4546/4547
  // ("Import av råvaror och material, 25/12/6 % moms") and ruta 60/61/62 only
  // by 2615/2625/2635 (import 25/12/6%): a closed one-to-one set at exactly
  // those three rates, so basbelopp = importmoms / sats with no other account
  // able to land in either side. VAT-free imports use 4540, which is not
  // mapped to any ruta.
  const importOutput = rutor.ruta60 + rutor.ruta61 + rutor.ruta62
  const expectedImportBase =
    rutor.ruta60 / 0.25 + rutor.ruta61 / 0.12 + rutor.ruta62 / 0.06
  // Same convention as the RC pair: per-voucher öre rounding (basis derived as
  // moms/sats vs the declared tullvärde) accumulates with voucher count, so
  // 0.5% with a 1 kr floor absorbs it without hiding a missing voucher.
  const importTolerance = Math.max(1, expectedImportBase * 0.005)

  // The proportional comparisons only ever see a POSITIVE base or moms, but
  // FK005/FK006 themselves test presence: "om belopp anges" is any amount the
  // declaration files, negative included (Tjänstebeskrivning API
  // Momsdeklaration, 4.1.1.5). A period whose only import line is negative,
  // an earlier import moved off 4545/4546/4547 or credited without its
  // importmoms, read as clean here and was refused at filing (crm#1348).
  // Presence is read on whole kronor as filed (filesAmount).
  const importBaseFiled = filesAmount(rutor.ruta50)
  const importOutputFiled = anyFiled(IMPORT_OUTPUT_RUTOR)

  // Rule 5: import base larger than the output importmoms accounts for, i.e.
  // some imports were booked on 4545/4546/4547 without their 26x5 moms.
  if (rutor.ruta50 > eps && rutor.ruta50 > expectedImportBase + importTolerance) {
    const shortfall = Math.round(rutor.ruta50 - expectedImportBase)
    findings.push({
      code: 'IMPORT_BASE_WITHOUT_OUTPUT',
      status: 'ERROR',
      message:
        `Importunderlaget (ruta 50) är ${Math.round(rutor.ruta50).toLocaleString('sv-SE')} kr, ` +
        'men den utgående importmomsen (ruta 60-62) motsvarar bara ett ' +
        `underlag på cirka ${Math.round(expectedImportBase).toLocaleString('sv-SE')} kr: ` +
        `cirka ${shortfall.toLocaleString('sv-SE')} kr av underlaget saknar ` +
        'utgående moms. Skatteverket kräver båda. Kontrollera att importmoms ' +
        'är bokförd på 2615/2625/2635 för varje import.',
      rutor: ['ruta50', 'ruta60', 'ruta61', 'ruta62'],
    })
  } else if (importBaseFiled && !importOutputFiled) {
    findings.push(importPairPresenceFinding(
      'IMPORT_BASE_WITHOUT_OUTPUT',
      rutor.ruta50,
      vatBelowOneKronaText(rutor, rutor.ruta50, IMPORT_OUTPUT_RUTOR),
    ))
  }

  // Rule 6: output importmoms larger than the reported base, i.e. the
  // tullvärdesunderlag is missing or too low. This was the canary that the
  // Phase 1b ruta50 wiring fixed.
  if (importOutput > eps && rutor.ruta50 + importTolerance < expectedImportBase) {
    const shortfall = Math.round(expectedImportBase - rutor.ruta50)
    findings.push({
      code: 'IMPORT_OUTPUT_WITHOUT_BASE',
      status: 'ERROR',
      message:
        'Den utgående importmomsen (ruta 60-62) motsvarar ett ' +
        `beskattningsunderlag på cirka ${Math.round(expectedImportBase).toLocaleString('sv-SE')} kr, ` +
        `men ruta 50 innehåller bara ${Math.round(rutor.ruta50).toLocaleString('sv-SE')} kr: ` +
        `cirka ${shortfall.toLocaleString('sv-SE')} kr saknas. Skatteverket ` +
        'kräver att importmoms kombineras med tullvärdesunderlag på ' +
        '4545/4546/4547.',
      rutor: ['ruta50', 'ruta60', 'ruta61', 'ruta62'],
    })
  } else if (importOutputFiled && !importBaseFiled) {
    findings.push(importPairPresenceFinding('IMPORT_OUTPUT_WITHOUT_BASE', importOutput))
  }

  // SummaMoms drift: sanity check that our local ruta49 matches what the
  // mapper will send. If this fires, the calculator and mapper disagree
  // and we'd hit SKV's FK009.
  const expectedRuta49 =
    rutor.ruta10 + rutor.ruta11 + rutor.ruta12 +
    rutor.ruta30 + rutor.ruta31 + rutor.ruta32 +
    rutor.ruta60 + rutor.ruta61 + rutor.ruta62 -
    rutor.ruta48
  if (Math.abs(expectedRuta49 - rutor.ruta49) > eps) {
    findings.push({
      code: 'SUMMA_MOMS_DRIFT',
      status: 'ERROR',
      message:
        'Beräknad ruta 49 (moms att betala) stämmer inte överens med summan ' +
        'av övriga rutor. Detta tyder på avrundningsfel i bokföringen. ' +
        'Kontrollera huvudboken för perioden innan inlämning.',
      rutor: ['ruta49'],
    })
  }

  return findings
}
