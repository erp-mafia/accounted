import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OPEN_BANKING_FAILURE_TEXTS, OPEN_BANKING_GENERIC_FAILURE, consentFailureText } from '../failure-text'

const messages = (lang: 'sv' | 'en') =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../messages/${lang}.json`, import.meta.url)), 'utf8')) as {
    bankFeed: { failure: Record<string, string>; failure_generic: string }
  }

describe('consentFailureText', () => {
  it('answers the provider code in both languages, case-insensitively, and the generic sentence otherwise', () => {
    expect(consentFailureText('AUTHENTICATION_SESSION_PSU_CANCELLED').sv).toBe('Användaren avbröt autentiseringen.')
    expect(consentFailureText(' signing_session_expired ')).toEqual(OPEN_BANKING_FAILURE_TEXTS.SIGNING_SESSION_EXPIRED)
    expect(consentFailureText('SOMETHING_NEW')).toEqual(OPEN_BANKING_GENERIC_FAILURE)
    expect(consentFailureText(null)).toEqual(OPEN_BANKING_GENERIC_FAILURE)
  })

  it('is published word for word under the bankFeed namespace of both message files', () => {
    const sv = messages('sv').bankFeed
    const en = messages('en').bankFeed
    for (const [code, text] of Object.entries(OPEN_BANKING_FAILURE_TEXTS)) {
      expect(sv.failure[code], `sv ${code}`).toBe(text.sv)
      expect(en.failure[code], `en ${code}`).toBe(text.en)
    }
    expect(Object.keys(sv.failure).sort()).toEqual(Object.keys(OPEN_BANKING_FAILURE_TEXTS).sort())
    expect(Object.keys(en.failure).sort()).toEqual(Object.keys(OPEN_BANKING_FAILURE_TEXTS).sort())
    expect(sv.failure_generic).toBe(OPEN_BANKING_GENERIC_FAILURE.sv)
    expect(en.failure_generic).toBe(OPEN_BANKING_GENERIC_FAILURE.en)
  })

  it('uses no em or en dashes', () => {
    for (const text of Object.values(OPEN_BANKING_FAILURE_TEXTS)) {
      expect(text.sv).not.toMatch(/[\u2013\u2014]/)
      expect(text.en).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
