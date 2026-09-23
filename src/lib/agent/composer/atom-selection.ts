import { getAnthropic, OPUS_MODEL } from './client'
import { AtomSelectionSchema, ATOM_SELECTION_TOOL_SCHEMA, type AtomSelection } from './schemas'
import { isSekOnlyMagnitude, type ComposerInputs, type CurrencyMagnitude } from './inputs'
import { employeeKnownFact, knowsEmployeeFact } from './employee-facts'

const SYSTEM_PROMPT = `Du komponerar en specialiserad svensk bokföringsassistent åt ett företag.

Du får:
- Företagets TIC-snapshot från Bolagsverket / Lens API. Inkluderar utöver grundfält (org-nummer, juridisk form, SNI, F-skatt/moms/arbetsgivarregistrering, anställdaintervall, omsättningsintervall, verksamhetsbeskrivning, senaste finansiella rapporter):
  - statuses[]: nuvarande och historiska bolagsstatus med trafikljus (red/yellow/green/neutral) och isCeased-flagga. Om isCeased eller red: kompositionen ska FORTSÄTTA men nämn det i uncertainty_notes.
  - signatory[]: firmateckningsregler i fritext ("Firman tecknas av styrelsen", "två i förening", "av en ledamot ensam"). En enda ledamot som tecknar ensam pekar starkt mot enpersonsbolag.
  - board: styrelsesammansättning: numberOfBoardMembers, numberOfDeputyBoardMembers, hasVacancy. Mer än 1 ledamot utan suppleant pekar bort från enpersonsmodifier.
  - representatives[]: aktiva personer (CEO, ledamöter, revisor) med positionType. Räkna unika personer för ownership-signal.
  - beneficialOwners[]: verklig huvudman per Bolagsverket. AUKTORITATIV ägarstrukturkälla. En enda namngiven owner = bekräftat enpersonsbolag. Två eller fler = multi-owner; välj INTE single-shareholder-ab-fmb.
  - payrolls[]: faktiska lönefilingar (payroll2-array per period med antal anställda + summa preliminärskatt). Om TOM trots att registration.payroll = true: arbetsgivaren är registrerad men har inte faktiskt betalat lön ännu. Välj INTE swedish-payroll i det läget: felaktig signal från statisk registrering är vanlig för nystartade AB.
  - fiscalYear: nuvarande räkenskapsårskonfiguration med startMonthDay/endMonthDay. Brutet räkenskapsår (annat än 01-01/12-31) är vanligt i konsult-AB och påverkar bokslut-atomvalet.
- KÄNDA FAKTA från företagets inställningar: saker användaren redan har angett (momsperiod, räkenskapsår, F-skatt-status, anställda, bokföringsmetod)
- Eventuell sammanfattning från importerad SIE-fil (topp-konton, topp-motparter, antal år)
- Eventuell sammanfattning från bankhistorik. Varje topp-motpart har:
  - belopp med sin valutaenhet utskriven (abs)
  - riktning: 'in' (intäkt/inbetalning), 'ut' (kostnad/utbetalning), eller 'in+ut'
  - bokföringsstatus: 'OBOKFÖRD' (minst en transaktion ej bokförd) eller 'bokförd'
  KRITISKT: ställ INTE en verifieringsfråga om en motpart där riktningen är entydig OCH alla transaktioner är bokförda. T.ex. en motpart märkt "(ut, bokförd)" är redan klassad som kostnad och redan kategoriserad. Att fråga "är detta en intäkt eller kostnad?" är fel. Fokusera frågorna på OBOKFÖRD-motparter där det finns en bokningsbeslutning kvar att fatta.

BELOPP OCH VALUTA (hård regel):
  - Ett belopp gäller ALLTID den enhet som står skriven. "412 000 kr" är svenska kronor. "30 000 EUR" är euro, inte kronor.
  - Addera ALDRIG belopp i olika valutor till en summa, och räkna aldrig om dem själv: du har ingen växelkurs.
  - Står det "motsvarar N kr" är N en lagrad SEK-motsvarighet och får användas som storleksordning.
  - Står det "SEK-motsvarighet OKÄND" eller "saknar växelkurs" finns INGEN känd kronsumma för de raderna. Behandla storleken som okänd, gissa aldrig fram ett kr-belopp, och nämn luckan i uncertainty_notes.
  - Ett block märkt "Motparter utan känd SEK-motsvarighet" listar motparter vars storlek vi inte kan uttrycka i kronor. De är inte små: de är omätta.
  - Om "Snittvolym per månad" saknas eller är märkt som ett golv: dra inga slutsatser om omsättningsstorlek av den.
- Ett register över tillgängliga atomer (horizontal/vertical/modifier) med beskrivning, SNI-prefix och utlösare

Din uppgift:
1. Välj ALLA horisontella atomer som är relevanta för verksamheten. De flesta företag behöver swedish-vat, swedish-invoice-compliance och swedish-year-end-closing. Lägg till swedish-payroll BARA om payrolls[] visar faktiska filingar (icke-tom payroll2-array) ELLER KÄNDA FAKTA bekräftar pågående löneutbetalning, inte enbart för att registration.payroll = true. Lägg till SRU/financial-reporting för AB. Lägg till asset-accounting om SIE visar 12xx-konton. Lägg till project-accounting om signalerna pekar mot tjänsteföretag med projekt. Lägg till tax-planning för aktiebolag.
2. Välj noll, en eller flera vertikala atomer (industri) baserat på SNI-prefix, verksamhetsbeskrivning och motpartsmönster. Tomt om ingen passar.
3. Välj modifier-atomer som faktiskt är sanna:
   - single-shareholder-ab-fmb: VÄLJ när beneficialOwners[] har exakt en person OCH legal form = AB. Avstå annars (även om bolaget "ser litet ut").
   - enskild-firma: om EF.
   - small-employer: om payrolls[] visar 1-9 anställda i senaste filing.
4. is_multi_vertical = true endast om företaget faktiskt har två etablerade affärsben.
5. Skriv 3-6 korta svenska verifieringsfrågor som användaren behöver bekräfta: fokusera på de högsta osäkerheterna.

   KRITISKT: Ställ INTE frågor vars svar redan finns i KÄNDA FAKTA eller TIC-snapshot. Användaren har redan sagt detta. Att fråga igen är slöseri med deras tid.
     - Om "Momsperiod" finns i KÄNDA FAKTA: fråga inte om momsperiod
     - Om "Anställda" finns i KÄNDA FAKTA: fråga inte om anställda
     - Om TIC visar F-skatt/momsregistrering: fråga inte om det
     - Om beneficialOwners[] finns: fråga INTE "vem äger bolaget?" eller "är du ensamägare?": det är redan auktoritativt besvarat
     - Om payrolls[] visar antal anställda: fråga INTE "hur många anställda?"
     - Om fiscalYear finns: fråga INTE om räkenskapsårsstart/slut
     - Om SNI-koder finns: fråga inte om branschen i allmänhet, men du KAN fråga om en specifik nyans (t.ex. "Säljer ni mest 25%- eller 12%-momsvaror?")

   Fokusera istället på frågor vars svar du inte kan se: specifika balansposter (t.ex. "Vad gäller ALMI-beloppet, lån eller bidrag?"), arbetssätt (faktureringscadens, kund-geografi), planerade förändringar (kommande löneutbetalning, expansion, fastighetsförvärv).

6. Skriv 1-3 svenska uncertainty_notes till utvecklaren som granskar valet senare. Inkludera explicit notering om statuses[] visar isCeased eller red-status, och om något belopp saknar känd SEK-motsvarighet.

Stil i all text du skriver (verifieringsfrågor och notes): använd ALDRIG tankstreck (— eller –). Använd kommatecken, punkt, eller "till" för intervall ("2,5 till 5 miljoner"). Hård regel.

Använd verktyget compose_agent_profile för att svara. Använd aldrig fritext.`

