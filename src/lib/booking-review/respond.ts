import type { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Logger } from '@/lib/logger'
import { BookingReviewRuleWriteError } from '@/lib/booking-review/rules'

/**
 * The response for a refusal from save_booking_review_rule or
 * archive_booking_review_rule, or null when the error is not one of theirs
 * (the wrapper then answers it as any other throw).
 */
export function bookingReviewRuleRefusalResponse(
  error: unknown,
  log: Logger,
  requestId: string,
): NextResponse | null {
  if (!(error instanceof BookingReviewRuleWriteError)) return null
  switch (error.refusal) {
    case 'forbidden':
      return errorResponseFromCode('FORBIDDEN', log, {
        requestId,
        messageSv: 'Bara företagets ägare eller en administratör kan lägga till eller arkivera spärrar.',
        messageEn: 'Only the company owner or an administrator can add or archive blocks.',
        details: { required_roles: ['owner', 'admin'] },
      })
    case 'not_found':
      return errorResponseFromCode('NOT_FOUND', log, {
        requestId,
        messageSv: 'Spärren finns inte, eller är redan arkiverad.',
        messageEn: 'The block does not exist, or is already archived.',
      })
    case 'unknown_counterparty':
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: 'Namnet pekar inte ut en motpart. Skriv motpartens namn som det står i banktexten, till exempel Google Cloud.',
        messageEn: 'The name does not identify a counterparty. Write the counterparty as the bank text names it, for example Google Cloud.',
        details: { field: 'counterparty' },
      })
    case 'invalid':
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: 'Spärren är ofullständig. Ange minst ett av konton, motpart, belopp eller momsbehandling.',
        messageEn: 'The block is incomplete. Give at least one of accounts, counterparty, amount or VAT treatment.',
      })
  }
}
