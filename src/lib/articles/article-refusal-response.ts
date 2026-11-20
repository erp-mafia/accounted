/**
 * An article command's refusal (lib/articles/article-commands.ts) as the
 * dashboard response: ACCOUNTS_NOT_IN_CHART keeps the activate-and-retry
 * envelope the article form reads, a write failure carries the database
 * reason, and every other code is its structured error (sessionFailureResponse).
 */
import type { NextResponse } from 'next/server'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import type { Logger } from '@/lib/logger'
import { sessionFailureResponse } from '@/lib/operations/session'
import type { OperationOutcome } from '@/lib/operations/types'

const ARTICLE_WRITE_FAILURES = ['ARTICLE_CREATE_FAILED', 'ARTICLE_UPDATE_FAILED'] as const

export function articleRefusalResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: Logger,
  requestId: string | undefined,
): NextResponse {
  if (outcome.code === 'ACCOUNTS_NOT_IN_CHART') {
    const accounts = (outcome.details?.account_numbers as string[] | undefined) ?? []
    return accountsNotInChartResponse(new AccountsNotInChartError(accounts))
  }
  return sessionFailureResponse(outcome, log, requestId, { writeFailureCodes: ARTICLE_WRITE_FAILURES })
}
