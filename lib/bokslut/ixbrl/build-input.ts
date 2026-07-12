/**
 * Assemble IxbrlArsredovisningInput for a fiscal period.
 *
 * Reuses the same sources as the PDF builder (buildArsredovisningData) for
 * narrative texts, noter and flerårsöversikt, and adds what iXBRL needs on
 * top: trial balances for BOTH years mapped to risbs concepts
 * (jämförelsesiffror: kontrollera 3006/3007), per-signer dates from the
 * signature flow, and the fastställelseintyg undertecknare.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { buildArsredovisningData } from '@/lib/bokslut/arsredovisning/build-data'
import { listSignatureRequests } from '@/lib/bokslut/arsredovisning/signature-service'
import { computeMedelantalAnstallda } from '@/lib/salary/medelantal'
import { mapTrialBalancesToK2, type TrialBalancePair } from './k2-mapper'
import { resolveEntryPoint } from './taxonomy/entry-points'
import type {
  EgetKapitalForandring,
  FlerarsRow,
  IxbrlArsredovisningInput,
  IxbrlSigner,
  Resultatdisposition,
} from './types'

/** TA §4.3.4-4.3.5: "<leverantör> - <produkt>", version "<huvud>.<revision>". */
export const PROGRAMVARA_NAMN = 'Accounted - Accounted'
export const PROGRAMVARA_VERSION = '2026.1'

export interface BuildIxbrlOptions {
  /** Undertecknare of the fastställelseintyg (chosen in the wizard). When
   *  omitted, the first signed board member is used. */
  undertecknare?: { firstName: string; lastName: string; role: string }
  /** Proposed dividend in SEK (0 = balansera allt). */
  proposedDividend?: number
  /** Override "today" for deterministic tests (ISO date). */
  todayIso?: string
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

  // Two TB variants per year (see TrialBalancePair): the FULL trial balance
  // (year-end closing included → 2099 booked, class 3-8 zeroed) drives the
  // BR; the PRE-CLOSING trial balance (excludeYearEndClosing: the same split
  // lib/reports' generateIncomeStatement uses) drives the RR. A single TB can
  // never serve both: with bokslut booked every RR concept would map to 0,
  // without it the BR would not tie.
  const [pdfData, periodRow, currentTbFull, currentTbPreClosing, signatureRequests] =
    await Promise.all([
      buildArsredovisningData(supabase, companyId, fiscalPeriodId),
      supabase
        .from('fiscal_periods')
        .select('id, period_start, period_end, previous_period_id')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single(),
      generateTrialBalance(supabase, companyId, fiscalPeriodId),
      generateTrialBalance(supabase, companyId, fiscalPeriodId, { excludeYearEndClosing: true }),
      listSignatureRequests(supabase, companyId, fiscalPeriodId),
    ])

  if (periodRow.error || !periodRow.data) throw new Error('Fiscal period not found')
  const period = periodRow.data

  if (pdfData.accounting_framework !== 'k2') {
    throw new Error(
      'Digital inlämning stöds ännu inte för K3: generera PDF eller vänta på K3-stödet.',
    )
  }
  const entryPoint = resolveEntryPoint('k2')

