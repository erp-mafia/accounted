import { describe, expect, it } from 'vitest';
import { FortnoxApiError, fortnoxErrorMessage, fortnoxRefusal, isFortnoxPermissionError } from '../client';

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

/**
 * The one reading of a Fortnox refusal (accounted#40, crm#1014). The bodies
 * are live answers from prod logs: an ordinary connection reads with the
 * rights of the Fortnox user who approved it, and a register that user may
 * not see comes back under either status with a code per register.
 */
describe('fortnoxRefusal', () => {
  const body = (message: string, code?: number) =>
    JSON.stringify({ ErrorInformation: { error: 1, message, ...(code ? { code } : {}) } });

  it('reads a user who may not see a register as a permission refusal, 400 or 403', () => {
    for (const [status, text, code] of [
      [403, 'Saknar behörighet för leverantörsregister.', 2003275],
      [400, 'Saknar behörighet för leverantörsfaktura.', 2002182],
      [400, 'Saknar behörighet för kundregister.', 2001538],
      [400, 'Saknar rättighet för att använda verifikationer.', 2001381],
    ] as const) {
      expect(fortnoxRefusal(new FortnoxApiError('x', status, body(text, code))), text)
        .toEqual({ reason: 'permission', documented: false });
    }
    // Plain text, no JSON and no code.
    expect(fortnoxRefusal(new FortnoxApiError('x', 403, 'Du saknar behörighet för GET-anrop mot /3/invoices')))
      .toEqual({ reason: 'permission', documented: false });
  });

  it('names the documented codes as documented, whatever the status', () => {
    expect(fortnoxRefusal(new FortnoxApiError('x', 400, body('Det finns ingen aktiv licens för önskat scope.', 2001101))))
      .toEqual({ reason: 'license', documented: true });
    expect(fortnoxRefusal(new FortnoxApiError('x', 403, body('Har inte behörighet för scope.', 2000663))))
      .toEqual({ reason: 'permission', documented: true });
    expect(fortnoxRefusal(new FortnoxApiError('x', 400, body('Api-licens saknas.', 2001103))))
      .toEqual({ reason: 'api_license', documented: true });
  });

  it('tells a licence from a right by the sentence when no documented code came with it', () => {
    expect(fortnoxRefusal(new FortnoxApiError('x', 400, body('Det finns ingen aktiv licens för önskat scope.'))))
      .toEqual({ reason: 'license', documented: false });
    expect(fortnoxRefusal(new FortnoxApiError('x', 400, body('Api-licens saknas.'))))
      .toEqual({ reason: 'api_license', documented: false });
    expect(fortnoxRefusal(new FortnoxApiError('x', 403))).toEqual({ reason: 'permission', documented: false });
  });

  it('is null for what is not a refusal', () => {
    expect(fortnoxRefusal(new FortnoxApiError('x', 401, body('Ogiltig inloggning', 2000310)))).toBeNull();
    expect(fortnoxRefusal(new FortnoxApiError('x', 400, body('Kan inte hitta kontot.', 2000423)))).toBeNull();
    expect(fortnoxRefusal(new FortnoxApiError('x', 404, body('Saknar behörighet för kundregister.')))).toBeNull();
    // An outage or a rate limit is never a refusal, even with a refusal code in the body.
    expect(fortnoxRefusal(new FortnoxApiError('x', 503, body('Api-licens saknas.', 2001103)))).toBeNull();
    expect(fortnoxRefusal(new FortnoxApiError('x', 429, body('Har inte behörighet för scope.', 2000663)))).toBeNull();
    expect(fortnoxRefusal(new Error('Saknar behörighet för kundregister.'))).toBeNull();
  });

  it('is what isFortnoxPermissionError answers', () => {
    expect(isFortnoxPermissionError(new FortnoxApiError('x', 400, body('Saknar behörighet för leverantörsfaktura.', 2002182)))).toBe(true);
    expect(isFortnoxPermissionError(new FortnoxApiError('x', 401))).toBe(false);
  });
});