export async function selectAtoms(inputs: ComposerInputs): Promise<AtomSelection> {
  const anthropic = getAnthropic()

  const userPrompt = buildUserPrompt(inputs)

  const response = await anthropic.messages.create({
    model: OPUS_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [
      {
        name: 'compose_agent_profile',
        description: 'Spara den valda atomuppsättningen för företaget.',
        input_schema: ATOM_SELECTION_TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'compose_agent_profile' },
  })

  // Forced tool_use guarantees exactly one tool_use block. We still validate
  // defensively in case the API ever returns something unexpected.
  const toolUse = response.content.find((b) => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Opus did not return a tool_use block')
  }

  const parsed = AtomSelectionSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    throw new Error(`Atom selection failed Zod validation: ${parsed.error.message}`)
  }

  // Enforce that selected atom IDs exist in the registry index we showed
  // the model. Hallucinated IDs would silently break the runtime loader.
  const knownIds = new Set(inputs.atomIndex.map((a) => a.id))
  const allSelected = [
    ...parsed.data.horizontal_atoms,
    ...parsed.data.vertical_atoms,
    ...parsed.data.modifier_atoms,
  ]
  const unknown = allSelected.filter((id) => !knownIds.has(id))
  if (unknown.length > 0) {
    // Drop unknown IDs rather than failing: composer can still produce a
    // useful profile. Surface in uncertainty_notes so a reviewer sees it.
    parsed.data.horizontal_atoms = parsed.data.horizontal_atoms.filter((id) => knownIds.has(id))
    parsed.data.vertical_atoms = parsed.data.vertical_atoms.filter((id) => knownIds.has(id))
    parsed.data.modifier_atoms = parsed.data.modifier_atoms.filter((id) => knownIds.has(id))
    parsed.data.uncertainty_notes = [
      ...parsed.data.uncertainty_notes,
      `Composer returned ${unknown.length} unknown atom id(s): ${unknown.join(', ')}`,
    ]
  }

  // Belt-and-braces: filter redundant questions deterministically even if
  // the model ignored the "do not ask about KÄNDA FAKTA" instruction.
  parsed.data.verification_questions = filterRedundantQuestions(
    parsed.data.verification_questions,
    inputs,
    parsed.data.modifier_atoms,
  )

  // Currency caveats are appended deterministically, not left to the model.
  // This selection becomes the company's standing agent profile, so a
  // magnitude the underlying data cannot support has to be flagged even when
  // the model failed to notice it: an explicit "unknown" is always better
  // than a confident wrong number baked into durable instructions.
  parsed.data.uncertainty_notes = [
    ...parsed.data.uncertainty_notes,
    ...buildCurrencyUncertaintyNotes(inputs),
  ]

  return parsed.data
}

