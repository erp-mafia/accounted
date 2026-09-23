import { describe, it, expect } from 'vitest'
import { getRiskLevel, isHighRisk, OPERATION_RISK_TIERS } from '../risk-tiers'

describe('risk-tiers', () => {
  it('classifies all currently-staged op types', () => {
    // Op types that exist in the pending_operations CHECK constraint today.
    const knownOps = [
      'categorize_transaction',
      'create_customer',
      'create_invoice',
      'mark_invoice_paid',
      'send_invoice',
      'mark_invoice_sent',
      'match_transaction_invoice',
    ]
    for (const op of knownOps) {
      expect(OPERATION_RISK_TIERS).toHaveProperty(op)
    }
  })

  it('treats sending invoices and marking paid as high risk', () => {
    expect(getRiskLevel('send_invoice')).toBe('high')
    expect(getRiskLevel('mark_invoice_paid')).toBe('high')
    expect(getRiskLevel('mark_invoice_sent')).toBe('high')
  })

  it('treats period close, year-end, and SIE import as high risk', () => {
    expect(getRiskLevel('close_period')).toBe('high')
    expect(getRiskLevel('lock_period')).toBe('high')
    expect(getRiskLevel('run_year_end')).toBe('high')
    expect(getRiskLevel('import_sie')).toBe('high')
    expect(getRiskLevel('set_opening_balances')).toBe('high')
  })

  it('treats customer creation as low risk (no booking impact)', () => {
    expect(getRiskLevel('create_customer')).toBe('low')
  })

  it('treats reversible bookings as medium risk', () => {
    expect(getRiskLevel('categorize_transaction')).toBe('medium')
    expect(getRiskLevel('match_transaction_invoice')).toBe('medium')
    expect(getRiskLevel('create_invoice')).toBe('medium')
    expect(getRiskLevel('uncategorize_transaction')).toBe('medium')
  })

  it('defaults unknown op types to high (fail-safe)', () => {
    expect(getRiskLevel('totally_unknown_op')).toBe('high')
    expect(isHighRisk('totally_unknown_op')).toBe(true)
  })

  it('isHighRisk returns true only for high-risk ops', () => {
    expect(isHighRisk('send_invoice')).toBe(true)
    expect(isHighRisk('create_customer')).toBe(false)
    expect(isHighRisk('categorize_transaction')).toBe(false)
  })

  // Phase 4: arbitrary-line bookkeeping primitives. These accept any account
  // and any amount from the caller, so they're HIGH despite being structurally
  // similar to uncategorize_transaction (which is medium).
  it('treats arbitrary-line voucher primitives as high risk', () => {
    expect(getRiskLevel('create_voucher')).toBe('high')
    expect(getRiskLevel('correct_entry')).toBe('high')
    expect(isHighRisk('create_voucher')).toBe(true)
    expect(isHighRisk('correct_entry')).toBe(true)
  })

  // Recurring schedules are medium (the commit only writes a template), but
  // auto_send=true turns the schedule into indefinite outbound email with no
  // per-send approval: the same external side-effect that makes one-off
  // send_invoice high.
  it('escalates recurring schedules to high when params carry auto_send: true', () => {
    expect(getRiskLevel('create_recurring_schedule')).toBe('medium')
    expect(getRiskLevel('update_recurring_schedule')).toBe('medium')

    expect(getRiskLevel('create_recurring_schedule', { auto_send: true })).toBe('high')
    expect(getRiskLevel('update_recurring_schedule', { auto_send: true })).toBe('high')
    expect(isHighRisk('create_recurring_schedule', { auto_send: true })).toBe(true)
    expect(isHighRisk('update_recurring_schedule', { auto_send: true })).toBe(true)
  })

  it('only a literal auto_send === true escalates, and only for schedule ops', () => {
    expect(getRiskLevel('create_recurring_schedule', { auto_send: false })).toBe('medium')
    expect(getRiskLevel('create_recurring_schedule', {})).toBe('medium')
    // Truthy-but-not-true values (a 'true' string from a sloppy caller) do
    // not escalate: the staged param is a boolean by schema, and anything
    // else must fail closed at validation, not silently change tiers here.
    expect(getRiskLevel('update_recurring_schedule', { auto_send: 'true' })).toBe('medium')
    // auto_send on an unrelated op neither raises nor lowers its tier.
    expect(getRiskLevel('create_customer', { auto_send: true })).toBe('low')
    expect(getRiskLevel('send_invoice', { auto_send: false })).toBe('high')
  })
})
