import { describe, it, expect } from 'vitest';
import { salesDocumentNumber, statedDocumentNumber } from '../dto';

/**
 * The one invoice-number rule the Bokio, Briox and WINT sales mappers share
 * (crm#1084, issue #51): a provider's record id never stands in for the
 * number of a draft or a cancelled document.
 */
describe('statedDocumentNumber', () => {
  it('trims and stringifies a stated number', () => {
    expect(statedDocumentNumber(' F-77 ')).toBe('F-77');
    expect(statedDocumentNumber(4711)).toBe('4711');
  });

  it('reads null, undefined and blank as no number', () => {
    expect(statedDocumentNumber(null)).toBe('');
    expect(statedDocumentNumber(undefined)).toBe('');
    expect(statedDocumentNumber('   ')).toBe('');
  });
});

describe('salesDocumentNumber', () => {
  it('keeps a stated number whatever the status', () => {
    expect(salesDocumentNumber('1001', 7, 'draft')).toBe('1001');
    expect(salesDocumentNumber(1001, 7, 'sent')).toBe('1001');
  });

  it('gives a draft or cancelled document without a number none, never the record id', () => {
    expect(salesDocumentNumber(null, 7, 'draft')).toBe('');
    expect(salesDocumentNumber('', 7, 'cancelled')).toBe('');
  });

  it('keeps the record id on an issued document without a number, which the insert could not store with none', () => {
    for (const status of ['sent', 'booked', 'paid', 'overdue', 'credited'] as const) {
      expect(salesDocumentNumber(undefined, 7, status)).toBe('7');
    }
    expect(salesDocumentNumber(undefined, undefined, 'sent')).toBe('');
  });
});
