/**
 * Activation turns on reminders and debt collection only: invoice delivery
 * through the provider is deferred and stays hidden (its settings group
 * renders only when deliveryEnabled). The words a user reads before and on
 * activation must name only what activation turns on.
 */
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

type Messages = Record<string, Record<string, string>>

const ACTIVATION_COPY: Array<[namespace: string, key: string]> = [
  ['collections', 'activate_cta'],
  ['collections', 'upgrade_note'],
  ['settings_collections', 'activate'],
  ['settings_connections', 'collections_help'],
]

describe('collections activation copy', () => {
  it.each(ACTIVATION_COPY)('%s.%s names reminders and collection, not delivery', (namespace, key) => {
    const svText = (sv as unknown as Messages)[namespace]?.[key]
    const enText = (en as unknown as Messages)[namespace]?.[key]
    expect(svText).toBeTruthy()
    expect(enText).toBeTruthy()
    expect(svText).not.toMatch(/utskick/i)
    expect(enText).not.toMatch(/deliver/i)
  })

  it('the activation button says what it activates', () => {
    expect((sv as unknown as Messages).settings_collections.activate).toBe('Aktivera påminnelser och inkasso')
    expect((en as unknown as Messages).settings_collections.activate).toBe('Activate reminders and debt collection')
  })
})
