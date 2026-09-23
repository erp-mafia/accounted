import { defineAgentIntent } from './types'
import { SONNET_MODEL } from '@/lib/agent/composer/client'

// settings.help: "Vad gör den här inställningen?" from a settings panel.
//
// Light-touch intent: progressive disclosure of atoms (the agent loads
// what it needs via gnubok_load_skill) keeps the system prompt cheap.
// The capture is just which settings panel the user is on.

interface SettingsHelpArgs {
  // Panel slug, e.g. 'invoicing', 'tax', 'bookkeeping', 'banking', 'team'.
  panel?: string | null
}

interface CapturedSettingsHelp {
  panel: string | null
}

export const settingsHelp = defineAgentIntent<SettingsHelpArgs, CapturedSettingsHelp>({
  id: 'settings.help',
  buttonLabel: 'Förklara dessa inställningar',
  sheetTitle: 'Hjälp med inställningar',

  atoms: {
    mode: 'progressive',
    horizontal: [],
    includeCompanyVertical: false,
    includeCompanyModifiers: false,
  },

  tools: [
    'gnubok_search_tools',
    'gnubok_list_skills',
    'gnubok_load_skill',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  capture: async ({ panel }) => ({ panel: panel ?? null }),

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push(
      `Användaren är i en inställningspanel${captured.panel ? ` (${captured.panel})` : ''} och vill förstå vad valen påverkar.`,
    )
    lines.push('')
    lines.push('Vänta in användarens fråga. Om de inte säger något, börja med en kort sammanfattning av panelens syfte. Var direkt och svara på svenska.')
    return lines.join('\n')
  },
})
