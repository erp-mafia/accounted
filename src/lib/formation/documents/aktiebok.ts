/**
 * The aktiebok as the board opens it when all founders have signed the
 * deed: every share by number with its owner, in numerical order (ABL 5
 * kap. 5 and 8 §§). One share class. Owners' postal addresses are not in
 * the answers (the e-service fetches them from the population register),
 * so the column is left for the board to fill in.
 */

import { type FormationAnswers, quotaValue } from '../answers'
import type { FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import { rangeText, shareRanges } from './facts'
import { BLANK, companyName, companyOrgNumber, count, kr, orBlank, partyIdNumber, partyName } from './format'

export function buildAktiebok(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const name = companyName(a, ctx)
  const date = orBlank(ctx.deedDate)
  const ranges = shareRanges(a)

  return {
    slug: 'aktiebok',
    title: 'Aktiebok',
    subtitle: ctx.registration ? name : `${name} under bildande`,
    blocks: [
      {
        kind: 'fields',
        rows: [
          { label: 'Företagsnamn', value: ctx.registration ? name : `${name} (namnförslag)` },
          { label: 'Organisationsnummer', value: companyOrgNumber(ctx) },
          { label: 'Aktiekapital', value: kr(a.capital.amount) },
          { label: 'Antal aktier', value: count(a.capital.shares) },
          { label: 'Kvotvärde', value: kr(quotaValue(a)) },
          { label: 'Aktieslag', value: 'Stamaktier, en röst per aktie (ett aktieslag)' },
          { label: 'Förbehåll i bolagsordningen', value: 'Inga' },
          { label: 'Aktiebrev', value: 'Inga aktiebrev har getts ut' },
          { label: 'Aktieboken upprättad', value: date },
        ],
      },
      {
        kind: 'table',
        head: ['Aktienummer', 'Aktieägare', 'Person-/organisationsnummer', 'Postadress', 'Antal', 'Datum', 'Anteckning'],
        rows:
          ranges.length > 0
            ? ranges.map((r) => [
                rangeText(r),
                partyName(r.party),
                partyIdNumber(r.party),
                BLANK,
                count(r.count),
                date,
                'Teckning vid bildandet',
              ])
            : [[BLANK, BLANK, BLANK, BLANK, BLANK, date, 'Teckning vid bildandet']],
        widths: [1.4, 2, 2, 2.2, 0.9, 1.4, 1.8],
      },
    ],
    footer:
      'Styrelsen ser till att aktieboken förs och bevaras. Aktieboken är offentlig. Den sparas så länge bolaget finns och minst tio år efter att bolaget upplösts.',
  }
}
