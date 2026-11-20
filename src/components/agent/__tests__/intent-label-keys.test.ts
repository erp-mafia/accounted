/**
 * crm#1356: the conversation page named an untitled thread from its own
 * Swedish list of four intents, and showed the raw id ("bokslut.step") for
 * the rest. It now reads the intent's name from the user's catalogue, keyed
 * by intent-label-keys.ts, and in Swedish says exactly what the sidebar's
 * intentLabel says for the same thread.
 */
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { intentLabel } from '../conversation-display'
import { INTENT_LABEL_KEYS, intentLabelKey } from '../intent-label-keys'

const svChat = sv.agent_chat as Record<string, string>
const enChat = en.agent_chat as Record<string, string>

describe('intentLabelKey', () => {
  const intents = [...Object.keys(INTENT_LABEL_KEYS), 'general.help', 'no.such.intent', 'toString']

  it('names every intent in Swedish as the sidebar does', () => {
    expect(Object.keys(INTENT_LABEL_KEYS)).toHaveLength(9)
    for (const intent of intents) {
      expect(svChat[intentLabelKey(intent)], intent).toBe(intentLabel(intent))
    }
  })

  it('names every intent in English', () => {
    for (const intent of intents) {
      const label = enChat[intentLabelKey(intent)]
      expect(label, intent).toBeTruthy()
      expect(looksSwedish(label), `${intent}: ${label}`).toBe(false)
    }
  })

  it('gives an unknown intent the general name, never its id', () => {
    expect(intentLabelKey('no.such.intent')).toBe('intent_general')
    expect(intentLabelKey('toString')).toBe('intent_general')
  })
})
