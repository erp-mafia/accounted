import { describe, it, expect, afterEach } from 'vitest'
import { bucketFor, groupConversations, relativeTime, type ConversationRow } from '../conversation-display'

function row(id: string, lastMessageAt: string, pinned = false): ConversationRow {
  return {
    id,
    intent_id: 'general.help',
    context_ref: null,
    title: null,
    pinned,
    archived: false,
    last_message_at: lastMessageAt,
    last_message_preview: null,
    created_at: lastMessageAt,
  }
}

const ms = (iso: string) => new Date(iso).getTime()

// The runtime zone is what differed between the server render (UTC on Vercel)
// and hydration (the visitor's zone). Every case runs in three of them.
const ZONES = ['UTC', 'Europe/Stockholm', 'America/Los_Angeles']
const originalTz = process.env.TZ

function inEachZone(check: () => void) {
  for (const zone of ZONES) {
    process.env.TZ = zone
    check()
  }
}

describe('bucketFor', () => {
  afterEach(() => {
    process.env.TZ = originalTz
  })

  // React #418 on /chat: at 10:00 Stockholm a conversation from 00:30
  // Stockholm (22:30 UTC the day before) was Igår to a UTC server and Idag to
  // the browser.
  it('counts days in Swedish time, whatever zone the runtime has', () => {
    const now = ms('2026-10-27T09:00:00Z') // 10:00 Stockholm (winter time)
    inEachZone(() => {
      expect(bucketFor(row('a', '2026-10-26T23:30:00Z'), now)).toBe('today') // 00:30 Stockholm
      expect(bucketFor(row('b', '2026-10-26T22:59:00Z'), now)).toBe('yesterday') // 23:59 the day before
      expect(bucketFor(row('c', '2026-10-25T23:00:00Z'), now)).toBe('yesterday') // 00:00 the day before
      expect(bucketFor(row('d', '2026-10-21T12:00:00Z'), now)).toBe('thisWeek') // six days back
      expect(bucketFor(row('e', '2026-10-20T12:00:00Z'), now)).toBe('older') // seven days back
    })
  })

  it('handles summer time and the clock change', () => {
    // 2026-10-25 03:00 summer time became 02:00: the day is 25 hours long.
    const now = ms('2026-10-25T22:30:00Z') // 23:30 Stockholm, winter time
    inEachZone(() => {
      expect(bucketFor(row('a', '2026-10-24T22:00:00Z'), now)).toBe('today') // 00:00 Stockholm summer time
      expect(bucketFor(row('b', '2026-10-24T21:59:00Z'), now)).toBe('yesterday')
    })
  })

  it('keeps pinned first and a future timestamp (clock skew) in today', () => {
    const now = ms('2026-10-27T09:00:00Z')
    expect(bucketFor(row('p', '2026-01-01T00:00:00Z', true), now)).toBe('pinned')
    expect(bucketFor(row('f', '2026-10-27T09:05:00Z'), now)).toBe('today')
  })

  it('files a row without a usable time under older', () => {
    const now = ms('2026-10-27T09:00:00Z')
    expect(bucketFor({ ...row('x', ''), created_at: '' }, now)).toBe('older')
    expect(bucketFor(row('y', 'not a date'), now)).toBe('older')
  })
})

describe('groupConversations', () => {
  afterEach(() => {
    process.env.TZ = originalTz
  })

  it('groups from the given now in Swedish days, in bucket order', () => {
    const now = ms('2026-10-27T09:00:00Z')
    inEachZone(() => {
      const groups = groupConversations(
        [row('p', '2026-09-01T10:00:00Z', true), row('a', '2026-10-26T23:30:00Z'), row('b', '2026-10-26T12:00:00Z')],
        now,
      )
      expect(groups.map((g) => [g.bucket, g.rows.map((r) => r.id)])).toEqual([
        ['pinned', ['p']],
        ['today', ['a']],
        ['yesterday', ['b']],
      ])
    })
  })
})

describe('relativeTime', () => {
  afterEach(() => {
    process.env.TZ = originalTz
  })

  it('labels minutes, hours and days from the given now', () => {
    const now = ms('2026-10-27T09:00:00Z')
    expect(relativeTime('2026-10-27T08:59:50Z', now)).toBe('nu')
    expect(relativeTime('2026-10-27T08:55:00Z', now)).toBe('5 min')
    expect(relativeTime('2026-10-27T06:00:00Z', now)).toBe('3 h')
    expect(relativeTime('2026-10-24T09:00:00Z', now)).toBe('3 d')
    expect(relativeTime(null, now)).toBe('')
  })

  // An older row shows its date. 23:30 UTC on 10-12 is 01:30 on 10-13 in
  // Stockholm; a UTC server printed "12 okt." and the browser "13 okt.".
  it('dates an older row in Swedish time, whatever zone the runtime has', () => {
    const now = ms('2026-10-27T09:00:00Z')
    inEachZone(() => {
      expect(relativeTime('2026-10-12T23:30:00Z', now)).toBe(
        new Date('2026-10-12T23:30:00Z').toLocaleDateString('sv-SE', {
          month: 'short',
          day: 'numeric',
          timeZone: 'Europe/Stockholm',
        }),
      )
      expect(relativeTime('2026-10-12T23:30:00Z', now)).toMatch(/^13 /)
    })
  })
})
