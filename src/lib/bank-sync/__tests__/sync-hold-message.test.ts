import { describe, expect, it } from 'vitest'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { SYNC_HOLD_UNTIMED, rateLimitMessages, syncCooldownMessages, syncHoldMessage } from '../sync-hold-message'

const NOW = Date.parse('2026-11-11T14:29:19Z') // 15:29 in Stockholm
const IN_14_MIN = '2026-11-11T14:43:00.000Z' // 15:43 in Stockholm

describe('syncCooldownMessages', () => {
  it('names the Stockholm clock time, as "at the earliest", and claims nothing about the rows', () => {
    const { sv, en } = syncCooldownMessages(Date.parse(IN_14_MIN), NOW)
    expect(sv).toBe('En synkning startades nyligen. Du kan synka igen tidigast 15:43.')
    expect(en).toBe('A sync was started recently. You can sync again at 15:43 (Swedish time) at the earliest.')
    // The code also answers while a sync runs and after one that failed: never "fresh".
    expect(sv + en).not.toMatch(/färsk|fresh/i)
  })

  it('rounds a hold that ends inside a minute up to the next one, across the hour and the day', () => {
    // 15:43:45: at 15:43:10 the hold still stands, so the earliest minute is 15:44.
    expect(syncCooldownMessages(Date.parse('2026-11-11T14:43:45Z'), NOW).sv).toContain('tidigast 15:44.')
    expect(syncCooldownMessages(Date.parse('2026-11-11T14:59:00.001Z'), NOW).sv).toContain('tidigast 16:00.')
    expect(syncCooldownMessages(Date.parse('2026-11-11T22:59:30Z'), NOW).sv).toContain('tidigast 12 nov. 00:00.')
  })
})

describe('syncHoldMessage', () => {
  // The toast a person got on Synka nu inside the cooldown read "Vänta tills
  // next_allowed_at innan du synkar igen" (22 times, 2026-10-29
  // to 2026-11-11): the registry sentence, written for agents, shown as is.
  it('words a cooldown envelope with the time, in the reader\'s language', () => {
    const details = { connection_id: 'c-1', next_allowed_at: IN_14_MIN, retry_after_seconds: 821 }
    expect(syncHoldMessage('BANK_SYNC_COOLDOWN', details, 'sv', NOW)).toBe('En synkning startades nyligen. Du kan synka igen tidigast 15:43.')
    expect(syncHoldMessage('BANK_SYNC_COOLDOWN', details, 'en', NOW)).toBe('A sync was started recently. You can sync again at 15:43 (Swedish time) at the earliest.')
  })

  it('words the bank\'s read limit with the same sentence the Enable Banking door answers', () => {
    const until = '2026-11-12T07:00:00.000Z' // another Stockholm day: the day comes first
    expect(syncHoldMessage('BANK_RATE_LIMITED', { next_allowed_at: until, status: 'active' }, 'sv', NOW)).toBe(rateLimitMessages(Date.parse(until), NOW).sv)
    expect(syncHoldMessage('BANK_RATE_LIMITED', { next_allowed_at: until }, 'sv', NOW)).toContain('Försök igen tidigast 12 nov. 08:00.')
  })

  it('the bank\'s short throttle is over in a minute: never a clock time, and the person\'s English', () => {
    expect(syncHoldMessage('BANK_THROTTLED', { next_allowed_at: IN_14_MIN }, 'sv', NOW)).toBe('Banken är upptagen just nu. Försök igen om en stund.')
    expect(syncHoldMessage('BANK_THROTTLED', { next_allowed_at: IN_14_MIN }, 'en', NOW)).toBe('The bank is busy right now. Try again in a moment.')
  })

  it('never hands a person a field name: every hold, both languages, with a time, without one, with one that is not one', () => {
    const fieldName = /\b[a-z]+(?:_[a-z0-9]+)+\b/
    for (const code of Object.keys(SYNC_HOLD_UNTIMED)) {
      for (const details of [{ next_allowed_at: IN_14_MIN }, {}, undefined, null, { next_allowed_at: 'soon' }, { next_allowed_at: 1794408180000 }]) {
        for (const locale of ['sv', 'en'] as const) {
          const text = syncHoldMessage(code, details, locale, NOW)
          expect(text, `${code} ${locale} ${JSON.stringify(details)}`).toEqual(expect.any(String))
          expect(text, `${code} ${locale} ${JSON.stringify(details)}`).not.toMatch(fieldName)
        }
      }
    }
  })

  it('without a time the Swedish sentence is the registry\'s own, word for word', () => {
    for (const [code, text] of Object.entries(SYNC_HOLD_UNTIMED)) {
      expect(getErrorEntry(code)?.message_sv, code).toBe(text.sv)
      expect(syncHoldMessage(code, {}, 'sv', NOW), code).toBe(text.sv)
    }
  })

  it('answers null for every other code, a key of Object included', () => {
    expect(syncHoldMessage('BANK_SYNC_FAILED', { next_allowed_at: IN_14_MIN }, 'sv', NOW)).toBeNull()
    expect(syncHoldMessage('constructor', { next_allowed_at: IN_14_MIN }, 'sv', NOW)).toBeNull()
    expect(syncHoldMessage('toString', {}, 'en', NOW)).toBeNull()
    expect(syncHoldMessage(undefined, { next_allowed_at: IN_14_MIN }, 'sv', NOW)).toBeNull()
  })
})
