import { getAnthropic, SONNET_MODEL } from './client'
import type { AtomSelection } from './schemas'
import type { ComposerInputs } from './inputs'

const SYSTEM_PROMPT = `Du skriver en kort, varm svensk introduktion från en specialiserad bokföringsassistent.

Stil:
- Max 120 ord, två-tre meningar är ofta nog.
- Andra person: "Du driver…", "Din verksamhet…".
- Saklig och konkret — inga floskler, inga utropstecken, inga emoji.
- Texten ska VISA att du har läst företagets uppgifter och ÅTERSPEGLA dem för bekräftelse.

Struktur:
1. Återspegla verksamheten med EGNA ORD baserat på SNI-koder och verksamhetsbeskrivning. Exempel: "Jag ser att du driver Torsken & Co AB som handlar med drycker, framför allt alkoholdrycker." Använd verksamhetsbeskrivningen ordagrant bara om den är mycket kort.
2. Avsluta med en bekräftelsefråga som låter användaren rätta dig om något inte stämmer. Exempel: "Stämmer det?" eller "Är det ungefär så ni jobbar?".

Skriv endast själva texten. Ingen rubrik, inga punktlistor.`

export async function writeNarrative(
  inputs: ComposerInputs,
  selection: AtomSelection,
): Promise<string> {
  const anthropic = getAnthropic()

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
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
      // confirming voice — pass it verbatim so the model can paraphrase.
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
