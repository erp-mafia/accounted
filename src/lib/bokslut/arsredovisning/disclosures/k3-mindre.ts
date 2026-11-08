/**
 * The K3 (BFNAR 2012:1, consolidated 2025-12-15) disclosure requirements of
 * a mindre aktiebolag: förvaltningsberättelse, redovisningsprinciper and
 * notes. Each entry cites its source; the review package
 * (docs/review/k3-arsredovisning-mindre-ab.md) lists them with how Accounted
 * meets each one and the K3 points judged not applicable.
 *
 * Entries that apply to större företag too carry both sizes; the större-only
 * entries (ÅRL 5 kap. 25-48 §§, K3 3.12-3.13, 8.4-8.5, 2.2, ...) are P4's
 * list, added in index.ts with `sizes: ['larger']`.
 */
import type { ContractRevenueMethod } from '@/lib/bokslut/pagaende-arbeten/calculator'
import { CONTRACT_REVENUE_METHOD_NAMES, contractRevenueMethodInText } from '@/lib/bokslut/pagaende-arbeten/methods'
import type { DisclosureContext, DisclosureRequirement } from './types'

const K3 = ['k3'] as const
const ALL_SIZES = ['smaller', 'larger'] as const

const text = (answer: { text?: string | null }) => answer.text?.trim() || null
const has = (ctx: DisclosureContext, kind: string) => ctx.facts.equityKinds.includes(kind as never)

