import { describe, it, expect } from 'vitest'
import { BOOKING_TEMPLATES, getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { DEFAULT_ACCOUNTS_BY_CATEGORY } from '@/lib/bokslut/assets/asset-service'

/**
 * Every account a booking template names must exist in BAS 2026.
 *
 * This is not pedantry: `lib/bookkeeping/account-backfill.ts` seeds a missing
 * account into a company's chart on demand ONLY if it appears in
 * BAS_REFERENCE. An account that does not is unreachable, so the template
 * fails with AccountsNotInChartError every single time it is used, for every
 * company. It is a template that can never work.
 *
 * Three shipped templates were in exactly that state until this test existed:
 *   vehicle_parking    5614  (the BAS 561x run skips 5614)
 *   it_cloud_hosting   5421  (BAS has 5420 Programvaror, no 5421)
 *   preliminar-f-skatt-ef  2012  (found separately by the pack validator)
 *
 * The pack catalogue gets this check from `scripts/validate-packs.ts`. The
 * static registry had nothing, which is why it drifted.
 */
describe('BOOKING_TEMPLATES reference only real BAS accounts', () => {
  const accountFields = ['debit_account', 'credit_account', 'debit_account_ab', 'credit_account_ab'] as const

  it('every referenced account resolves in BAS 2026', () => {
    const missing: string[] = []

    for (const t of BOOKING_TEMPLATES) {
      for (const field of accountFields) {
        const account = (t as unknown as Record<string, string | undefined>)[field]
        if (!account) continue
        if (!getBASReference(account)) {
          missing.push(`${t.id}.${field} = ${account}`)
        }
      }
    }

    expect(
      missing,
      `These templates name accounts that do not exist in BAS 2026, so account-backfill ` +
        `cannot seed them and every booking through them fails:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('account numbers are strings, never numbers', () => {
    for (const t of BOOKING_TEMPLATES) {
      for (const field of accountFields) {
        const account = (t as unknown as Record<string, unknown>)[field]
        if (account === undefined) continue
        expect(typeof account, `${t.id}.${field}`).toBe('string')
      }
    }
  })

  it('a VAT-bearing purchase never debits equity or revenue', () => {
    // Catches a transposed account number that happens to exist. Deliberately
    // narrow: class 1 is legitimate here (equipment_capital debits 1220
    // Inventarier and reclaims VAT, which is how capex is booked), and classes
    // 4-7 are ordinary costs. What a purchase can never debit is class 2
    // (equity and liabilities) or class 3 (revenue): those would be a sign
    // error, not a categorisation choice.
    const FORBIDDEN = new Set([2, 3])

    for (const t of BOOKING_TEMPLATES) {
      if (!t.vat_rate || t.direction !== 'expense') continue
      const cls = Number(t.debit_account.charAt(0))
      expect(
        FORBIDDEN.has(cls),
        `${t.id} charges VAT ${t.vat_rate} but debits ${t.debit_account} (class ${cls}): ` +
          `a purchase cannot debit equity/liabilities or revenue`,
      ).toBe(false)
    }
  })

  // Regression guard for #2632, the template-side twin of the asset-default
  // guard in lib/bokslut/__tests__/asset-service.test.ts (#2618). The BAS 2026
  // catalogue update (#2413) turned 1230/1240/1249/1250/1259/1260/1269 into
  // "(Fritt konto ...)" entries: accounts that exist, so the existence check
  // above passes, but that carry no prescribed meaning. equipment_capital kept
  // capitalizing to 1250 for two catalogue releases because nothing tied the
  // template literal to the catalogue's naming. A booking on a free account is
  // unreadable to the SIE reader, the INK2R mapping and the next accountant.
  it('never targets a free BAS account', () => {
    const free: string[] = []

    for (const t of BOOKING_TEMPLATES) {
      for (const field of accountFields) {
        const account = (t as unknown as Record<string, string | undefined>)[field]
        if (!account) continue
        if (/[Ff]ritt konto/.test(getBASReference(account)?.account_name ?? '')) {
          free.push(`${t.id}.${field} = ${account}`)
        }
      }
    }

    expect(
      free,
      `These templates book onto BAS 2026 free accounts ("(Fritt konto ...)"), which have ` +
        `no prescribed meaning:\n  ${free.join('\n  ')}`,
    ).toEqual([])
  })

  // The capitalizing template and the fixed-asset module must agree on where
  // an inventarie lives, or the autobooked purchase and the asset register it
  // later feeds sit on different accounts. The template holds a literal (it is
  // client-bundled and cannot import the server-side asset service), so the
  // agreement is pinned here instead.
  it('equipment_capital capitalizes to the asset module default for equipment', () => {
    const template = getTemplateById('equipment_capital')
    expect(template).toBeDefined()
    expect(template?.debit_account).toBe(DEFAULT_ACCOUNTS_BY_CATEGORY.equipment.asset)
    expect(getBASReference(template!.debit_account)?.account_name).toBe(
      'Inventarier, verktyg och installationer',
    )
  })
})
