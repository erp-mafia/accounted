import { notFound } from 'next/navigation'
import { getDashboardAuthContext, getDashboardCompanyId } from '../request-context'
import { QuestionList } from '@/components/questions/QuestionList'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { createLogger } from '@/lib/logger'
import { listAppQuestions, type AppQuestion } from '@/lib/questions/app-answer'

const log = createLogger('questions')

/**
 * /questions: the open questions put to the company, each with the records it
 * rests on and its answers. 404 outside COMPANY_QUESTIONS_COMPANY_IDS. A list
 * that could not be read is handed to the page as null, which offers to read
 * it again.
 */
export default async function QuestionsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isCompanyQuestionsEnabled(companyId)) notFound()
  const { supabase } = await getDashboardAuthContext()
  let initial: AppQuestion[] | null = null
  try {
    initial = await listAppQuestions(supabase, companyId)
  } catch (error) {
    log.warn('the question list could not be read', { companyId, error: error instanceof Error ? error.message : String(error) })
  }
  return <QuestionList initial={initial} />
}
