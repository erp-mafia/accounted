/**
 * Notification payload constructors for all push notification types.
 *
 * Centralises every notification's title/body/icon/action in one place.
 * Both event handlers and the cron scheduler import from here.
 */

import type { NotificationPayload } from './notification-sender'

// ============================================================
// Helpers
// ============================================================

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('sv-SE', {
    day: 'numeric',
    month: 'short',
  })
}

// ============================================================
// Event-driven payloads
// ============================================================

export function createPeriodLockedPayload(
  periodName: string,
  periodId: string
): NotificationPayload {
  return {
    title: 'Period låst',
    body: `${periodName} har låsts`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `period-locked-${periodId}`,
    data: {
      url: '/periods',
      type: 'period_locked',
      id: periodId,
    },
  }
}

export function createYearClosedPayload(
  periodName: string,
  periodId: string
): NotificationPayload {
  return {
    title: 'Årsbokslut klart',
    body: `Årsbokslut klart för ${periodName}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `year-closed-${periodId}`,
    data: {
      url: '/periods',
      type: 'period_year_closed',
      id: periodId,
    },
  }
}

export function createInvoiceSentPayload(
  invoiceNumber: string,
  invoiceId: string
): NotificationPayload {
  return {
    title: 'Faktura skickad',
    body: `Faktura ${invoiceNumber} skickad`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `invoice-sent-${invoiceId}`,
    data: {
      url: `/invoices/${invoiceId}`,
      type: 'invoice_sent',
      id: invoiceId,
    },
  }
}

export function createReceiptExtractedPayload(
  merchantName: string | null,
  receiptId: string
): NotificationPayload {
  const merchant = merchantName || 'Okänd butik'
  return {
    title: 'Kvitto analyserat',
    body: `Kvitto analyserat: ${merchant}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `receipt-extracted-${receiptId}`,
    data: {
      url: '/transactions',
      type: 'receipt_extracted',
      id: receiptId,
    },
  }
}

export function createReceiptMatchedPayload(
  receiptId: string,
  transactionId: string
): NotificationPayload {
  return {
    title: 'Kvitto matchat',
    body: 'Kvitto matchat mot transaktion',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `receipt-matched-${receiptId}`,
    data: {
      url: '/transactions',
      type: 'receipt_matched',
      id: receiptId,
    },
  }
}

// ============================================================
// Missing underlag payload
// ============================================================

export function createMissingUnderlagPayload(count: number): NotificationPayload {
  return {
    title: 'Saknade underlag',
    body: `${count} verifikation(er) saknar underlag. Bifoga för att uppfylla bokföringslagen.`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: 'missing-underlag-weekly',
    data: {
      url: '/bookkeeping?missingUnderlag=true',
      type: 'missing_underlag',
    },
  }
}

// ============================================================
// Cron-based payloads (moved from lib/push/web-push.ts)
// ============================================================

export function createTaxDeadlinePayload(
  title: string,
  dueDate: string,
  daysUntil: number,
  deadlineId: string
): NotificationPayload {
  const urgencyText =
    daysUntil === 0 ? 'IDAG!' : daysUntil === 1 ? 'imorgon' : `om ${daysUntil} dagar`

  return {
    title: `${title}`,
    body: `Deadline ${urgencyText} (${formatDate(dueDate)})`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `tax-deadline-${deadlineId}`,
    data: {
      url: '/deadlines',
      type: 'tax_deadline',
      id: deadlineId,
    },
    actions: [
      { action: 'view', title: 'Visa' },
      { action: 'dismiss', title: 'Avfärda' },
    ],
  }
}

// Invoices carry their own currency; "kr" is only correct for SEK.
function formatInvoiceAmount(amount: number, currency: string): string {
  return `${amount.toLocaleString('sv-SE')} ${!currency || currency === 'SEK' ? 'kr' : currency}`
}

export function createInvoiceOverduePayload(
  invoiceNumber: string,
  customerName: string,
  amount: number,
  currency: string,
  dueDate: string,
  invoiceId: string
): NotificationPayload {
  return {
    title: `Obetald faktura #${invoiceNumber}`,
    body: `${customerName} - ${formatInvoiceAmount(amount, currency)} (förföll ${formatDate(dueDate)})`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `invoice-${invoiceId}`,
    data: {
      url: `/invoices/${invoiceId}`,
      type: 'invoice_overdue',
      id: invoiceId,
    },
    actions: [{ action: 'view', title: 'Visa faktura' }],
  }
}

export function createInvoiceDuePayload(
  invoiceNumber: string,
  customerName: string,
  amount: number,
  currency: string,
  dueDate: string,
  invoiceId: string
): NotificationPayload {
  return {
    title: `Faktura #${invoiceNumber} förfaller`,
    body: `${customerName} - ${formatInvoiceAmount(amount, currency)} (${formatDate(dueDate)})`,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `invoice-${invoiceId}`,
    data: {
      url: `/invoices/${invoiceId}`,
      type: 'invoice_due',
      id: invoiceId,
    },
    actions: [{ action: 'view', title: 'Visa faktura' }],
  }
}
