import type { ReactNode } from 'react'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import { hasBankFeed } from '@/lib/onboarding/checklist'
import { isNewCompany, pickFirstThing } from '@/lib/onboarding/first-thing'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { createLogger } from '@/lib/logger'
import { walkQuestions } from '@/lib/onboarding/question-first'
import { listAppQuestions } from '@/lib/questions/app-answer'
import { getWorklistCounts } from '@/lib/worklist'
import type { UserUiState } from '@/types'
import { countCompletedSieImports, countTransactions, readActiveBankConnections } from './hem-reads'
import { getDashboardAuthContext, getDashboardCompanyMemberships } from './request-context'

const log = createLogger('hem-question-first')

/**
 * Hem for a person in the first-thing rollout: a new company opens on one
 * named first thing (components/dashboard/HemFirstThing) under the notice
 * line, after the open questions when the company has the question list
 * (components/dashboard/HemQuestionFirst); every other case, and a person who closed the block, gets `hem`, the
 * usual Hem the page built. The cheap checks (company age, the closed block)
 * run before the worklist is read.
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
  /** The AI clients this person has connected. */
  clients: AiClient[]
}) {
  const { supabase } = await getDashboardAuthContext()
  const today = todayIsoStockholm(now)
  const [{ data: memberships }, { data: preferences }] = await Promise.all([
    getDashboardCompanyMemberships(),
    supabase.from('user_preferences').select('ui_state').eq('user_id', userId).maybeSingle(),
  ])
  const embedded = memberships?.find((m) => m.company_id === companyId)?.companies as
    | { created_at?: string | null }
    | { created_at?: string | null }[]
    | null
    | undefined
  const createdAt = (Array.isArray(embedded) ? embedded[0] : embedded)?.created_at ?? null
  const uiState = preferences?.ui_state as UserUiState | null
  const closed = Boolean(uiState?.first_thing_closed?.[companyId])
  if (closed || !isNewCompany(createdAt, today)) return hem

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
  })
  if (!firstThing) return hem

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
          clients={clients}
          bankHref={ENABLED_EXTENSION_IDS.has('enable-banking') ? '/import?mode=psd2' : '/import?mode=bank'}
          receiptsHref={hasAi ? '/e/general/invoice-inbox' : '/settings/billing'}
          inboxHref={worklist.inboxHref ?? null}
          companyId={companyId}
        />
      }
    />
  )
}
