/**
 * bolaget.md: the founder's planned company as plain markdown, for their
 * own AI assistant next to the accounted-start-company skill. Personnummer
 * show only their last four digits: the file leaves Accounted, and the
 * skill tells the assistant never to type another person's number anyway.
 */

import {
  type FormationAnswers,
  type FormationParty,
  boardMembers,
  deputies,
  founders,
  persons,
  quotaValue,
} from '../answers'
import { beneficialOwners } from '../rules'
import type { DocumentContext } from './context'
import {
  BANK_LABEL,
  BENEFICIAL_OWNER_FEE,
  REGISTRATION_FEE,
  boardLimits,
  capitalLimits,
  firstFiscalYear,
  firstFiscalYearShort,
  fiscalYearShort,
  ownershipPercent,
  roleLabels,
} from './facts'
import {
  BLANK,
  businessSentence,
  companyName,
  count,
  displayOrgNumber,
  kr,
  maskedPersonnummer,
  nameProposals,
  orBlank,
  partyName,
  percentText,
} from './format'
import { signatoryRuleText } from './signatory'
import { vatAnswer } from './skatteverket'

/** Keeps a value from breaking a markdown table row: backslashes first, then pipes, then line breaks. */
export function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function idOf(p: FormationParty): string {
  return p.type === 'person' ? maskedPersonnummer(p.personnummer) : displayOrgNumber(p.orgNumber)
}

const OWNER_SALARY: Record<FormationAnswers['tax']['ownerSalary'], string> = {
  now: 'ägaren tar ut lön från start, registrera som arbetsgivare nu',
  later: 'lön senare, registrera som arbetsgivare innan första lönen',
  no: 'ingen lön planerad',
}

const VAT_PERIOD: Record<FormationAnswers['tax']['vatPeriod'], string> = {
  month: 'månad',
  quarter: 'kvartal',
  year: 'helår',
}

