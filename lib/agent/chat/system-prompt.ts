import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import type { AgentIntent } from '../intents/types'

// Builds the system prompt the chat loop sends to Anthropic.
//
// Order matters (plan §10 — caching strategy):
//
//   Block 1 — shared atom bodies (or metadata index)  ← cache_control ttl=1h
//   Block 2 — identity + profile + ranked memory       ← cache_control ttl=1h
//
// Block 1 hits across all users that share the same loadout (e.g. all
// konsult-IT single-shareholder AB users). Block 2 hits across all turns
// for one user until memory or profile change. Two breakpoints, well under
// Anthropic's 4-breakpoint hard limit.

export interface PromptBlocks {
  // Anthropic SDK content-block array suitable for the `system` parameter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[]
  // SHA-256 hex of the canonical block content. Stamped on
  // pending_operations.agent_metadata.prompt_hash so a future BFL audit can
  // reconstruct what the model was looking at when it staged a write.
  promptHash: string
  // Atom IDs whose bodies are in Block 1 (or whose metadata is, for
  // progressive disclosure). Recorded on the same agent_metadata row.
  atomsLoaded: string[]
}

interface BuildArgs {
  intent: AgentIntent
  companyId: string
  companyName: string
  firstName: string | null
  profileSummary: string | null
  rankedMemory: { content: string; kind: string }[]
  supabase: SupabaseClient
}

export async function buildSystemPrompt(args: BuildArgs): Promise<PromptBlocks> {
  const block1 = await buildAtomBlock(args)
  const block2 = buildIdentityBlock(args)

  const blocks = [
    {
      type: 'text' as const,
      text: block1.body,
      cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
    },
    {
      type: 'text' as const,
      text: block2,
      cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
    },
  ]

  const hash = createHash('sha256')
  hash.update(block1.body)
  hash.update('\n---\n')
  hash.update(block2)

  return {
    blocks,
    promptHash: `sha256:${hash.digest('hex')}`,
    atomsLoaded: block1.atomsLoaded,
  }
}

async function buildAtomBlock(
  args: BuildArgs,
): Promise<{ body: string; atomsLoaded: string[] }> {
  const { intent, supabase, companyId } = args

  if (intent.atoms.mode === 'progressive') {
    // Metadata-only Block 1: keeps cache prefix small enough to share across
    // many user loadouts. Bodies pulled on demand via gnubok_load_skill.
    const { data: rows } = await supabase
      .from('agent_atom_registry')
      .select('id, title, description')
      .eq('is_active', true)
      .order('id')

    const lines: string[] = []
    lines.push('# Din kunskapsbas — översikt')
    lines.push('')
    lines.push(
      'Du har följande färdighetsatomer tillgängliga. Innehållet i varje atom är INTE laddat — anropa gnubok_load_skill(skill_id) när du behöver djup i ett ämne.',
    )
    lines.push('')
    for (const row of (rows ?? []) as { id: string; title: string; description: string }[]) {
      lines.push(`- **${row.id}** (${row.title}): ${row.description.slice(0, 240)}`)
    }
    return { body: lines.join('\n'), atomsLoaded: (rows ?? []).map((r: { id: string }) => r.id) }
  }

  // Declarative mode — load full atom bodies from disk.
  const ids = await resolveDeclarativeAtomIds(supabase, intent, companyId)

  const repoRoot = process.cwd()
  const sections: string[] = []
  for (const id of ids) {
    const path = await resolveBodyPath(supabase, id)
    if (!path) continue
    try {
      const body = await readFile(join(repoRoot, path), 'utf8')
      sections.push(body)
    } catch {
      // Missing body file — skip silently.
    }
  }

  return { body: sections.join('\n\n---\n\n'), atomsLoaded: ids }
}

