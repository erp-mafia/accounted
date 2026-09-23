import { Invoice, Deadline, PaymentCalendarDay } from '@/types'

// Swedish day names (Monday first)
export const SWEDISH_DAYS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön']

// Swedish month names
export const SWEDISH_MONTHS = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'
]

// Parse ISO date string to Date object at start of day
export function parseDate(dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1, day)
}

// Format date as ISO string (YYYY-MM-DD)
export function formatDateISO(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Get start of day
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// Check if date is before another
export function isBefore(date1: Date, date2: Date): boolean {
  return startOfDay(date1).getTime() < startOfDay(date2).getTime()
}

// Check if two dates are the same day
export function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  )
}

// Check if invoice is overdue
export function isInvoiceOverdue(invoice: Invoice): boolean {
  if (invoice.status === 'paid' || invoice.status === 'cancelled' || invoice.status === 'credited') {
    return false
  }
  const today = startOfDay(new Date())
  const dueDate = parseDate(invoice.due_date)
  return isBefore(dueDate, today)
}

// Check if deadline is overdue
export function isDeadlineOverdue(deadline: Deadline): boolean {
  if (deadline.is_completed) return false
  const today = startOfDay(new Date())
  const dueDate = parseDate(deadline.due_date)
  return isBefore(dueDate, today)
}

// Get all days in a month as a grid (including padding days from prev/next months)
export function getMonthGrid(year: number, month: number): Date[][] {
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)

  // Get day of week (0 = Sunday, 1 = Monday, etc.)
  // Convert to Monday-first (0 = Monday, 6 = Sunday)
  let startDayOfWeek = firstDay.getDay() - 1
  if (startDayOfWeek < 0) startDayOfWeek = 6

  const daysInMonth = lastDay.getDate()

  const weeks: Date[][] = []
  let currentWeek: Date[] = []

  // Add padding days from previous month
  const prevMonth = new Date(year, month, 0)
  const prevMonthDays = prevMonth.getDate()
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    currentWeek.push(new Date(year, month - 1, prevMonthDays - i))
  }

  // Add days of current month
  for (let day = 1; day <= daysInMonth; day++) {
    currentWeek.push(new Date(year, month, day))
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }

  // Add padding days from next month
  if (currentWeek.length > 0) {
    let nextDay = 1
    while (currentWeek.length < 7) {
      currentWeek.push(new Date(year, month + 1, nextDay++))
    }
    weeks.push(currentWeek)
  }

  return weeks
}

// Group invoices by due date
export function groupInvoicesByDate(invoices: Invoice[]): Map<string, Invoice[]> {
  const grouped = new Map<string, Invoice[]>()

  for (const invoice of invoices) {
    const dateKey = invoice.due_date
    const existing = grouped.get(dateKey) || []
    existing.push(invoice)
    grouped.set(dateKey, existing)
  }

  return grouped
}

// Group deadlines by due date
export function groupDeadlinesByDate(deadlines: Deadline[]): Map<string, Deadline[]> {
  const grouped = new Map<string, Deadline[]>()

  for (const deadline of deadlines) {
    const dateKey = deadline.due_date
    const existing = grouped.get(dateKey) || []
    existing.push(deadline)
    grouped.set(dateKey, existing)
  }

  return grouped
}

/**
 * SEK value of an invoice for aggregation, or null when it cannot be known:
 * total_sek stays NULL when the Riksbanken rate fetch failed at creation, and
 * falling back to the raw foreign total would add EUR into SEK sums. Callers
 * skip null and surface the count instead of silently mixing currencies.
 */
export function invoiceSekAmount(invoice: Invoice): number | null {
  if (invoice.total_sek != null) return invoice.total_sek
  return !invoice.currency || invoice.currency === 'SEK' ? invoice.total : null
}

// Create PaymentCalendarDay from invoices for a specific date
export function createPaymentCalendarDay(date: string, invoices: Invoice[]): PaymentCalendarDay {
  const dayInvoices = invoices.filter(inv => inv.due_date === date)
  const overdueCount = dayInvoices.filter(isInvoiceOverdue).length
  const totalExpected = dayInvoices
    .filter(inv => inv.status !== 'paid' && inv.status !== 'cancelled' && inv.status !== 'credited')
    .reduce((sum, inv) => sum + (invoiceSekAmount(inv) ?? 0), 0)

  return {
    date,
    invoices: dayInvoices,
    totalExpected,
    overdueCount
  }
}

// Get invoices for a month
export function getInvoicesForMonth(invoices: Invoice[], year: number, month: number): Invoice[] {
  const monthStr = String(month + 1).padStart(2, '0')
  const prefix = `${year}-${monthStr}`

  return invoices.filter(inv => inv.due_date.startsWith(prefix))
}

// Get deadlines for a month
export function getDeadlinesForMonth(deadlines: Deadline[], year: number, month: number): Deadline[] {
  const monthStr = String(month + 1).padStart(2, '0')
  const prefix = `${year}-${monthStr}`

  return deadlines.filter(d => d.due_date.startsWith(prefix))
}

