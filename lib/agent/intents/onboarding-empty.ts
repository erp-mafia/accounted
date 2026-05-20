import { defineAgentIntent } from './types'
import { SONNET_MODEL } from '@/lib/agent/composer/client'

// onboarding.empty — "Hjälp mig komma igång" on an empty-state page
// (no transactions, no customers, no invoices, etc.).
//
// Progressive atom mode — keeps the prompt small so the agent can fan out
// to whichever horizontal skill matches the empty area. Captures the route
// + subject so the agent knows whether to talk about banking connection,
// invoice creation, customer setup, etc.

interface OnboardingEmptyArgs {
  // The route the user is on, e.g. '/transactions', '/customers'. Optional.
  route?: string | null
  // The subject of the empty state, e.g. 'transactions', 'customers',
  // 'invoices'. Optional — derived from route when absent.
  subject?: string | null
}

interface CapturedOnboardingEmpty {
  route: string | null
  subject: string | null
}

export const onboardingEmpty = defineAgentIntent<OnboardingEmptyArgs, CapturedOnboardingEmpty>({
  id: 'onboarding.empty',
  buttonLabel: 'Visa mig hur jag kommer igång',
  sheetTitle: 'Komma igång',

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

  capture: async ({ route, subject }) => ({
    route: route ?? null,
    subject: subject ?? deriveSubject(route ?? null),
  }),

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push(
      `Användaren är på en tom sida${captured.subject ? ` för ${captured.subject}` : ''} och vill komma igång.`,
    )
    if (captured.route) lines.push(`Route: ${captured.route}`)
    lines.push('')
    lines.push(
      'Förklara kort vad sidan är till för och vilka 1–2 nästa steg som ger mest värde för just denna användare. Var konkret. Svara på svenska.',
    )
    return lines.join('\n')
  },
})

function deriveSubject(route: string | null): string | null {
  if (!route) return null
  if (route.startsWith('/transactions')) return 'transaktioner'
  if (route.startsWith('/customers')) return 'kunder'
  if (route.startsWith('/invoices')) return 'kundfakturor'
  if (route.startsWith('/supplier-invoices')) return 'leverantörsfakturor'
  if (route.startsWith('/bookkeeping')) return 'bokföring'
  if (route.startsWith('/assets')) return 'anläggningstillgångar'
  if (route.startsWith('/reports')) return 'rapporter'
  if (route.startsWith('/salary')) return 'löner'
  return null
}
