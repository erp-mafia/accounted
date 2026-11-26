import type { ReactNode } from 'react'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import { hasBankFeed } from '@/lib/onboarding/checklist'
import { roleMayWrite } from '@/lib/auth/role-may-write'
import { loadAiClientsBoundTo } from '@/lib/onboarding/ai-clients.server'
import { createdOnOrAfter, isNewCompany, pickFirstThing } from '@/lib/onboarding/first-thing'
import { hemFirstThingCreatedFrom } from '@/lib/onboarding/first-thing-rollout'
import { createServiceClient } from '@/lib/supabase/server'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { createLogger } from '@/lib/logger'
import { walkQuestions } from '@/lib/onboarding/question-first'
import { listAppQuestions } from '@/lib/questions/app-answer'
import { getWorklistCounts } from '@/lib/worklist'
import type { UserUiState } from '@/types'
import { countCompletedSieImports, countTransactions, readActiveBankConnections } from './hem-reads'
import { getDashboardAuthContext, getDashboardCompanyMemberships, getDashboardSettings } from './request-context'

const log = createLogger('hem-question-first')

/**
 * Hem for a person in the first-thing rollout: a new company opens on one
 * named first thing (components/dashboard/HemFirstThing) under the notice
 * line, after the open questions when the company has the question list
 * (components/dashboard/HemQuestionFirst); every other case, and a person who closed the block, gets `hem`, the
 * usual Hem the page built. So does a read-only member, the demo company, a
 * company with a deadline that needs attention, and a company created before the day the
 * block applies from (HEM_FIRST_THING_FROM). The company's age is judged from
 * rows the page already read, so an older company costs no read here; the
 * closed block, the role and that day are checked before the worklist is read.
 */
export async function HemFirstThingSection({
  companyId,
  userId,
  now,
  notices,
  hem,
  clients,
}: {
  companyId: string
  userId: string
  now: Date
  notices: ReactNode
  /** Hem as it is without the rollout. */
  hem: ReactNode
  /** The AI clients this person has connected, to any company. */
  clients: AiClient[]
}) {
  const { supabase } = await getDashboardAuthContext()
  const today = todayIsoStockholm(now)
  // Both are rows the page and the layout already read (request-cached).
  const [{ data: memberships }, { data: settings }] = await Promise.all([
    getDashboardCompanyMemberships(),
    getDashboardSettings(),
  ])
  const membership = memberships?.find((m) => m.company_id === companyId)
  const embedded = membership?.companies as
    | { created_at?: string | null }
    | { created_at?: string | null }[]
    | null
    | undefined
  const createdAt = (Array.isArray(embedded) ? embedded[0] : embedded)?.created_at ?? null
  // An older company gets the usual Hem before anything is read for the block.
  if (!isNewCompany(createdAt, today)) return hem

  const { data: preferences } = await supabase.from('user_preferences').select('ui_state').eq('user_id', userId).maybeSingle()
  const uiState = preferences?.ui_state as UserUiState | null
  const closed = Boolean(uiState?.first_thing_closed?.[companyId])

  if (isCompanyQuestionsEnabled(companyId)) {
    let questions: ReturnType<typeof walkQuestions> = []
    try {
      questions = walkQuestions(await listAppQuestions(supabase, companyId), uiState?.hem_questions_passed?.[companyId])
    } catch (error) {
      // A failed read falls through as if there were no questions.
      log.warn('the open questions could not be read', { companyId, error: error instanceof Error ? error.message : String(error) })
    }
    if (questions.length > 0) {
      const { HemQuestionFirst } = await import('@/components/dashboard/HemQuestionFirst')
      return <DashboardContent notices={notices} panes={<HemQuestionFirst questions={questions} companyId={companyId} />} />
    }
  }

  // The closed block hides the first thing, never a question filed after the person last went through them.
  if (closed) return hem
  // None of the first things is a read-only member's to do.
  const canWrite = roleMayWrite(membership?.role ?? null)
  if (!canWrite) return hem
  // The demo company a visitor tries the app in shows the usual Hem.
  const demoCompany = settings?.is_sandbox === true
  if (demoCompany) return hem
  const createdFrom = hemFirstThingCreatedFrom()
  if (createdFrom && !createdOnOrAfter(createdAt, createdFrom)) return hem

  const [worklist, bankConnections, transactions, sieImports, hasAi] = await Promise.all([
    getWorklistCounts(supabase, companyId),
    readActiveBankConnections(companyId),
    countTransactions(companyId),
    countCompletedSieImports(companyId),
    hasCapability(supabase, companyId, CAPABILITY.ai),
  ])
  // A failed read shows the usual Hem: guessing "nothing connected" would send a connected company to the bank step.
  if (bankConnections.error || transactions.error || sieImports.error) return hem

  const transactionCount = transactions.count || 0
  const firstThing = pickFirstThing({
    inRollout: true,
    counts: worklist.counts,
    hasBankFeed: hasBankFeed({ activeBankConnections: (bankConnections.data ?? []).length, transactionCount }),
    hasImportedBooks: (sieImports.count || 0) > 0,
    hasTransactions: transactionCount > 0,
    hasAi,
    companyCreatedAt: createdAt,
    today,
    closed,
    canWrite,
    demoCompany,
    // The bank connection is an extension: without it the bank rows come in as a statement file.
    bankConnectOffered: ENABLED_EXTENSION_IDS.has('enable-banking'),
    createdFrom,
  })
  if (!firstThing) return hem

  // The chat a hand-off opens gets a prompt that names no company, and a
  // connection starts such a task in its own company: only the clients whose
  // connection belongs to this company are offered here. Service role, for
  // the reason the page's own connection read gives; the read filters on the
  // person.
  const boundClients = clients.length > 0 ? await loadAiClientsBoundTo(await createServiceClient(), userId, companyId) : []

  // Loaded only where the block shows, so Hem's module graph is the same for everyone else.
  const { HemFirstThing } = await import('@/components/dashboard/HemFirstThing')

  return (
    <DashboardContent
      notices={notices}
      panes={
        <HemFirstThing
          kind={firstThing.kind}
          lead={firstThing.lead}
          after={firstThing.after}
          clients={boundClients}
          bankHref={ENABLED_EXTENSION_IDS.has('enable-banking') ? '/import?mode=psd2' : '/import?mode=bank'}
          bankFileHref="/import?mode=bank"
          inboxHref={worklist.inboxHref ?? null}
          companyId={companyId}
        />
      }
    />
  )
}