// Calculate summary for a period
export interface PeriodSummary {
  totalExpected: number
  totalOverdue: number
  totalPaid: number
  overdueCount: number
  pendingCount: number
  paidCount: number
  /** Non-SEK invoices without a stored SEK conversion, excluded from the totals. */
  unconvertedCount: number
}

export function calculatePeriodSummary(invoices: Invoice[]): PeriodSummary {
  let totalExpected = 0
  let totalOverdue = 0
  let totalPaid = 0
  let overdueCount = 0
  let pendingCount = 0
  let paidCount = 0
  let unconvertedCount = 0

  for (const invoice of invoices) {
    const amount = invoiceSekAmount(invoice)
    if (amount == null) unconvertedCount++

    if (invoice.status === 'paid') {
      totalPaid += amount ?? 0
      paidCount++
    } else if (invoice.status !== 'cancelled' && invoice.status !== 'credited') {
      totalExpected += amount ?? 0
      pendingCount++

      if (isInvoiceOverdue(invoice)) {
        totalOverdue += amount ?? 0
        overdueCount++
      }
    }
  }

  return {
    totalExpected,
    totalOverdue,
    totalPaid,
    overdueCount,
    pendingCount,
    paidCount,
    unconvertedCount
  }
}

// Get upcoming deadlines (next N days)
export function getUpcomingDeadlines(deadlines: Deadline[], days: number = 7): Deadline[] {
  const today = startOfDay(new Date())
  const endDate = new Date(today)
  endDate.setDate(endDate.getDate() + days)

  return deadlines
    .filter(d => {
      if (d.is_completed) return false
      const dueDate = parseDate(d.due_date)
      return dueDate >= today && dueDate <= endDate
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
}

// Swedish deadline type labels
export const DEADLINE_TYPE_LABELS: Record<string, string> = {
  delivery: 'Leverans',
  approval: 'Godkännande',
  invoicing: 'Fakturering',
  report: 'Rapport',
  revision: 'Revision',
  other: 'Övrigt'
}

// Swedish priority labels
export const PRIORITY_LABELS: Record<string, string> = {
  critical: 'Kritisk',
  important: 'Viktig',
  normal: 'Normal'
}

// Priority colors for styling
export const PRIORITY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  critical: { bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-700 dark:text-red-400', border: 'border-red-200 dark:border-red-800/50' },
  important: { bg: 'bg-orange-50 dark:bg-orange-950/40', text: 'text-orange-700 dark:text-orange-400', border: 'border-orange-200 dark:border-orange-800/50' },
  normal: { bg: 'bg-gray-50 dark:bg-gray-800/40', text: 'text-gray-700 dark:text-gray-300', border: 'border-gray-200 dark:border-gray-700/50' }
}

// ============================================================
// Status-aware deadline functions
// ============================================================

import type { DeadlineStatus } from '@/types'

// Status labels in Swedish
export const STATUS_LABELS: Record<DeadlineStatus, string> = {
  upcoming: 'Kommande',
  action_needed: 'Åtgärd krävs',
  in_progress: 'Pågår',
  submitted: 'Inskickad',
  confirmed: 'Bekräftad',
  overdue: 'Försenad'
}

// Status colors for styling
export const STATUS_COLORS: Record<DeadlineStatus, { bg: string; text: string; border: string; dot: string }> = {
  upcoming: { bg: 'bg-primary/5', text: 'text-foreground', border: 'border-primary/20', dot: 'bg-primary' },
  action_needed: { bg: 'bg-warning/10', text: 'text-warning-foreground', border: 'border-warning/30', dot: 'bg-warning' },
  in_progress: { bg: 'bg-warning/5', text: 'text-warning-foreground', border: 'border-warning/20', dot: 'bg-warning' },
  submitted: { bg: 'bg-primary/5', text: 'text-foreground', border: 'border-primary/20', dot: 'bg-primary' },
  confirmed: { bg: 'bg-success/10', text: 'text-success', border: 'border-success/30', dot: 'bg-success' },
  overdue: { bg: 'bg-destructive/5', text: 'text-destructive', border: 'border-destructive/30', dot: 'bg-destructive' }
}

// Get deadlines needing attention (action_needed or overdue)
export function getDeadlinesNeedingAttention(deadlines: Deadline[]): Deadline[] {
  return deadlines.filter(d =>
    !d.is_completed &&
    (d.status === 'action_needed' || d.status === 'overdue')
  ).sort((a, b) => {
    // Sort overdue first, then by date
    if (a.status === 'overdue' && b.status !== 'overdue') return -1
    if (b.status === 'overdue' && a.status !== 'overdue') return 1
    return a.due_date.localeCompare(b.due_date)
  })
}

// Get tax deadlines only
export function getTaxDeadlines(deadlines: Deadline[]): Deadline[] {
  return deadlines.filter(d => d.deadline_type === 'tax')
}

// Get tax deadlines needing attention
export function getTaxDeadlinesNeedingAttention(deadlines: Deadline[]): Deadline[] {
  return getDeadlinesNeedingAttention(deadlines).filter(d => d.deadline_type === 'tax')
}

// Count deadlines by status
export function countDeadlinesByStatus(deadlines: Deadline[]): Record<DeadlineStatus, number> {
  const counts: Record<DeadlineStatus, number> = {
    upcoming: 0,
    action_needed: 0,
    in_progress: 0,
    submitted: 0,
    confirmed: 0,
    overdue: 0
  }

  for (const d of deadlines) {
    if (!d.is_completed && d.status) {
      counts[d.status]++
    }
  }

  return counts
}

// Get all calendar events for a month (unified view)
export interface CalendarEvent {
  id: string
  type: 'invoice' | 'deadline'
  date: string
  title: string
  subtitle?: string
  status?: string
  priority?: string
  isOverdue?: boolean
  customerId?: string
}

export function getCalendarEventsForMonth(
  invoices: Invoice[],
  deadlines: Deadline[],
  year: number,
  month: number
): CalendarEvent[] {
  const events: CalendarEvent[] = []
  const monthStr = String(month + 1).padStart(2, '0')
  const prefix = `${year}-${monthStr}`
  const today = formatDateISO(new Date())

  // Invoice due dates
  for (const inv of invoices) {
    if (inv.due_date.startsWith(prefix) && !['paid', 'cancelled', 'credited'].includes(inv.status)) {
      events.push({
        id: `inv-${inv.id}`,
        type: 'invoice',
        date: inv.due_date,
        title: `Faktura ${inv.invoice_number}`,
        subtitle: inv.customer?.name,
        status: inv.status,
        isOverdue: inv.due_date < today && !['paid', 'cancelled', 'credited'].includes(inv.status),
        customerId: inv.customer_id
      })
    }
  }

  // Deadlines
  for (const d of deadlines) {
    if (d.due_date.startsWith(prefix) && !d.is_completed) {
      events.push({
        id: `dl-${d.id}`,
        type: 'deadline',
        date: d.due_date,
        title: d.title,
        subtitle: d.customer?.name,
        priority: d.priority,
        isOverdue: d.due_date < today,
        customerId: d.customer_id || undefined
      })
    }
  }

  // Sort by date
  events.sort((a, b) => a.date.localeCompare(b.date))

  return events
}

// Group calendar events by date
export function groupCalendarEventsByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const grouped = new Map<string, CalendarEvent[]>()

  for (const event of events) {
    const existing = grouped.get(event.date) || []
    existing.push(event)
    grouped.set(event.date, existing)
  }

  return grouped
}

// ============================================================
// Week and Day View Utilities
// ============================================================

// View mode labels in Swedish
export const VIEW_MODE_LABELS = {
  month: 'Månad',
  week: 'Vecka',
  day: 'Dag'
} as const

// Swedish full day names
export const SWEDISH_DAYS_FULL = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag']

// Get Monday of the week for a given date (ISO week - Monday first)
export function getWeekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayOfWeek = d.getDay()
  // Convert Sunday (0) to 7 for ISO week calculation
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  d.setDate(d.getDate() - diff)
  return d
}

