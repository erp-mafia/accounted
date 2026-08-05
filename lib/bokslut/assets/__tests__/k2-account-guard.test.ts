/**
 * The K2 gate fires on ANY account the BAS chart flags k2_excluded ("Ej K2"),
 * but those accounts are excluded for different reasons. These tests pin that
 * the rejection text cites BFNAR 2016:10 punkt 10.4 only for the
 * egenupparbetade immateriella group and stays generic everywhere else, so a
 * deferred-tax or fair-value account never gets a wrong legal citation.
 */
import { describe, it, expect } from 'vitest'
import {
  findK2ExcludedAccount,
  k2ExcludedAccountMessages,
} from '@/lib/bokslut/assets/k2-account-guard'
import { BAS_REFERENCE, getBASReference } from '@/lib/bookkeeping/bas-reference'

function messagesFor(accountNumber: string) {
  const account = getBASReference(accountNumber)
  expect(account, `${accountNumber} missing from the BAS reference`).toBeTruthy()
  return k2ExcludedAccountMessages(account!)
}

describe('findK2ExcludedAccount', () => {
  it('returns the first Ej K2 account in the list', () => {
    expect(findK2ExcludedAccount(['1030', '1010'])?.account_number).toBe('1010')
    expect(findK2ExcludedAccount(['1010', '1370'])?.account_number).toBe('1010')
  })

  it('returns null when every account is allowed under K2', () => {
    expect(findK2ExcludedAccount(['1030', '1039'])).toBeNull()
    expect(findK2ExcludedAccount([undefined, '1220', '1229'])).toBeNull()
  })

  it('treats unknown account numbers as allowed', () => {
    expect(findK2ExcludedAccount(['9999'])).toBeNull()
  })
})

describe('k2ExcludedAccountMessages', () => {
  // The boundary is derived from the chart (kontogrupp 10 + k2_excluded), not
  // from a literal list. This asserts the derivation still selects exactly the
  // egenupparbetade accounts, so a future flag change surfaces here.
  const intangibleGroup = BAS_REFERENCE.filter(
    (a) => a.k2_excluded && a.account_class === 1 && a.account_group === '10',
  ).map((a) => a.account_number)

  it('covers exactly the egenupparbetade immateriella accounts', () => {
    expect(intangibleGroup).toEqual(['1010', '1011', '1012', '1018', '1019', '1081'])
  })

  it.each(['1010', '1011', '1012', '1018', '1019', '1081'])(
    'cites BFNAR 2016:10 punkt 10.4 for %s',
    (accountNumber) => {
      const { message_sv, message_en } = messagesFor(accountNumber)
      expect(message_sv).toContain(accountNumber)
      expect(message_sv).toContain('egenupparbetade utvecklingsutgifter')
      expect(message_sv).toContain('BFNAR 2016:10 punkt 10.4')
      expect(message_en).toContain('internally generated development expenditure')
      expect(message_en).toContain('BFNAR 2016:10 paragraph 10.4')
    },
  )

  // K2 forbids only EGENUPPARBETADE immateriella tillgångar; an ACQUIRED one
  // is lawful and belongs on 1090 (k2-vs-k3.md:24, "Only acquired intangibles
  // may be recognized"). The rejection has to point there, otherwise the only
  // way out it offers is the one that is wrong.
  it.each(['1010', '1011', '1012', '1018', '1019', '1081'])(
    'points %s at the acquired-intangible account 1090 instead',
    (accountNumber) => {
      const { message_sv, message_en } = messagesFor(accountNumber)
      expect(message_sv).toContain('1090')
      expect(message_sv).toContain('förvärvad immateriell tillgång')
      expect(message_en).toContain('1090')
      expect(message_en).toContain('acquired intangible asset')
    },
  )

  // Switching regelverk pulls in komponentavskrivning and uppskjuten skatt and
  // rewrites the whole årsredovisning: it is never the remedy for one
  // misdirected account. No message may suggest it, on any Ej K2 account.
  it('never tells the user to change the accounting framework', () => {
    for (const account of BAS_REFERENCE.filter((a) => a.k2_excluded)) {
      const { message_sv, message_en } = k2ExcludedAccountMessages(account)
      expect(message_sv).not.toContain('Byt regelverk')
      expect(message_sv).not.toContain('Inställningar')
      expect(message_en).not.toContain('Switch the accounting framework')
      expect(message_en).not.toContain('Settings')
    }
  })

  // The routes resolve accounting_framework from a read whose error they
  // discard, so a transient failure looks like "not K3" even for a K3
  // company. The text must therefore describe the ACCOUNT, never claim which
  // framework this company applies.
  it('never asserts which framework the company applies', () => {
    for (const account of BAS_REFERENCE.filter((a) => a.k2_excluded)) {
      const { message_sv, message_en } = k2ExcludedAccountMessages(account)
      expect(message_sv).not.toContain('företaget tillämpar')
      expect(message_sv).not.toContain('ert företag')
      expect(message_en).not.toContain('the company applies')
      expect(message_en).not.toContain('your company')
    }
  })

  it('never cites punkt 10.4 for an Ej K2 account outside kontogrupp 10', () => {
    const others = BAS_REFERENCE.filter((a) => a.k2_excluded).filter(
      (a) => !intangibleGroup.includes(a.account_number),
    )
    // 1370, 1518, 2089, 2092, 2096, 2240, 2448, 3940, 7940, 82xx-84xx, 8940.
    expect(others.length).toBeGreaterThan(0)
    for (const account of others) {
      const { message_sv, message_en } = k2ExcludedAccountMessages(account)
      expect(message_sv).toContain(account.account_number)
      expect(message_sv).toContain('Ej K2')
      expect(message_sv).toContain('K3')
      expect(message_sv).not.toContain('10.4')
      expect(message_sv).not.toContain('egenupparbetade')
      // 1090 is the answer for a misdirected intangible only: proposing it for
      // a deferred-tax or fair-value account would be its own wrong advice.
      expect(message_sv).not.toContain('1090')
      expect(message_en).toContain('Ej K2')
      expect(message_en).not.toContain('10.4')
      expect(message_en).not.toContain('intangible')
      expect(message_en).not.toContain('1090')
    }
  })

  it('names the account so the user can see what was rejected', () => {
    const { message_sv } = messagesFor('1370')
    expect(message_sv).toContain('1370 (Uppskjuten skattefordran)')
  })
})
