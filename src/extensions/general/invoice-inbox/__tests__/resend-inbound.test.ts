import { describe, it, expect } from 'vitest'
import {
  extractLocalPartForDomain,
  extractSharedRecipientsForDomain,
  groupSharedRecipientsByInbox,
  isMailMachineryPart,
  isPlainTextPart,
  kindHintFromTag,
  mayRedeliverOverMinuteCap,
  MINUTE_CAP_REDELIVERY_WINDOW_MS,
  resolveKindHintForTags,
  splitKnownInboxTags,
} from '@/extensions/general/invoice-inbox/lib/resend-inbound'

describe('mayRedeliverOverMinuteCap', () => {
  const now = Date.parse('2026-11-10T13:20:30Z')

  it('hands back a mail inside the first hour, where Resend retries at 5 s, 5 min and 30 min', () => {
    expect(mayRedeliverOverMinuteCap('2026-11-10T13:20:10Z', now)).toBe(true)
    expect(mayRedeliverOverMinuteCap('2026-11-10T12:50:30Z', now)).toBe(true)
  })

  it('drops a mail still over the cap after that window, as a flood', () => {
    expect(mayRedeliverOverMinuteCap(new Date(now - MINUTE_CAP_REDELIVERY_WINDOW_MS).toISOString(), now)).toBe(false)
    expect(mayRedeliverOverMinuteCap('2026-11-10T10:00:00Z', now)).toBe(false)
  })

  it('treats a missing or unreadable receive time as too old, so the mail ends in a record', () => {
    expect(mayRedeliverOverMinuteCap(null, now)).toBe(false)
    expect(mayRedeliverOverMinuteCap(undefined, now)).toBe(false)
    expect(mayRedeliverOverMinuteCap('not a date', now)).toBe(false)
  })
})

describe('isPlainTextPart', () => {
  it('reads text/plain with or without parameters and in any case', () => {
    expect(isPlainTextPart('text/plain')).toBe(true)
    expect(isPlainTextPart('text/plain; charset=utf-8')).toBe(true)
    expect(isPlainTextPart('Text/Plain')).toBe(true)
  })

  it('leaves every other type alone', () => {
    expect(isPlainTextPart('text/html')).toBe(false)
    expect(isPlainTextPart('application/pdf')).toBe(false)
    expect(isPlainTextPart(null)).toBe(false)
    expect(isPlainTextPart(undefined)).toBe(false)
  })
})

describe('isMailMachineryPart (crm#1809)', () => {
  it('reads invites, mail signatures, contact cards and delivery reports, with parameters and in any case', () => {
    expect(isMailMachineryPart('text/calendar')).toBe(true)
    expect(isMailMachineryPart('Text/Calendar; method=REQUEST; charset=UTF-8')).toBe(true)
    expect(isMailMachineryPart('application/ics')).toBe(true)
    expect(isMailMachineryPart('application/pkcs7-signature; name="smime.p7s"')).toBe(true)
    expect(isMailMachineryPart('application/pgp-signature')).toBe(true)
    expect(isMailMachineryPart('text/vcard')).toBe(true)
    expect(isMailMachineryPart('message/delivery-status')).toBe(true)
  })

  it('leaves anything that can be a document, in a format the inbox takes or not', () => {
    for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/tiff', 'text/html', 'text/plain', 'application/zip', 'application/xml', 'application/octet-stream', 'message/rfc822']) {
      expect(isMailMachineryPart(type)).toBe(false)
    }
    expect(isMailMachineryPart(null)).toBe(false)
    expect(isMailMachineryPart(undefined)).toBe(false)
  })
})