// Deterministic notes about what the amount signals cannot tell us. Exported
// so the stream endpoint can apply the same caveats to fallback selections,
// which never see the model at all.
export function buildCurrencyUncertaintyNotes(inputs: ComposerInputs): string[] {
  const notes: string[] = []

  const bank = inputs.bankingSummary
  if (bank) {
    const foreign = bank.currencies.filter((c) => c !== 'SEK')
    if (foreign.length > 0) {
      notes.push(
        `Banksammanfattningen spänner över flera valutor (${bank.currencies.join(', ')}). Beloppen är inte en enda kr-summa: kontrollera valutan innan en storleksordning används.`,
      )
    }
    if (bank.volume_rows_without_sek > 0) {
      const total = bank.volume_rows_with_sek + bank.volume_rows_without_sek
      notes.push(
        bank.monthly_volume == null
          ? `Ingen månadsvolym i kr kan anges: samtliga ${total} banktransaktioner saknar lagrad SEK-motsvarighet.`
          : `${bank.volume_rows_without_sek} av ${total} banktransaktioner saknar lagrad SEK-motsvarighet och ingår inte i snittvolymen. Volymen i kr är ett golv, inte ett facit.`,
      )
    }
    if (bank.unconvertible_counterparties.length > 0) {
      notes.push(
        `${bank.unconvertible_counterparties.length} motpart(er) kunde inte rankas i kr eftersom växelkurs saknas: ${bank.unconvertible_counterparties.map((c) => c.name).join(', ')}.`,
      )
    }
  }

  const sie = inputs.sieSummary
  if (sie) {
    const unknownRows = [...sie.top_counterparties, ...sie.unconvertible_counterparties].reduce(
      (n, c) => n + c.rows_without_sek,
      0,
    )
    if (unknownRows > 0) {
      notes.push(
        `SIE-motpartsbeloppen innehåller ${unknownRows} rad(er) i utländsk valuta utan känd SEK-motsvarighet.`,
      )
    }
  }

  return notes
}

