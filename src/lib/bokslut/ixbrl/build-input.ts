/**
 * Assemble IxbrlArsredovisningInput for a fiscal period.
 *
 * Reuses the PDF builder's report (buildArsredovisningReport): its
 * narrative texts, noter and flerårsöversikt, and the K2 mapping of BOTH
 * years to risbs concepts (jämförelsesiffror: kontrollera 3006/3007) it was
 * built from, so the two documents read one set of trial balances. Adds what
 * iXBRL needs on top: per-signer dates from the signature flow and the
 * fastställelseintyg undertecknare.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildArsredovisningReport,
  type ArsredovisningBuild,
} from '@/lib/bokslut/arsredovisning/build-data'
import { listSignatureRequests } from '@/lib/bokslut/arsredovisning/signature-service'
import { getAnnualReportProfile } from '@/lib/bokslut/arsredovisning/profile-service'
import type { AnnualReportProfile } from '@/lib/bokslut/arsredovisning/compliance-types'
import { buildRevisorspateckning, splitRoster } from './revisorspateckning'
import { resolveMedelantalAnstallda } from '@/lib/salary/medelantal'
import { getMedelantalOverride } from '@/lib/bokslut/arsredovisning/narrative-service'
import { resolveEntryPoint } from './taxonomy/entry-points'
import { k3IxbrlEnabled } from './k3-release'
import {
  k3BalanceSheetSource,
  k3CashFlowInput,
  k3EquityInput,
  k3ForvaltningsberattelseItems,
} from './k3-adapters'
import type {
  EgetKapitalForandring,
  FlerarsRow,
  IxbrlArsredovisningInput,
  IxbrlSigner,
  Resultatdisposition,
} from './types'
import { isFirstFiscalPeriod } from '@/lib/bookkeeping/validate-period-duration'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { arsredovisningDatering } from '@/lib/bokslut/arsredovisning/datering'
import { signatureDate } from '@/lib/bokslut/arsredovisning/signature-pages'
import { effectiveDisclosureTexts } from '@/lib/bokslut/arsredovisning/register-disclosures'
import { k2EquityTableInput } from '@/lib/bokslut/arsredovisning/equity-specification'
import {
  AGM_DATE_MISSING_WARNING,
  AGM_DECISION_MISSING_WARNING,
  NO_SIGNERS_WARNING,
  NOT_ALL_SIGNED_WARNING,
} from './input-warnings'

/**
 * TA §4.3.4-4.3.5: "<leverantör> - <produkt>", version "<huvud>.<revision>".
 * The leverantör is the legal entity behind the product (the party that signs
 * Bolagsverket's agreement); the version is the generator's, registered with
 * Bolagsverket, which can refuse filings from a version it no longer supports
 * (felkod 4002), so bump it together with them, not per deploy.
 */
export const PROGRAMVARA_NAMN = 'Arcim Technology AB - Accounted'
export const PROGRAMVARA_VERSION = '1.0'

export interface BuildIxbrlOptions {
  /** Undertecknare of the fastställelseintyg (chosen in the wizard). When
   *  omitted, the first signed board member is used. */
  undertecknare?: { firstName: string; lastName: string; role: string }
  /** Proposed dividend in SEK (0 = balansera allt). */
  proposedDividend?: number
  /** Override "today" for deterministic tests (ISO date). */
  todayIso?: string
  /**
   * Reuse a canonical report instance, and the statements it was built
   * from, so PDF and iXBRL cannot diverge and no trial balance is built twice.
   */
  report?: ArsredovisningBuild
  /** Reuse the version-bound signer roster when a canonical model is built. */
  signatureRequests?: Awaited<ReturnType<typeof listSignatureRequests>>
  /** Reuse the compliance profile when a canonical model is built. */
  profile?: AnnualReportProfile
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] }
}

