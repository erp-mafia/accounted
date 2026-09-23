/**
 * ICS calendar feed generator
 * Generates .ics files for Apple Calendar / Google Calendar sync
 */

import { createEvents, type EventAttributes, type DateArray } from 'ics'
import type { Deadline, Invoice } from '@/types'

export interface FeedOptions {
  includeTaxDeadlines: boolean
  includeInvoices: boolean
}

export interface CalendarData {
  deadlines: Deadline[]
  invoices: Invoice[]
}

/**
 * Generate a stable UID for calendar events
 * This ensures updates to events are recognized by calendar apps
 */
function getEventUID(type: string, id: string, domain: string = 'accounted.se'): string {
  return `${type}-${id}@${domain}`
}

/**
 * Convert date string (YYYY-MM-DD) to ICS DateArray
 */
function dateToArray(dateStr: string): DateArray {
  const [year, month, day] = dateStr.split('-').map(Number)
  return [year, month, day]
}

/**
 * Convert date and optional time to ICS DateArray with hours/minutes
 */
function dateTimeToArray(dateStr: string, timeStr?: string | null): DateArray {
  const [year, month, day] = dateStr.split('-').map(Number)
  if (timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number)
    return [year, month, day, hours, minutes]
  }
  return [year, month, day, 9, 0] // Default to 9:00 AM
}

/**
 * Create alarm arrays for an event (VALARM)
 */
function createAlarms(daysBefore: number[]): EventAttributes['alarms'] {
  return daysBefore.map((days) => ({
    action: 'display' as const,
    trigger: { days, before: true },
    description: 'Påminnelse',
  }))
}

/**
 * Generate deadline events
 */
function generateDeadlineEvents(deadlines: Deadline[]): EventAttributes[] {
  return deadlines.map((deadline) => {
    const event: EventAttributes = {
      uid: getEventUID('deadline', deadline.id),
      title: deadline.title,
      start: dateTimeToArray(deadline.due_date, deadline.due_time),
      duration: { hours: 1 },
      description: formatDeadlineDescription(deadline),
      categories: ['Deadline', deadline.deadline_type === 'tax' ? 'Skatt' : deadline.deadline_type],
      status: deadline.is_completed ? 'CONFIRMED' : 'TENTATIVE',
      alarms: createAlarms(deadline.reminder_offsets || [7, 1]),
    }

    return event
  })
}

/**
 * Format deadline description for calendar
 */
function formatDeadlineDescription(deadline: Deadline): string {
  const lines: string[] = []

  if (deadline.tax_deadline_type) {
    lines.push(`Typ: ${getSwedishTaxTypeLabel(deadline.tax_deadline_type)}`)
  }
  if (deadline.tax_period) {
    lines.push(`Period: ${deadline.tax_period}`)
  }
  if (deadline.notes) {
    lines.push(`\nNoteringar: ${deadline.notes}`)
  }
  if (deadline.status) {
    lines.push(`\nStatus: ${getSwedishStatusLabel(deadline.status)}`)
  }

  return lines.join('\n')
}

/**
 * Generate invoice events
 */
function generateInvoiceEvents(invoices: Invoice[]): EventAttributes[] {
  return invoices.map((invoice) => {
    const customerName = invoice.customer?.name || 'Okänd kund'

    const event: EventAttributes = {
      uid: getEventUID('invoice', invoice.id),
      title: `Faktura #${invoice.invoice_number} - ${customerName}`,
      start: dateToArray(invoice.due_date),
      duration: { days: 1 },
      description: formatInvoiceDescription(invoice),
      categories: ['Faktura'],
      status: invoice.status === 'paid' ? 'CONFIRMED' : 'TENTATIVE',
      alarms: createAlarms([3, 1]),
    }

    return event
  })
}

/**
 * Format invoice description for calendar
 */
function formatInvoiceDescription(invoice: Invoice): string {
  const lines: string[] = []

  lines.push(`Belopp: ${invoice.total.toLocaleString('sv-SE')} ${invoice.currency}`)
  lines.push(`Status: ${getSwedishInvoiceStatusLabel(invoice.status)}`)

  if (invoice.customer?.name) {
    lines.push(`Kund: ${invoice.customer.name}`)
  }

  return lines.join('\n')
}

/**
 * Generate complete calendar feed
 */
export function generateCalendarFeed(
  data: CalendarData,
  options: FeedOptions
): Promise<string> {
  const events: EventAttributes[] = []

  // The include_tax_deadlines flag governs SYSTEM-generated deadlines only:
  // the user's own manual deadlines always appear in the feed. The previous
  // nesting hid every deadline, including user-created ones, when the flag
  // was off.
  const visibleDeadlines = options.includeTaxDeadlines
    ? data.deadlines
    : data.deadlines.filter((d) => d.source !== 'system')

  const taxDeadlines = visibleDeadlines.filter((d) => d.deadline_type === 'tax')
  events.push(...generateDeadlineEvents(taxDeadlines))

  const otherDeadlines = visibleDeadlines.filter((d) => d.deadline_type !== 'tax')
  events.push(...generateDeadlineEvents(otherDeadlines))

  if (options.includeInvoices) {
    events.push(...generateInvoiceEvents(data.invoices))
  }

  return new Promise((resolve, reject) => {
    createEvents(events, (error, value) => {
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    })
  })
}

/**
 * Swedish labels for tax deadline types
 */
function getSwedishTaxTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    moms_monthly: 'Momsdeklaration (månad)',
    moms_quarterly: 'Momsdeklaration (kvartal)',
    moms_yearly: 'Momsdeklaration (år)',
    f_skatt: 'Preliminärskatt (F-skatt)',
    arbetsgivardeklaration: 'Arbetsgivardeklaration',
    skatteinbetalning: 'Skatteinbetalning (storföretag)',
    inkomstdeklaration_ef: 'Inkomstdeklaration EF',
    inkomstdeklaration_ab: 'Inkomstdeklaration AB',
    arsredovisning: 'Årsredovisning',
    arsstamma: 'Årsstämma',
    periodisk_sammanstallning: 'Periodisk sammanställning',
  }
  return labels[type] || type
}

/**
 * Swedish labels for deadline status
 */
function getSwedishStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    upcoming: 'Kommande',
    action_needed: 'Åtgärd krävs',
    in_progress: 'Pågår',
    submitted: 'Inskickad',
    confirmed: 'Bekräftad',
    overdue: 'Försenad',
  }
  return labels[status] || status
}

/**
 * Swedish labels for invoice status
 */
function getSwedishInvoiceStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'Utkast',
    sent: 'Skickad',
    paid: 'Betald',
    overdue: 'Förfallen',
    cancelled: 'Makulerad',
    credited: 'Krediterad',
  }
  return labels[status] || status
}
