import { getAnthropic, SONNET_MODEL } from './client'
import type { AtomSelection } from './schemas'
import type { ComposerInputs } from './inputs'

// Two voices: second-person ownership ("Du driver…") only when BankID
// CompanyRoles has confirmed the active user holds a director-like position
// at this company. Otherwise we use neutral third-person ("Coredination AB
// är…") so manual-orgnr signups (accountant-on-behalf-of, employees,
// family members setting up a parent's company) don't get a narrative
// presuming they personally own the company. Same content, different voice.
const SHARED_PROMPT_HEADER = `Du skriver en kort, saklig profil av ett företag. Profilen visas för användaren under rubriken "Profil" och används som bakgrund åt en bokföringsassistent. Den är INTE en hälsning och INTE ett chattmeddelande.

Stil:
- Max 80 ord, två till tre meningar.
- Saklig och konkret. Inga floskler, inga utropstecken, inga emoji, ingen avslutande fråga ("Stämmer det?").
- Skriv ALDRIG i jag-form ("Jag ser att…"). Det är en beskrivning, inte assistenten som talar.
- Använd ALDRIG tankstreck (— eller –). Använd kommatecken, punkt eller skriv "till" för intervall ("2,5 till 5 miljoner"). Hård regel.

Innehåll:
1. Beskriv verksamheten med egna ord utifrån SNI-koder och verksamhetsbeskrivning: vad företaget gör, juridisk form och ägarbild om den är känd. Återge inte verksamhetsbeskrivningen ordagrant: den visas redan separat under "Verksamhet".
2. Avsluta med en mening om vad assistenten är inställd på att hjälpa till med för den här typen av verksamhet, utifrån de valda specialiteterna.

Skriv endast själva profiltexten. Ingen rubrik, inga punktlistor.`

const VOICE_DIRECTOR = `\n\nRöst: Andra person, ägar-/ledningsperspektiv. "Du driver…", "Din verksamhet…". Användaren är verifierad styrelseledamot eller firmatecknare i bolaget.`

const VOICE_NEUTRAL = `\n\nRöst: Tredje person, neutral. "Coredination AB är…", "Bolaget bedriver…". Användaren kan vara ägare, anställd eller redovisningskonsult: vi vet inte. Skriv ALDRIG "Du driver…", "Din verksamhet…" eller andra formuleringar som antar att användaren själv äger eller leder bolaget. Använd företagsnamnet eller "Bolaget".`

function systemPromptFor(userIsConfirmedDirector: boolean): string {
  return SHARED_PROMPT_HEADER + (userIsConfirmedDirector ? VOICE_DIRECTOR : VOICE_NEUTRAL)
}

export async function writeNarrative(
  inputs: ComposerInputs,
  selection: AtomSelection,
): Promise<string> {
  const anthropic = getAnthropic()

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 400,
    system: systemPromptFor(inputs.userIsConfirmedDirector),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(inputs, selection),
      },
    ],
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  return text
}

function buildUserPrompt(inputs: ComposerInputs, selection: AtomSelection): string {
  const lines: string[] = []
  lines.push(`Företag: ${inputs.companyName}`)
  lines.push(`Juridisk form: ${inputs.entityType}`)

  if (inputs.ticSnapshot) {
    const tic = inputs.ticSnapshot as Record<string, unknown>
    const sni = (tic.sniCodes as { code: string; name: string }[] | undefined) ?? []
    if (sni.length > 0) {
      lines.push(`SNI: ${sni.map((s) => `${s.code} ${s.name}`).join('; ')}`)
    }
    if (typeof tic.purpose === 'string' && tic.purpose.trim().length > 0) {
      // Verksamhetsbeskrivning is the most important signal for the
      // confirming voice: pass it verbatim so the model can paraphrase.
      lines.push(`Verksamhetsbeskrivning (Bolagsverket): ${tic.purpose as string}`)
    }
    const reg = tic.registration as { fTax?: boolean; vat?: boolean; payroll?: boolean } | undefined
    if (reg) {
      const flags = [
        reg.fTax ? 'F-skatt' : null,
        reg.vat ? 'momsregistrerad' : null,
        reg.payroll ? 'arbetsgivare' : null,
      ].filter(Boolean)
      if (flags.length > 0) lines.push(`Registreringar: ${flags.join(', ')}`)
    }
    if (tic.employeeRange) lines.push(`Anställda: ${tic.employeeRange as string}`)
    if (tic.turnoverRange) lines.push(`Omsättning: ${tic.turnoverRange as string}`)
    const owners = tic.beneficialOwners as
      | { name: string; extentDescription?: string | null }[]
      | undefined
    if (Array.isArray(owners) && owners.length > 0) {
      const names = owners.map((o) => o.name).join(', ')
      lines.push(
        `Verkliga huvudmän: ${names}${owners.length === 1 ? ' (ensam ägare)' : ''}`,
      )
    }
  }

  if (inputs.sieSummary && inputs.sieSummary.top_accounts.length > 0) {
    const top = inputs.sieSummary.top_accounts.slice(0, 5)
    lines.push(`Topp-konton i SIE: ${top.map((a) => a.account).join(', ')}`)
  }

  lines.push('')
  lines.push(`Valda horizontals: ${selection.horizontal_atoms.join(', ') || '(inga)'}`)
  lines.push(`Valda verticals: ${selection.vertical_atoms.join(', ') || '(inga)'}`)
  lines.push(`Valda modifiers: ${selection.modifier_atoms.join(', ') || '(inga)'}`)

  return lines.join('\n')
}
