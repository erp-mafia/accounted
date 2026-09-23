import { describe, expect, it, vi } from 'vitest'
import { SIEJobMappingsSchema } from '@/lib/api/schemas'
import { ACCOUNT_NUMBER_MESSAGE } from '@/lib/invariants/account-number'
import { errorResponse } from '../get-structured-error'
import { getErrorMessage } from '../get-error-message'

const envelope = (issues: unknown) => ({ error: { code: 'VALIDATION_ERROR',
  message: 'Förfrågan innehåller ogiltiga uppgifter.', details: { issues } } })

describe('canonical validation details in the UI', () => {
  it.each(['sv', 'en'] as const)('shows the actual rejected source account in %s', locale => {
    const message = getErrorMessage(envelope([{ field: '0.targetAccount', message: ACCOUNT_NUMBER_MESSAGE, sourceAccount: '193000' }]), { locale })
    expect(message).toContain('193000')
    expect(message).toContain(locale === 'sv' ? 'fyra siffror' : 'four digits')
    expect(message).not.toContain('ogiltiga uppgifter')
  })

  it('renders the real JSON response without corrupting Swedish characters', async () => {
    const checked = SIEJobMappingsSchema.safeParse([{ sourceAccount: '999', targetAccount: '999',
      sourceName: 'Källkonto', targetName: 'Målkonto', confidence: 1, matchType: 'manual' }])
    expect(checked.success).toBe(false)
    if (checked.success) return
    const response = errorResponse(checked.error, { warn: vi.fn(), error: vi.fn() } as never, { requestId: 'test-request' })
    const body = await response.json()
    expect(body.error.details.issues[0].message).toBe('Kontonummer måste vara 4 siffror')
    expect(getErrorMessage(body)).toContain('Målkontot måste ha exakt fyra siffror')
  })

  it('shows all three useful issues and summarizes the remaining count', () => {
    const message = getErrorMessage(envelope(Array.from({ length: 5 }, (_, i) => ({ field: `rows.${i}.name`, message: 'Namnet saknas.' }))))
    expect(message).toContain('rows.0.name')
    expect(message).toContain('rows.2.name')
    expect(message).not.toContain('rows.3.name')
    expect(message).toContain('(+2 till)')
  })

  it.each([undefined, null, [], [null, {}, { message: 42 }], [{ message: 'TypeError at secret.ts:12' }]])('falls back safely for malformed or technical details: %j', issues => {
    expect(getErrorMessage(envelope(issues))).toBe('Förfrågan innehåller ogiltiga uppgifter.')
  })
})
