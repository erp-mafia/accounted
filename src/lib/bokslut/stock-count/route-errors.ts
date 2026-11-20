import type { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import { StockCountError } from './errors'

/** A stock count refusal as its structured error response, or null for any other error (the caller rethrows). */
export function stockCountErrorResponse(err: unknown, ctx: { log: Logger; requestId: string }): NextResponse | null {
  if (!(err instanceof StockCountError)) return null
  return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId, details: err.details })
}

/** The answer while the stock count is off for the company (BOLAGET_COMPANY_IDS). */
export function stockCountDisabledResponse(ctx: { log: Logger; requestId: string }): NextResponse {
  return errorResponseFromCode('STOCK_COUNT_DISABLED', ctx.log, { requestId: ctx.requestId })
}