export async function buildIxbrlInput(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: BuildIxbrlOptions = {},
): Promise<IxbrlArsredovisningInput> {
  const warnings: string[] = []

  // The statements come from the report: its TrialBalancePair per year (the
  // FULL trial balance drives the BR, the PRE-CLOSING one the RR) mapped once
  // with the company's equity table, previous year included.
  const [built, periodRow, signatureRequests, profile] = await Promise.all([
    options.report ?? buildArsredovisningReport(supabase, companyId, fiscalPeriodId),
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    options.signatureRequests ?? listSignatureRequests(supabase, companyId, fiscalPeriodId),
    options.profile ?? getAnnualReportProfile(supabase, companyId, fiscalPeriodId),
  ])
  const pdfData = built.data
  const { mapping, comparison } = built.statements
  const disclosed = effectiveDisclosureTexts(pdfData.disclosures, pdfData.disclosures.from_registers)

  if (periodRow.error || !periodRow.data) throw new Error('Fiscal period not found')
  const period = periodRow.data

  // K2 resolves to K2 AB risbs; K3 to K3 AB risbs only while the K3 iXBRL
  // document is switched on (k3-release.ts), else a message that says what
  // is and is not possible.
  const framework = pdfData.accounting_framework
  const entryPoint = resolveEntryPoint(framework, { k3Enabled: k3IxbrlEnabled() })

  // Previous period: jämförelsesiffror, when its trial balances loaded.
  let previousPeriod: { start: string; end: string } | null = null
  let previousPeriodId: string | null = null
  if (comparison) {
    previousPeriodId = comparison.id
    if (comparison.loaded) {
      previousPeriod = { start: comparison.period_start, end: comparison.period_end }
    } else {
      warnings.push(
        'Jämförelsesiffror kunde inte hämtas för föregående räkenskapsår: balans- och resultaträkning visas utan jämförelseår (kontrollera-kod 3006/3007 kan utlösas).',
      )
    }
  }

  warnings.push(...mapping.warnings)

  // ---- flerårsöversikt (reuse PDF rows; whole SEK) -------------------------
  // PDF rows are oldest-first; iXBRL columns newest-first. Each row needs the
  // matching fiscal-period range so the document can declare period2/3 +
  // balans2/3 contexts explicitly.
  const { data: allPeriods, error: allPeriodsError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })
  if (allPeriodsError) throw new Error(`Failed to read fiscal periods: ${allPeriodsError.message}`)
  const periodByName = new Map(
    ((allPeriods ?? []) as Array<{ name: string; period_start: string; period_end: string }>).map(
      (p) => [p.name, p],
    ),
  )
  const flerarsoversikt: FlerarsRow[] = []
  const flerarsPerioder: Array<{ start: string; end: string }> = []
  for (const row of [...pdfData.forvaltningsberattelse.flerarsoversikt].reverse()) {
    const match = periodByName.get(row.year)
    if (!match) continue // can't tag a year without a known period range
    flerarsoversikt.push({
      year: row.year,
      nettoomsattning: Math.round(row.net_revenue),
      resultatEfterFinansiellaPoster: Math.round(row.result_after_financial),
      soliditetPct: row.soliditet_pct,
    })
    flerarsPerioder.push({ start: match.period_start, end: match.period_end })
  }
  // Column 0 must be the current period and column 1 the previous one:
  // the document reuses period0/period1 contexts for them. Anything else
  // (e.g. a missed periodByName lookup shifting the rows) means the period
  // chain is inconsistent; drop the table rather than tag amounts against
  // the wrong period.
  const flerarsMisaligned =
    (flerarsPerioder.length > 0 && flerarsPerioder[0].start !== period.period_start) ||
    (flerarsPerioder.length > 1 &&
      previousPeriod !== null &&
      flerarsPerioder[1].start !== previousPeriod.start)
  if (flerarsMisaligned) {
    warnings.push(
      'Flerårsöversikten kunde inte knytas till räkenskapsperioderna: tabellen utelämnas ur iXBRL-dokumentet.',
    )
    flerarsoversikt.length = 0
    flerarsPerioder.length = 0
  }
  // Duplicate-fact consistency (TA §2.7.3): the flerårsöversikt repeats
  // Nettoomsattning / ResultatEfterFinansiellaPoster in the same contexts
  // (period0/period1) as the RR, and repeated facts must be value-identical
  // or Bolagsverket rejects the filing. The PDF rows already come from
  // mapTrialBalancesToK2 per year (buildFlerarsoversikt, since #1116), and
  // the report pins its current and previous year to the very mapping this
  // document tags; the columns are still overridden from that mapping here,
  // so the repeated facts are identical by construction whatever the PDF
  // rows matched. Older years have no RR facts and keep the PDF values.
  if (flerarsoversikt.length > 0) {
    flerarsoversikt[0] = {
      ...flerarsoversikt[0],
      nettoomsattning: mapping.rr['Nettoomsattning']?.current ?? 0,
      resultatEfterFinansiellaPoster: mapping.totals.resultatEfterFinansiellaPoster.current,
    }
    if (flerarsoversikt.length > 1 && previousPeriod !== null) {
      flerarsoversikt[1] = {
        ...flerarsoversikt[1],
        nettoomsattning: mapping.rr['Nettoomsattning']?.previous ?? 0,
        resultatEfterFinansiellaPoster:
          mapping.totals.resultatEfterFinansiellaPoster.previous ?? 0,
      }
    }
  }

  // ---- eget kapital-förändring ---------------------------------------------
  // From the report's specification of changes in equity, which reads the
  // year's equity verifikat and ties every post to this mapping
  // (lib/bokslut/arsredovisning/equity-specification.ts). It replaces a
  // derivation from closing balances that called every fall in balanserat
  // resultat beyond last year's result a dividend.
  if (!pdfData.equity_specification) {
    throw new Error('The annual report carries no equity specification: build it with buildArsredovisningReport.')
  }
  const egetKapital: EgetKapitalForandring = k2EquityTableInput(pdfData.equity_specification)

  // ---- resultatdisposition --------------------------------------------------
  // BalanseratResultat is tagged in BR and the eget kapital-table for the
  // same context: the disposition row must carry the identical value
  // (TA §2.7.3), so fri överkursfond (2097) is its own row tagged with the
  // separate Overkursfond concept instead of being folded into balanserat.
  const proposedDividend = Math.max(
    0,
    Math.round(
      options.proposedDividend ?? pdfData.forvaltningsberattelse.proposed_dividend,
    ),
  )
  const dispositionAmounts = pdfData.forvaltningsberattelse.resultatdisposition_amounts
  const dispBalanserat = dispositionAmounts.retained_earnings
  const dispOverkursfond = dispositionAmounts.share_premium_reserve
  const dispArets = dispositionAmounts.current_year_result
  const dispSumma = dispositionAmounts.total
  // Only a dividend that is actually proposed can exceed the free equity: with
  // none proposed and a negative free equity there is nothing to warn about.
  if (proposedDividend > 0 && proposedDividend > dispSumma) {
    warnings.push(
      `Föreslagen utdelning (${proposedDividend} kr) överstiger fritt eget kapital (${dispSumma} kr).`,
    )
  }
  const resultatdisposition: Resultatdisposition = {
    balanseratResultat: dispBalanserat,
    overkursfond: dispOverkursfond,
    aretsResultat: dispArets,
    summa: dispSumma,
    utdelning: proposedDividend,
    balanserasINyRakning: dispSumma - proposedDividend,
    kommentar: pdfData.forvaltningsberattelse.resultatdisposition || null,
  }

  // ---- underskrifter ---------------------------------------------------------
  // Every active signature request becomes a signer row (the board must appear
  // in the document), but ONLY actually-signed requests get a date: an unsigned
  // request keeps signedDate null. Legal dates are never fabricated: the
  // missing date renders as an omitted fact in the preview and preflight 1214
  // blocks the submission path until everyone has signed.
  // The revisor's slots hold the revisorspåteckning, not a signature of the
  // årsredovisning (ABL 9 kap. 28 §): they are split off here and never count
  // as board signers (ÅRL 2 kap. 7 §), for the datering or the intyg signer.
  const { board: activeSignatureRequests, revisorer: revisorRequests } = splitRoster(signatureRequests)
  const signedRequests = activeSignatureRequests.filter((request) => request.status === 'signed')
  const today = options.todayIso ?? todayIsoStockholm()
  const signers: IxbrlSigner[] = activeSignatureRequests.map((request) => {
    const { firstName, lastName } = splitName(request.signer_name)
    return {
      firstName,
      lastName,
      role: request.role || null,
      signedDate: signatureDate(request.signed_at),
    }
  })
  if (signers.length === 0) {
    warnings.push(NO_SIGNERS_WARNING)
  }
  if (signedRequests.length !== activeSignatureRequests.length) {
    warnings.push(NOT_ALL_SIGNED_WARNING)
  }
  const harVd = signers.some((signer) => /verkställande direktör|^vd$/i.test(signer.role ?? ''))
  const dateringsdatum = arsredovisningDatering(signers.map((signer) => signer.signedDate))
  const revisorspateckning = buildRevisorspateckning(revisorRequests, profile)

  // ---- fastställelseintyg ----------------------------------------------------
  // A missing AGM date is NEVER replaced with today's date: it stays null,
  // the document renders a placeholder and preflight 1103 blocks filing
  // (mirrors Bolagsverket kontrollera 1103).
  const agmDate = pdfData.forvaltningsberattelse.agm_date
  if (!agmDate) {
    warnings.push(AGM_DATE_MISSING_WARNING)
  }
  const agmDispositionOutcome = pdfData.forvaltningsberattelse.agm_disposition_outcome
  const agmDispositionDecision = pdfData.forvaltningsberattelse.agm_disposition_decision
  if (!agmDispositionOutcome) {
    warnings.push(AGM_DECISION_MISSING_WARNING)
  }
  const fallbackSigner = signers[0] ?? { firstName: '', lastName: '', role: null }
  const undertecknare = options.undertecknare ?? {
    firstName: fallbackSigner.firstName,
    lastName: fallbackSigner.lastName,
    role: fallbackSigner.role ?? 'Styrelseledamot',
  }
  if (!undertecknare.firstName) {
    warnings.push('Undertecknare av fastställelseintyget saknas (kontrollera-kod 1169).')
  }

  // Allmänt om verksamheten is the PDF's text, word for word: the
  // fastställelseintyg attests that the electronic document matches the
  // signed original. Säte is tagged on the cover instead, where the PDF
  // prints it too.
  const allmant = pdfData.forvaltningsberattelse.description

  // ---- medelantal anställda ---------------------------------------------------
  // Compute BOTH years with the same resolver the PDF note uses: a manual
  // override on arsredovisning_narratives for that period wins, otherwise
  // the FTE average over the employees table. The note-prose regex stays
  // only as a last-resort fallback when the employees query fails.
  let medelantalAnstallda: { current: number; previous: number | null }
  const [{ data: employeeRows, error: employeesError }, previousOverride] = await Promise.all([
    supabase
      .from('employees')
      .select('employment_start, employment_end, employment_degree')
      .eq('company_id', companyId),
    previousPeriodId ? getMedelantalOverride(supabase, companyId, previousPeriodId) : null,
  ])
  if (employeesError) {
    // The note already embeds the current year's override; last year's
    // manual figure is still worth showing when only the employees read
    // failed.
    medelantalAnstallda = extractMedelantal(pdfData.noter, previousOverride)
  } else {
    const employees = (employeeRows ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>
    medelantalAnstallda = {
      current: resolveMedelantalAnstallda(
        pdfData.disclosures.medelantal_anstallda_override,
        employees,
        period.period_start,
        period.period_end,
      ),
      previous: previousPeriod
        ? resolveMedelantalAnstallda(
            previousOverride,
            employees,
            previousPeriod.start,
            previousPeriod.end,
          )
        : null,
    }
  }

  return {
    company: {
      name: pdfData.company.name,
      orgNumber: pdfData.company.org_number,
      registeredOffice: pdfData.company.registered_office,
    },
    period: { start: period.period_start, end: period.period_end },
    previousPeriod,
    isFirstFiscalYear: isFirstFiscalPeriod(
      period.period_start,
      ((allPeriods ?? []) as Array<{ period_start: string }>).map((p) => p.period_start),
    ),
    rr: mapping.rr,
    br: mapping.br,
    totals: mapping.totals,
    forvaltningsberattelse: {
      allmantOmVerksamheten: allmant,
      vasentligaHandelser: pdfData.forvaltningsberattelse.important_events,
      flerarsoversikt,
      flerarsPerioder,
      egetKapital,
      resultatdisposition,
      kontrollbalansrakningUpprattad: pdfData.forvaltningsberattelse.kontrollbalans_required === true,
    },
    // fixedAssets is spread only when the note has it, so the content hash
    // of a document without the tables does not move.
    noter: pdfData.noter.map((note) => ({
      number: note.number,
      title: note.title,
      body: note.body,
      ...(note.fixedAssets && note.fixedAssets.length > 0 ? { fixedAssets: note.fixedAssets } : {}),
      ...(note.depreciationPrinciples && note.depreciationPrinciples.length > 0
        ? { depreciationPrinciples: note.depreciationPrinciples }
        : {}),
    })),
    disclosures: {
      longTermDebtOverFiveYears:
        pdfData.disclosures.long_term_debt_over_five_years ?? 0,
      // The manual text, else what the registers in Avtal och åtaganden
      // say, else "Inga.": the same resolution as the PDF notes.
      securitiesPledged: disclosed.securities_pledged || 'Inga.',
      contingentLiabilities: disclosed.contingent_liabilities || 'Inga.',
      parentCompany: disclosed.parent_company_name
        ? [
            `Moderföretag: ${disclosed.parent_company_name}.`,
            disclosed.parent_company_org_number
              ? `Organisationsnummer: ${disclosed.parent_company_org_number}.`
              : '',
            disclosed.parent_company_city
              ? `Säte: ${disclosed.parent_company_city}.`
              : '',
          ]
            .filter(Boolean)
            .join(' ')
        : null,
      aktiekapitalNot: built.shareCapital ?? null,
    },
    medelantalAnstallda,
    underskrifter: {
      ort: pdfData.company.registered_office ?? '',
      dateringsdatum,
      signers,
      harVd,
    },
    // Only when there is a påteckning: an unaudited company's input keeps
    // the shape (and the content hash) it had before the revisor package.
    ...(revisorspateckning ? { revisorspateckning } : {}),
    // K3's own parts, through the seams to the other phases' builders
    // (k3-adapters.ts): equity specification, kassaflödesanalys, K3
    // förvaltningsberättelse items and K3 balance sheet posts.
    ...(framework === 'k3'
      ? {
          k3: {
            forvaltningsberattelse: k3ForvaltningsberattelseItems(pdfData),
            equity: k3EquityInput(pdfData, mapping.br),
            cashFlow: k3CashFlowInput(pdfData),
            balanceSheetSource: k3BalanceSheetSource(mapping),
          },
        }
      : {}),
    faststallelseintyg: {
      arsstammaDatum: agmDate ?? null,
      resultatdispositionOutcome: agmDispositionOutcome,
      resultatdispositionDecision: agmDispositionDecision,
      signerFirstName: undertecknare.firstName,
      signerLastName: undertecknare.lastName,
      signerRole: undertecknare.role,
      genereratDatum: today,
    },
    programvara: { namn: PROGRAMVARA_NAMN, version: PROGRAMVARA_VERSION },
    entryPointId: entryPoint.id,
    // Dedupe: the PDF statements come from the same K2 mapping, so its
    // warnings overlap with the ones pushed here.
    warnings: Array.from(new Set([...pdfData.warnings, ...warnings])),
  }
}

/** Pull the FTE figure out of the medelantal note body ("…uppgått till X."). */
function extractMedelantal(
  noter: Array<{ title: string; body: string }>,
  previous: number | null,
): { current: number; previous: number | null } {
  const note = noter.find((n) => /medelantal.*anst/i.test(n.title))
  if (!note) return { current: 0, previous }
  const match = note.body.match(/uppgått till\s+([\d,.]+)/i)
  if (!match) return { current: 0, previous }
  const value = Number(match[1].replace(',', '.'))
  return { current: Number.isFinite(value) ? value : 0, previous }
}
