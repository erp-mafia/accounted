/**
 * crm#1216: Bokför on a salary run posted its vouchers on the first click,
 * dated on the payment date even when that date was a week ahead. Every
 * other state-advancing action on the page confirmed first; design.md
 * convention 10 says posting actions confirm up front with the outcome.
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
    const bookAt = body.indexOf("handleAction('book')")
    expect(confirmAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(confirmAt)
    expect(bookAt).toBeGreaterThan(guardAt)
  })

  it('says so when the payment date is after today (Stockholm calendar day)', () => {
    expect(page).toMatch(/run\.payment_date > todayIsoStockholm\(\)\) lines\.push\(t\('confirm_book_ahead'/)
  })
})

describe('Bokför confirm copy', () => {
  const keys = ['confirm_book_title', 'confirm_book_intro', 'confirm_book_ahead', 'confirm_book_correction'] as const

  it.each([
    ['sv', sv.salary_run],
    ['en', en.salary_run],
  ] as const)('%s has every string, with the period and the date', (_locale, messages) => {
    for (const key of keys) expect(typeof messages[key]).toBe('string')
    expect(messages.confirm_book_intro).toContain('{period}')
    expect(messages.confirm_book_intro).toContain('{date}')
    expect(messages.confirm_book_ahead).toContain('{date}')
    for (const key of keys) expect(messages[key]).not.toMatch(/[–—]/)
  })

  it('no Swedish sentence starts with "Att"', () => {
    for (const key of keys) expect(sv.salary_run[key]).not.toMatch(/(^|[.!?]\s+)Att\b/)
  })
})
