import { describe, expect, it } from 'vitest'
import { extractDomain, parseLbLine, preclean, repairCharset, splitRail, stripNoise } from '../preclean'

describe('repairCharset', () => {
  it('maps ISO 646-SE braces to Swedish letters when the text has none', () => {
    expect(repairCharset('OC H{rn|sand AB')).toBe('OC Härnösand AB')
    expect(repairCharset('H¦gan{s')).toBe('Höganäs')
  })

  it('leaves text that already carries Swedish letters alone', () => {
    expect(repairCharset('Åhléns {city}')).toBe('Åhléns {city}')
  })
})

describe('parseLbLine', () => {
  it('reads the payee, not the payer block, out of a Bankgiro payment-file line', () => {
    const lb = parseLbLine('2617264 DBT.VIEWLEDGER AB 144 240 2617264 350 Brorsan Brorsan AB c/o Johan Crona')
    expect(lb).toEqual({ payee: 'VIEWLEDGER AB', giro: null })
  })

  it('keeps the giro number when the payee is written with one', () => {
    const lb = parseLbLine('1655958320228 DBT.5050-1055 SKATTEVERK 144 240 1655958320228 350 Polytop AB')
    expect(lb).toEqual({ payee: 'SKATTEVERK', giro: { scheme: 'bg', value: '5050-1055' } })
  })

  it('stops at the Fnr field', () => {
    expect(parseLbLine('240 DBT.126-5974 LINDA WALLI Fnr 1180 144 Fnr 1180 350 Polytop AB')?.payee).toBe('LINDA WALLI')
  })

  it('is null for ordinary memos', () => {
    expect(parseLbLine('Kortköp 260828 KRONANS APOTEK AB')).toBeNull()
  })
})

describe('splitRail', () => {
  it('splits FACILITATOR*SUBMERCHANT into rail and merchant', () => {
    expect(splitRail('PAYPAL *LINKEDIN,35314369001,GB Kortköp')).toMatchObject({ rail: 'PayPal', subMerchant: 'LINKEDIN,35314369001,GB Kortköp' })
    expect(splitRail('K*SODASTREAM')).toMatchObject({ rail: 'Klarna', subMerchant: 'SODASTREAM' })
    expect(splitRail('PADDLE.NET* PUBLER.COM K1687 Kortköp/uttag')).toMatchObject({ rail: 'Paddle' })
    expect(splitRail('SP PRINTIT K7739 Kortköp/uttag')).toMatchObject({ rail: 'Shopify Payments', subMerchant: 'PRINTIT K7739 Kortköp/uttag' })
  })

  it('treats a bare reference after the star as no sub-merchant', () => {
    expect(splitRail('SHOPIFY* 54983')).toEqual({ rail: null, subMerchant: null, railCounterpart: null })
    expect(splitRail('ZETTLE_*12345')).toMatchObject({ rail: 'Zettle', subMerchant: null })
  })

  it('reads the payer out of a Stripe payment and keeps the fee on Stripe', () => {
    expect(splitRail('Stripe-betalning Erik Hellqvist')).toMatchObject({ rail: 'Stripe', subMerchant: 'Erik Hellqvist' })
    expect(splitRail('Stripe-avgift (Stripe-betalning Erik Hellqvist)')).toMatchObject({ railCounterpart: 'Stripe' })
    expect(splitRail('Stripe: Automatic Taxes (2026-08-20): Automatic tax')).toMatchObject({ railCounterpart: 'Stripe' })
  })

  it('names the facilitator itself when the star part is a reference', () => {
    expect(splitRail('FACEBK *EG3BLLVQF2')).toMatchObject({ railCounterpart: 'Meta' })
    expect(splitRail('BKG*BOOKING.COM HOTEL K3667 Kortköp/uttag')).toMatchObject({ railCounterpart: 'Booking.com' })
    expect(splitRail('APPLE.COM/BILL 866-712-7753 Kortköp')).toMatchObject({ railCounterpart: 'Apple' })
  })
})

describe('stripNoise', () => {
  it('removes card suffixes, method words and dates', () => {
    expect(stripNoise('Hotel at Booking.com K3667 Kortköp/uttag').text).toBe('Hotel at Booking.com')
    expect(stripNoise('Kortköp 260822 WILLYS VARMDO KOPCEN').text).toBe('WILLYS VARMDO KOPCEN')
    expect(stripNoise('UBER    TRIP/26-04-16').text).toBe('UBER TRIP')
    expect(stripNoise('LinkedIn Pre P30426919 K9263: Kortköp/uttag').text).toBe('LinkedIn Pre')
  })

  it('reads the country out of a ",CITY,CC" memo tail', () => {
    expect(stripNoise('ANTHROPIC* CLAUDE SUB,SAN FRANCISCO,US Kortköp')).toEqual({ text: 'ANTHROPIC* CLAUDE SUB', country: 'US' })
    expect(stripNoise('SNABBGROSS VARBERG,VARBERG,SE Kortköp')).toEqual({ text: 'SNABBGROSS VARBERG', country: 'SE' })
  })

  it('unwraps Wise card lines to the merchant', () => {
    expect(stripNoise('CARD-3500367590 Card transaction of 251.00 SEK issued by Elgiganten.se Kistad').text).toBe('Elgiganten.se Kistad')
  })
})

describe('extractDomain', () => {
  it('finds a host in the memo', () => {
    expect(extractDomain('UBER *TRIP HELP.UBER.COM')).toBe('help.uber.com')
    expect(extractDomain('Kortköp 260202 NETFLIX.COM')).toBe('netflix.com')
    expect(extractDomain('Hetzner Online www.hetzner.c Kortköp/uttag')).toBeNull()
  })
})

describe('preclean', () => {
  it('produces the template key as alias key and the classifier label', () => {
    const p = preclean('Lön Jakob Juni Överföring via internet')
    expect(p.label).toBe('payroll')
    expect(p.aliasKey.length).toBeGreaterThan(0)
  })

  it('anchors on a legal-form name in the text', () => {
    const p = preclean('Kortköp 260828 KRONANS APOTEK AB')
    expect(p.legalName?.name).toMatch(/kronans apotek ab/i)
    expect(p.text).toBe('KRONANS APOTEK AB')
  })

  it('uses the payment-file payee as the text and keeps the giro', () => {
    const p = preclean('1655958320228 DBT.5050-1055 SKATTEVERK 144 240 1655958320228 350 Polytop AB Lucas Wickström')
    expect(p.lbPayee).toBe('SKATTEVERK')
    expect(p.text).toBe('SKATTEVERK')
    expect(p.giro).toEqual({ scheme: 'bg', value: '5050-1055' })
    expect(p.legalName).toBeNull()
  })

  it('splits the rail off and keeps the sub-merchant as the text', () => {
    const p = preclean('PAYPAL *ATLASSIANUS,4029357733,US Kortköp')
    expect(p.rail).toBe('PayPal')
    expect(p.text).toBe('ATLASSIANUS')
    expect(p.country).toBe('US')
  })

  it('does not read a card suffix as a rail', () => {
    const p = preclean('LinkedIn Pre P30426919 K9263: Kortköp/uttag')
    expect(p.rail).toBeNull()
    expect(p.text).toBe('LinkedIn Pre')
  })
})