export const K3_MINDRE_REQUIREMENTS: readonly DisclosureRequirement[] = [
  // ── Förvaltningsberättelse ─────────────────────────────────────────────
  {
    id: 'fb.verksamhet',
    code: 'AR-MANAGEMENT-DESCRIPTION',
    title: 'Verksamheten',
    sources: ['ÅRL 6 kap. 1 § första stycket', 'K3 3.7 a'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    existing: 'Verksamhetsbeskrivning (description)',
    applicability: () => 'applies',
    missingMessage: 'Verksamhetsbeskrivning saknas.',
  },
  {
    id: 'fb.vasentliga_handelser',
    code: 'AR-MANAGEMENT-EVENTS',
    title: 'Väsentliga händelser under räkenskapsåret',
    sources: ['ÅRL 6 kap. 1 § andra stycket 1-2', 'K3 3.7 b'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    existing: 'Väsentliga händelser (important_events)',
    applicability: () => 'applies',
    missingMessage: 'Uppgift om väsentliga händelser saknas.',
  },
  {
    id: 'fb.externa_faktorer',
    code: 'AR-K3-FB-EXTERNAL-FACTORS',
    title: 'Viktiga externa faktorer',
    concept: 'ViktigaExternaFaktorerPaverkatForetagetStallningResultat',
    sources: ['ÅRL 6 kap. 1 § andra stycket 1', 'K3 3.7 c'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    question:
      'Har viktiga externa faktorer, till exempel marknaden, råvaruförsörjningen, räntor eller valutakurser, påverkat företagets ställning och resultat under året?',
    textLabel: 'Beskriv faktorerna och hur de har påverkat företaget.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om viktiga externa faktorer har påverkat företagets ställning och resultat (K3 3.7 c).',
  },
  {
    id: 'fb.speciella_omstandigheter',
    code: 'AR-K3-FB-SPECIAL-CIRCUMSTANCES',
    title: 'Speciella omständigheter',
    concept: 'SpeciellaOmstandigheterBerorForetaget',
    sources: ['ÅRL 6 kap. 1 § andra stycket 1', 'K3 3.7 d'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    question:
      'Finns det speciella omständigheter som i särskild grad berör företaget, till exempel leasing av anläggningstillgångar, offentliga bidrag, fordringar och skulder i utländsk valuta eller rättelse av fel?',
    textLabel: 'Beskriv omständigheterna.',
    applicability: (ctx) => (has(ctx, 'rattelse_av_fel') ? 'applies' : 'ask'),
    hint: (ctx) =>
      has(ctx, 'rattelse_av_fel')
        ? 'Eget kapital har rättats för ett fel under året: det ska nämnas här (K3 3.7 kommentar).'
        : null,
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om speciella omständigheter i särskild grad berör företaget (K3 3.7 d).',
  },
  {
    id: 'fb.agare',
    code: 'AR-K3-FB-MAJOR-OWNERS',
    title: 'Ägarförhållanden',
    concept: 'UppgiftAgareMerAnTioProcentAndelarRoster',
    sources: ['K3 3.7 e'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    question: 'Finns det ägare som har mer än tio procent av antalet andelar eller rösterna i företaget?',
    textLabel: 'Ange ägarna och deras andel av kapital och röster.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om någon ägare har mer än tio procent av andelarna eller rösterna (K3 3.7 e).',
  },
  {
    id: 'fb.agarstruktur',
    code: 'AR-K3-FB-OWNERSHIP-CHANGES',
    title: 'Förändringar i ägarstrukturen',
    concept: 'VasentligaAndringarAgarstrukturen',
    sources: ['K3 3.7 g'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    question: 'Har det skett väsentliga förändringar i ägarstrukturen under året?',
    textLabel: 'Beskriv förändringarna.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om ägarstrukturen har förändrats väsentligt (K3 3.7 g).',
  },
  {
    id: 'fb.flerarsoversikt',
    code: 'AR-K3-FB-MULTI-YEAR',
    title: 'Flerårsöversikt',
    sources: ['ÅRL 6 kap. 1 § första stycket', 'K3 3.5A'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'generated',
    existing: 'Flerårsöversikt ur bokföringen (nettoomsättning, resultat efter finansiella poster, soliditet)',
    applicability: () => 'applies',
    missingMessage: 'Flerårsöversikten saknas.',
  },
  {
    id: 'fb.fortlevnad',
    code: 'AR-K3-GOING-CONCERN',
    title: 'Fortlevnad',
    concept: 'ForetagetTillamparInteFortlevnadsprincipen',
    sources: ['ÅRL 2 kap. 4 § första stycket 1', 'ÅRL 5 kap. 5 §', 'K3 3.8'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    question: 'Kan företaget fortsätta att tillämpa fortlevnadsprincipen, det vill säga driva verksamheten vidare minst tolv månader efter balansdagen?',
    choices: [
      { value: 'tillampas', label: 'Ja, fortlevnadsprincipen tillämpas', text: '' },
      { value: 'tillampas_inte', label: 'Nej, verksamheten kan inte fortsätta', text: '' },
    ],
    applicability: () => 'applies',
    unsupported: {
      code: 'AR-K3-GOING-CONCERN-UNSUPPORTED',
      message:
        'Företaget kan inte längre tillämpa fortlevnadsprincipen. Accounteds K3-dokument stöder inte en årsredovisning som upprättas utan fortlevnadsprincipen (ÅRL 5 kap. 5 §, K3 3.8): upprätta den med redovisningskonsult eller revisor.',
      when: (_ctx, answer) => answer.choice === 'tillampas_inte',
    },
    render: () => null,
    missingMessage: 'Ange om fortlevnadsprincipen tillämpas (K3 3.8).',
  },
  {
    id: 'fb.kontrollbalans',
    code: 'AR-K3-FB-KONTROLLBALANS',
    title: 'Kontrollbalansräkning',
    concept: 'Kontrollbalansrakning',
    sources: ['ABL 25 kap. 13 §', 'K3 3.11'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    textLabel:
      'Ange att en kontrollbalansräkning har upprättats eller ska upprättas, och när den upprättades eller ska upprättas.',
    applicability: (ctx) => (ctx.facts.equityBelowHalfShareCapital ? 'applies' : 'not_applicable'),
    hint: () => 'Eget kapital understiger hälften av det registrerade aktiekapitalet.',
    render: (_ctx, answer) => text(answer),
    missingMessage:
      'Eget kapital understiger hälften av aktiekapitalet: förvaltningsberättelsen ska ange att en kontrollbalansräkning har upprättats eller ska upprättas (K3 3.11).',
  },
  {
    id: 'fb.egna_aktier',
    code: 'AR-K3-FB-OWN-SHARES',
    title: 'Egna aktier',
    concept: 'EgnaAktier',
    sources: ['ÅRL 6 kap. 1 § andra stycket 6-9'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    textLabel:
      'Ange antal och kvotvärde för de egna aktier som innehas och som förvärvats eller överlåtits under året, deras andel av aktiekapitalet, ersättningen och skälen för förvärven eller överlåtelserna.',
    applicability: (ctx) => (ctx.facts.ownShares ? 'applies' : 'not_applicable'),
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Företaget har egna aktier: förvaltningsberättelsen ska lämna upplysningarna i ÅRL 6 kap. 1 § andra stycket 6-9.',
  },
  {
    id: 'fb.eget_kapital',
    code: 'AR-K3-EQUITY-UNCLASSIFIED',
    title: 'Förändring av eget kapital',
    sources: ['ÅRL 6 kap. 2 § andra stycket', 'K3 6.3 a-e', 'K3 3.10'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'generated',
    existing: 'Specifikationen av förändringar i eget kapital ur bokföringen (equity-specification.ts)',
    applicability: () => 'applies',
    unsupported: {
      code: 'AR-K3-EQUITY-UNCLASSIFIED',
      message:
        'Ett eller flera verifikat ändrar eget kapital mot konton som inte visar vad förändringen är. Ange för varje verifikat om det är en rättelse av fel, en ändrad redovisningsprincip, en transaktion med ägarna eller något annat (K3 6.3).',
      when: (ctx) => ctx.facts.equityUnclassified.length > 0,
    },
    missingMessage: 'Specifikationen av förändringar i eget kapital saknas.',
  },
  {
    id: 'fb.resultatdisposition',
    code: 'AR-MANAGEMENT-DISPOSITION',
    title: 'Förslag till resultatdisposition',
    sources: ['ÅRL 6 kap. 2 § första stycket', 'K3 3.14'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'management_report',
    producer: 'typed',
    existing: 'Förslag till resultatdisposition (resultatdisposition, proposed_dividend)',
    applicability: () => 'applies',
    missingMessage: 'Styrelsens förslag till resultatdisposition saknas.',
  },

  // ── Redovisnings- och värderingsprinciper (not 1) ──────────────────────
  {
    id: 'pr.ramverk',
    code: 'AR-K3-PRINCIPLES-FRAMEWORK',
    title: 'Tillämpat regelverk',
    sources: ['ÅRL 5 kap. 4 §', 'K3 1.6', 'K3 8.3 första stycket'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'generated',
    existing: 'Första stycket i not 1 (buildK3RedovisningsPrinciper)',
    applicability: () => 'applies',
    missingMessage: 'Not 1 anger inte regelverket.',
  },
  {
    id: 'pr.intakter_uppdrag',
    code: 'AR-K3-PRINCIPLES-CONTRACTS',
    title: 'Pågående uppdrag',
    sources: ['K3 23.29 b', 'K3 23.31'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'typed',
    question: 'Hur redovisas pågående uppdrag (pågående arbete för annans räkning)?',
    textLabel: 'Beskriv hur färdigställandegraden fastställs.',
    // The values are the register's ContractRevenueMethod. Answers stored
    // under the earlier values ('alternativregeln', 'fardigstallandemetoden',
    // whose label named the other method) match no choice and are asked again.
    choices: [
      {
        value: 'successiv' satisfies ContractRevenueMethod,
        label: CONTRACT_REVENUE_METHOD_NAMES.successiv,
        text: null,
      },
      {
        value: 'fardigstallande' satisfies ContractRevenueMethod,
        label: CONTRACT_REVENUE_METHOD_NAMES.fardigstallande,
        text: `Pågående uppdrag till fast pris redovisas enligt ${contractRevenueMethodInText('fardigstallande')} (K3 punkt 23.31): intäkten redovisas när uppdraget i allt väsentligt har slutförts. Uppdrag på löpande räkning intäktsredovisas i takt med att arbetet utförs.`,
      },
    ],
    applicability: (ctx) => (ctx.facts.contractsInProgress !== 0 ? 'applies' : 'not_applicable'),
    hint: () => 'Balansräkningen har pågående arbete för annans räkning.',
    render: (ctx, answer) => {
      const choice = K3_CONTRACT_CHOICES.find((c) => c.value === answer.choice)
      if (!choice) return null
      if (choice.text) return `Pågående uppdrag: ${choice.text}`
      const how = text(answer)
      return how
        ? `Pågående uppdrag: Inkomster från uppdrag redovisas enligt ${contractRevenueMethodInText('successiv')}, i takt med färdigställandegraden. ${how}`
        : null
    },
    missingMessage: 'Ange hur pågående uppdrag redovisas och hur färdigställandegraden fastställs (K3 23.29 b).',
  },
  {
    id: 'pr.varulager',
    code: 'AR-K3-PRINCIPLES-INVENTORY',
    title: 'Varulager',
    sources: ['ÅRL 4 kap. 9 §', 'K3 13', 'K3 13.14', 'K3 8.3 andra stycket'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'typed',
    question: 'Hur värderas varulagret?',
    choices: [
      {
        value: 'fifo',
        label: 'Lägsta värdets princip, först in först ut',
        text: 'Varulagret värderas till det lägsta av anskaffningsvärdet och nettoförsäljningsvärdet. Anskaffningsvärdet beräknas enligt först in, först ut-principen.',
      },
      {
        value: 'vagt_genomsnitt',
        label: 'Lägsta värdets princip, vägt genomsnitt',
        text: 'Varulagret värderas till det lägsta av anskaffningsvärdet och nettoförsäljningsvärdet. Anskaffningsvärdet beräknas som ett vägt genomsnitt.',
      },
      {
        value: 'inkomstskattelagen',
        label: 'Enligt inkomstskattelagen (K3 13.14)',
        text: 'Varulagret värderas i juridisk person enligt bestämmelserna i inkomstskattelagen (K3 punkt 13.14).',
      },
    ],
    applicability: (ctx) => (ctx.facts.inventory !== 0 ? 'applies' : 'not_applicable'),
    render: (_ctx, answer) => {
      const choice = K3_INVENTORY_CHOICES.find((c) => c.value === answer.choice)
      return choice?.text ? `Varulager: ${choice.text}` : null
    },
    missingMessage: 'Ange hur varulagret värderas (K3 kapitel 13).',
  },
  {
    id: 'pr.utveckling',
    code: 'AR-K3-PRINCIPLES-DEVELOPMENT',
    title: 'Internt upparbetade immateriella tillgångar',
    sources: ['K3 18.7', 'K3 18.28 kommentar', 'ÅRL 4 kap. 2 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'typed',
    question: 'Har företaget utgifter för internt upparbetade immateriella anläggningstillgångar, till exempel egen utveckling av programvara?',
    choices: [
      {
        value: 'aktiveringsmodellen',
        label: 'Aktiveringsmodellen',
        text: 'Utgifter för internt upparbetade immateriella anläggningstillgångar redovisas enligt aktiveringsmodellen: utgifter i utvecklingsfasen som uppfyller kriterierna i K3 kapitel 18 tas upp som tillgång, och ett motsvarande belopp förs från fritt eget kapital till fond för utvecklingsutgifter.',
      },
      {
        value: 'kostnadsforingsmodellen',
        label: 'Kostnadsföringsmodellen',
        text: 'Utgifter för internt upparbetade immateriella anläggningstillgångar redovisas enligt kostnadsföringsmodellen: de kostnadsförs när de uppkommer.',
      },
    ],
    applicability: (ctx) =>
      ctx.facts.developmentModel || ctx.facts.capitalizedDevelopment !== 0 ? 'applies' : 'ask',
    satisfiedByFacts: (ctx) => Boolean(ctx.facts.developmentModel),
    hint: (ctx) =>
      ctx.facts.capitalizedDevelopment !== 0
        ? 'Balansräkningen har balanserade utgifter för utvecklingsarbeten (konto 1010-1019).'
        : null,
    render: (ctx, answer) => {
      const value = ctx.facts.developmentModel ?? answer.choice
      const choice = K3_DEVELOPMENT_CHOICES.find((c) => c.value === value)
      return choice?.text ? `Immateriella tillgångar: ${choice.text}` : null
    },
    missingMessage:
      'Ange om aktiveringsmodellen eller kostnadsföringsmodellen tillämpas för internt upparbetade immateriella tillgångar (K3 18.28 kommentar).',
  },
  {
    id: 'pr.goodwill',
    code: 'AR-K3-PRINCIPLES-GOODWILL',
    title: 'Goodwill',
    sources: ['ÅRL 5 kap. 9 §', 'K3 18.20'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'typed',
    textLabel: 'Ange avskrivningsperioden för goodwill och skälen för den.',
    applicability: (ctx) => (ctx.facts.goodwill !== 0 ? 'applies' : 'not_applicable'),
    render: (_ctx, answer) => (text(answer) ? `Goodwill: ${text(answer)}` : null),
    missingMessage: 'Företaget redovisar goodwill: ange avskrivningsperioden och skälen för den (ÅRL 5 kap. 9 §).',
  },
  {
    id: 'pr.bidrag',
    code: 'AR-K3-PRINCIPLES-GRANTS',
    title: 'Offentliga bidrag',
    sources: ['K3 24.5', 'K3 24.8'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'generated',
    question: 'Har anläggningstillgångar anskaffats med offentliga bidrag?',
    applicability: () => 'ask',
    render: () =>
      'Offentliga bidrag: Offentliga bidrag som avser förvärv av anläggningstillgångar har minskat tillgångarnas anskaffningsvärde. Anskaffningsvärdet i noten om anläggningstillgångar avser det redovisade anskaffningsvärdet (K3 punkt 24.8).',
    missingMessage: 'Ange om anläggningstillgångar har anskaffats med offentliga bidrag (K3 24.8).',
  },
  {
    id: 'pr.valuta',
    code: 'AR-K3-PRINCIPLES-FX',
    title: 'Fordringar och skulder i utländsk valuta',
    sources: ['K3 8.3A', 'K3 30.3', 'K3 30.7'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'confirmed',
    question: 'Har företaget tillgångar, avsättningar eller skulder i annan valuta än svenska kronor på balansdagen?',
    confirmation:
      'Monetära poster i utländsk valuta är omräknade till balansdagens kurs i bokföringen (K3 punkt 30.3).',
    applicability: () => 'ask',
    render: () =>
      'Utländsk valuta: Monetära poster i utländsk valuta räknas om till balansdagens kurs. Kursdifferenser på rörelsefordringar och rörelseskulder redovisas i rörelseresultatet och övriga kursdifferenser bland finansiella poster.',
    missingMessage: 'Ange om företaget har poster i utländsk valuta och hur de räknats om (K3 8.3A).',
  },
  {
    id: 'pr.anlaggningar',
    code: 'AR-K3-PRINCIPLES-DEPRECIATION',
    title: 'Avskrivningsmetod och nyttjandeperioder',
    sources: ['ÅRL 5 kap. 8 § andra stycket', 'K3 17.23', 'K3 18.28'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'generated',
    existing: 'Not 1 (linjär avskrivning) och noten Materiella anläggningstillgångar (nyttjandeperioder ur anläggningsregistret)',
    applicability: () => 'applies',
    missingMessage: 'Avskrivningsmetod och nyttjandeperioder saknas.',
  },
  {
    id: 'pr.ovriga_principer',
    code: 'AR-K3-PRINCIPLES-OTHER',
    title: 'Intäkter, leasing, skatter och finansiella instrument',
    sources: ['K3 8.3 andra stycket', 'K3 23.29 a', 'K3 20.29', 'K3 29.37', 'K3 kapitel 11'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'principles',
    producer: 'generated',
    existing: 'Not 1 (buildK3RedovisningsPrinciper: intäkter, leasing enligt 20.29, uppskjuten skatt, finansiella instrument)',
    applicability: () => 'applies',
    missingMessage: 'Redovisningsprinciperna saknas.',
  },

  // ── Noter ───────────────────────────────────────────────────────────────
  {
    id: 'not.avvikelser',
    code: 'AR-K3-NOTE-DEPARTURES',
    title: 'Avvikelser från redovisningsprinciper',
    sources: ['ÅRL 2 kap. 3 § tredje stycket', 'ÅRL 2 kap. 4 § andra stycket', 'ÅRL 5 kap. 5 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Har företaget avvikit från en grundläggande redovisningsprincip (ÅRL 2 kap. 4 §) eller från en bestämmelse för att ge en rättvisande bild?',
    textLabel: 'Ange skälen för avvikelsen och en bedömning av effekten på ställning och resultat.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om företaget har avvikit från en grundläggande redovisningsprincip (ÅRL 5 kap. 5 §).',
  },
  {
    id: 'not.principbyte',
    code: 'AR-K3-NOTE-POLICY-CHANGE',
    title: 'Byte av redovisningsprincip',
    sources: ['K3 10.6', 'K3 10.7', 'ÅRL 3 kap. 5 §', 'ÅRL 5 kap. 7 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question: 'Har företaget bytt redovisningsprincip under året?',
    textLabel:
      'Beskriv bytet, justeringsbeloppen för varje påverkad post (eller varför de inte kan beräknas), varför den nya principen ger mer tillförlitlig och relevant information vid ett frivilligt byte, och den bristande jämförbarheten om jämförelsetalen inte räknats om.',
    applicability: (ctx) => (has(ctx, 'andrad_redovisningsprincip') ? 'applies' : 'ask'),
    hint: (ctx) =>
      has(ctx, 'andrad_redovisningsprincip')
        ? 'Eget kapital har justerats för en ändrad redovisningsprincip under året.'
        : null,
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om företaget har bytt redovisningsprincip (K3 10.6-10.7).',
  },
  {
    id: 'not.rattelse',
    code: 'AR-K3-NOTE-ERROR-CORRECTION',
    title: 'Rättelse av fel',
    sources: ['K3 10.12 tredje stycket', 'K3 10.14'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Har företaget rättat ett väsentligt fel från ett tidigare år genom att räkna om ingående balans för detta räkenskapsår?',
    textLabel: 'Beskriv felet och vilken effekt rättelsen har på resultat och ställning (den bristande jämförbarheten).',
    applicability: (ctx) => (has(ctx, 'rattelse_av_fel') ? 'applies' : 'ask'),
    hint: (ctx) => (has(ctx, 'rattelse_av_fel') ? 'Eget kapital har rättats för ett fel under året.' : null),
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om ett väsentligt fel har rättats mot ingående eget kapital (K3 10.14).',
  },
  {
    id: 'not.jamforelsetal',
    code: 'AR-K3-NOTE-COMPARABILITY',
    title: 'Jämförelsetal',
    sources: ['ÅRL 3 kap. 5 § tredje stycket', 'ÅRL 5 kap. 7 §', 'K3 3.5'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Finns det en post vars belopp inte är jämförbart med föregående års, eller där föregående års belopp har anpassats?',
    textLabel: 'Ange posten, varför beloppen inte är jämförbara eller hur jämförelsebeloppet har anpassats.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om något jämförelsebelopp inte är jämförbart eller har anpassats (ÅRL 5 kap. 7 §).',
  },
  {
    id: 'not.exceptionella_poster',
    code: 'AR-K3-NOTE-EXCEPTIONAL',
    title: 'Exceptionella intäkter och kostnader',
    sources: ['ÅRL 5 kap. 19 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Har företaget haft intäkter eller kostnader som är exceptionella i fråga om storlek eller förekomst, till exempel stora nedskrivningar, en omstrukturering eller en uppgörelse i en rättstvist?',
    textLabel: 'Ange arten och storleken av varje sådan intäkt eller kostnad.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om företaget har haft exceptionella intäkter eller kostnader (ÅRL 5 kap. 19 §).',
  },
  {
    id: 'not.arrangemang',
    code: 'AR-K3-NOTE-OFF-BALANCE',
    title: 'Ekonomiska arrangemang som inte redovisas i balansräkningen',
    sources: ['ÅRL 5 kap. 17 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Har företaget ekonomiska arrangemang som inte redovisas i balansräkningen men är förenade med betydande risker eller fördelar för företaget?',
    textLabel: 'Ange arrangemangens inriktning och kommersiella syfte.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om företaget har ekonomiska arrangemang utanför balansräkningen (ÅRL 5 kap. 17 §).',
  },
  {
    id: 'not.lan_ledande',
    code: 'AR-K3-NOTE-MANAGEMENT-LOANS',
    title: 'Lån till ledande befattningshavare',
    sources: ['ÅRL 5 kap. 18 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Har företaget lämnat lån till, eller ställt säkerhet, garanti eller annat åtagande för, en styrelseledamot, styrelsesuppleant, VD eller vice VD?',
    textLabel:
      'Ange lånens storlek, huvudsakliga villkor, räntesatser, återbetalda belopp, säkerheter och åtaganden, befattningshavarens anknytning till företaget och lån som skrivits av.',
    applicability: () => 'ask',
    hint: (ctx) =>
      ctx.facts.shareholderLoans !== 0
        ? 'Balansräkningen har lån till delägare eller närstående (konto 1360-1369 eller 1685).'
        : null,
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om företaget har lån till eller åtaganden för styrelseledamöter eller VD (ÅRL 5 kap. 18 §).',
  },
  {
    id: 'not.koncernataganden',
    code: 'AR-K3-NOTE-GROUP-COMMITMENTS',
    title: 'Åtaganden till förmån för koncernföretag m.fl.',
    sources: ['ÅRL 5 kap. 16 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Har företaget ställda säkerheter, garantier eller ekonomiska åtaganden till förmån för ett koncernföretag, ett intresseföretag eller ett gemensamt styrt företag?',
    textLabel: 'Ange åtagandena och till förmån för vilket företag.',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om företaget har åtaganden till förmån för koncernföretag eller intresseföretag (ÅRL 5 kap. 16 §).',
  },
  {
    id: 'not.eventualforpliktelser_k3',
    code: 'AR-K3-NOTE-CONTINGENT',
    title: 'Eventualförpliktelser',
    sources: ['ÅRL 5 kap. 15 §', 'K3 21.16A', 'K3 21.17A'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'confirmed',
    confirmation:
      'Eventualförpliktelserna anges till en uppskattning av deras finansiella effekt värderad enligt K3 punkt 21.9-21.13, och borgensåtaganden och ansvar som obegränsat ansvarig delägare är medtagna även när sannolikheten för reglering är ytterst liten (K3 punkt 21.16A och 21.17A).',
    applicability: () => 'applies',
    missingMessage:
      'Bekräfta att eventualförpliktelserna är värderade enligt K3 21.16A och att borgensåtaganden alltid är medtagna (K3 21.17A).',
  },
  {
    id: 'not.stallda_sakerheter_k3',
    code: 'AR-K3-NOTE-SECURITIES',
    title: 'Ställda säkerheter',
    sources: ['ÅRL 5 kap. 14 §', 'K3 8.6A'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'confirmed',
    confirmation:
      'Ställda säkerheter anges med redovisat värde för panter och nominellt belopp för inteckningar (K3 punkt 8.6A).',
    applicability: () => 'applies',
    missingMessage: 'Bekräfta att ställda säkerheter anges enligt K3 8.6A.',
  },
  {
    id: 'not.handelser_efter_balansdagen',
    code: 'AR-K3-NOTE-EVENTS-AFTER',
    title: 'Väsentliga händelser efter balansdagen',
    concept: 'NotVasentligaHandelserRakenskapsaretsSlut',
    sources: ['ÅRL 5 kap. 22 §', 'K3 32.4'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question: 'Har det inträffat händelser av väsentlig betydelse för företaget efter räkenskapsårets slut?',
    textLabel:
      'Ange händelsernas art och ekonomiska effekt, eller att effekten inte kan uppskattas (K3 32.4).',
    applicability: () => 'ask',
    render: (_ctx, answer) => text(answer),
    renderNone: 'Inga väsentliga händelser har inträffat efter räkenskapsårets slut.',
    missingMessage: 'Ange om väsentliga händelser har inträffat efter räkenskapsårets slut (ÅRL 5 kap. 22 §).',
  },
  {
    id: 'not.uppskrivningsfond',
    code: 'AR-K3-NOTE-REVALUATION-RESERVE',
    title: 'Uppskrivningsfond',
    sources: ['ÅRL 5 kap. 11 §', 'K3 6.3 kommentar'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    textLabel:
      'Ange hur avsättningarna till fonden har behandlats skattemässigt, hur belopp som förts från fonden har använts, och det värde som skulle ha redovisats om tillgångarna inte hade skrivits upp.',
    applicability: (ctx) => (ctx.facts.revaluationReserveChanged ? 'applies' : 'not_applicable'),
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Uppskrivningsfonden har ändrats: noten ska lämna sammanställningen i ÅRL 5 kap. 11 §.',
  },
  {
    id: 'not.verkligt_varde',
    code: 'AR-K3-NOTE-FAIR-VALUE',
    title: 'Finansiella instrument värderade till verkligt värde',
    sources: ['ÅRL 4 kap. 14 a-e §§', 'ÅRL 5 kap. 10 och 12 §§', 'K3 kapitel 12'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question: 'Värderar företaget finansiella instrument till verkligt värde enligt ÅRL 4 kap. 14 a § (K3 kapitel 12)?',
    applicability: (ctx) => (ctx.facts.fairValueReserve ? 'applies' : 'ask'),
    unsupported: {
      code: 'AR-K3-FAIR-VALUE-UNSUPPORTED',
      message:
        'Accounteds K3-dokument stöder ännu inte värdering till verkligt värde (K3 kapitel 12, ÅRL 5 kap. 10 och 12 §§): upprätta årsredovisningen med redovisningskonsult eller revisor.',
      when: (ctx, answer) => ctx.facts.fairValueReserve || answer.applies === true,
    },
    render: () => null,
    missingMessage: 'Ange om finansiella instrument värderas till verkligt värde (ÅRL 4 kap. 14 a §).',
  },
  {
    id: 'not.narstaende_publikt',
    code: 'AR-K3-NOTE-RELATED-PARTIES',
    title: 'Transaktioner med närstående',
    sources: ['ÅRL 5 kap. 23 § andra stycket', 'ÅRL 5 kap. 24 §'],
    frameworks: K3,
    sizes: ['smaller'],
    placement: 'note',
    producer: 'typed',
    question:
      'Har bolaget genomfört transaktioner på andra än marknadsmässiga villkor med någon som har ett betydande aktieinnehav eller är styrelseledamot?',
    textLabel: 'Ange transaktionernas art och belopp, närståendeförhållandet och övriga uppgifter som behövs för att bedöma ställningen.',
    applicability: (ctx) => (ctx.facts.publicCompany === true ? 'ask' : 'not_applicable'),
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ett publikt aktiebolag ska ange transaktioner med närstående på andra än marknadsmässiga villkor (ÅRL 5 kap. 23 §).',
  },
  {
    id: 'not.finansiella_anlaggningstillgangar',
    code: 'AR-K3-NOTE-FINANCIAL-FIXED-ASSETS',
    title: 'Finansiella anläggningstillgångar',
    sources: ['ÅRL 5 kap. 8 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'generated',
    existing: 'Noten Finansiella anläggningstillgångar ur bokföringen (ledger-fixed-asset-notes.ts)',
    applicability: (ctx) => (ctx.facts.financialFixedAssets ? 'applies' : 'not_applicable'),
    missingMessage: 'Noten om finansiella anläggningstillgångar saknas.',
  },
  {
    id: 'not.anlaggningstillgangar',
    code: 'AR-K3-NOTE-FIXED-ASSETS',
    title: 'Immateriella och materiella anläggningstillgångar',
    sources: ['ÅRL 5 kap. 8 §', 'K3 17.23', 'K3 18.28'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'generated',
    // The roll-forward is built from the asset register (with nedskrivningar
    // from the ledger): assets in the ledger that the register does not hold
    // leave the note unprinted, which blocks rather than files without it.
    applicability: (ctx) => (ctx.facts.fixedAssetsInLedger ? 'applies' : 'not_applicable'),
    satisfiedByFacts: (ctx) => ctx.facts.fixedAssetNoteFromRegister,
    missingMessage:
      'Bokföringen har immateriella eller materiella anläggningstillgångar men anläggningsregistret saknar dem, så noten om anläggningstillgångar (ÅRL 5 kap. 8 §) kan inte tas fram. Lägg in tillgångarna i anläggningsregistret.',
  },
  {
    id: 'not.medelantal',
    code: 'AR-K3-NOTE-EMPLOYEES',
    title: 'Medelantal anställda',
    sources: ['ÅRL 5 kap. 20 §', 'K3 8.6B'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'generated',
    existing: 'Noten Medelantal anställda (Löner eller angivet antal)',
    applicability: () => 'applies',
    missingMessage: 'Noten om medelantal anställda saknas.',
  },
  {
    id: 'not.langfristiga_skulder',
    code: 'AR-NOTE-LONG-DEBT-UNCONFIRMED',
    title: 'Långfristiga skulder',
    sources: ['ÅRL 5 kap. 13 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'confirmed',
    existing: 'Lagstadgade upplysningar: långfristiga skulder (med bekräftelse)',
    applicability: () => 'applies',
    missingMessage: 'Uppgiften om långfristiga skulder är inte bekräftad.',
  },
  {
    id: 'not.moderforetag',
    code: 'AR-NOTE-PARENT-UNCONFIRMED',
    title: 'Moderföretag',
    sources: ['ÅRL 5 kap. 21 §'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'confirmed',
    existing: 'Lagstadgade upplysningar: koncernförhållanden (med bekräftelse)',
    applicability: () => 'applies',
    missingMessage: 'Uppgiften om moderföretag är inte bekräftad.',
  },
  {
    // A new company's first financial report is its first K3 year (K3
    // 35.3): nothing to restate, no relief rule applied, no principle
    // changed, so the note is generated. A first K3 year after K2 is
    // blocked in eligibility.ts (AR-K3-FIRST-YEAR-UNSUPPORTED) and an
    // unknown history there too (AR-K3-FIRST-YEAR-UNKNOWN).
    id: 'not.forsta_k3_aret',
    code: 'AR-K3-NOTE-FIRST-YEAR',
    title: 'Första gången K3 tillämpas',
    sources: ['K3 35.3', 'K3 35.31', 'K3 35.33', 'BFNAR 2012:4 punkt 3'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'generated',
    applicability: (ctx) => (ctx.firstYear === 'new_company' ? 'applies' : 'not_applicable'),
    render: () =>
      'Detta är företagets första årsredovisning och första gången Bokföringsnämndens allmänna råd BFNAR 2012:1 Årsredovisning och koncernredovisning (K3) tillämpas. Inga lättnadsregler enligt punkterna 35.21-35.30 har tillämpats och inga redovisningsprinciper har ändrats vid övergången, eftersom det inte finns någon tidigare finansiell rapport.',
    missingMessage: 'Upplysningen om att K3 tillämpas för första gången saknas (K3 35.31).',
  },
  {
    id: 'not.mtf_prospekt',
    code: 'AR-K3-NOTE-MTF-PROSPECTUS',
    title: 'Nya uppgifter enligt prospekt eller upptagandedokument',
    sources: ['ÅRL 5 kap. 18 a § (i kraft 2026-12-05)'],
    frameworks: K3,
    sizes: ALL_SIZES,
    placement: 'note',
    producer: 'typed',
    question:
      'Handlas bolagets aktier på en MTF-plattform efter att bolaget lämnat uppgifter i ett prospekt eller ett upptagandedokument, och finns det nya sådana uppgifter att lämna?',
    textLabel: 'Ange de nya uppgifterna.',
    // Only a publikt aktiebolag can have shares traded on an MTF platform
    // (ABL 1 kap. 7 §), so a private company is never asked.
    applicability: (ctx) => (ctx.facts.publicCompany === true ? 'ask' : 'not_applicable'),
    render: (_ctx, answer) => text(answer),
    missingMessage: 'Ange om bolaget har nya uppgifter att lämna enligt ÅRL 5 kap. 18 a § (aktier på en MTF-plattform).',
  },
]

const K3_CONTRACT_CHOICES = K3_MINDRE_REQUIREMENTS.find((r) => r.id === 'pr.intakter_uppdrag')?.choices ?? []
const K3_INVENTORY_CHOICES = K3_MINDRE_REQUIREMENTS.find((r) => r.id === 'pr.varulager')?.choices ?? []
const K3_DEVELOPMENT_CHOICES = K3_MINDRE_REQUIREMENTS.find((r) => r.id === 'pr.utveckling')?.choices ?? []