// Renders a magnitude so the number always carries its real unit.
//
// Plain SEK data renders exactly as before ("412 000 kr"). Anything else keeps
// each currency in its own unit and states, in words, how much of it has a
// known SEK equivalent. There is deliberately no path that turns a mixed or
// rate-less magnitude into a single "kr" figure.
export function formatMagnitude(m: CurrencyMagnitude): string {
  if (isSekOnlyMagnitude(m)) {
    return `${formatAmount(m.abs_amount)} kr`
  }

  const native = m.by_currency
    .map((c) => `${formatAmount(c.abs_amount)} ${c.currency}`)
    .join(' + ')

  if (m.rows_without_sek === 0) {
    return `${native} (motsvarar ${formatAmount(m.abs_amount)} kr)`
  }
  const missing = `${m.rows_without_sek} ${m.rows_without_sek === 1 ? 'transaktion' : 'transaktioner'} saknar växelkurs`
  if (m.abs_amount === 0) {
    return `${native} (SEK-motsvarighet OKÄND: ${missing}, ingen kr-summa kan anges)`
  }
  return `${native} (varav ${formatAmount(m.abs_amount)} kr har känd SEK-motsvarighet, ${missing} och ingår inte)`
}

function formatAmount(value: number): string {
  return Math.round(value).toLocaleString('sv-SE')
}

function counterpartyLabels(c: {
  direction: 'in' | 'out' | 'mixed'
  has_unbooked: boolean
}): string {
  const dirLabel = c.direction === 'in' ? 'in' : c.direction === 'out' ? 'ut' : 'in+ut'
  return `${dirLabel}, ${c.has_unbooked ? 'OBOKFÖRD' : 'bokförd'}`
}

// Drops questions whose answer is already settled in company_settings or
// TIC snapshot. Each question is matched against keyword patterns:
// keep this conservative so we never accidentally drop a legitimate
// nuance question (e.g. "Säljer ni mest 25%- eller 12%-momsvaror?" is
// kept even when moms_period is known, because it's about VAT RATE not
// VAT PERIOD).
//
// Exported so the stream endpoint can re-apply it to fallback selections too:
// fallbackAtomSelection generates questions from a template that doesn't
// know about KÄNDA FAKTA. Belt-and-braces against both model misbehavior
// and the fallback path.
export function filterRedundantQuestions(
  questions: string[],
  inputs: ComposerInputs,
  selectedModifiers: string[] = [],
): string[] {
  const s = inputs.companySettings
  const tic = inputs.ticSnapshot as
    | {
        registration?: { fTax?: boolean; vat?: boolean; payroll?: boolean }
        employeeRange?: string | null
        beneficialOwners?: { name: string }[]
      }
    | null

  const knowsMomsPeriod = !!s?.moms_period
  const knowsEmployees = knowsEmployeeFact({
    activeEmployees: inputs.activeEmployees,
    ticEmployeeRange: tic?.employeeRange ?? null,
    employerRegistered: s?.employer_registered ?? null,
    paysSalaries: s?.pays_salaries ?? null,
  })
  const knowsFiscalYear = s?.fiscal_year_start_month != null
  const knowsFSkatt = s?.f_skatt != null || tic?.registration?.fTax != null
  const knowsVatRegistered = s?.vat_registered != null || tic?.registration?.vat != null
  const knowsAccountingMethod = !!s?.accounting_method
  // Ownership is settled by EITHER: the composer picked the single-
  // shareholder modifier, OR Bolagsverket's beneficial-owner register has
  // exactly one person on file (sole verklig huvudman per Lag 2017:631).
  // Either signal is enough to drop the redundant question.
  const ownerCount = Array.isArray(tic?.beneficialOwners) ? tic.beneficialOwners.length : 0
  const knowsOwnershipSingle =
    selectedModifiers.includes('modifier/single-shareholder-ab-fmb') || ownerCount === 1
  const knowsOwners = ownerCount > 0

  return questions.filter((q) => {
    const lower = q.toLowerCase()

    // Ownership ("är du ensamägare", "äger du majoriteten", "vem äger
    // bolaget"…): drop when EITHER the single-shareholder modifier is set
    // OR Bolagsverket's beneficial-owner register confirms a single owner.
    if (
      knowsOwnershipSingle &&
      /(ensamägare|enda ägare|majoriteten av aktierna|vem äger|aktieägare|fåmansbolag.*ensam|verksam i bolaget.*ensam)/.test(
        lower,
      )
    ) {
      return false
    }
    // Verklig huvudman: if TIC says we have owners, don't ask who they are.
    if (knowsOwners && /(verklig huvudman|huvudmän)/.test(lower)) {
      return false
    }

    // Moms period: "månad/kvartal/år" all together is the giveaway.
    if (
      knowsMomsPeriod &&
      lower.includes('momsperiod') &&
      (lower.includes('månad') || lower.includes('kvartal') || lower.includes('år'))
    ) {
      return false
    }

    // Employees: pattern "har bolaget anställda" or "har du anställda".
    if (knowsEmployees && /har\s+(bolaget|du|ni|företaget)\s+anställda/.test(lower)) {
      return false
    }

    // Fiscal year: "räkenskapsår" + ("januari"|"month names"|"börjar").
    if (knowsFiscalYear && lower.includes('räkenskapsår') && /(börjar|januari|kalenderår|brutet)/.test(lower)) {
      return false
    }

    // F-skatt: "är bolaget registrerat för f-skatt" type questions.
    if (knowsFSkatt && /f[-\s]?skatt/.test(lower) && /(registrerad|registrerat|aktiv)/.test(lower)) {
      return false
    }

    // VAT registration: "är ni momsregistrerade" type questions.
    if (knowsVatRegistered && /(momsregistrerad|registrerade?\s+för\s+moms)/.test(lower)) {
      return false
    }

    // Accounting method: "fakturametoden eller kontantmetoden".
    if (knowsAccountingMethod && /(fakturamet|kontantmet|bokföringsmet)/.test(lower)) {
      return false
    }

    return true
  })
}

