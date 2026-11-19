/**
 * The skattekonto's ledger account for one company (PH 175).
 *
 * Two practices exist for an enskild firma. Our BAS 2026 chart runs the
 * skattekonto on 1630 Avräkning för skatter och avgifter and books only the
 * owner's own tax to eget kapital (2013), see
 * .claude/skills/swedish-daily-bookkeeping/references/skattekonto-and-owner.md.
 * Fortnox, Björn Lundén and the BAS K1 chart (förenklat årsbokslut) run it on
 * 2012 Avräkning för skatter och avgifter (skattekonto) under eget kapital,
 * because the firm shares the skattekonto with the owner. An aktiebolag (and
 * every other form) always runs 1630.
 *
 * The company's choice is company_settings.skattekonto_account. The resolver
 * is the SQL function company_skattekonto_account() (migration
 * 20261015030000), which the VAT and onboarding functions read too; this
 * module calls it so the app and the database cannot disagree. Every reader
 * that means "the skattekonto" (connection and sync, booking a row, matching,
 * linking, the reconciliation, MCP, v1, labels) takes the account from here,
 * never from a literal.
 *
 * Client-safe: the async functions only take a client as an argument.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { legalFormProfile, resolveCompanyEntityType } from '@/lib/company/entity-type'
import type { EntityType } from '@/types'

/** The default, and the only account outside an enskild firma. */
export const SKATTEKONTO_ACCOUNT_DEFAULT = '1630'

/** An enskild firma's alternative, in eget kapital (BAS K1 chart). */
export const SKATTEKONTO_ACCOUNT_EQUITY = '2012'

export const SKATTEKONTO_LEDGER_ACCOUNTS = [SKATTEKONTO_ACCOUNT_DEFAULT, SKATTEKONTO_ACCOUNT_EQUITY] as const
export type SkattekontoLedgerAccount = (typeof SKATTEKONTO_LEDGER_ACCOUNTS)[number]

/** Name of 2012 when the product adds it to a chart (BAS K1 chart wording). */
export const SKATTEKONTO_EQUITY_ACCOUNT_NAME = 'Avräkning för skatter och avgifter (skattekonto)'

export function isSkattekontoLedgerAccount(value: unknown): value is SkattekontoLedgerAccount {
  return value === SKATTEKONTO_ACCOUNT_DEFAULT || value === SKATTEKONTO_ACCOUNT_EQUITY
}

/** The accounts a company of this form may run its skattekonto on, the default first. */
export function skattekontoAccountChoices(entityType: EntityType): SkattekontoLedgerAccount[] {
  return legalFormProfile(entityType).bookkeeping.skattekontoAccounts.filter(isSkattekontoLedgerAccount)
}

/**
 * The TS mirror of company_skattekonto_account() for a caller that already
 * holds both facts: the stored choice when the form allows it, else 1630.
 */
export function skattekontoAccountFor(entityType: EntityType, stored: unknown): SkattekontoLedgerAccount {
  return isSkattekontoLedgerAccount(stored) && skattekontoAccountChoices(entityType).includes(stored)
    ? stored
    : SKATTEKONTO_ACCOUNT_DEFAULT
}

/**
 * A booking template's account for this company. Every template (the static
 * catalog, the library and its packs, "Insättning skattekonto", "Momsbetalning
 * via skattekonto", F-skatt) names the skattekonto as 1630, BAS's account for
 * it; for a company that runs the skattekonto on 2012 the same template books
 * 2012, so the bank side lands where the twin and cover guards look. Any other
 * account, and every account without a known skattekonto account, is kept.
 */
export function templateSkattekontoAccount(
  account: string,
  skattekontoAccount: SkattekontoLedgerAccount | undefined,
): string {
  return skattekontoAccount && account === SKATTEKONTO_ACCOUNT_DEFAULT ? skattekontoAccount : account
}

/** Whether a template names the skattekonto at all (so only then is the account read). */
export function templateTouchesSkattekonto(accounts: ReadonlyArray<string | undefined | null>): boolean {
  return accounts.some((a) => a === SKATTEKONTO_ACCOUNT_DEFAULT)
}

/**
 * PostgREST answers PGRST202 for a function it does not know, Postgres 42883.
 * Only during the window between a deploy and its migration: every company
 * then still runs 1630, so that is the answer, not an error.
 */
function isMissingFunction(error: { code?: string | null } | null): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

/**
 * The company's skattekonto account. Throws when it cannot be read: a reader
 * that guessed 1630 for a firm on 2012 would book or match on the wrong
 * account.
 */
export async function resolveSkattekontoAccount(
  supabase: SupabaseDataClient,
  companyId: string,
): Promise<SkattekontoLedgerAccount> {
  const { data, error } = await supabase.rpc('company_skattekonto_account', { p_company_id: companyId })
  if (error) {
    if (isMissingFunction(error)) return SKATTEKONTO_ACCOUNT_DEFAULT
    throw new Error(`Kunde inte läsa skattekontots konto: ${error.message}`)
  }
  return isSkattekontoLedgerAccount(data) ? data : SKATTEKONTO_ACCOUNT_DEFAULT
}

/**
 * What the books say (derive_skattekonto_account): 1630 when any posted line
 * is on 1630, else 2012 when one is on 2012, else null.
 */
export async function deriveSkattekontoAccountFromBooks(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SkattekontoLedgerAccount | null> {
  const { data, error } = await supabase.rpc('derive_skattekonto_account', { p_company_id: companyId })
  if (error) {
    if (isMissingFunction(error)) return null
    throw new Error(`Kunde inte läsa bokföringen på skattekontot: ${error.message}`)
  }
  return isSkattekontoLedgerAccount(data) ? data : null
}

/**
 * Derive the choice once, when a company's skattekonto rows first arrive (a
 * sync, a file import) and the choice is still unset: an enskild firma whose
 * books run 2012 and never 1630 (an imported K1, Fortnox or Björn Lundén
 * chart) gets 2012 stored, so booking and matching follow its books. Stored
 * only when the books give evidence, so an empty company stays unset (1630)
 * until its first line or the user's choice decides. A stored value is never
 * changed here. Best effort, never throws: a failure leaves the company on
 * what it resolves to now. Returns the account the company resolves to
 * afterwards, or undefined when that cannot be read (the caller's readers
 * then resolve it themselves).
 */
export async function ensureSkattekontoAccountDerived(
  supabase: SupabaseClient,
  companyId: string,
  onError?: (err: unknown) => void,
): Promise<SkattekontoLedgerAccount | undefined> {
  try {
    const { data: settings, error } = await supabase
      .from('company_settings')
      .select('entity_type, skattekonto_account')
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const row = settings as { entity_type: string | null; skattekonto_account: string | null } | null
    if (
      row &&
      row.skattekonto_account === null &&
      skattekontoAccountChoices(await resolveCompanyEntityType(supabase, companyId, row.entity_type)).includes(
        SKATTEKONTO_ACCOUNT_EQUITY,
      )
    ) {
      const derived = await deriveSkattekontoAccountFromBooks(supabase, companyId)
      if (derived) {
        const { error: updateError } = await supabase
          .from('company_settings')
          .update({ skattekonto_account: derived })
          .eq('company_id', companyId)
          .is('skattekonto_account', null)
        if (updateError) throw new Error(updateError.message)
      }
    }
  } catch (err) {
    onError?.(err)
  }
  try {
    return await resolveSkattekontoAccount(supabase, companyId)
  } catch (err) {
    onError?.(err)
    return undefined
  }
}