async function resolveDeclarativeAtomIds(
  supabase: SupabaseClient,
  intent: AgentIntent,
  companyId: string,
): Promise<string[]> {
  const ids: string[] = intent.atoms.horizontal.map((slug) => `horizontal/${slug}`)

  if (intent.atoms.includeCompanyVertical || intent.atoms.includeCompanyModifiers) {
    const { data: profile } = await supabase
      .from('agent_profiles')
      .select('vertical_atoms, modifier_atoms')
      .eq('company_id', companyId)
      .maybeSingle()
    if (profile) {
      if (intent.atoms.includeCompanyVertical) {
        ids.push(...((profile.vertical_atoms as string[] | null) ?? []))
      }
      if (intent.atoms.includeCompanyModifiers) {
        ids.push(...((profile.modifier_atoms as string[] | null) ?? []))
      }
    }
  }

  return [...new Set(ids)]
}

async function resolveBodyPath(supabase: SupabaseClient, id: string): Promise<string | null> {
  const { data } = await supabase
    .from('agent_atom_registry')
    .select('body_path, is_active')
    .eq('id', id)
    .maybeSingle()
  if (!data || data.is_active === false) return null
  return (data.body_path as string) ?? null
}

function buildIdentityBlock(args: BuildArgs): string {
  const { intent, companyName, firstName, profileSummary, rankedMemory } = args

  const lines: string[] = []
  lines.push('# Din roll')
  lines.push('')
  const owner = firstName ? `${firstName}s` : 'användarens'
  lines.push(
    `Du är ${owner} specialiserade bokföringsassistent för ${companyName}. Du svarar alltid på svenska. Du är direkt, korrekt och kortfattad. Du föreslår — du beslutar inte. Skrivåtgärder stageas via verktyg och godkänns av användaren i gnubok.`,
  )
  lines.push('')

  // Formatting rules — the chat surface is narrow (sheet ≈ 420px). Markdown
  // tables compress to pipe-soup and tend to come out malformed when written
  // mid-stream. Force bullet lists instead and reserve code formatting for
  // identifiers, never multi-line bookföring previews (those go through the
  // staged approval card, not chat prose).
  lines.push('# Svarsformat')
  lines.push('')
  lines.push('KORTHET ÄR REGEL NUMMER ETT. Användaren är företagare, inte revisor, och sitter i en smal chattruta. Skriv som en kunnig kollega som svarar snabbt, inte som en lärobok.')
  lines.push('- Sikta på 2-4 meningar. Behöver du en lista, max 3-4 korta punkter. Längre än så bara om användaren uttryckligen ber om en utförlig förklaring.')
  lines.push('- LEDA MED SVARET eller åtgärden. Ingen uppvärmning ("Här är vad som gäller för den här typen av utlägg…", "Låt mig förklara…"). Säg slutsatsen först.')
  lines.push('- Förklara INTE hela regelverket eller räkna momsen steg för steg i prosa. Ge slutsatsen och en kort mening om varför. Användaren litar på att du kan reglerna, den vill inte läsa härledningen.')
  lines.push('- Bokföringsförslag (rader, konton, momsbelopp) visas i godkännande-kortet — repetera dem ALDRIG i texten. Skriv inte ut momsuträkningar som "370 / 1,25 × 0,25 = 74 kr"; kortet visar beloppen.')
  lines.push('- Ställ en fråga i taget när du behöver något. Klumpa inte ihop flera frågor med förklaringar emellan.')
  lines.push('- ANVÄND ALDRIG markdown-tabeller (|...|) i chattsvar, utrymmet är smalt och formatet bryts. Använd punktlista eller löpande text.')
  lines.push('- ANVÄND ALDRIG långt tankstreck (—) eller halvlångt streck (–). Använd kort bindestreck (-), kommatecken eller börja ny mening istället. Detta är en hård regel: även när du tycker att ett tankstreck "läser bättre", använd kommatecken eller punkt.')
  lines.push('- Använd `kod`-formatering bara för korta identifierare (kontonummer, fältnamn). Undvik tre-backtick block för prosa.')
  lines.push('- Lämna ett mellanslag mellan meningar.')
  lines.push('')

  // First-message ritual. Makes the assistant feel co-present with the user
  // on the page they're on — "jag ser att du tittar på X" — instead of a
  // generic "Hej! Hur kan jag hjälpa dig?" that could be from any chatbot.
  // The bonus effect is anchoring: the user is gently primed to keep the
  // conversation on the visible entity rather than drifting.
  //
  // Only fires on the first assistant turn of a conversation. The model
  // detects "first turn" from message history (no prior assistant message).
  // On subsequent turns we explicitly forbid re-greeting so it doesn't
  // start every response with "Hej Antonia, du tittar fortfarande på…".
  lines.push('# Första svaret i en ny konversation')
  lines.push('')
  const greetName = firstName ?? 'där'
  lines.push(
    `När du svarar på det ALLRA FÖRSTA meddelandet i en konversation (ingen tidigare assistent-tur i historiken): börja med EN mening som hälsar användaren vid namn och bekräftar konkret vad du ser hen håller på med — sidan, transaktionen, fakturan, perioden, leverantören. Det är så användaren märker att du "tittar med".`,
  )
  lines.push('')
  lines.push(
    `Mall: "Hej ${greetName}, jag ser att du [konkret observation från det laddade kontextet]." Sedan kommer själva svaret direkt efter, utan tom rad mellan.`,
  )
  lines.push('')
  lines.push(
    'På efterföljande turn:s i samma konversation — INGEN ny hälsning, ingen ny "jag ser att…"-mening. Svara direkt på frågan. Hälsa bara en gång.',
  )
  lines.push('')

  // Anti-hallucination guardrail. Without this the agent calls
  // gnubok_search_tools (or recalls atom IDs from training), sees the wider
  // MCP catalog, and then claims access to tools that aren't in this
  // intent's whitelist. The tools-parameter the model receives via the
  // Anthropic API is the canonical source of truth — anything outside it
  // is reachable from *other* gnubok surfaces, not from here.
  lines.push('# Verktyg')
  lines.push('')
  lines.push('Verktygen du kan anropa just nu är EXAKT de som ligger i din tools-parameter — varken fler eller färre. Om du har sett andra verktygsnamn via gnubok_search_tools eller gnubok_list_skills så finns de i systemet, men de är inte anropbara från denna ingång. Påstå aldrig att du har ett verktyg som inte ligger i tools-parametern.')
  lines.push('')
  lines.push('När användaren frågar "vad kan du?" / "vilka verktyg har du?": svara i förmågor (vad du faktiskt kan hjälpa till med här), inte i API-namn. Lista inte tekniska verktygsnamn som du sett via search_tools om de inte ligger i din nuvarande tools-lista.')
  lines.push('')
  lines.push('När en uppgift kräver ett verktyg du inte har: hänvisa användaren till rätt vy i gnubok där motsvarande knapp har rätt verktyg inkopplat (t.ex. en transaktionsrad, /invoices/new, /bookkeeping/year-end). Säg vart de ska gå — försök inte fejka åtgärden.')
  lines.push('')
  lines.push('När du HAR rätt verktyg — använd dem. Gissa aldrig siffror när ett läsverktyg kan hämta dem; gissa aldrig en kategori när gnubok_query_journal kan visa hur motparten bokfördes förut.')
  lines.push('')

  if (profileSummary) {
    lines.push('# Företagets profil')
    lines.push('')
    lines.push(profileSummary)
    lines.push('')
  }

  if (rankedMemory.length > 0) {
    lines.push('# Vad du minns om företaget')
    lines.push('')
    for (const m of rankedMemory) {
      lines.push(`- (${m.kind}) ${m.content}`)
    }
    lines.push('')
  }

  lines.push('# Aktuell uppgift')
  lines.push('')
  lines.push(`Intent: ${intent.id}`)
  lines.push(`Sheet-titel: ${intent.sheetTitle}`)
  if (intent.atoms.mode === 'progressive') {
    lines.push(
      'Atomer i översiktsläge. När en fråga kräver djup — använd gnubok_load_skill(skill_id) för att hämta den fullständiga atomen.',
    )
  } else {
    lines.push('Atomer förladdade. Använd dem direkt utan att hämta dem på nytt.')
  }

  return lines.join('\n')
}
