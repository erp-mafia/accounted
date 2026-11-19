/**
 * The month's lines for byrå clients (usage_statements status manual): what
 * support adds to each byrå's invoice by hand, mailed once by the monthly
 * usage cron. Grouped by byrå, one row per client and kind, amounts exkl.
 * moms.
 */

import type { Logger } from '@/lib/logger'
import { getBranding } from '@/lib/branding/service'
import { getEmailService } from '@/lib/email/service'
import { getSupportRecipientEmail } from '@/lib/support'
import { invoiceLineDescription, type CloseUsageResult } from './close-period'
import { formatOre } from './kinds'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The mail's text, grouped by byrå: "Byrå X: 120,00 kr" and one line per client and kind under it. */
export function byraStatementsText(result: Pick<CloseUsageResult, 'period' | 'manual'>): string {
  const byTeam = new Map<string, { teamName: string; rows: string[]; ore: number }>()
  for (const entry of result.manual) {
    const team = byTeam.get(entry.teamId) ?? { teamName: entry.teamName, rows: [], ore: 0 }
    for (const line of entry.lines) {
      team.rows.push(`  ${entry.companyId}: ${invoiceLineDescription(line, result.period)} = ${formatOre(line.amount_ore)}`)
      team.ore += line.amount_ore
    }
    byTeam.set(entry.teamId, team)
  }
  return [...byTeam.values()]
    .map((team) => `${team.teamName}: ${formatOre(team.ore)} exkl. moms\n${team.rows.join('\n')}`)
    .join('\n\n')
}

/** Mail support the byrå lines when there are any. Never throws: the statements are written either way. */
export async function mailByraStatements(result: Pick<CloseUsageResult, 'period' | 'manual'>, log: Logger): Promise<boolean> {
  if (result.manual.length === 0) return false
  try {
    const emailService = await getEmailService()
    if (!emailService.isConfigured()) {
      log.warn('email service not configured: byrå usage lines not mailed', { period: result.period })
      return false
    }
    const text = `Styckavgifter för byråkunder, ${result.period}, att lägga på byråns faktura:\n\n${byraStatementsText(result)}\n\nRaderna finns i usage_statements med status manual.`
    const sent = await emailService.sendEmail({
      to: getSupportRecipientEmail(),
      subject: `[${getBranding().appName.toLowerCase()} användning] Byråkunder att fakturera, ${result.period}`,
      text,
      html: `<pre>${escapeHtml(text)}</pre>`,
    })
    if (!sent.success) log.error('byrå usage lines mail failed', new Error(sent.error ?? 'unknown'), { period: result.period })
    return sent.success
  } catch (err) {
    log.error('byrå usage lines mail failed', err as Error, { period: result.period })
    return false
  }
}
