/**
 * An article command's refusal (lib/articles/article-commands.ts) as the
 * dashboard response: ACCOUNTS_NOT_IN_CHART keeps the activate-and-retry
 * envelope the article form reads, a write failure carries the database
 * reason, and every other code is its structured error.
 */
import type { NextResponse } from 'next/server'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome } from '@/lib/operations/types'

export function articleRefusalResponse(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
  log: Logger,
  requestId: string | undefined,
): NextResponse {
  if (outcome.code === 'ACCOUNTS_NOT_IN_CHART') {
    const accounts = (outcome.details?.account_numbers as string[] | undefined) ?? []
    return accountsNotInChartResponse(new AccountsNotInChartError(accounts))
  }
  if (outcome.code === 'ARTICLE_CREATE_FAILED' || outcome.code === 'ARTICLE_UPDATE_FAILED') {
    return errorResponseFromCode(outcome.code, log, {
      requestId,
      details: { reason: getUserErrorMessage(outcome.error) },
    })
  }
  return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
}