  // Previous period: trial balances for jämförelsesiffror (same full/
  // pre-closing split as the current year).
  let previousPeriod: { start: string; end: string } | null = null
  let previousTb: TrialBalancePair | null = null
  if (period.previous_period_id) {
    const { data: prev } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('id', period.previous_period_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (prev) {
      previousPeriod = { start: prev.period_start, end: prev.period_end }
      try {
        const [prevFull, prevPreClosing] = await Promise.all([
          generateTrialBalance(supabase, companyId, prev.id),
          generateTrialBalance(supabase, companyId, prev.id, { excludeYearEndClosing: true }),
        ])
        previousTb = { full: prevFull.rows, preClosing: prevPreClosing.rows }
      } catch {
        warnings.push(
          'Jämförelsesiffror kunde inte hämtas för föregående räkenskapsår: balans- och resultaträkning visas utan jämförelseår (kontrollera-kod 3006/3007 kan utlösas).',
        )
        previousPeriod = null
      }
    }
  }

  const mapping = mapTrialBalancesToK2(
    { full: currentTbFull.rows, preClosing: currentTbPreClosing.rows },
    previousTb,
  )
  warnings.push(...mapping.warnings)

  // ---- flerårsöversikt (reuse PDF rows; whole SEK) -------------------------
  // PDF rows are oldest-first; iXBRL columns newest-first. Each row needs the
  // matching fiscal-period range so the document can declare period2/3 +
  // balans2/3 contexts explicitly.
  const { data: allPeriods } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })
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
  // or Bolagsverket rejects the filing. The PDF rows are computed from the
  // income statement (ALL class-3 revenue), while nettoomsättning per ÅRL is
  // strictly 3000-3799: so the current and previous year columns are
  // overridden with the mapper outputs. Older years have no RR facts and
  // keep the PDF values.
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
  const br = mapping.br
  const at = (concept: string): { ib: number; ub: number } => ({
    ib: br[concept]?.previous ?? 0,
    ub: br[concept]?.current ?? 0,
  })
  const aktiekapital = at('Aktiekapital')
  const balanserat = at('BalanseratResultat')
  const aretsRes = at('AretsResultatEgetKapital')
  const totalt = {
    ib: mapping.totals.egetKapital.previous ?? 0,
    ub: mapping.totals.egetKapital.current,
  }
  const ovrigaPoster = {
    ib:
      totalt.ib - aktiekapital.ib - balanserat.ib - aretsRes.ib,
    ub:
      totalt.ub - aktiekapital.ub - balanserat.ub - aretsRes.ub,
  }
  // Movement derivation: föregående års resultat balanseras; vad som därutöver
  // lämnat balanserat resultat antas vara utdelning (vanligaste fallet).
  const balanserasINyRakning = aretsRes.ib
  const balanseratResidual = balanserat.ub - (balanserat.ib + balanserasINyRakning)
  const utdelning = balanseratResidual < 0 ? -balanseratResidual : 0
  const ovrigForandringBalanserat = balanseratResidual > 0 ? balanseratResidual : 0
  const egetKapital: EgetKapitalForandring = {
    aktiekapital,
    balanseratResultat: balanserat,
    aretsResultat: aretsRes,
    totalt,
    ovrigaPoster,
    balanserasINyRakning,
    utdelning,
    forandringAktiekapital: aktiekapital.ub - aktiekapital.ib,
    ovrigForandringBalanserat,
    aretsResultatRorelse: aretsRes.ub,
  }

  // ---- resultatdisposition --------------------------------------------------
  // BalanseratResultat is tagged in BR and the eget kapital-table for the
  // same context: the disposition row must carry the identical value
  // (TA §2.7.3), so fri överkursfond (2097) is its own row tagged with the
  // separate Overkursfond concept instead of being folded into balanserat.
  const proposedDividend = Math.max(0, Math.round(options.proposedDividend ?? 0))
  const dispBalanserat = br['BalanseratResultat']?.current ?? 0
  const dispOverkursfond = br['Overkursfond']?.current ?? 0
  const dispArets = br['AretsResultatEgetKapital']?.current ?? 0
  const dispSumma = mapping.totals.frittEgetKapital.current
  if (proposedDividend > dispSumma) {
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
  // Every signature request becomes a signer row (the board must appear in
  // the document), but ONLY actually-signed requests get a date: an unsigned
  // request keeps signedDate null. Legal dates are never fabricated: the
  // missing date renders as an omitted fact in the preview and preflight 1214
  // blocks the submission path until everyone has signed.
  const signedRequests = signatureRequests.filter((request) => request.status === 'signed')
  const today = options.todayIso ?? new Date().toISOString().slice(0, 10)
  const signers: IxbrlSigner[] = signatureRequests.map((request) => {
    const { firstName, lastName } = splitName(request.signer_name)
    return {
      firstName,
      lastName,
      role: request.role || null,
      signedDate: request.signed_at ? request.signed_at.slice(0, 10) : null,
    }
  })
  if (signers.length === 0) {
    warnings.push(
      'Inga underskrifter är registrerade: årsredovisningen måste skrivas under av styrelsen (och ev. VD) innan inlämning (kontrollera-kod 1107/1201).',
    )
  }
  if (signedRequests.length !== signatureRequests.length) {
    warnings.push('Alla underskriftsförfrågningar är inte signerade ännu.')
  }
  const harVd = signers.some((signer) => /verkställande direktör|^vd$/i.test(signer.role ?? ''))
  const latestSignatureDate = signers.reduce<string | null>(
    (latest, signer) =>
      signer.signedDate !== null && (latest === null || signer.signedDate > latest)
        ? signer.signedDate
        : latest,
    null,
  )

  // ---- fastställelseintyg ----------------------------------------------------
  // A missing AGM date is NEVER replaced with today's date: it stays null,
  // the document renders a placeholder and preflight 1103 blocks filing
  // (mirrors Bolagsverket kontrollera 1103).
  const agmDate = pdfData.forvaltningsberattelse.agm_date
  if (!agmDate) {
    warnings.push(
      'Datum för årsstämma saknas: fastställelseintyget kan inte fyllas i (kontrollera-kod 1103).',
    )
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

  // ---- allmänt om verksamheten: ensure säte is mentioned ---------------------
  let allmant = pdfData.forvaltningsberattelse.description
  if (pdfData.company.city && !/säte/i.test(allmant)) {
    allmant = `${allmant}\n\nBolaget har sitt säte i ${pdfData.company.city}.`
  }

  // ---- medelantal anställda ---------------------------------------------------
  // Compute BOTH years with the real FTE helper (the same one the PDF note
  // uses) over the employees table. The note-prose regex stays only as a
  // last-resort fallback when the employees query fails.
  let medelantalAnstallda: { current: number; previous: number | null }
  const { data: employeeRows, error: employeesError } = await supabase
    .from('employees')
    .select('employment_start, employment_end, employment_degree')
    .eq('company_id', companyId)
  if (employeesError) {
    medelantalAnstallda = extractMedelantal(pdfData.noter, null)
  } else {
    const employees = (employeeRows ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>
    medelantalAnstallda = {
      current: computeMedelantalAnstallda(employees, period.period_start, period.period_end),
      previous: previousPeriod
        ? computeMedelantalAnstallda(employees, previousPeriod.start, previousPeriod.end)
        : null,
    }
  }

  return {
    company: {
      name: pdfData.company.name,
      orgNumber: pdfData.company.org_number,
      city: pdfData.company.city,
    },
    period: { start: period.period_start, end: period.period_end },
    previousPeriod,
    isFirstFiscalYear: previousPeriod === null,
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
    },
    noter: pdfData.noter.map((note) => ({ number: note.number, title: note.title, body: note.body })),
    medelantalAnstallda,
    underskrifter: {
      ort: pdfData.company.city ?? '',
      dateringsdatum: latestSignatureDate,
      signers,
      harVd,
    },
    faststallelseintyg: {
      arsstammaDatum: agmDate ?? null,
      signerFirstName: undertecknare.firstName,
      signerLastName: undertecknare.lastName,
      signerRole: undertecknare.role,
      genereratDatum: today,
    },
    programvara: { namn: PROGRAMVARA_NAMN, version: PROGRAMVARA_VERSION },
    entryPointId: entryPoint.id,
    // Dedupe: buildArsredovisningData now runs the same K2 mapping for the
    // PDF statements, so its warnings overlap with the ones produced here.
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