function buildUserPrompt(inputs: ComposerInputs): string {
  const lines: string[] = []
  lines.push(`# Företag`)
  lines.push(`Namn: ${inputs.companyName}`)
  lines.push(`Juridisk form (Accounted): ${inputs.entityType}`)
  lines.push('')

  const known = buildKnownFacts(inputs)
  if (known.length > 0) {
    lines.push(`# KÄNDA FAKTA (fråga inte om dessa)`)
    for (const line of known) lines.push(`- ${line}`)
    lines.push('')
  }

  if (inputs.ticSnapshot) {
    lines.push(`# TIC-snapshot`)
    lines.push('```json')
    lines.push(JSON.stringify(redactTic(inputs.ticSnapshot), null, 2))
    lines.push('```')
    if (inputs.ticFetchedAt) lines.push(`Hämtad: ${inputs.ticFetchedAt}`)
    lines.push('')
  } else {
    lines.push(`# TIC-snapshot`)
    lines.push('Saknas. Förlita dig på företagsnamn, gnubok-entity_type och övriga signaler.')
    lines.push('')
  }

  if (inputs.sieSummary) {
    lines.push(`# SIE-sammanfattning`)
    lines.push(`Antal år: ${inputs.sieSummary.year_count}`)
    if (inputs.sieSummary.top_accounts.length > 0) {
      // Ledger balances: journal_entry_lines are booked in SEK by definition,
      // so a bare kr figure is correct here.
      lines.push('Topp-konton (abs-belopp, bokförda i SEK):')
      for (const a of inputs.sieSummary.top_accounts.slice(0, 20)) {
        lines.push(`  ${a.account.padEnd(8)} ${Math.round(a.abs_amount).toLocaleString('sv-SE')} kr`)
      }
    }
    if (inputs.sieSummary.top_counterparties.length > 0) {
      lines.push('Topp-motparter (från transaktionsbeskrivningar):')
      for (const c of inputs.sieSummary.top_counterparties.slice(0, 10)) {
        lines.push(`  ${c.name}: ${formatMagnitude(c)}`)
      }
    }
    if (inputs.sieSummary.unconvertible_counterparties.length > 0) {
      lines.push('Motparter utan känd SEK-motsvarighet (växelkurs saknas, därför inte rankade ovan):')
      for (const c of inputs.sieSummary.unconvertible_counterparties) {
        lines.push(`  ${c.name}: ${formatMagnitude(c)}`)
      }
    }
    lines.push('')
  }

  if (inputs.bankingSummary) {
    const bank = inputs.bankingSummary
    lines.push(`# Banktransaktioner (12 mån)`)

    const volumeTotal = bank.volume_rows_with_sek + bank.volume_rows_without_sek
    if (bank.monthly_volume != null) {
      // Only the rows with a known SEK value are in this figure. When some
      // rows are missing a rate the number is a floor, and saying so beats
      // printing a confident total the data cannot back.
      const caveat =
        bank.volume_rows_without_sek > 0
          ? ` (GOLV: ${bank.volume_rows_without_sek} av ${volumeTotal} transaktioner saknar växelkurs och ingår inte, den verkliga volymen är högre)`
          : ''
      lines.push(
        `Snittvolym per månad: ${Math.round(bank.monthly_volume).toLocaleString('sv-SE')} kr${caveat}`,
      )
    } else if (bank.volume_rows_without_sek > 0) {
      lines.push(
        `Snittvolym per månad: OKÄND. Samtliga ${volumeTotal} transaktioner är i utländsk valuta utan lagrad växelkurs, så ingen kr-volym kan beräknas.`,
      )
    }
    lines.push(`Antal obokförda transaktioner: ${bank.unbooked_count}`)
    if (bank.currencies.length > 1) {
      lines.push(
        `Valutor i underlaget: ${bank.currencies.join(', ')}. Beloppen nedan står i sin egen valuta, addera dem inte.`,
      )
    }
    if (bank.top_counterparties.length > 0) {
      lines.push('Topp-motparter (riktning + bokföringsstatus):')
      for (const c of bank.top_counterparties.slice(0, 20)) {
        // direction tells Opus whether this counterparty is a source of
        // income, a cost, or both. has_unbooked says whether there's still
        // a transaction waiting for the user to book: only those are
        // legitimate verification-question fodder.
        lines.push(`  ${c.name}: ${formatMagnitude(c)} (${counterpartyLabels(c)})`)
      }
    }
    if (bank.unconvertible_counterparties.length > 0) {
      // These rank as 0 kr and would otherwise disappear at the slice above.
      // They are unmeasured, not small: listing them separately keeps that
      // distinction visible to the model.
      lines.push(
        'Motparter utan känd SEK-motsvarighet (växelkurs saknas, därför inte rankade ovan, storleken är omätt och inte liten):',
      )
      for (const c of bank.unconvertible_counterparties) {
        lines.push(`  ${c.name}: ${formatMagnitude(c)} (${counterpartyLabels(c)})`)
      }
    }
    lines.push('')
  }

  lines.push(`# Atomregister`)
  lines.push('')
  lines.push('## Horizontal')
  for (const a of inputs.atomIndex.filter((x) => x.tier === 'horizontal')) {
    lines.push(`- ${a.id}: ${a.description.slice(0, 240)}`)
  }

  const verticals = inputs.atomIndex.filter((x) => x.tier === 'vertical')
  lines.push('')
  lines.push('## Vertical')
  if (verticals.length === 0) {
    lines.push('(inga vertikala atomer i registret ännu, välj alltid en tom array)')
  } else {
    for (const a of verticals) {
      const sni = a.sni_prefixes.length > 0 ? ` [SNI ${a.sni_prefixes.join(', ')}]` : ''
      lines.push(`- ${a.id}${sni}: ${a.description.slice(0, 240)}`)
    }
  }

  const modifiers = inputs.atomIndex.filter((x) => x.tier === 'modifier')
  lines.push('')
  lines.push('## Modifier')
  if (modifiers.length === 0) {
    lines.push('(inga modifier-atomer i registret ännu, välj alltid en tom array)')
  } else {
    for (const a of modifiers) {
      lines.push(`- ${a.id}: ${a.description.slice(0, 240)}`)
    }
  }

  return lines.join('\n')
}

