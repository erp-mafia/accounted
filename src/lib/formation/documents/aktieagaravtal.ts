/**
 * A plain, balanced shareholders' agreement template between the founders.
 * It is a contract, not a statutory document: every choice the founders
 * have to make stays a visible blank line, and the document states no
 * legal facts. The footer tells them to have a lawyer read it.
 */

import { type FormationAnswers, boardMembers, deputies, founders } from '../answers'
import type { DocBlock, FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import { ownershipPercent } from './facts'
import {
  BLANK,
  businessSentence,
  companyName,
  companyNameWithStatus,
  companyOrgNumber,
  count,
  joinNames,
  orBlank,
  partyIdNumber,
  partyName,
  percentText,
} from './format'
import { signatoryRuleText } from './signatory'

export const AKTIEAGARAVTAL_FOOTER = 'Mall från Accounted. Låt en jurist läsa igenom avtalet innan ni skriver under.'

/** Each party signs; a founding company signs through its signatories. */
function partySignatures(a: FormationAnswers): Array<{ name: string; caption?: string }> {
  return founders(a).flatMap((f) => {
    if (f.type === 'person') return [{ name: partyName(f), caption: 'Part' }]
    const names = f.signatories.map((s) => s.trim()).filter(Boolean)
    const caption = `För ${partyName(f)}`
    return names.length > 0 ? names.map((n) => ({ name: n, caption })) : [{ name: BLANK, caption }]
  })
}

export function buildAktieagaravtal(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const name = companyName(a, ctx)
  const fs = founders(a)
  const members = boardMembers(a)
  const deps = deputies(a)
  const say = (text: string): DocBlock => ({ kind: 'paragraph', text })
  const signatures = partySignatures(a)

  const blocks: DocBlock[] = [
    { kind: 'heading', text: '1. Parter' },
    say('Det här avtalet gäller mellan följande aktieägare, var för sig kallade part och tillsammans parterna:'),
    {
      kind: 'table',
      head: ['Part', 'Person-/organisationsnummer', 'Adress'],
      rows: fs.length > 0 ? fs.map((f) => [partyName(f), partyIdNumber(f), BLANK]) : [[BLANK, BLANK, BLANK]],
      widths: [3, 2, 4],
    },
    {
      kind: 'fields',
      rows: [
        { label: 'Bolaget', value: companyNameWithStatus(a, ctx) },
        { label: 'Organisationsnummer', value: companyOrgNumber(ctx) },
      ],
    },

    { kind: 'heading', text: '2. Bakgrund och syfte' },
    say(`Parterna äger tillsammans alla aktier i ${name}. ${businessSentence(a)}`),
    say(
      'Syftet med avtalet är att bestämma hur parterna äger och styr bolaget tillsammans. Parterna ska rösta på bolagsstämman och agera i styrelsen så att avtalet följs.',
    ),

    { kind: 'heading', text: '3. Ägande' },
    {
      kind: 'table',
      head: ['Part', 'Antal aktier', 'Andel'],
      rows: fs.map((f) => [partyName(f), count(f.shares), percentText(ownershipPercent(a, f))]),
      widths: [4, 2, 2],
    },

    { kind: 'heading', text: '4. Styrelse och firmateckning' },
    say(
      `Styrelsen består vid start av ${joinNames(members.map(partyName))}${deps.length > 0 ? `, med ${joinNames(deps.map(partyName))} som suppleant` : ''}.`,
    ),
    say(`Varje part som äger minst ${BLANK} procent av aktierna har rätt att föreslå en styrelseledamot. De andra parterna ska rösta för den som föreslås.`),
    say(`Firmateckning: ${signatoryRuleText(a.signatoryRule)}`),

    { kind: 'heading', text: '5. Beslut som kräver enighet' },
    say('Följande beslut kräver att alla parter är överens, på bolagsstämman eller i styrelsen:'),
    {
      kind: 'list',
      items: [
        'ändring av bolagsordningen',
        'nyemission, ökning eller minskning av aktiekapitalet',
        'utdelning och andra värdeöverföringar till aktieägarna',
        'försäljning av bolagets verksamhet eller en väsentlig del av den',
        `lån, borgen eller pant över ${BLANK} kr`,
        'avtal mellan bolaget och en part, eller någon som står en part nära',
        'tillsättning eller entledigande av verkställande direktör',
        'köp eller start av andra bolag',
        'likvidation, fusion eller delning av bolaget',
      ],
    },

    { kind: 'heading', text: '6. Överlåtelse av aktier' },
    say(
      `En part som vill sälja aktier ska först skriftligt erbjuda de andra parterna att köpa dem (förköp). De andra parterna har ${BLANK} dagar på sig att svara. Vill flera köpa delas aktierna i förhållande till deras innehav.`,
    ),
    say(
      `Priset är marknadsvärdet. Kommer parterna inte överens om priset inom ${BLANK} dagar bestäms det av en oberoende värderare som parterna utser tillsammans. Kostnaden för värderingen delas lika mellan säljaren och köparna.`,
    ),
    say(
      `Köper de andra parterna inte alla aktier får säljaren sälja dem till någon annan inom ${BLANK} månader, till ett pris och på villkor som inte är bättre för köparen än i erbjudandet. Den som köper ska först gå in i det här avtalet.`,
    ),
    say(
      'Går aktier över till någon annan på annat sätt än genom försäljning, till exempel genom gåva, arv eller bodelning, ska den nya ägaren erbjuda de andra parterna att köpa aktierna enligt samma regler (hembud).',
    ),

    { kind: 'heading', text: '7. Om en part slutar arbeta i bolaget' },
    say(
      `Om en part som arbetar i bolaget slutar har de andra parterna rätt att köpa den partens aktier. Rätten ska användas inom ${BLANK} dagar från att parten slutade.`,
    ),
    say(
      `Slutar parten efter minst ${BLANK} månader, eller på grund av sjukdom eller dödsfall, är priset marknadsvärdet (good leaver).`,
    ),
    say(
      `Slutar parten på egen begäran inom ${BLANK} månader, eller för att parten allvarligt har brutit mot det här avtalet eller sitt anställningsavtal, är priset det lägsta av marknadsvärdet och ${BLANK} (bad leaver).`,
    ),

    { kind: 'heading', text: '8. Konkurrens och sekretess' },
    say(
      `Så länge en part äger aktier i bolaget, och ${BLANK} månader efter det, får parten inte driva eller arbeta i en verksamhet som konkurrerar med bolaget utan de andra parternas skriftliga samtycke.`,
    ),
    say('Parterna ska hålla bolagets affärshemligheter och innehållet i det här avtalet hemliga, även efter att avtalet har upphört att gälla för dem.'),

    { kind: 'heading', text: '9. Oenighet' },
    say(
      `Kan parterna inte enas i en fråga som kräver enighet, eller kan styrelsen inte fatta ett beslut som bolaget behöver (dödläge), ska parterna först förhandla i god tro under ${BLANK} dagar.`,
    ),
    say('Löser förhandlingen inte frågan ska parterna försöka lösa den genom medling, med en medlare som de utser tillsammans. Kostnaden för medlingen delas lika.'),

    { kind: 'heading', text: '10. Avtalets giltighet' },
    say(
      'Avtalet gäller från att alla parter har skrivit under och så länge en part äger aktier i bolaget. För en part som inte längre äger aktier upphör avtalet, utom punkt 8 om konkurrens och sekretess.',
    ),

    { kind: 'heading', text: '11. Ändringar' },
    say('Ändringar och tillägg till avtalet ska vara skriftliga och undertecknade av alla parter.'),

    { kind: 'heading', text: '12. Tvist' },
    say(`Tvister om avtalet avgörs av allmän domstol, med ${BLANK} tingsrätt som första instans. Svensk lag gäller för avtalet.`),

    { kind: 'heading', text: '13. Underskrifter' },
    say(`Avtalet har upprättats i ${BLANK} likalydande exemplar, ett för varje part.`),
    {
      kind: 'fields',
      rows: [
        { label: 'Ort', value: BLANK },
        { label: 'Datum', value: BLANK },
      ],
    },
    { kind: 'signatures', people: signatures.length > 0 ? signatures : [{ name: BLANK, caption: 'Part' }] },
  ]

  return {
    slug: 'aktieagaravtal',
    title: 'Aktieägaravtal',
    subtitle: `${orBlank(name)}, ${ctx.today}`,
    blocks,
    footer: AKTIEAGARAVTAL_FOOTER,
  }
}