export function buildBolagetMarkdown(a: FormationAnswers, ctx: DocumentContext): string {
  const name = companyName(a, ctx)
  const proposals = nameProposals(a)
  const fs = founders(a)
  const members = boardMembers(a)
  const deps = deputies(a)
  const limits = boardLimits(a)
  const capital = capitalLimits(a)
  const owners = beneficialOwners(a)
  const involved = persons(a).filter((p) => p.shares > 0 || p.roles.length > 0)
  const registered = ctx.registration ?? null
  const first = registered ? firstFiscalYear(a, registered.date) : null
  const vat = vatAnswer(a)
  const lines: string[] = []
  const push = (...l: string[]) => lines.push(...l)

  push(
    '# bolaget.md',
    '',
    `Uppgifter om aktiebolaget ${name}, sparade från Accounted ${ctx.today}. Personnummer visas bara med de fyra sista siffrorna.`,
    '',
    '## Företaget',
    '',
  )
  if (registered) {
    push(`- Registrerat: ${registered.date}, organisationsnummer ${displayOrgNumber(registered.orgNumber)}, namn ${registered.name}`)
  } else {
    push('- Status: under bildande, inte registrerat än')
  }
  push(
    `- Namnförslag i turordning: ${proposals.length > 0 ? proposals.map((n, i) => `${i + 1}. ${n}`).join(', ') : BLANK}`,
    `- Verksamhet: ${businessSentence(a)}`,
    `- Säte (kommun): ${orBlank(a.seat)}`,
    `- Postadress: ${[a.address.co && `c/o ${a.address.co}`, a.address.street, `${a.address.postalCode} ${a.address.city}`.trim()].filter((s) => s && s.trim()).join(', ') || BLANK}`,
    `- Företagets e-post: ${orBlank(a.companyEmail)}`,
    `- Kontaktperson i ärendet: ${orBlank(a.contact.name)}, ${orBlank(a.contact.email)}, ${orBlank(a.contact.phone)}`,
    '',
    '## Aktier och ägare',
    '',
    `- Aktiekapital: ${kr(a.capital.amount)}, betalas i pengar`,
    `- Antal aktier: ${count(a.capital.shares)}, kvotvärde ${kr(quotaValue(a))} per aktie, ett aktieslag`,
    `- Bolagsordningens gränser: aktiekapital ${kr(capital.capitalMin)} till ${kr(capital.capitalMax)}, aktier ${count(capital.sharesMin)} till ${count(capital.sharesMax)}`,
    '',
    '| Stiftare | Person-/organisationsnummer | Aktier | Andel |',
    '|---|---|---|---|',
    ...(fs.length > 0
      ? fs.map((f) => `| ${cell(partyName(f))} | ${idOf(f)} | ${count(f.shares)} | ${percentText(ownershipPercent(a, f))} |`)
      : [`| ${BLANK} | ${BLANK} | ${BLANK} | ${BLANK} |`]),
    '',
  )
  for (const f of fs) {
    if (f.type !== 'company') continue
    const sig = f.signatories.map((s) => s.trim()).filter(Boolean)
    push(`- ${partyName(f)} skriver under genom: ${sig.length > 0 ? sig.join(', ') : BLANK}`)
  }

  push(
    '',
    '## Styrelse och roller',
    '',
    `- Styrelseledamöter: ${members.length > 0 ? members.map(partyName).join(', ') : BLANK}`,
    `- Styrelsesuppleanter: ${deps.length > 0 ? deps.map(partyName).join(', ') : 'inga'}`,
    `- Bolagsordningens gränser: ${limits.membersMin} till ${limits.membersMax} ledamöter, ${limits.deputiesMin} till ${limits.deputiesMax} suppleanter`,
    '',
    '| Person | Personnummer | Roller |',
    '|---|---|---|',
    ...(involved.length > 0
      ? involved.map((p) => `| ${cell(partyName(p))} | ${maskedPersonnummer(p.personnummer)} | ${roleLabels(p).join(', ')} |`)
      : [`| ${BLANK} | ${BLANK} | ${BLANK} |`]),
    '',
    `- Firmateckning: ${signatoryRuleText(a.signatoryRule)}`,
    `- Revisor: ${a.auditor.has ? orBlank(a.auditor.name) : 'ingen, bolagsordningen säger att bolaget inte ska ha revisor'}`,
    `- Kallelse till bolagsstämma: ${a.noticeByEmail ? 'e-post eller brev med posten' : 'brev med posten'}`,
    `- Räkenskapsår: ${fiscalYearShort(a.fiscalYearStartMonth)}`,
    `- Första räkenskapsåret: ${first ? `${first.from} till ${first.to}` : firstFiscalYearShort(a).toLowerCase()}`,
    '',
    '## Verkliga huvudmän',
    '',
    ...(owners.length > 0
      ? owners.map(
          (o) =>
            `- ${o.name}: ${percentText(o.percent)} av rösterna, ${o.via === 'direct' ? 'genom egna aktier' : `genom ${orBlank(o.throughCompany)}`}`,
        )
      : ['- Ingen person äger eller kontrollerar mer än 25 procent']),
    '',
    '## Bank',
    '',
    `- Bank: ${a.bank ? BANK_LABEL[a.bank] : 'inte vald'}`,
    `- Kontot öppnas för ${name} under bildande, och ${kr(a.capital.amount)} sätts in`,
    '',
    '## Skatteverket',
    '',
    '- F-skatt: ja',
    `- Beräknad omsättning per år: ${a.tax.expectedTurnover === null ? 'inte angiven' : kr(a.tax.expectedTurnover)}`,
    `- Moms: ${vat === 'register' ? 'registrera' : vat === 'not_required' ? 'inte nödvändigt under 120 000 kr per kalenderår, frivilligt går' : 'inte bestämt'}, momsperiod ${VAT_PERIOD[a.tax.vatPeriod]}`,
    `- Arbetsgivare: ${OWNER_SALARY[a.tax.ownerSalary]}`,
    `- Beräknat överskott första året: ${a.tax.expectedProfit === null ? 'inte angivet' : kr(a.tax.expectedProfit)}`,
    '- SNI-kod: väljs i Skatteverkets e-tjänst utifrån verksamheten',
    '',
    '## Nästa steg',
    '',
  )

  const steps = registered
    ? [
        'Registrera bolaget hos Skatteverket i e-tjänsten "F-skatt, moms, arbetsgivare och SNI-koder" på verksamt.se. Bara en firmatecknare som är registrerad hos Bolagsverket kan göra det. Gratis, upp till sex veckor.',
        'Banken flyttar aktiekapitalet till bolagets konto när bolaget är registrerat.',
        `Bokföringen börjar den dag bolaget registrerades, ${registered.date}.`,
        'Spara stiftelseurkunden, bolagsordningen, styrelseprotokollet och aktieboken tillsammans.',
      ]
    : [
        `Kontakta banken först: öppna ett konto för ${name} under bildande, sätt in ${kr(a.capital.amount)} och be om ett elektroniskt bankintyg och kontaktpersonens e-postadress.`,
        'Fyll i "Registrera aktiebolag med pengar" på verksamt.se, steg 1 till 13. Utkastet sparas vid varje Nästa.',
        `Alla stiftare skriver under stiftelseurkunden med e-legitimation. Betala ${kr(REGISTRATION_FEE)} för registreringen och ${kr(BENEFICIAL_OWNER_FEE)} för anmälan av verklig huvudman. Ansökan måste komma in inom sex månader från underskriften.`,
        'Styrelsen upprättar aktieboken samma dag som alla stiftare har skrivit under.',
        'Vänta på Bolagsverket, ungefär 8 arbetsdagar från att ansökan och betalningen kommit in.',
        'Registrera bolaget hos Skatteverket när organisationsnumret har kommit: F-skatt, moms och arbetsgivare.',
        'Bokföringen börjar den dag Bolagsverket registrerar bolaget.',
      ]
  steps.forEach((s, i) => push(`${i + 1}. ${s}`))
  push('')
  return lines.join('\n')
}