// Surfaces user-settled facts in a tight bullet list the composer can scan
// before generating questions. Anything in here is OFF-LIMITS for the
// verification_questions list: the user already said it.
export function buildKnownFacts(inputs: ComposerInputs): string[] {
  const out: string[] = []
  const s = inputs.companySettings
  if (s) {
    if (s.moms_period) {
      const label =
        s.moms_period === 'monthly'
          ? 'månadsvis'
          : s.moms_period === 'quarterly'
            ? 'kvartalsvis'
            : s.moms_period === 'yearly'
              ? 'årligen'
              : s.moms_period
      out.push(`Momsperiod: ${label}`)
    }
    if (s.fiscal_year_start_month != null) {
      out.push(`Räkenskapsår börjar månad ${s.fiscal_year_start_month}`)
    }
    if (s.f_skatt != null) {
      out.push(`F-skatt: ${s.f_skatt ? 'aktiv' : 'saknas'}`)
    }
    if (s.vat_registered != null) {
      out.push(`Momsregistrerad: ${s.vat_registered ? 'ja' : 'nej'}`)
    }
    // Only a true is a fact: the column is NOT NULL DEFAULT false, so false is
    // what every company that never opened the Skatt settings reads
    // (employee-facts.ts). An attested negative surfaces through
    // employeeKnownFact below; the default must not be read as "nej".
    if (s.pays_salaries === true) {
      out.push('Betalar ut lön: ja')
    }
    if (s.employer_registered != null) {
      out.push(`Arbetsgivarregistrerad: ${s.employer_registered ? 'ja' : 'nej'}`)
    }
    if (s.accounting_method) {
      out.push(`Bokföringsmetod: ${s.accounting_method}`)
    }
    if (s.city) {
      out.push(`Säte: ${s.city}`)
    }
  }
  // Outside the settings block on purpose: a live employee count is a fact even
  // for a company with no company_settings row yet.
  const employeeFact = employeeKnownFact({
    activeEmployees: inputs.activeEmployees,
    ticEmployeeRange: null,
    employerRegistered: s?.employer_registered ?? null,
    paysSalaries: s?.pays_salaries ?? null,
  })
  if (employeeFact) out.push(employeeFact)
  const tic = inputs.ticSnapshot as
    | {
        registration?: { fTax?: boolean; vat?: boolean; payroll?: boolean }
        employeeRange?: string | null
        sniCodes?: { code: string; name: string }[]
        purpose?: string | null
        beneficialOwners?: {
          name: string
          extentDescription?: string | null
          extentCode?: string | null
        }[]
      }
    | null
  if (tic) {
    if (tic.registration) {
      const flags: string[] = []
      if (tic.registration.fTax) flags.push('F-skatt')
      if (tic.registration.vat) flags.push('moms')
      if (tic.registration.payroll) flags.push('arbetsgivare')
      if (flags.length > 0) out.push(`Bolagsverket-registreringar: ${flags.join(', ')}`)
    }
    if (tic.employeeRange) out.push(`Anställdaintervall (TIC): ${tic.employeeRange}`)
    if (Array.isArray(tic.sniCodes) && tic.sniCodes.length > 0) {
      // Dedupe by code (TIC sometimes returns the same SNI twice).
      const seen = new Set<string>()
      const codes = tic.sniCodes
        .filter((s) => {
          if (seen.has(s.code)) return false
          seen.add(s.code)
          return true
        })
        .map((s) => `${s.code} ${s.name}`)
        .join('; ')
      out.push(`SNI: ${codes}`)
    }
    if (tic.purpose) {
      out.push(`Verksamhetsbeskrivning: ${tic.purpose}`)
    }
    if (Array.isArray(tic.beneficialOwners) && tic.beneficialOwners.length > 0) {
      // Verklig huvudman per Bolagsverket: authoritative ownership data.
      // Composer must NOT ask "are you the sole owner?" when this is set.
      const owners = tic.beneficialOwners
        .map((o) => {
          const extent = o.extentDescription ?? o.extentCode ?? ''
          return extent ? `${o.name} (${extent})` : o.name
        })
        .join('; ')
      out.push(
        `Verkliga huvudmän (Bolagsverket): ${owners}${tic.beneficialOwners.length === 1 ? ', ensam ägare' : ''}`,
      )
    }
  }
  return out
}

