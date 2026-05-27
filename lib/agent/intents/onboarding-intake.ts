import { defineAgentIntent } from './types'
import { SONNET_MODEL } from '@/lib/agent/composer/client'

// onboarding.intake — Phase C "first-meeting intake" conversation. Fires
// after Phase B review/verify completes. The agent runs a real intake the
// way a new redovisningskonsult would: one question at a time, unhurried,
// shaped by the loaded vertical + modifier atoms.
//
// Phase B now only confirms the inferred facts and names the assistant — it
// no longer asks the verification questions as a form. This chat is the
// entire interview, so it carries the composer's questions as its bank.
//
// Declarative atom mode — full bodies. Intake is the highest-leverage chat
// in the company's lifetime, so we pay the cache-prefix cost once and load
// everything. The intake conversation also tends to be longer than other
// intents, so the per-user block stays hot for the duration.
//
// Plan refs: §7 Phase C, §16 ("Onboarding chat shape").

interface IntakeArgs {
  // No args — the intake is per-company and reads everything from the
  // profile. The /chat/intake route mounts AgentChat with intent_args
  // omitted; the capture below pulls the state.
  _?: never
}

interface CapturedIntake {
  agentDisplayName: string | null
  userFirstName: string | null
  companyName: string | null
  profileSummary: string | null
  // The composer's flagged uncertainties. Phase B no longer asks these as a
  // form — the chat intake is the only place they get answered, so the agent
  // treats them as its highest-leverage question bank.
  verificationQuestions: string[]
  intakeAlreadyCompleted: boolean
  // Titles of the loaded specialty atoms — used in the prompt to remind the
  // agent which industry depth it can lean on for follow-up questions.
  loadedAtomTitles: string[]
}

export const onboardingIntake = defineAgentIntent<IntakeArgs, CapturedIntake>({
  id: 'onboarding.intake',
  buttonLabel: 'Starta introduktion',
  sheetTitle: 'Introduktion',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-accounting-compliance'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  // No write tools — the intake conversation only captures memory. Specific
  // staged operations come later from other intents once the agent knows the
  // business.
  tools: [
    'gnubok_search_tools',
    'gnubok_list_skills',
    'gnubok_load_skill',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  capture: async (_args, { supabase, companyId, userId }) => {
    const [
      { data: profile },
      { data: company },
      { data: userProfile },
    ] = await Promise.all([
      supabase
        .from('agent_profiles')
        .select(
          'display_name, profile_summary, verification_questions, intake_completed_at, vertical_atoms, modifier_atoms, horizontal_atoms',
        )
        .eq('company_id', companyId)
        .maybeSingle(),
      supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
      supabase.from('profiles').select('full_name').eq('id', userId).maybeSingle(),
    ])

    const verificationQuestions =
      ((profile?.verification_questions as string[] | null) ?? []).filter(
        (q) => typeof q === 'string' && q.trim().length > 0,
      )

    const atomIds = [
      ...((profile?.vertical_atoms as string[] | null) ?? []),
      ...((profile?.modifier_atoms as string[] | null) ?? []),
    ]
    let loadedAtomTitles: string[] = []
    if (atomIds.length > 0) {
      const { data: atoms } = await supabase
        .from('agent_atom_registry')
        .select('id, title')
        .in('id', atomIds)
      loadedAtomTitles = ((atoms ?? []) as { title: string }[]).map((r) => r.title)
    }

    const fullName = (userProfile?.full_name as string | null) ?? null
    const userFirstName = fullName ? fullName.split(' ')[0] : null

    return {
      agentDisplayName: (profile?.display_name as string | null) ?? null,
      userFirstName,
      companyName: (company?.name as string | null) ?? null,
      profileSummary: (profile?.profile_summary as string | null) ?? null,
      verificationQuestions,
      intakeAlreadyCompleted: !!profile?.intake_completed_at,
      loadedAtomTitles,
    }
  },

  promptTemplate: ({ captured }) => {
    const agent = captured.agentDisplayName?.trim() || 'din bokföringsassistent'
    const user = captured.userFirstName?.trim() || null
    const lines: string[] = []

    // Identity + tone — first message the user reads should feel like a
    // person, not a form. Hedge against the agent immediately listing
    // questions: the directive below is explicit.
    lines.push(
      `Du är ${agent}. Detta är ditt allra första möte med ${user ?? 'användaren'}${captured.companyName ? ` på ${captured.companyName}` : ''}.`,
    )
    lines.push('')

    if (captured.profileSummary) {
      lines.push('Detta är vad du redan vet om verksamheten (från Bolagsverket + uppgifter användaren bekräftat):')
      lines.push(captured.profileSummary)
      lines.push('')
    }

    // The composer flagged these as the highest-leverage uncertainties. This
    // intake is the only place they get answered — weave them into the
    // conversation naturally, starting with the ones that matter most. Never
    // dump them on the user as a list.
    if (captured.verificationQuestions.length > 0) {
      lines.push('Det här är de viktigaste sakerna du fortfarande är osäker på och vill få klarhet i under samtalet (väv in dem naturligt, en i taget, börja med de viktigaste):')
      for (const q of captured.verificationQuestions) lines.push(`  • ${q}`)
      lines.push('')
    }

    if (captured.loadedAtomTitles.length > 0) {
      lines.push(`Dina laddade specialiteter ger dig djup för branschspecifika följdfrågor: ${captured.loadedAtomTitles.join(', ')}.`)
      lines.push('Använd dem för att forma 3–7 frågor som hjälper dig förstå verksamheten på riktigt — det som en ny redovisningskonsult skulle vilja veta vid första mötet.')
      lines.push('')
    }

    // Operational guidance. Keep it firm: one question at a time, not a
    // wall. Persist via memory. End naturally — don't force a "complete"
    // signal. Plan §7: "If the user wants to skip: they close the sheet."
    lines.push('Hur du genomför mötet:')
    lines.push('• Inled med en kort, varm hälsning — presentera dig kort. Inget formellt, inga punktlistor.')
    lines.push('• Ställ EN fråga i taget och vänta in svaret. Aldrig en mur av frågor.')
    lines.push('• Lyssna ordentligt. Följ upp naturligt — en intresserad fördjupande följdfråga är ofta värt mer än nästa nya fråga.')
    lines.push('• När användaren säger något betydelsefullt (återkommande kund, hyresavtal, lönepolicy, anställda du inte visste om, kunder utomlands…) — spara det med gnubok_remember_fact med source_ref="onboarding_intake" och relevance_score 0.9. Berätta inte att du sparar; gör det tyst.')
    lines.push('• Behöver du djupare branschkunskap för en följdfråga? Använd gnubok_load_skill på rätt atom.')
    lines.push('• Sikta på 5–10 frågor totalt över hela samtalet. Inte mer. Bättre färre, men bra.')
    lines.push('• Avsluta naturligt när du har en bra bild — säg att ni kan fortsätta nästa gång ni ses i bokföringen, och att du kommer minnas det här samtalet.')
    lines.push('')

    lines.push('Svara på svenska. Ditt första meddelande ska vara hälsningen + första frågan. Skriv det nu.')

    return lines.join('\n')
  },
})
