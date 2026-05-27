import { getAnthropic, OPUS_MODEL } from './client'
import { AtomSelectionSchema, ATOM_SELECTION_TOOL_SCHEMA, type AtomSelection } from './schemas'
import type { ComposerInputs } from './inputs'

const SYSTEM_PROMPT = `Du komponerar en specialiserad svensk bokföringsassistent åt ett företag.

Du får:
- Företagets TIC-snapshot från Bolagsverket / Lens API. Inkluderar utöver grundfält (org-nummer, juridisk form, SNI, F-skatt/moms/arbetsgivarregistrering, anställdaintervall, omsättningsintervall, verksamhetsbeskrivning, senaste finansiella rapporter):
  - statuses[]: nuvarande och historiska bolagsstatus med trafikljus (red/yellow/green/neutral) och isCeased-flagga. Om isCeased eller red: kompositionen ska FORTSÄTTA men nämn det i uncertainty_notes.
  - signatory[]: firmateckningsregler i fritext ("Firman tecknas av styrelsen", "två i förening", "av en ledamot ensam"). En enda ledamot som tecknar ensam pekar starkt mot enpersonsbolag.
  - board: styrelsesammansättning — numberOfBoardMembers, numberOfDeputyBoardMembers, hasVacancy. Mer än 1 ledamot utan suppleant pekar bort från enpersonsmodifier.
  - representatives[]: aktiva personer (CEO, ledamöter, revisor) med positionType. Räkna unika personer för ownership-signal.
  - beneficialOwners[]: verklig huvudman per Bolagsverket. AUKTORITATIV ägarstrukturkälla. En enda namngiven owner = bekräftat enpersonsbolag. Två eller fler = multi-owner; välj INTE single-shareholder-ab-fmb.
  - payrolls[]: faktiska lönefilingar (payroll2-array per period med antal anställda + summa preliminärskatt). Om TOM trots att registration.payroll = true: arbetsgivaren är registrerad men har inte faktiskt betalat lön ännu. Välj INTE swedish-payroll i det läget — felaktig signal från statisk registrering är vanlig för nystartade AB.
  - fiscalYear: nuvarande räkenskapsårskonfiguration med startMonthDay/endMonthDay. Brutet räkenskapsår (annat än 01-01/12-31) är vanligt i konsult-AB och påverkar bokslut-atomvalet.
- KÄNDA FAKTA från företagets inställningar — saker användaren redan har angett (momsperiod, räkenskapsår, F-skatt-status, anställda, bokföringsmetod)
- Eventuell sammanfattning från importerad SIE-fil (topp-konton, topp-motparter, antal år)
- Eventuell sammanfattning från bankhistorik. Varje topp-motpart har:
  - belopp i kr (abs)
  - riktning: 'in' (intäkt/inbetalning), 'ut' (kostnad/utbetalning), eller 'in+ut'
  - bokföringsstatus: 'OBOKFÖRD' (minst en transaktion ej bokförd) eller 'bokförd'
  KRITISKT: ställ INTE en verifieringsfråga om en motpart där riktningen är entydig OCH alla transaktioner är bokförda. T.ex. en motpart märkt "(ut, bokförd)" är redan klassad som kostnad och redan kategoriserad. Att fråga "är detta en intäkt eller kostnad?" är fel. Fokusera frågorna på OBOKFÖRD-motparter där det finns en bokningsbeslutning kvar att fatta.
- Ett register över tillgängliga atomer (horizontal/vertical/modifier) med beskrivning, SNI-prefix och utlösare

Din uppgift:
1. Välj ALLA horisontella atomer som är relevanta för verksamheten. De flesta företag behöver swedish-vat, swedish-invoice-compliance och swedish-year-end-closing. Lägg till swedish-payroll BARA om payrolls[] visar faktiska filingar (icke-tom payroll2-array) ELLER KÄNDA FAKTA bekräftar pågående löneutbetalning — inte enbart för att registration.payroll = true. Lägg till SRU/financial-reporting för AB. Lägg till asset-accounting om SIE visar 12xx-konton. Lägg till project-accounting om signalerna pekar mot tjänsteföretag med projekt. Lägg till tax-planning för aktiebolag.
2. Välj noll, en eller flera vertikala atomer (industri) baserat på SNI-prefix, verksamhetsbeskrivning och motpartsmönster. Tomt om ingen passar.
3. Välj modifier-atomer som faktiskt är sanna:
   - single-shareholder-ab-fmb: VÄLJ när beneficialOwners[] har exakt en person OCH legal form = AB. Avstå annars (även om bolaget "ser litet ut").
   - enskild-firma: om EF.
   - small-employer: om payrolls[] visar 1–9 anställda i senaste filing.
4. is_multi_vertical = true endast om företaget faktiskt har två etablerade affärsben.
5. Skriv 3-6 korta svenska verifieringsfrågor som användaren behöver bekräfta — fokusera på de högsta osäkerheterna.

   KRITISKT: Ställ INTE frågor vars svar redan finns i KÄNDA FAKTA eller TIC-snapshot. Användaren har redan sagt detta. Att fråga igen är slöseri med deras tid.
     - Om "Momsperiod" finns i KÄNDA FAKTA: fråga inte om momsperiod
     - Om "Anställda" finns i KÄNDA FAKTA: fråga inte om anställda
     - Om TIC visar F-skatt/momsregistrering: fråga inte om det
     - Om beneficialOwners[] finns: fråga INTE "vem äger bolaget?" eller "är du ensamägare?" — det är redan auktoritativt besvarat
     - Om payrolls[] visar antal anställda: fråga INTE "hur många anställda?"
     - Om fiscalYear finns: fråga INTE om räkenskapsårsstart/slut
     - Om SNI-koder finns: fråga inte om branschen i allmänhet, men du KAN fråga om en specifik nyans (t.ex. "Säljer ni mest 25%- eller 12%-momsvaror?")

   Fokusera istället på frågor vars svar du inte kan se: specifika balansposter (t.ex. "Vad gäller ALMI-beloppet, lån eller bidrag?"), arbetssätt (faktureringscadens, kund-geografi), planerade förändringar (kommande löneutbetalning, expansion, fastighetsförvärv).

6. Skriv 1-3 svenska uncertainty_notes till utvecklaren som granskar valet senare. Inkludera explicit notering om statuses[] visar isCeased eller red-status.

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
    // Drop unknown IDs rather than failing — composer can still produce a
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

  return parsed.data
}

// Drops questions whose answer is already settled in company_settings or
// TIC snapshot. Each question is matched against keyword patterns —
// keep this conservative so we never accidentally drop a legitimate
// nuance question (e.g. "Säljer ni mest 25%- eller 12%-momsvaror?" is
// kept even when moms_period is known, because it's about VAT RATE not
// VAT PERIOD).
//
// Exported so the stream endpoint can re-apply it to fallback selections too
// — fallbackAtomSelection generates questions from a template that doesn't
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
  const knowsEmployees = s?.has_employees != null || s?.employee_count != null || !!tic?.employeeRange
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
    // bolaget"…) — drop when EITHER the single-shareholder modifier is set
    // OR Bolagsverket's beneficial-owner register confirms a single owner.
    if (
      knowsOwnershipSingle &&
      /(ensamägare|enda ägare|majoriteten av aktierna|vem äger|aktieägare|fåmansbolag.*ensam|verksam i bolaget.*ensam)/.test(
        lower,
      )
    ) {
      return false
    }
    // Verklig huvudman — if TIC says we have owners, don't ask who they are.
    if (knowsOwners && /(verklig huvudman|huvudmän)/.test(lower)) {
      return false
    }

    // Moms period — "månad/kvartal/år" all together is the giveaway.
    if (
      knowsMomsPeriod &&
      lower.includes('momsperiod') &&
      (lower.includes('månad') || lower.includes('kvartal') || lower.includes('år'))
    ) {
      return false
    }

    // Employees — pattern "har bolaget anställda" or "har du anställda".
    if (knowsEmployees && /har\s+(bolaget|du|ni|företaget)\s+anställda/.test(lower)) {
      return false
    }

    // Fiscal year — "räkenskapsår" + ("januari"|"month names"|"börjar").
    if (knowsFiscalYear && lower.includes('räkenskapsår') && /(börjar|januari|kalenderår|brutet)/.test(lower)) {
      return false
    }

    // F-skatt — "är bolaget registrerat för f-skatt" type questions.
    if (knowsFSkatt && /f[-\s]?skatt/.test(lower) && /(registrerad|registrerat|aktiv)/.test(lower)) {
      return false
    }

    // VAT registration — "är ni momsregistrerade" type questions.
    if (knowsVatRegistered && /(momsregistrerad|registrerade?\s+för\s+moms)/.test(lower)) {
      return false
    }

    // Accounting method — "fakturametoden eller kontantmetoden".
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
  lines.push(`Juridisk form (gnubok): ${inputs.entityType}`)
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
      lines.push('Topp-konton (abs-belopp):')
      for (const a of inputs.sieSummary.top_accounts.slice(0, 20)) {
        lines.push(`  ${a.account.padEnd(8)} ${Math.round(a.abs_amount).toLocaleString('sv-SE')} kr`)
      }
    }
    if (inputs.sieSummary.top_counterparties.length > 0) {
      lines.push('Topp-motparter (från transaktionsbeskrivningar):')
      for (const c of inputs.sieSummary.top_counterparties.slice(0, 10)) {
        lines.push(`  ${c.name} — ${Math.round(c.abs_amount).toLocaleString('sv-SE')} kr`)
      }
    }
    lines.push('')
  }

  if (inputs.bankingSummary) {
    lines.push(`# Banktransaktioner (12 mån)`)
    if (inputs.bankingSummary.monthly_volume != null) {
      lines.push(
        `Snittvolym per månad: ${Math.round(inputs.bankingSummary.monthly_volume).toLocaleString('sv-SE')} kr`,
      )
    }
    lines.push(
      `Antal obokförda transaktioner: ${inputs.bankingSummary.unbooked_count}`,
    )
    if (inputs.bankingSummary.top_counterparties.length > 0) {
      lines.push('Topp-motparter (riktning + bokföringsstatus):')
      for (const c of inputs.bankingSummary.top_counterparties.slice(0, 20)) {
        // direction tells Opus whether this counterparty is a source of
        // income, a cost, or both. has_unbooked says whether there's still
        // a transaction waiting for the user to book — only those are
        // legitimate verification-question fodder.
        const dirLabel =
          c.direction === 'in' ? 'in' : c.direction === 'out' ? 'ut' : 'in+ut'
        const bookedLabel = c.has_unbooked ? 'OBOKFÖRD' : 'bokförd'
        lines.push(
          `  ${c.name}: ${Math.round(c.abs_amount).toLocaleString('sv-SE')} kr (${dirLabel}, ${bookedLabel})`,
        )
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
    lines.push('(inga vertikala atomer i registret ännu — välj alltid en tom array)')
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
    lines.push('(inga modifier-atomer i registret ännu — välj alltid en tom array)')
  } else {
    for (const a of modifiers) {
      lines.push(`- ${a.id}: ${a.description.slice(0, 240)}`)
    }
  }

  return lines.join('\n')
}