// Get array of 7 dates for the week containing the given date
export function getWeekDays(date: Date): Date[] {
  const weekStart = getWeekStart(date)
  const days: Date[] = []
  for (let i = 0; i < 7; i++) {
    const day = new Date(weekStart)
    day.setDate(weekStart.getDate() + i)
    days.push(day)
  }
  return days
}

// Get ISO week number for a date
export function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  // Set to nearest Thursday (current date + 4 - current day number, make Sunday = 7)
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  // Get first day of year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  // Calculate full weeks to nearest Thursday
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return weekNo
}

// Generate hourly time slots
export function getTimeSlots(startHour: number = 8, endHour: number = 20): string[] {
  const slots: string[] = []
  for (let hour = startHour; hour <= endHour; hour++) {
    slots.push(`${String(hour).padStart(2, '0')}:00`)
  }
  return slots
}

// Get invoices for a date range (inclusive)
export function getInvoicesForDateRange(invoices: Invoice[], startDate: Date, endDate: Date): Invoice[] {
  const start = formatDateISO(startDate)
  const end = formatDateISO(endDate)
  return invoices.filter(inv => inv.due_date >= start && inv.due_date <= end)
}

// Get deadlines for a date range (inclusive)
export function getDeadlinesForDateRange(deadlines: Deadline[], startDate: Date, endDate: Date): Deadline[] {
  const start = formatDateISO(startDate)
  const end = formatDateISO(endDate)
  return deadlines.filter(d => d.due_date >= start && d.due_date <= end)
}

// Format date for week view header (e.g., "Mån 27")
export function formatWeekDayHeader(date: Date): string {
  const dayIndex = date.getDay() === 0 ? 6 : date.getDay() - 1
  return `${SWEDISH_DAYS[dayIndex]} ${date.getDate()}`
}

// Format date for day view header (e.g., "Måndag 27 januari 2025")
export function formatDayViewHeader(date: Date): string {
  const dayIndex = date.getDay() === 0 ? 6 : date.getDay() - 1
  return `${SWEDISH_DAYS_FULL[dayIndex]} ${date.getDate()} ${SWEDISH_MONTHS[date.getMonth()].toLowerCase()} ${date.getFullYear()}`
}
