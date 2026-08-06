/**
 * K2 framework gate for the asset register.
 *
 * The BAS chart marks every account a K2 company may not use with the
 * k2_excluded flag ("Ej K2"). The gate asks the BAS reference instead of
 * hardcoding number ranges: any account whose flag is set requires the K3
 * framework. The asset API routes reject writes that would land an asset (or
 * its accumulated-depreciation counterpart) on such an account when the
 * company's accounting_framework is not 'k3'.
 *
 * Those accounts are excluded for DIFFERENT reasons, so the rejection message
 * has to name the rule that actually applies:
 *
 * - Kontogrupp 10 (immateriella anläggningstillgångar): 1010-1019 balanserade
 *   utvecklingsutgifter plus 1081 pågående projekt. These are the
 *   egenupparbetade immateriella tillgångar that K2 forbids capitalizing
 *   (BFNAR 2016:10 punkt 10.4), so the message cites that rule.
 * - Everything else on the Ej K2 list (uppskjuten skatt 1370/2240/8940,
 *   verkligt värde, säkringsredovisning, aktiverade ränteutgifter, ...) is
 *   excluded for unrelated reasons. Those get a generic message: what the
 *   chart says, and that it presumes K3. No paragraph reference is invented
 *   for them, since citing punkt 10.4 on a deferred-tax account would put a
 *   factually wrong legal claim in front of the user.
 *
 * Two things the messages deliberately do NOT do:
 *
 * - They never assert which framework the company applies. The routes read
 *   companies.accounting_framework without checking the read error, so a
 *   transient failure resolves to "not K3" for a company that IS on K3;
 *   phrasing the rejection as a fact about the account keeps a failed read
 *   from turning into a false claim about the customer's regelverk.
 * - They never propose switching regelverk as the remedy. Moving a company
 *   from K2 to K3 pulls in komponentavskrivning and uppskjuten skatt and
 *   rewrites the whole årsredovisning; it is not a fix for one misdirected
 *   account. The remedy offered is the lawful account instead: an ACQUIRED
 *   intangible belongs on 1090, which K2 permits
 *   (.claude/skills/swedish-year-end-closing/references/k2-vs-k3.md:24,
 *   "Only acquired intangibles may be recognized").
 *
 * The K2 framing only holds for an entity that prepares an ÅRSREDOVISNING.
 * companies.accounting_framework is NOT NULL DEFAULT 'k2', so an enskild
 * firma trips this gate too, and BFNAR 2016:10 is not its regelverk: K2 is
 * for mindre aktiebolag och ekonomiska föreningar, while a sole trader
 * prepares ett förenklat årsbokslut (K1) or ett årsbokslut (BFNAR 2017:3)
 * (.claude/skills/swedish-year-end-closing/references/legal-framework.md:29,
 * :31, :48). Citing punkt 10.4 at them is a wrong legal claim, and "apply K3
 * instead" is not a remedy the ordinary sole trader has (the same source, :50,
 * has it reaching an årsredovisning only by meeting the större-företag
 * criteria, which it calls extremely rare). The K1 counterpart of punkt 10.4
 * is not sourced in the repo skills, so nothing is cited in its place: the
 * enskild-firma wording states what the BAS chart marks and what the asset
 * register does, plus the same 1090 remedy. `entityType` is optional, and
 * when it is missing the neutral wording is used: an unknown entity may not
 * be handed a legal citation on a guess.
 */
import type { EntityType } from '@/types'
import { getBASReference, type BASReferenceAccount } from '@/lib/bookkeeping/bas-reference'

/** Swedish and English rejection text, mirroring the structured-errors registry shape. */
export interface K2ExcludedAccountMessages {
  message_sv: string
  message_en: string
}