// Surfaces user-settled facts in a tight bullet list the composer can scan
// before generating questions. Anything in here is OFF-LIMITS for the
// verification_questions list — the user already said it.
function buildKnownFacts(inputs: ComposerInputs): string[] {
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
    if (s.has_employees != null || s.employee_count != null) {
      const ec = s.employee_count
      if (typeof ec === 'number') {
        out.push(`Anställda: ${ec}`)
      } else if (s.has_employees != null) {
        out.push(`Anställda: ${s.has_employees ? 'ja' : 'nej'}`)
      }
    }
    if (s.pays_salaries != null) {
      out.push(`Betalar ut lön: ${s.pays_salaries ? 'ja' : 'nej'}`)
    }
    if (s.accounting_method) {
      out.push(`Bokföringsmetod: ${s.accounting_method}`)
    }
    if (s.city) {
      out.push(`Säte: ${s.city}`)
    }
  }
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
      // Verklig huvudman per Bolagsverket — authoritative ownership data.
      // Composer must NOT ask "are you the sole owner?" when this is set.
      const owners = tic.beneficialOwners
        .map((o) => {
          const extent = o.extentDescription ?? o.extentCode ?? ''
          return extent ? `${o.name} (${extent})` : o.name
        })
        .join('; ')
      out.push(
        `Verkliga huvudmän (Bolagsverket): ${owners}${tic.beneficialOwners.length === 1 ? ' — ensam ägare' : ''}`,
      )
    }
  }
  return out
}

// Drop fields from the TIC snapshot that the composer doesn't need and that
// inflate token count or carry PII unnecessarily. After the v2 migration we
// include the new ownership/governance/payroll sections — these change atom
// selection materially (payroll signal goes from "is registered" to "has
// actual filings"; ownership signal goes from heuristic to authoritative).
// Excluded: bankAccounts, email, phone, fiscalYearHistory, financialReports
// — high token cost, low atom-selection signal.
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
    // v2 governance + ownership — settles redundant questions deterministically
    'beneficialOwners',
    'signatory',
    'board',
    'representatives',
    // v2 payroll history — distinguishes "registered" vs "has actually filed"
    'payrolls',
    // v2 status entries — refuse to compose for ceased/liquidated companies
    'statuses',
    // v2 fiscal year — already exposed as a known fact via fiscal_year_start_month
    // but having the raw object lets Opus reason about brutet räkenskapsår
    'fiscalYear',
  ])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(snapshot)) {
    if (allowed.has(k)) out[k] = v
  }
  return out
}
