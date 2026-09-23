import { describe, it, expect } from 'vitest'
import { parseCustomIssuanceLines } from '../issuance-custom-lines'

describe('parseCustomIssuanceLines', () => {
  const balanced = [
    { account_number: '1510', debit_amount: 12500, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
    { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
  ]

  it('passes through a missing body as no lines', () => {
    expect(parseCustomIssuanceLines(null)).toEqual({ ok: true, lines: undefined })
    expect(parseCustomIssuanceLines(undefined)).toEqual({ ok: true, lines: undefined })
  })

  it('accepts a body without lines', () => {
    expect(parseCustomIssuanceLines({})).toEqual({ ok: true, lines: undefined })
  })

  it('accepts balanced lines', () => {
    const result = parseCustomIssuanceLines({ lines: balanced })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.lines).toHaveLength(3)
  })

  it('rejects malformed bodies via the schema', () => {
    const result = parseCustomIssuanceLines({ lines: [{ account_number: 'x', debit_amount: -1 }] })
    expect(result).toMatchObject({ ok: false, error: 'invalid_body' })
  })

  it('rejects fewer than two lines', () => {
    const result = parseCustomIssuanceLines({ lines: [balanced[0]] })
    expect(result).toMatchObject({ ok: false, error: 'invalid_body' })
  })

  it('rejects unbalanced lines', () => {
    const result = parseCustomIssuanceLines({
      lines: [balanced[0], { account_number: '3001', debit_amount: 0, credit_amount: 9999 }],
    })
    expect(result).toMatchObject({ ok: false, error: 'unbalanced' })
  })

  it('rejects zero-debit entries', () => {
    const result = parseCustomIssuanceLines({
      lines: [
        { account_number: '1510', debit_amount: 0, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 0 },
      ],
    })
    expect(result).toMatchObject({ ok: false, error: 'unbalanced' })
  })

  it('rejects sub-öre payloads whose raw sums balance but rounded sums do not', () => {
    const result = parseCustomIssuanceLines({
      lines: [
        { account_number: '1510', debit_amount: 0.004, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0.004, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 0.008 },
      ],
    })
    expect(result).toMatchObject({ ok: false, error: 'unbalanced' })
  })

  it('rejects a row carrying both debit and credit', () => {
    const result = parseCustomIssuanceLines({
      lines: [
        { account_number: '1510', debit_amount: 100, credit_amount: 50 },
        { account_number: '3001', debit_amount: 0, credit_amount: 50 },
      ],
    })
    expect(result).toMatchObject({
      ok: false,
      error: 'invalid_lines',
      details: { reason: 'both_sides', index: 0 },
    })
  })

  it('rejects 29xx interim accounts', () => {
    const result = parseCustomIssuanceLines({
      lines: [
        { account_number: '1510', debit_amount: 12500, credit_amount: 0 },
        { account_number: '2990', debit_amount: 0, credit_amount: 12500 },
      ],
    })
    expect(result).toMatchObject({
      ok: false,
      error: 'invalid_lines',
      details: { reason: 'accrual_interim_account', account: '2990' },
    })
  })
})
