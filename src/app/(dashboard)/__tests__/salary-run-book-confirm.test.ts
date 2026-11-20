/**
 * crm#1216: Bokför on a salary run posted its vouchers on the first click,
 * dated on the payment date even when that date was a week ahead. Every
 * other state-advancing action on the page confirmed first; the design
 * convention is that posting actions confirm up front with the outcome.
 * Markera som betald, the step before it, asks first too when the payment
 * date has not come yet (the rule itself: lib/salary/payout-date.ts). The
 * server refuses an early payout without that answer, so the confirmed call
 * carries confirm_payment_date_ahead.
 * Components are not rendered in this suite (vitest runs in `node`), so the
 * wiring is pinned on the page source and the copy on the message files.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const page = fs.readFileSync(path.resolve(__dirname, '../salary/runs/[id]/page.tsx'), 'utf8')

describe('salary run Bokför confirms before posting', () => {
  it('the header action goes through handleBook, never straight to the book endpoint', () => {
    expect(page).toMatch(/key: 'book', label: t\('action_book'\), onClick: handleBook \}/)
    expect(page).not.toMatch(/onClick: \(\) => handleAction\('book'\)/)
  })

  it('handleBook posts only after the confirm resolves true', () => {
    const body = page.slice(page.indexOf('async function handleBook()'))
    const confirmAt = body.indexOf('await confirmAction(')
    const guardAt = body.indexOf('if (!ok) return')
    const bookAt = body.indexOf("handleAction('book'")
    expect(confirmAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(confirmAt)
    expect(bookAt).toBeGreaterThan(guardAt)
  })

  it('says so when the payment date is after today (Stockholm calendar day)', () => {
    expect(page).toMatch(/const ahead = isPaymentDateAhead\(run\.payment_date\)/)
    expect(page).toMatch(/if \(ahead\) lines\.push\(t\('confirm_book_ahead'/)
  })

  it('sends the confirmation the server asks for only when the dialog named the early date', () => {
    expect(page).toMatch(/handleAction\('book', 'POST', ahead \? \{ confirm_payment_date_ahead: true \} : undefined\)/)
  })

  it('names the bank leg when the run pays something out', () => {
    expect(page).toMatch(/if \(!noPayout\) lines\.push\(t\('confirm_book_bank'\)\)/)
  })
})

describe('salary run Markera som betald asks first when the payment date is ahead', () => {
  it('the header action goes through handleMarkPaid, never straight to the paid endpoint', () => {
    expect(page).toMatch(/key: 'paid', label: [^}]*, onClick: handleMarkPaid \}/)
    expect(page).not.toMatch(/onClick: \(\) => handleAction\('paid'\)/)
  })

  it('confirms only for a future payout, and marks paid only after the confirm resolves true', () => {
    const body = page.slice(page.indexOf('async function handleMarkPaid()'))
    const askAt = body.indexOf('if (needsFuturePayoutConfirm(run.payment_date, noPayout))')
    const confirmAt = body.indexOf('await confirmAction(')
    const guardAt = body.indexOf('if (!ok) return')
    const confirmedPaidAt = body.indexOf("handleAction('paid', 'POST', { confirm_payment_date_ahead: true })")
    const plainPaidAt = body.indexOf("handleAction('paid')")
    expect(askAt).toBeGreaterThan(-1)
    expect(confirmAt).toBeGreaterThan(askAt)
    expect(guardAt).toBeGreaterThan(confirmAt)
    expect(confirmedPaidAt).toBeGreaterThan(guardAt)
    expect(plainPaidAt).toBeGreaterThan(confirmedPaidAt)
    expect(body.slice(confirmAt, guardAt)).toContain("t('confirm_mark_paid_ahead'")
  })
})

describe('Bokför and Markera som betald confirm copy', () => {
  const keys = [
    'confirm_book_title',
    'confirm_book_intro',
    'confirm_book_bank',
    'confirm_book_ahead',
    'confirm_book_correction',
    'confirm_mark_paid_ahead_title',
    'confirm_mark_paid_ahead',
  ] as const

  it.each([
    ['sv', sv.salary_run],
    ['en', en.salary_run],
  ] as const)('%s has every string, with the period and the date', (_locale, messages) => {
    for (const key of keys) expect(typeof messages[key]).toBe('string')
    expect(messages.confirm_book_intro).toContain('{period}')
    expect(messages.confirm_book_intro).toContain('{date}')
    expect(messages.confirm_book_ahead).toContain('{date}')
    expect(messages.confirm_mark_paid_ahead).toContain('{date}')
    for (const key of keys) expect(messages[key]).not.toMatch(/[–—]/)
  })

  it('no Swedish sentence starts with "Att"', () => {
    for (const key of keys) expect(sv.salary_run[key]).not.toMatch(/(^|[.!?]\s+)Att\b/)
  })
})