describe('extractLocalPartForDomain', () => {
  it('returns the local part when a recipient matches the domain', () => {
    const result = extractLocalPartForDomain(
      ['acme-ab-x7f2@arcim.io', 'billing@acme.se'],
      'arcim.io'
    )
    expect(result).toEqual({ localPart: 'acme-ab-x7f2', tag: null })
  })

  it('lowercases the local part and matches domain case-insensitively', () => {
    const result = extractLocalPartForDomain(
      ['ACME-AB-X7F2@ARCIM.IO'],
      'arcim.io'
    )
    expect(result).toEqual({ localPart: 'acme-ab-x7f2', tag: null })
  })

  it('splits a plus-address into local part and tag', () => {
    expect(extractLocalPartForDomain(['acme-ab-x7f2+lev@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: 'lev',
    })
    expect(extractLocalPartForDomain(['acme-ab-x7f2+ver@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: 'ver',
    })
  })

  it('lowercases the tag and splits at the first plus only', () => {
    expect(extractLocalPartForDomain(['Acme-AB-x7f2+LEV+extra@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: 'lev+extra',
    })
  })

  it('treats an empty tag as no tag', () => {
    expect(extractLocalPartForDomain(['acme-ab-x7f2+@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: null,
    })
  })

  it('does not read a plus in a foreign-domain recipient', () => {
    expect(extractLocalPartForDomain(['x+lev@acme.se', 'acme-ab-x7f2@arcim.io'], 'arcim.io')).toEqual({
      localPart: 'acme-ab-x7f2',
      tag: null,
    })
  })

  it('returns null when no recipient matches', () => {
    const result = extractLocalPartForDomain(
      ['billing@acme.se', 'invoices@contoso.com'],
      'arcim.io'
    )
    expect(result).toBeNull()
  })

  it('returns null for malformed addresses', () => {
    const result = extractLocalPartForDomain(
      ['not-an-email', '@arcim.io', 'foo@'],
      'arcim.io'
    )
    expect(result).toBeNull()
  })

  it('returns the first matching recipient when multiple match', () => {
    const result = extractLocalPartForDomain(
      ['first-abcd@arcim.io', 'second-efgh@arcim.io'],
      'arcim.io'
    )
    expect(result?.localPart).toBe('first-abcd')
  })

  it('trims whitespace inside candidate addresses', () => {
    const result = extractLocalPartForDomain(
      ['  acme-xxx@arcim.io  '],
      'arcim.io'
    )
    expect(result?.localPart).toBe('acme-xxx')
  })
})

describe('kindHintFromTag', () => {
  it('maps the two documented tags', () => {
    expect(kindHintFromTag('lev')).toBe('supplier_invoice')
    expect(kindHintFromTag('ver')).toBe('receipt')
  })

  it('returns null for unknown, empty or missing tags', () => {
    expect(kindHintFromTag('faktura')).toBeNull()
    expect(kindHintFromTag('lev+extra')).toBeNull()
    expect(kindHintFromTag('')).toBeNull()
    expect(kindHintFromTag(null)).toBeNull()
    expect(kindHintFromTag(undefined)).toBeNull()
  })
})

describe('extractSharedRecipientsForDomain (#2181)', () => {
  it('returns every shared-domain recipient in order with its tag', () => {
    expect(
      extractSharedRecipientsForDomain(
        ['acme-ab-x7f2+lev@arcim.io', 'billing@acme.se', 'Acme-AB-x7f2+VER@arcim.io', 'other-1234@arcim.io'],
        'arcim.io',
      ),
    ).toEqual([
      { localPart: 'acme-ab-x7f2', tag: 'lev' },
      { localPart: 'acme-ab-x7f2', tag: 'ver' },
      { localPart: 'other-1234', tag: null },
    ])
  })

  it('collapses the same address listed twice', () => {
    expect(
      extractSharedRecipientsForDomain(['acme-ab-x7f2+lev@arcim.io', 'ACME-AB-X7F2+lev@arcim.io'], 'arcim.io'),
    ).toEqual([{ localPart: 'acme-ab-x7f2', tag: 'lev' }])
  })

  it('skips foreign domains and malformed addresses', () => {
    expect(
      extractSharedRecipientsForDomain(['x+lev@acme.se', 'not-an-email', '@arcim.io', 'foo@'], 'arcim.io'),
    ).toEqual([])
  })

  it('keeps extractLocalPartForDomain as the first entry', () => {
    const to = ['second-efgh+ver@arcim.io', 'first-abcd@arcim.io']
    expect(extractLocalPartForDomain(to, 'arcim.io')).toEqual(extractSharedRecipientsForDomain(to, 'arcim.io')[0])
  })
})

describe('groupSharedRecipientsByInbox (#2181)', () => {
  it('groups recipients per local part with distinct tags in first-seen order', () => {
    expect(
      groupSharedRecipientsByInbox([
        { localPart: 'acme', tag: 'lev' },
        { localPart: 'other', tag: null },
        { localPart: 'acme', tag: 'ver' },
        { localPart: 'acme', tag: 'lev' },
      ]),
    ).toEqual([
      { localPart: 'acme', tags: ['lev', 'ver'] },
      { localPart: 'other', tags: [] },
    ])
  })
})

describe('resolveKindHintForTags (#2181)', () => {
  it('maps a single documented tag', () => {
    expect(resolveKindHintForTags(['lev'])).toEqual({ kindHint: 'supplier_invoice', conflict: false })
    expect(resolveKindHintForTags(['ver'])).toEqual({ kindHint: 'receipt', conflict: false })
  })

  it('returns no hint and no conflict for unknown or missing tags', () => {
    expect(resolveKindHintForTags([])).toEqual({ kindHint: null, conflict: false })
    expect(resolveKindHintForTags(['faktura'])).toEqual({ kindHint: null, conflict: false })
  })

  it('ignores unknown tags next to a documented one', () => {
    expect(resolveKindHintForTags(['faktura', 'lev'])).toEqual({ kindHint: 'supplier_invoice', conflict: false })
  })

  it('resolves +lev and +ver on one mail to no hint, flagged as a conflict', () => {
    expect(resolveKindHintForTags(['lev', 'ver'])).toEqual({ kindHint: null, conflict: true })
    expect(resolveKindHintForTags(['ver', 'lev'])).toEqual({ kindHint: null, conflict: true })
  })
})

describe('splitKnownInboxTags (#2181)', () => {
  it('keeps the documented tags and only counts the rest', () => {
    expect(splitKnownInboxTags(['lev', '8501011234', 'ver', 'anna-svensson'])).toEqual({
      known: ['lev', 'ver'],
      unknownCount: 2,
    })
    expect(splitKnownInboxTags([])).toEqual({ known: [], unknownCount: 0 })
  })
})
