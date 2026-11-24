/**
 * The statutory notices an invoice prints cite the provision of the VAT act in
 * force, Mervärdesskattelag (2023:200), that the treatment rests on. Read with
 * the parser behind `npm run law:refs`, so "ML 6 kap. 33 §" and "ML 6:33" are
 * the same citation.
 */
import { describe, expect, it } from 'vitest'
import { parseLawRefs } from '@/scripts/lib/lagrum.mjs'
import { PDF_LABELS } from '@/lib/invoices/pdf/labels'
import {
  DOMESTIC_REVERSE_CHARGE_NOTICE,
  EU_GOODS_SUPPLY_NOTICE,
  EXPORT_GOODS_NOTICE_SV,
  EXPORT_SERVICES_NOTICE_SV,
} from '@/lib/invoices/vat-rules'

const keys = (text: string): string[] => parseLawRefs(text).map((r: { key: string }) => r.key)

describe('invoice VAT notices cite the provision of the current VAT act', () => {
  it.each(['sv', 'en'] as const)('%s: a service sold outside the EU cites the place-of-supply rule (6 kap. 33 §)', (lang) => {
    expect(keys(PDF_LABELS[lang].exportServicesNotice)).toEqual(['sfs:2023:200#K6P33'])
  })

  it.each(['sv', 'en'] as const)('%s: goods exported outside the EU cite their exemption (10 kap. 64 §)', (lang) => {
    expect(keys(PDF_LABELS[lang].exportGoodsNotice)).toEqual(['sfs:2023:200#K10P64'])
  })

  it.each(['sv', 'en'] as const)('%s: an exempt sale cites the exemptions chapter (10 kap.)', (lang) => {
    expect(keys(PDF_LABELS[lang].exemptNotice)).toEqual(['sfs:2023:200#K10'])
  })

  it('the stored Swedish notices cite the same provisions', () => {
    expect(keys(EXPORT_SERVICES_NOTICE_SV)).toEqual(['sfs:2023:200#K6P33'])
    expect(keys(EXPORT_GOODS_NOTICE_SV)).toEqual(['sfs:2023:200#K10P64'])
    expect(keys(DOMESTIC_REVERSE_CHARGE_NOTICE)).toEqual(['sfs:2023:200#K16P13'])
    expect(keys(EU_GOODS_SUPPLY_NOTICE)).toEqual(['sfs:2023:200#K10P42'])
  })

  it.each(['sv', 'en'] as const)('%s: no label cites the repealed act (1994:200)', (lang) => {
    const cited = Object.values(PDF_LABELS[lang])
      .filter((v): v is string => typeof v === 'string')
      .flatMap(keys)
    expect(cited.length).toBeGreaterThan(0)
    expect(cited.filter((k) => !k.startsWith('sfs:2023:200'))).toEqual([])
  })
})
