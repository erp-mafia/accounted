import { getVatDeadlineForPeriod } from '@/lib/tax/deadline-config'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'

export interface SandboxVatDeadline {
  title: string
  dueDate: string
  period: string
}

/** Build the current quarter's canonical, banking-day-adjusted sandbox deadline. */
export function buildSandboxVatDeadline(today: Date): SandboxVatDeadline {
  const year = today.getFullYear()
  const quarter = Math.floor(today.getMonth() / 3) + 1
  const rawDeadline = getVatDeadlineForPeriod('quarterly', year, quarter, {
    vat_taxable_base_over_40m: false,
  })
  if (!rawDeadline) throw new Error('Could not resolve sandbox VAT deadline')

  const deadline = adjustDeadlineToNextBankingDay(
    new Date(rawDeadline.year, rawDeadline.month, rawDeadline.day),
  )
  const dueDate = [
    deadline.getFullYear(),
    String(deadline.getMonth() + 1).padStart(2, '0'),
    String(deadline.getDate()).padStart(2, '0'),
  ].join('-')

  return {
    title: `Momsdeklaration Q${quarter} ${year}`,
    dueDate,
    period: `${year}-Q${quarter}`,
  }
}
