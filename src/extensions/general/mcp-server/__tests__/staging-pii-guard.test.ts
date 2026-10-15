import { describe, it, expect } from 'vitest'
import { assertNoPlaintextPersonnummer } from '../staging-pii-guard'

describe('assertNoPlaintextPersonnummer', () => {
  it('throws on a top-level plaintext personnummer key in params', () => {
    expect(() =>
      assertNoPlaintextPersonnummer(
        { first_name: 'Test', personnummer: '198501011234' },
        'params',
      ),
    ).toThrow(/params contains plaintext PII key "personnummer"/)
  })

  it('throws when the key is nested inside a patch object (update-style staging)', () => {
    expect(() =>
      assertNoPlaintextPersonnummer(
        { employee_id: 'e-1', patch: { personnummer: '198501011234' } },
        'params',
      ),
    ).toThrow(/plaintext PII key "personnummer"/)
  })

  it('throws when the key hides inside an array of row objects', () => {
    expect(() =>
      assertNoPlaintextPersonnummer(
        { rows: [{ amount: 100 }, { ssn: '850101-1234' }] },
        'preview_data',
      ),
    ).toThrow(/preview_data contains plaintext PII key "ssn"/)
  })

  it('throws on the customers personal_number key (create_customer must stage the encrypted form)', () => {
    expect(() =>
      assertNoPlaintextPersonnummer(
        { name: 'Anna Andersson', customer_type: 'individual', personal_number: '19900101-1234' },
        'params',
      ),
    ).toThrow(/params contains plaintext PII key "personal_number"/)
  })

  it('allows the encrypted/masked derivatives that create_customer stages', () => {
    expect(() =>
      assertNoPlaintextPersonnummer(
        {
          name: 'Anna Andersson',
          customer_type: 'individual',
          personal_number_encrypted: 'ab'.repeat(40),
          personal_number_masked: '********-1234',
        },
        'params',
      ),
    ).not.toThrow()
  })

  it('allows the encrypted/masked derivatives that create_employee stages', () => {
    expect(() =>
      assertNoPlaintextPersonnummer(
        {
          first_name: 'Test',
          personnummer_encrypted: 'v1:abcdef',
          personnummer_last4: '1234',
          personnummer_masked: '850101-****',
        },
        'params',
      ),
    ).not.toThrow()
  })

  it('allows ordinary payloads: UUIDs, dates, aggregates, names', () => {
    expect(() =>
      assertNoPlaintextPersonnummer(
        {
          employee_id: 'b7f8d1a2-0000-0000-0000-000000000000',
          from: '2026-07-01',
          to: '2026-07-05',
          absence_type: 'sick',
          hours_per_day: 8,
          notes: null,
        },
        'params',
      ),
    ).not.toThrow()
  })

  it('fails closed when the payload nests past the scan depth (PII could hide below)', () => {
    // Before the fail-closed change, the scanner silently accepted anything
    // past MAX_DEPTH, so this personnummer would have been persisted.
    const payload = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { personnummer: '198501011234' } } } } } } },
    }
    expect(() => assertNoPlaintextPersonnummer(payload, 'params')).toThrow(
      /cannot be scanned for plaintext PII/,
    )
  })

  it('does not value-match: an EF org number equal to a personnummer passes under a business key', () => {
    // For enskild firma the org number IS the owner's personnummer; the
    // guard is key-based so legitimate counterparty data stays stageable.
    expect(() =>
      assertNoPlaintextPersonnummer({ org_number: '850101-1234' }, 'params'),
    ).not.toThrow()
  })
})
