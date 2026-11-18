/**
 * Begär fler: a person asking for more of a priced service than the month
 * includes. The request is stored (usage_requests) and mailed to support with
 * what an operator needs to open the charge: the company, who asked, the
 * month's usage against what is included, the price and who would pay. An
 * operator answers by opening the charge (consent.ts) and setting handled_at.
 *
 * Bank payments keep their own request (lib/payments/allowance.ts), which
 * also asks how many payments a month the company needs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome } from '@/lib/operations/types'
import { getBranding } from '@/lib/branding/service'
import { getEmailService } from '@/lib/email/service'
import { currentUsagePeriod } from '@/lib/payments/usage'
import { getSupportRecipientEmail } from '@/lib/support'
import { countCompanyUsage } from './counters'
import { formatOre, USAGE_INVOICE_LABELS, USAGE_PRICES, type UsageKind } from './kinds'
import { readCompanyPayer } from './paying'

/** One open request per company and kind a day: the operators answer by hand. */
export const USAGE_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000

export interface UsageRequestCreated {
  request_id: string
  created_at: string
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Store the request and mail support. Written as the service role: a
 * browser session cannot write the table. Refused while the company has an
 * open request for the kind younger than a day. When the mail cannot be sent
 * the row is removed again, so the person can try later instead of waiting
 * on a request nobody saw.
 */
export async function requestMoreUsage(
  service: SupabaseClient,
  actor: { companyId: string; userId: string; email: string | null; log: Logger },
  input: { kind: UsageKind; message: string | null },
  now: Date = new Date(),
): Promise<OperationOutcome<UsageRequestCreated>> {
  const since = new Date(now.getTime() - USAGE_REQUEST_WINDOW_MS).toISOString()
  const { data: open, error: openError } = await service
    .from('usage_requests')
    .select('id, created_at')
    .eq('company_id', actor.companyId)
    .eq('kind', input.kind)
    .is('handled_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
  if (openError) throw openError
  const pending = ((open ?? []) as Array<{ id: string; created_at: string }>)[0]
  if (pending) return { ok: false, code: 'USAGE_REQUEST_OPEN', details: { requested_at: pending.created_at } }

  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    actor.log.warn('email service not configured: usage request not sent')
    return { ok: false, code: 'USAGE_REQUEST_NOT_SENT' }
  }

  const period = currentUsagePeriod()
  const price = USAGE_PRICES[input.kind]
  // A kind included once (signed documents) counts every unit so far against what is included in all.
  const once = price.includedOnce !== undefined
  const included = (once ? price.includedOnce : price.includedPerMonth) ?? 0
  const [used, usedBefore, payer, companyRead] = await Promise.all([
    countCompanyUsage(service, actor.companyId, input.kind, period),
    once ? countCompanyUsage(service, actor.companyId, input.kind, period, { before: true }) : Promise.resolve(0),
    readCompanyPayer(service, actor.companyId),
    service.from('companies').select('name, org_number').eq('id', actor.companyId).maybeSingle(),
  ])
  const company = (companyRead.data ?? null) as { name: string | null; org_number: string | null } | null

  const { data: inserted, error: insertError } = await service
    .from('usage_requests')
    .insert({ company_id: actor.companyId, kind: input.kind, requested_by: actor.userId, message: input.message })
    .select('id, created_at')
    .single()
  if (insertError) throw insertError
  const row = inserted as { id: string; created_at: string }

  const payerText = !payer ? 'ingen (provperiod eller utan abonnemang)' : payer.kind === 'byra' ? `byrån ${payer.teamName}, faktureras för hand` : 'eget abonnemang'
  const lines: Array<[string, string]> = [
    ['Företag', company?.name ?? '(namn saknas)'],
    ['Organisationsnummer', company?.org_number ?? '(saknas)'],
    ['Företags-id', actor.companyId],
    ['Begärt av', actor.email ?? actor.userId],
    ['Tjänst', USAGE_INVOICE_LABELS[input.kind]],
    once ? ['Använt totalt', `${usedBefore + used} av ${included} som ingår`] : [`Använt ${period}`, `${used} av ${included} som ingår`],
    ['Pris därutöver', formatOre(price.unitPriceOre ?? 0)],
    ['Betalas av', payerText],
    ['Förfrågan', row.id],
  ]
  const openSql =
    `insert into usage_consents (company_id, kind, unit_price_ore, included, accepted_by) values ` +
    `('${actor.companyId}', '${input.kind}', ${price.unitPriceOre ?? 0}, ${included}, '<din user id>');`
  const footer = `Öppna avgiften för företaget och sätt handled_at på förfrågan:\n${openSql}`
  const message = input.message ?? ''
  const text = `${lines.map(([label, value]) => `${label}: ${value}`).join('\n')}${message ? `\n\nMeddelande:\n${message}` : ''}\n\n${footer}`
  const html = `${lines.map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join('')}${
    message ? `<hr /><p><strong>Meddelande:</strong></p><p>${escapeHtml(message).replace(/\n/g, '<br />')}</p>` : ''
  }<hr /><p>Öppna avgiften för företaget och sätt handled_at på förfrågan:</p><pre>${escapeHtml(openSql)}</pre>`

  const result = await emailService.sendEmail({
    to: getSupportRecipientEmail(),
    subject: `[${getBranding().appName.toLowerCase()} användning] ${USAGE_INVOICE_LABELS[input.kind]}: ${company?.name ?? actor.companyId}`,
    html,
    text,
    replyTo: actor.email ?? undefined,
  })
  if (!result.success) {
    actor.log.error('usage request mail failed', new Error(result.error ?? 'unknown'), { requestId: row.id })
    const { error: removeError } = await service.from('usage_requests').delete().eq('id', row.id).eq('company_id', actor.companyId)
    if (removeError) actor.log.error('unsent usage request could not be removed', removeError, { requestId: row.id })
    return { ok: false, code: 'USAGE_REQUEST_NOT_SENT' }
  }
  actor.log.info('usage request sent', { requestId: row.id, kind: input.kind, messageId: result.messageId })
  return { ok: true, data: { request_id: row.id, created_at: row.created_at }, created: true }
}
