/**
 * remindersActiveFor is the one predicate UI surfaces read before claiming
 * that automatic reminders go out for a company. It joins the product-wide
 * kill switch (off since May 2026, PR #583) with the per-company toggle, so a
 * company whose toggle is on is not told "Automatiskt efter 15, 30 och 45
 * dagar" while nothing is sent (crm#95). The toggle is opt-in since migration
 * 20261025084600: only an explicit true counts as on.
 */
import { describe, it, expect } from 'vitest'
import { REMINDERS_SENDING_ENABLED, remindersActiveFor } from '@/lib/invoices/reminders-enabled'

describe('remindersActiveFor', () => {
  it('is false for every company while the product-wide switch is off', () => {
    expect(REMINDERS_SENDING_ENABLED).toBe(false)
    expect(remindersActiveFor(true)).toBe(false)
    expect(remindersActiveFor(false)).toBe(false)
    expect(remindersActiveFor(null)).toBe(false)
    expect(remindersActiveFor(undefined)).toBe(false)
  })

  it('follows the company toggle once sending is on, with a missing value counting as off like the opt-in default', () => {
    expect(remindersActiveFor(true, true)).toBe(true)
    expect(remindersActiveFor(null, true)).toBe(false)
    expect(remindersActiveFor(undefined, true)).toBe(false)
    expect(remindersActiveFor(false, true)).toBe(false)
  })
})
