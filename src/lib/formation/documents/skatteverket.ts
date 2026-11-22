/**
 * What to answer in Skatteverket's Företagsregistrering (SKV 4620, the
 * e-service "F-skatt, moms, arbetsgivare och SNI-koder" on verksamt.se)
 * once Bolagsverket has registered the company.
 *
 * Sources (Skatteverket's pages, checked 2026-11-19): registration is free and takes up to six weeks; only a signatory
 * registered at Bolagsverket can use the e-service for the company;
 * without F-skatt, customers buying services withhold tax; VAT
 * registration is required above 120,000 kr turnover in a calendar year
 * (since 2025-01-01), and regardless of turnover in some EU and
 * reverse-charge cases; VAT periods: a full year up to 1 MSEK, quarterly
 * up to 40 MSEK, monthly above; an owner who takes salary makes the AB an
 * employer, registered before the first payment; the preliminary income
 * declaration sets the monthly preliminary tax, and new businesses may ask
 * at registration to defer the first three months; the fiscal year passes
 * from Bolagsverket automatically; Skatteverket does not choose SNI codes.
 */

import type { FormationAnswers } from '../answers'
import type { DocBlock, FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import { firstFiscalYear, firstFiscalYearSentence, fiscalYearShort } from './facts'
import { BLANK, businessSentence, companyName, companyOrgNumber, kr } from './format'

export const VAT_THRESHOLD = 120_000
const VAT_YEAR_MAX = 1_000_000
const VAT_QUARTER_MAX = 40_000_000

const VAT_PERIOD_LABEL: Record<FormationAnswers['tax']['vatPeriod'], string> = {
  month: 'Månad',
  quarter: 'Kvartal',
  year: 'Helår',
}

export type VatAnswer = 'register' | 'not_required' | 'unknown'

export function vatAnswer(a: FormationAnswers): VatAnswer {
  const turnover = a.tax.expectedTurnover
  if (turnover === null) return 'unknown'
  return turnover > VAT_THRESHOLD ? 'register' : 'not_required'
}

function vatPeriodNote(a: FormationAnswers): string | null {
  const turnover = a.tax.expectedTurnover
  if (turnover === null) return null
  if (turnover > VAT_QUARTER_MAX && a.tax.vatPeriod !== 'month')
    return 'Med en omsättning över 40 miljoner kr redovisas moms varje månad.'
  if (turnover > VAT_YEAR_MAX && a.tax.vatPeriod === 'year')
    return 'Helår går bara med en omsättning upp till 1 miljon kr. Välj kvartal eller månad.'
  return null
}

const EMPLOYER: Record<FormationAnswers['tax']['ownerSalary'], string> = {
  now: 'Ja, registrera nu',
  later: 'Ja, registrera innan den första lönen betalas ut',
  no: 'Inte nu',
}

export function buildSkatteverket(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const vat = vatAnswer(a)
  const periodNote = vatPeriodNote(a)
  const first = ctx.registration ? firstFiscalYear(a, ctx.registration.date) : null
  const profit = a.tax.expectedProfit

  const vatValue =
    vat === 'register'
      ? 'Ja'
      : vat === 'not_required'
        ? 'Inte nödvändigt nu. Ni kan registrera er frivilligt.'
        : BLANK

  const blocks: DocBlock[] = [
    {
      kind: 'paragraph',
      text: 'Registreringen är gratis och tar upp till sex veckor. Bara den som är registrerad som firmatecknare hos Bolagsverket kan använda e-tjänsten för bolaget.',
      muted: true,
    },
    {
      kind: 'paragraph',
      text: 'Gör det här när bolaget har fått sitt organisationsnummer. Använd e-tjänsten "F-skatt, moms, arbetsgivare och SNI-koder" på verksamt.se (Företagsregistrering, SKV 4620). Registrera bolaget innan verksamheten börjar.',
    },
    {
      kind: 'fields',
      rows: [
        { label: 'Bolag', value: companyName(a, ctx) },
        { label: 'Organisationsnummer', value: ctx.registration ? companyOrgNumber(ctx) : BLANK },
      ],
    },

    { kind: 'heading', text: 'F-skatt' },
    { kind: 'fields', rows: [{ label: 'Ansök om F-skatt', value: 'Ja' }] },
    { kind: 'paragraph', text: 'Med F-skatt drar kunder som köper tjänster av bolaget inte skatt från betalningen.' },

    { kind: 'heading', text: 'Moms' },
    {
      kind: 'fields',
      rows: [
        { label: 'Beräknad omsättning per år', value: a.tax.expectedTurnover === null ? BLANK : kr(a.tax.expectedTurnover) },
        { label: 'Registrera för moms', value: vatValue },
        {
          label: vat === 'not_required' ? 'Momsperiod, om ni registrerar er' : 'Momsperiod',
          value: VAT_PERIOD_LABEL[a.tax.vatPeriod],
        },
      ],
    },
    {
      kind: 'paragraph',
      text: `Bolaget måste momsregistreras när omsättningen blir högre än ${kr(VAT_THRESHOLD)} under ett kalenderår. Vid vissa köp och försäljningar inom EU och vid omvänd skattskyldighet krävs registrering tidigare, oavsett omsättning.`,
    },
    ...(periodNote ? ([{ kind: 'paragraph', text: periodNote, bold: true }] as DocBlock[]) : []),

    { kind: 'heading', text: 'Arbetsgivare' },
    { kind: 'fields', rows: [{ label: 'Registrera som arbetsgivare', value: EMPLOYER[a.tax.ownerSalary] }] },
    {
      kind: 'paragraph',
      text: 'En ägare som tar ut lön räknas som anställd. Då ska bolaget vara registrerat som arbetsgivare innan den första lönen betalas ut.',
    },

    { kind: 'heading', text: 'Preliminär inkomstdeklaration' },
    {
      kind: 'fields',
      rows: [
        { label: 'Beräknat överskott första räkenskapsåret', value: profit === null ? BLANK : kr(profit) },
        { label: 'Uppskov med preliminärskatten de tre första månaderna', value: 'Välj själva' },
      ],
    },
    {
      kind: 'paragraph',
      text: 'Skatteverket räknar ut den preliminära skatt som bolaget betalar varje månad från det beräknade överskottet. Nya företag kan be om uppskov de tre första månaderna, men bara i samband med registreringen.',
    },

    { kind: 'heading', text: 'Räkenskapsår' },
    {
      kind: 'fields',
      rows: [
        { label: 'Räkenskapsår', value: fiscalYearShort(a.fiscalYearStartMonth) },
        { label: 'Första räkenskapsåret', value: first ? `${first.from} till ${first.to}` : BLANK },
      ],
    },
    {
      kind: 'paragraph',
      text: first
        ? 'Räkenskapsåret följer med automatiskt från Bolagsverket.'
        : `Räkenskapsåret följer med automatiskt från Bolagsverket. ${firstFiscalYearSentence(a)}`,
    },
    ...(first?.extensionRefused
      ? ([
          {
            kind: 'paragraph',
            text: 'Det första räkenskapsåret kan inte förlängas: det skulle bli längre än 18 månader.',
            bold: true,
          },
        ] as DocBlock[])
      : []),

    { kind: 'heading', text: 'SNI-kod' },
    {
      kind: 'fields',
      rows: [
        { label: 'Verksamhet', value: businessSentence(a) },
        { label: 'SNI-kod', value: 'Välj i e-tjänsten utifrån verksamheten' },
      ],
    },
    {
      kind: 'paragraph',
      text: 'Skatteverket väljer inte kod åt er. Sök fram koden i SCB:s SNI-sök (snisok.scb.se) utifrån verksamheten ovan. Ni kan ange flera koder.',
    },
  ]

  return {
    slug: 'skatteverket',
    title: 'Företagsregistrering hos Skatteverket',
    subtitle: `${companyName(a, ctx)}, ${ctx.today}`,
    blocks,
  }
}
