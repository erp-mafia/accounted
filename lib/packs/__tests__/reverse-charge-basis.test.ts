import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadPacks } from '@/lib/packs/load'

/**
 * A reverse-charge pack must book its cost on a basbelopp account.
 *
 * Momsdeklaration rutor 20-24 are driven purely by BAS account number
 * (ACCOUNT_RUTA in lib/reports/vat-declaration.ts): the fiktiv-moms pair
 * (2614/2624/2634 + 2645/2647) fills ruta 30-32 and 48, but the purchase
 * value itself only reaches ruta 20-24 when the expense sits on the 44xx/45xx
 * basis series. A reverse-charge pack that books its cost elsewhere (the
 * pre-fix 4010/6540) produces a declaration with VAT but no inköpsvärde,
 * which Skatteverket rejects (felkod FK004; ML 13 kap requires both sides).
 * User report: Anders, 2026-08-25.
 */

const ROOT = path.resolve(__dirname, '../../..')

// Fictitious output-VAT accounts that mark a purchase-side reverse-charge pack.
const FIKTIV_OUTPUT_VAT = new Set(['2614', '2624', '2634'])

// Same range isBasisAccount() in lib/bookkeeping/booking-templates.ts guards:
// 44xx/45xx, the ruta 20-24 inputs.
const BASIS_ACCOUNT_RE = /^4[45]\d{2}$/

describe('reverse-charge packs feed momsdeklaration ruta 20-24', () => {
  const { packs, errors } = loadPacks(ROOT)

  it('catalogue loads', () => {
    expect(errors).toEqual([])
  })

  const reverseChargePacks = packs.filter((p) =>
    p.pack.lines.some((l) => FIKTIV_OUTPUT_VAT.has(l.account)),
  )

  it('the catalogue actually contains reverse-charge purchase packs', () => {
    // Guards the filter above: if the fiktiv accounts are ever renumbered,
    // this suite must be updated rather than silently asserting nothing.
    expect(reverseChargePacks.length).toBeGreaterThanOrEqual(2)
  })

  it.each([
    ['inkop-eu-varor-omvand-moms-25', '4515'],
    ['inkop-eu-tjanster-omvand-moms-25', '4535'],
  ])('%s books its cost on basis account %s', (slug, account) => {
    const pack = packs.find((p) => p.pack.meta.slug === slug)
    expect(pack).toBeDefined()
    const business = pack!.pack.lines.filter((l) => l.type === 'business')
    expect(business).toHaveLength(1)
    expect(business[0].account).toBe(account)
    expect(business[0].side).toBe('debit')
  })

  it('every reverse-charge purchase pack books its business debit on a 44xx/45xx basis account', () => {
    for (const p of reverseChargePacks) {
      const businessDebits = p.pack.lines.filter(
        (l) => l.type === 'business' && l.side === 'debit',
      )
      for (const line of businessDebits) {
        expect(
          BASIS_ACCOUNT_RE.test(line.account),
          `${p.pack.meta.slug}: business debit on ${line.account} never reaches ruta 20-24; ` +
            `book reverse-charge cost on the 44xx/45xx basis series`,
        ).toBe(true)
      }
    }
  })
})
