'use client'

import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import type { AutomaticReminderState } from '@/lib/reminders/automatic'
import type { InvoiceReminderLadder } from '@/lib/reminders/invoice-ladder'
import type { ReminderOverview, ReminderSummary } from '@/lib/reminders/overview'
import type { ReminderLevel } from '@/lib/reminders/policy'
import type { ReminderPreview } from '@/lib/reminders/preview'
import {
  reminderSettingsBody,
  sendBatches,
  type PickedSendResult,
  type ReminderDays,
} from '@/lib/reminders/turn-on'

/**
 * Browser side of turning reminders on (accounted#104, phase 3): the calls to
 * the reminder routes, the settings save and the customer flag. A refusal
 * comes back as one sentence in the user's language (getErrorMessage), plus
 * the structured code where the caller decides on it.
 */

export type ReminderCall<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; message: string }

/** The structured envelope's code ({ error: { code } }), when the body has one. */
function structuredCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const envelope = (body as { error?: unknown }).error
  if (!envelope || typeof envelope !== 'object') return null
  const code = (envelope as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

async function reminderCall<T>(
  path: string,
  locale: ErrorLocale,
  write?: { method: 'POST' | 'PUT' | 'PATCH'; body: unknown },
): Promise<ReminderCall<T>> {
  try {
    const response = await fetch(path, {
      method: write?.method ?? 'GET',
      headers: write ? { 'Content-Type': 'application/json' } : undefined,
      body: write ? JSON.stringify(write.body) : undefined,
      cache: 'no-store',
    })
    const body = (await response.json().catch(() => null)) as { data?: T } | null
    if (response.ok && body && 'data' in body) return { ok: true, data: body.data as T }
    return {
      ok: false,
      status: response.status,
      code: structuredCode(body),
      message: getErrorMessage(body, { statusCode: response.status, locale }),
    }
  } catch (error) {
    return { ok: false, status: 0, code: null, message: getErrorMessage(error, { locale }) }
  }
}

/** The whole sheet: switches, days, automatic sending and the pick list. */
export function fetchReminderOverview(locale: ErrorLocale): Promise<ReminderCall<ReminderOverview>> {
  return reminderCall<ReminderOverview>('/api/reminders/overview', locale)
}

/** The invoice list's read: the switches and the offer's count, no pick list. */
export function fetchReminderSummary(locale: ErrorLocale): Promise<ReminderCall<ReminderSummary>> {
  return reminderCall<ReminderSummary>('/api/reminders/overview?view=summary', locale)
}

/** The mail for one invoice (or the company's latest overdue one), at a level or the one a pick would send. */
export function fetchReminderPreview(
  locale: ErrorLocale,
  request: { invoiceId?: string; level?: ReminderLevel },
): Promise<ReminderCall<ReminderPreview>> {
  const params = new URLSearchParams()
  if (request.invoiceId) params.set('invoice_id', request.invoiceId)
  if (request.level) params.set('level', String(request.level))
  const query = params.toString()
  return reminderCall<ReminderPreview>(`/api/reminders/preview${query ? `?${query}` : ''}`, locale)
}

/** Whether the daily ladder reminds the invoice by itself, and after which days. */
export function fetchInvoiceReminderLadder(locale: ErrorLocale, invoiceId: string): Promise<ReminderCall<InvoiceReminderLadder>> {
  return reminderCall<InvoiceReminderLadder>(`/api/reminders/ladder?invoice_id=${encodeURIComponent(invoiceId)}`, locale)
}

/** PUT /api/settings (owner or administrator): the toggle and/or the days. */
export async function saveReminderSettings(
  locale: ErrorLocale,
  change: { on?: boolean; days?: ReminderDays },
): Promise<ReminderCall<unknown>> {
  const result = await reminderCall<unknown>('/api/settings', locale, { method: 'PUT', body: reminderSettingsBody(change) })
  // The settings row is session-cached (lib/reference-data): the invoice page reads the toggle from it.
  if (result.ok) await invalidateReferenceData('company_settings')
  return result
}

/**
 * Remind the picked invoices now, in calls of at most 50. Stops at the first
 * refused call: the answers so far come back with the refusal, so the person
 * sees which invoices went and which were never tried.
 */
export async function sendPickedReminders(
  locale: ErrorLocale,
  invoiceIds: readonly string[],
  bankAttested: boolean,
): Promise<{ results: PickedSendResult[]; error: string | null }> {
  const results: PickedSendResult[] = []
  for (const batch of sendBatches(invoiceIds)) {
    const call = await reminderCall<{ results: PickedSendResult[] }>('/api/reminders/send', locale, {
      method: 'POST',
      body: bankAttested ? { invoice_ids: batch, bank_attested: true } : { invoice_ids: batch },
    })
    if (!call.ok) return { results, error: call.message }
    results.push(...call.data.results)
  }
  return { results, error: null }
}

/** Whether the batch sends itself, and whether that may be offered yet. */
export function fetchAutomaticReminders(locale: ErrorLocale): Promise<ReminderCall<AutomaticReminderState>> {
  return reminderCall<AutomaticReminderState>('/api/reminders/automatic', locale)
}

/** Let the daily batch send itself (owner or administrator, after three clean batches), or approve every batch again. */
export function saveAutomaticReminders(locale: ErrorLocale, enabled: boolean): Promise<ReminderCall<AutomaticReminderState>> {
  return reminderCall<AutomaticReminderState>('/api/reminders/automatic', locale, { method: 'POST', body: { enabled } })
}

/** "Skicka aldrig påminnelser" on a customer, or lifting it. */
export function saveCustomerRemindersExcluded(
  locale: ErrorLocale,
  customerId: string,
  excluded: boolean,
): Promise<ReminderCall<{ id: string; reminders_excluded: boolean }>> {
  return reminderCall(`/api/customers/${encodeURIComponent(customerId)}/reminders-exclusion`, locale, {
    method: 'PATCH',
    body: { excluded },
  })
}

/** "sv" or "en" from next-intl's locale. */
export function errorLocale(locale: string): ErrorLocale {
  return locale === 'en' ? 'en' : 'sv'
}
