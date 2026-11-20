import { describe, expect, it } from 'vitest'
import { settingsSaveErrorMessage } from '../save-error'

describe('settingsSaveErrorMessage', () => {
  it('reads the structured envelope instead of printing [object Object]', () => {
    const body = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Ett oväntat serverfel uppstod.',
        message_en: 'An unexpected server error occurred.',
      },
    }

    const sv = settingsSaveErrorMessage(body, 500, 'sv')
    expect(sv).not.toContain('[object Object]')
    expect(sv).toBe('Ett oväntat serverfel uppstod.')
    expect(settingsSaveErrorMessage(body, 500, 'en')).not.toContain('[object Object]')
  })

  it('names the field rules of a validation refusal', () => {
    const body = {
      error: 'Validation failed',
      type: 'validation_error',
      errors: [
        { field: 'org_number', message: 'Organisationsnumret ska ha tio siffror.' },
        { field: 'vat_number', message: 'Momsregistreringsnumret är ogiltigt.' },
      ],
    }

    expect(settingsSaveErrorMessage(body, 400, 'sv')).toBe(
      'Organisationsnumret ska ha tio siffror. • Momsregistreringsnumret är ogiltigt.',
    )
  })

  it('falls back to the status when the body is not JSON', () => {
    expect(settingsSaveErrorMessage(null, 502, 'sv')).toBe('Servern är tillfälligt otillgänglig. Försök igen om en stund.')
  })
})
