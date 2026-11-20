/**
 * What the checks share: the company facts they branch on (read once per
 * queue), the refusal sentences, and the line that turns a failed read into
 * a cannot_check instead of a zero.
 */
import { AccountRoleError, resolveAccountRole, type AccountRole } from '@/lib/bookkeeping/account-roles'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { formatAmount } from '@/lib/utils'
import type { CheckContext, CheckRefusal, CheckRun, CheckSide, CheckSubject } from './types'

const log = createLogger('unexplained')

export interface CompanyFacts {
  /** companies.jurisdiction: the account-role pack the company books in. */
  jurisdiction: string
  /** companies.ledger_currency: the currency every ledger balance is in. */
  ledgerCurrency: string | null
  /** company_settings.accounting_method; null defaults to faktureringsmetoden. */
  accountingMethod: 'accrual' | 'cash'
  vatRegistered: boolean
}

const FACTS = new WeakMap<CheckContext, Promise<CompanyFacts>>()

/** The company facts, read once per context. Throws on a failed read. */
export function companyFacts(ctx: CheckContext): Promise<CompanyFacts> {
  let pending = FACTS.get(ctx)
  if (!pending) {
    pending = readCompanyFacts(ctx)
    FACTS.set(ctx, pending)
  }
  return pending
}

async function readCompanyFacts(ctx: CheckContext): Promise<CompanyFacts> {
  const [company, settings] = await Promise.all([
    ctx.supabase.from('companies').select('jurisdiction, ledger_currency').eq('id', ctx.companyId).maybeSingle(),
    ctx.supabase
      .from('company_settings')
      .select('accounting_method, vat_registered')
      .eq('company_id', ctx.companyId)
      .maybeSingle(),
  ])
  if (company.error) throw Object.assign(new Error(`company read failed: ${company.error.message}`), { code: company.error.code })
  if (settings.error) throw Object.assign(new Error(`company settings read failed: ${settings.error.message}`), { code: settings.error.code })
  const c = company.data as { jurisdiction?: string | null; ledger_currency?: string | null } | null
  const s = settings.data as { accounting_method?: string | null; vat_registered?: boolean | null } | null
  return {
    jurisdiction: c?.jurisdiction ?? '',
    ledgerCurrency: c?.ledger_currency ?? null,
    accountingMethod: s?.accounting_method === 'cash' ? 'cash' : 'accrual',
    vatRegistered: s?.vat_registered === true,
  }
}

/** The accounts the roles resolve to for the company, or the refusal that says which role is missing. */
export function roleAccounts(
  facts: CompanyFacts,
  roles: readonly AccountRole[],
): { ok: true; accounts: string[] } | { ok: false; refusal: CheckRefusal } {
  try {
    return { ok: true, accounts: roles.map((role) => resolveAccountRole({ jurisdiction: facts.jurisdiction }, role)) }
  } catch (err) {
    if (!(err instanceof AccountRoleError)) throw err
    return {
      ok: false,
      refusal: {
        code: 'ACCOUNT_ROLE_UNAVAILABLE',
        message_sv: `Bolagets land (${err.jurisdiction || 'okänt'}) har inget konto för rollen ${err.role}, så kontrollen kan inte köras.`,
        message_en: `The company's jurisdiction (${err.jurisdiction || 'unknown'}) has no account for the role ${err.role}, so the check cannot run.`,
        details: { role: err.role, jurisdiction: err.jurisdiction },
      },
    }
  }
}

export function noFiscalPeriod(date: string): CheckRefusal {
  return {
    code: 'NO_FISCAL_PERIOD',
    message_sv: `Inget räkenskapsår i bokföringen omfattar ${date}, så det finns inget bokfört saldo att jämföra med.`,
    message_en: `No fiscal period in the books covers ${date}, so there is no booked balance to compare with.`,
    details: { date },
  }
}

/**
 * A failed read as a refusal. A transient failure is marked retryable; any
 * failure is logged. Never a zero: the check answers cannot_check.
 */
export function sourceFailed(checkId: string, report: string, err: unknown): CheckRefusal {
  const retryable = getStructuredError(err).retryable
  log.warn('check source failed', {
    checkId,
    report,
    retryable,
    error: err instanceof Error ? err.message : String(err),
  })
  return {
    code: 'SOURCE_FAILED',
    message_sv: `Underlaget (${report}) gick inte att läsa, så kontrollen kunde inte köras.${retryable ? ' Försök igen om en stund.' : ''}`,
    message_en: `The source (${report}) could not be read, so the check could not run.${retryable ? ' Try again shortly.' : ''}`,
    retryable,
    details: { report },
  }
}

/** A cannot_check run. */
export function cannotCheck<S>(
  subject: CheckSubject,
  asOf: string,
  refusal: CheckRefusal,
  sides: CheckSide[] = [],
): CheckRun<S> {
  return {
    subject,
    status: 'cannot_check',
    difference: null,
    as_of: asOf,
    summary_sv: refusal.message_sv,
    sides,
    refusal,
    source: null,
  }
}

/** ok or unexplained for a difference against the tolerance. */
export function statusFor(difference: number, tolerance: number): 'ok' | 'unexplained' {
  return Math.abs(difference) <= tolerance + 1e-9 ? 'ok' : 'unexplained'
}

/** "12 345,67 kr" for the Swedish summaries. */
export function kronor(amount: number): string {
  return `${formatAmount(roundOre(amount))} kr`
}

/** Sum rounded to öre at the end, so many small addends do not drift. */
export function sumOre(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return roundOre(total)
}
