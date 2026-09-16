import { describe, it, expect } from 'vitest'
import { classifyBankConnectionDenial, getBankConnectionErrorMessage } from '../get-error-message'

// The PSD2 callback mapper (issue #1716): raw provider tokens used to reach
// the user verbatim ("server_error", "invalid_state"), which left them with
// nothing to act on and support with nothing to answer.
describe('getBankConnectionErrorMessage', () => {
  it('maps a user cancel (access_denied) without echoing the provider text', () => {
    const msg = getBankConnectionErrorMessage('access_denied', 'User cancelled')
    expect(msg).toContain('Anslutningen avbröts hos banken')
    expect(msg).not.toContain('User cancelled')
  })

  it('treats a bare access_denied (no description) as a cancel', () => {
    const msg = getBankConnectionErrorMessage('access_denied')
    expect(msg).toContain('Anslutningen avbröts hos banken')
  })

  it('treats a declined consent as a cancel, not a bank-side refusal', () => {
    const msg = getBankConnectionErrorMessage('access_denied', 'Denied data sharing consent')
    expect(msg).toContain('Anslutningen avbröts hos banken')
    expect(msg).not.toContain('Denied data sharing consent')
  })

  it('explains a refused login (Handelsbanken "Invalid credentials") as a fullmakt problem, not a cancel', () => {
    // Since 2026-09-14 Handelsbanken reports an unlinked "API Företag"
    // fullmakt this way; it used to read as "you cancelled, try again".
    const msg = getBankConnectionErrorMessage('access_denied', 'Invalid credentials')
    expect(msg).toContain('godkände inte inloggningen')
    expect(msg).toContain('fullmakt')
    expect(msg).not.toContain('Anslutningen avbröts')
    // The bank's own sentence still reaches the screenshot.
    expect(msg).toContain('(Invalid credentials)')
  })

  it('explains a closed account-information door (SEB) as something the bank must enable', () => {
    const msg = getBankConnectionErrorMessage(
      'access_denied',
      'You cannot retrieve account information, please ask PSU to contact bank'
    )
    expect(msg).toContain('tillgång till kontoinformation')
    expect(msg).toContain('Be banken')
    expect(msg).not.toContain('Anslutningen avbröts')
    expect(msg).toContain('(You cannot retrieve account information')
  })

  it('falls back to the generic rejection with the bank text for an unknown access_denied description', () => {
    const msg = getBankConnectionErrorMessage('access_denied', 'ASPSP internal policy 42')
    expect(msg).toContain('Banken avvisade anslutningen')
    expect(msg).toContain('(ASPSP internal policy 42)')
    expect(msg).not.toContain('Anslutningen avbröts')
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

  describe('classifyBankConnectionDenial', () => {
    it('classifies the denial shapes the settings page keys its hints on', () => {
      expect(classifyBankConnectionDenial('access_denied')).toBe('cancelled')
      expect(classifyBankConnectionDenial('access_denied', 'User cancelled')).toBe('cancelled')
      expect(classifyBankConnectionDenial('access_denied', 'Denied data sharing consent')).toBe('cancelled')
      expect(classifyBankConnectionDenial('server_error', 'Cancelled by user')).toBe('cancelled')
      expect(classifyBankConnectionDenial('access_denied', 'Invalid credentials')).toBe('invalid_credentials')
      expect(
        classifyBankConnectionDenial(
          'access_denied',
          'You cannot retrieve account information, please ask PSU to contact bank'
        )
      ).toBe('account_access')
      expect(classifyBankConnectionDenial('access_denied', 'ASPSP internal policy 42')).toBe('other')
    })

    it('returns null for every non-denial code', () => {
      expect(classifyBankConnectionDenial('server_error')).toBeNull()
      expect(classifyBankConnectionDenial('temporarily_unavailable', 'try later')).toBeNull()
      expect(classifyBankConnectionDenial('invalid_state')).toBeNull()
    })
  })
})