/**
 * True when the BAS chart itself puts the account in kontogrupp 10
 * (immateriella anläggningstillgångar) and flags it Ej K2. That intersection
 * is exactly the egenupparbetade set (1010, 1011, 1012, 1018, 1019, 1081):
 * every other group-10 account covers an ACQUIRED intangible (koncessioner,
 * patent, licenser, varumärken, hyresrätter, goodwill, förskott, övriga) and
 * carries k2_excluded=false. Reading the boundary off the chart instead of a
 * literal account list means a flag change in
 * lib/bookkeeping/bas-data/class-1-assets.ts moves the boundary with it.
 */
function isEgenupparbetadImmateriell(account: BASReferenceAccount): boolean {
  return account.k2_excluded && account.account_class === 1 && account.account_group === '10'
}

/**
 * Return the first account in the list that the BAS reference flags as
 * k2_excluded ("Ej K2"), or null when every account is allowed under K2.
 * Unknown account numbers are treated as allowed: the Zod range checks and
 * chart validation own that concern.
 */
export function findK2ExcludedAccount(
  accountNumbers: Array<string | undefined>,
): BASReferenceAccount | null {
  for (const accountNumber of accountNumbers) {
    if (!accountNumber) continue
    const reference = getBASReference(accountNumber)
    if (reference?.k2_excluded) return reference
  }
  return null
}

/**
 * User-facing text for the K2_EXCLUDED_ACCOUNT rejection, in both languages.
 * The legal citation is conditional on what actually triggered the gate AND on
 * the entity preparing an årsredovisning at all: see the file header.
 *
 * @param entityType companies.entity_type for the company being written to.
 *   Only 'aktiebolag' gets the K2/K3 regelverk framing; anything else
 *   (enskild firma, or an entity we could not read) gets wording that is true
 *   without it.
 */
export function k2ExcludedAccountMessages(
  account: BASReferenceAccount,
  entityType?: EntityType | null,
): K2ExcludedAccountMessages {
  const label = `${account.account_number} (${account.account_name})`
  const preparesArsredovisning = entityType === 'aktiebolag'

  if (isEgenupparbetadImmateriell(account)) {
    if (!preparesArsredovisning) {
      return {
        message_sv:
          `Konto ${label} är i BAS-kontoplanen reserverat för egenupparbetade ` +
          `utvecklingsutgifter och markerat Ej K2: anläggningsregistret tar inte emot det. ` +
          `En förvärvad immateriell tillgång bokförs på 1090 ` +
          `(Övriga immateriella anläggningstillgångar).`,
        message_en:
          `Account ${label} is reserved in the BAS chart of accounts for internally generated ` +
          `development expenditure and marked Ej K2: the asset register does not accept it. ` +
          `An acquired intangible asset belongs on 1090 ` +
          `(Övriga immateriella anläggningstillgångar).`,
      }
    }
    return {
      message_sv:
        `Konto ${label} är reserverat för egenupparbetade utvecklingsutgifter, som bara får ` +
        `aktiveras enligt K3 (BFNAR 2016:10 punkt 10.4). En förvärvad immateriell tillgång ` +
        `bokförs på 1090 (Övriga immateriella anläggningstillgångar).`,
      message_en:
        `Account ${label} is reserved for internally generated development expenditure, which ` +
        `may only be capitalized under K3 (BFNAR 2016:10 paragraph 10.4). An acquired ` +
        `intangible asset belongs on 1090 (Övriga immateriella anläggningstillgångar).`,
    }
  }

  if (!preparesArsredovisning) {
    return {
      message_sv:
        `Konto ${label} är markerat Ej K2 i BAS-kontoplanen: anläggningsregistret tar inte ` +
        `emot det. Välj ett annat konto för tillgången.`,
      message_en:
        `Account ${label} is marked Ej K2 in the BAS chart of accounts: the asset register ` +
        `does not accept it. Choose a different account for the asset.`,
    }
  }

  return {
    message_sv: `Konto ${label} är markerat Ej K2 i BAS-kontoplanen och förutsätter K3.`,
    message_en:
      `Account ${label} is marked Ej K2 in the BAS chart of accounts and presumes the K3 ` +
      `framework.`,
  }
}
