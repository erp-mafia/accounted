import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OPEN_BANKING_FAILURE_TEXTS, OPEN_BANKING_GENERIC_FAILURE, OPEN_BANKING_PERMANENT_FAILURES, consentFailureText, isPermanentConsentFailure, refusalNamesReason } from '../failure-text'

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

  it('tells the person to start again on the bank\'s page when the bank imposed it, now that that works', () => {
    expect(consentFailureText('SCA_REDIRECT_UNSUPPORTED').sv).toBe('Banken vill att du signerar på sin egen sida. Starta om och välj att signera på bankens sida.')
    expect(consentFailureText('SCA_REDIRECT_UNSUPPORTED').sv).not.toMatch(/stöds inte/)
    expect(consentFailureText('SCA_REDIRECT_UNSUPPORTED').en).not.toMatch(/not supported/)
  })

  it('has a Swedish text for every code a consent flow can hit, and marks the ones resolved in the online bank as permanent', () => {
    for (const code of ['PSU_CREDENTIALS_INVALID', 'PSU_OPEN_BANKING_RIGHTS_MISSING', 'BANK_AGREEMENT_MISSING', 'BANKID_EXTENDED_USE_REQUIRED', 'KYC_INVALID', 'AUTHENTICATION_SESSION_ONGOING', 'STRONGER_AUTHENTICATION_NEEDED', 'BANK_REQUEST_LIMIT_EXCEEDED']) {
      expect(OPEN_BANKING_FAILURE_TEXTS[code], code).toBeDefined()
      expect(consentFailureText(code), code).not.toEqual(OPEN_BANKING_GENERIC_FAILURE)
    }
    for (const code of ['BANK_AGREEMENT_MISSING', 'BANKID_EXTENDED_USE_REQUIRED', 'BANKID_NOT_ACTIVATED', 'KYC_INVALID', 'PSU_OPEN_BANKING_RIGHTS_MISSING', 'PSU_RIGHTS_MISSING', 'PSU_CREDENTIALS_INVALID', 'PSU_ACCOUNT_MISSING']) {
      expect(isPermanentConsentFailure(code), code).toBe(true)
      expect(OPEN_BANKING_FAILURE_TEXTS[code], `${code} has a text`).toBeDefined()
    }
    expect(isPermanentConsentFailure(' kyc_invalid ')).toBe(true)
    // Trying again helps here: a session that ran out, a cancelled signing, a busy bank, an unknown code.
    for (const code of ['SIGNING_SESSION_EXPIRED', 'AUTHENTICATION_SESSION_PSU_CANCELLED', 'BANK_REQUEST_LIMIT_EXCEEDED', 'AUTHENTICATION_SESSION_ONGOING', 'SCA_REDIRECT_UNSUPPORTED', 'SOMETHING_NEW', null, undefined]) {
      expect(isPermanentConsentFailure(code), String(code)).toBe(false)
    }
    for (const code of OPEN_BANKING_PERMANENT_FAILURES) expect(OPEN_BANKING_FAILURE_TEXTS[code], code).toBeDefined()
  })

  it('uses no em or en dashes', () => {
    for (const text of Object.values(OPEN_BANKING_FAILURE_TEXTS)) {
      expect(text.sv).not.toMatch(/[\u2013\u2014]/)
      expect(text.en).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('refusalNamesReason', () => {
  it('is true for a code with a sentence of its own, whatever its case', () => {
    for (const code of ['AUTHENTICATION_SESSION_ONGOING', 'KYC_INVALID', 'PSU_AUTHORISER_ID_MISSING', ' psu_rights_missing ']) {
      expect(refusalNamesReason(code), code).toBe(true)
    }
  })

  it('is false when the person would only get the generic line: no code, an unknown one, the provider\'s catch-all', () => {
    for (const code of ['FORMAT_ERROR', 'CONNECTOR_AIS_REFUSED', 'UNEXPECTED_ERROR', ' unexpected_error ', 'toString', '', null, undefined]) {
      expect(refusalNamesReason(code), String(code)).toBe(false)
    }
  })
})
