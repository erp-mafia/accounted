/**
 * The founder's checklist for the bank: open an account for the company
 * "under bildande", deposit the share capital, have the bank issue the
 * electronic bankintyg into the verksamt.se case.
 *
 * Bank facts come from each bank's own pages (2026-11-19): SEB, Swedbank,
 * Nordea, Lunar and Svea. Handelsbanken, Danske Bank and other banks get
 * the generic list only. Only banks connected to Bolagsverket's
 * bankintygstjänst can issue the certificate electronically; no public
 * list of them exists. The bankintyg states whether any withdrawal has
 * been made from the account.
 */

import type { BankId, FormationAnswers } from '../answers'
import { boardMembers, deputies } from '../answers'
import { beneficialOwners } from '../rules'
import type { DocBlock, FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import { BANK_LABEL } from './facts'
import { BLANK, businessSentence, companyName, joinNames, kr, partyName } from './format'

/** What the report found about each bank's formation flow. */
export const BANK_NOTES: Partial<Record<BankId, string[]>> = {
  seb: [
    'SEB tar ut en startavgift på 2 500 kr.',
    'Kontot tar 1 till 2 veckor och hela processen 4 till 6 veckor.',
    'Banken håller ett digitalt kundmöte och kreditprövar styrelsen, firmatecknarna och ägarna.',
    'Bankintyget kommer ungefär två bankdagar efter insättningen.',
    'Skriv företagsnamnet exakt likadant i SEB:s ansökan och på verksamt.se.',
  ],
  swedbank: [
    'Swedbank tar ut 2 500 kr.',
    'Banken skriver att det tar ungefär 4 till 6 veckor innan ni hör av den.',
    'Alla firmatecknare besöker ett bankkontor.',
  ],
  nordea: [
    'Fyll i verksamt.se fram till steget Bankintyg först.',
    'Bifoga dokumenten från e-tjänsten i Nordeas digitala ansökan.',
    'Bankintyget kostar 625 kr.',
  ],
  lunar: [
    'Lunar använder adressen business@lunar.app för bankintyget. Skriv den i steg 12.',
    'Lunar kontrollerar ett uppladdat kvitto på överföringen.',
    'Bankintyget kostar 495 kr. Det finns ingen fast handläggningstid.',
  ],
  svea: [
    'Svea Banks kundkontroll tar ungefär 3 arbetsdagar.',
    'Bankintyget kan komma samma dag som insättningen.',
  ],
}

export function buildBankChecklist(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const name = companyName(a, ctx)
  const bank = a.bank ? BANK_LABEL[a.bank] : null
  const notes = a.bank ? BANK_NOTES[a.bank] : undefined
  const owners = beneficialOwners(a)
  const board = [...boardMembers(a), ...deputies(a)]

  const blocks: DocBlock[] = [
    { kind: 'heading', text: 'Det här gör ni' },
    {
      kind: 'list',
      ordered: true,
      items: [
        `Öppna ett konto för ${name} under bildande.`,
        `Sätt in aktiekapitalet, ${kr(a.capital.amount)}, på kontot.`,
        'Be banken utfärda ett elektroniskt bankintyg till ärendet på verksamt.se. Bara banker som är anslutna till Bolagsverkets bankintygstjänst kan göra det, så fråga först.',
        'Be om e-postadressen till er kontaktperson på banken. Den skriver ni in i steg 12, Bankintyg, i e-tjänsten.',
        'Ta inte ut pengar från kontot innan bolaget är registrerat. Bankintyget visar om något uttag har gjorts.',
        'Fråga banken vad det kostar och hur lång tid det tar.',
      ],
    },

    { kind: 'heading', text: 'Ha det här redo' },
    {
      kind: 'list',
      items: [
        'Legitimation för var och en av er.',
        'Namn och personnummer för styrelsen och firmatecknarna.',
        'Vilka som är verkliga huvudmän.',
        'Vad bolaget ska göra och hur mycket ni räknar med att sälja för.',
        'Varifrån pengarna till aktiekapitalet kommer.',
      ],
    },
    {
      kind: 'fields',
      rows: [
        { label: 'Företagsnamn', value: `${name} under bildande` },
        { label: 'Aktiekapital', value: kr(a.capital.amount) },
        { label: 'Styrelseledamöter och suppleanter', value: board.length > 0 ? joinNames(board.map(partyName)) : BLANK },
        {
          label: 'Verkliga huvudmän',
          value: owners.length > 0 ? joinNames(owners.map((o) => o.name)) : 'Ingen person äger eller kontrollerar mer än 25 procent',
        },
        { label: 'Verksamhet', value: businessSentence(a) },
        { label: 'Beräknad omsättning per år', value: a.tax.expectedTurnover === null ? BLANK : kr(a.tax.expectedTurnover) },
      ],
    },
  ]

  if (bank && notes) {
    blocks.push({ kind: 'heading', text: `Om ${bank}` }, { kind: 'list', items: notes })
  }

  return {
    slug: 'bank',
    title: 'Checklista för banken',
    subtitle: bank && a.bank !== 'other' ? `${name}, ${bank}` : name,
    blocks,
  }
}
