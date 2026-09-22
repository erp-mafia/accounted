import { describe, expect, it } from 'vitest';
import { FortnoxApiError, fortnoxErrorMessage, isFortnoxPermissionError } from '../client';

describe('fortnoxErrorMessage', () => {
  it('reads ErrorInformation.message from a Fortnox error body', () => {
    const error = new FortnoxApiError(
      'Fortnox API error: 400 Bad Request',
      400,
      '{"ErrorInformation":{"error":1,"message":"Kan inte hitta kontot.","code":2000423}}',
    );
    expect(fortnoxErrorMessage(error)).toBe('Kan inte hitta kontot.');
  });

  it('falls back to the raw body when it is not JSON and to null when empty', () => {
    expect(fortnoxErrorMessage(new FortnoxApiError('x', 500, 'Gateway timeout'))).toBe(
      'Gateway timeout',
    );
    expect(fortnoxErrorMessage(new FortnoxApiError('x', 500, ''))).toBeNull();
    expect(fortnoxErrorMessage(new Error('not fortnox'))).toBeNull();
  });
});

describe('isFortnoxPermissionError', () => {
  it('treats 403 as a permission failure regardless of body', () => {
    expect(isFortnoxPermissionError(new FortnoxApiError('forbidden', 403))).toBe(true);
  });

  it('treats a 400 with a behörighet/scope/licens message as a permission failure', () => {
    const error = new FortnoxApiError(
      'Fortnox API error: 400 Bad Request',
      400,
      '{"ErrorInformation":{"error":1,"message":"Du saknar behörighet till denna resurs.","code":2000663}}',
    );
    expect(isFortnoxPermissionError(error)).toBe(true);
    expect(
      isFortnoxPermissionError(
        new FortnoxApiError('x', 400, '{"ErrorInformation":{"message":"Invalid scope"}}'),
      ),
    ).toBe(true);
  });

  it('does not classify an ordinary 400 or a non-Fortnox error as permission', () => {
    expect(
      isFortnoxPermissionError(
        new FortnoxApiError('x', 400, '{"ErrorInformation":{"message":"Kan inte hitta kontot."}}'),
      ),
    ).toBe(false);
    expect(isFortnoxPermissionError(new FortnoxApiError('x', 400, ''))).toBe(false);
    expect(isFortnoxPermissionError(new Error('boom'))).toBe(false);
  });
});