// Drop fields from the TIC snapshot that the composer doesn't need and that
// inflate token count or carry PII unnecessarily. After the v2 migration we
// include the new ownership/governance/payroll sections: these change atom
// selection materially (payroll signal goes from "is registered" to "has
// actual filings"; ownership signal goes from heuristic to authoritative).
// Excluded: bankAccounts, email, phone, fiscalYearHistory, financialReports:
// high token cost, low atom-selection signal.
function redactTic(snapshot: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'orgNumber',
    'companyName',
    'legalEntityType',
    'registrationDate',
    'activityStatus',
    'purpose',
    'registration',
    'sector',
    'employeeRange',
    'turnoverRange',
    'sniCodes',
    'address',
    'financials',
    // v2 governance + ownership: settles redundant questions deterministically
    'beneficialOwners',
    'signatory',
    'board',
    'representatives',
    // v2 payroll history: distinguishes "registered" vs "has actually filed"
    'payrolls',
    // v2 status entries: refuse to compose for ceased/liquidated companies
    'statuses',
    // v2 fiscal year: already exposed as a known fact via fiscal_year_start_month
    // but having the raw object lets Opus reason about brutet räkenskapsår
    'fiscalYear',
  ])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(snapshot)) {
    if (allowed.has(k)) out[k] = v
  }
  return out
}
