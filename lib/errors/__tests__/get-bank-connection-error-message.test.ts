import { describe, it, expect } from 'vitest'
import { getBankConnectionErrorMessage } from '../get-error-message'

// The PSD2 callback mapper (issue #1716): raw provider tokens used to reach
// the user verbatim ("server_error", "invalid_state"), which left them with
// nothing to act on and support with nothing to answer.
describe('getBankConnectionErrorMessage', () => {
  it('maps a user cancel (access_denied) without echoing the provider text', () => {
    const msg = getBankConnectionErrorMessage('access_denied', 'User cancelled')
    expect(msg).toContain('Anslutningen avbröts hos banken')
    expect(msg).not.toContain('User cancelled')
  })

  it('treats "Cancelled by user" descriptions as a cancel regardless of code', () => {
    const msg = getBankConnectionErrorMessage('server_error', 'Cancelled by user')
    expect(msg).toContain('Anslutningen avbröts hos banken')
  })

  it('maps a bare server_error to the bank-side failure explanation', () => {
    const msg = getBankConnectionErrorMessage('server_error')
    expect(msg).toContain('fel på bankens sida')
    // The Handelsbanken corporate case: point at mandates without naming a bank
    // (the settings page adds the bank-specific steps from bank_error_code).
    expect(msg).toContain('fullmakt')
  })

  it('surfaces the provider description in parentheses on unknown codes', () => {
    const msg = getBankConnectionErrorMessage('aspsp_error', 'PSU lacks corporate mandate')
    expect(msg).toContain('Banken avvisade anslutningen')
    expect(msg).toContain('(PSU lacks corporate mandate)')
  })

  it('does not duplicate the code when the description equals the code', () => {
    const msg = getBankConnectionErrorMessage('server_error', 'server_error')
    expect(msg).toContain('fel på bankens sida')
    expect(msg).not.toContain('(server_error)')
  })

  it('maps session-expiry descriptions to the expired-session message', () => {
    const msg = getBankConnectionErrorMessage('server_error', 'Session expired at ASPSP')
    expect(msg).toContain('inloggningssession')
    expect(msg).toContain('(Session expired at ASPSP)')
  })

  it('maps the internal invalid_state token to a retry explanation', () => {
    const msg = getBankConnectionErrorMessage('invalid_state')
    expect(msg).toContain('Starta bankkopplingen på nytt')
    expect(msg).not.toContain('invalid_state')
  })

  it('maps missing_parameters and invalid_code_format to Swedish', () => {
    expect(getBankConnectionErrorMessage('missing_parameters')).toContain('ofullständigt svar')
    expect(getBankConnectionErrorMessage('invalid_code_format')).toContain('ogiltigt svar')
  })

  it('maps temporarily_unavailable to the try-later message', () => {
    const msg = getBankConnectionErrorMessage('temporarily_unavailable')
    expect(msg).toContain('tillfälligt otillgänglig')
  })

  it('falls back to a Swedish rejection message for unknown codes without description', () => {
    const msg = getBankConnectionErrorMessage('weird_code')
    expect(msg).toContain('Banken avvisade anslutningen')
    expect(msg).not.toContain('weird_code')
  })
})
