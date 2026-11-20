import { describe, expect, it } from 'vitest'
import { VENDOR_KEYS, vendorKeyFor, vendorTokens } from '../match'
import { FAINT_ON_WHITE, contrast, vendorLook, vendorLookFor } from '../index'
import { VENDOR_MARKS } from '../marks'
import { VENDOR_MONOGRAMS } from '../monograms'

describe('vendorTokens', () => {
  it('lower-cases, drops accents and splits on everything that is not a letter or a digit', () => {
    expect(vendorTokens('OPENAI *CHATGPT SUBSCR')).toEqual(['openai', 'chatgpt', 'subscr'])
    expect(vendorTokens('Kjell & Company')).toEqual(['kjell', 'company'])
    expect(vendorTokens('APPLE.COM/BILL')).toEqual(['apple', 'com', 'bill'])
    expect(vendorTokens('Hemköp Södermalm')).toEqual(['hemkop', 'sodermalm'])
    expect(vendorTokens('  ')).toEqual([])
  })
})

describe('vendorKeyFor: supplier names as read off a document', () => {
  it.each([
    ['Telia Sverige AB', 'telia'],
    ['Telia Company AB', 'telia'],
    ['OpenAI, L.L.C.', 'openai'],
    ['OpenAI Ireland Ltd', 'openai'],
    ['Google Ireland Limited', 'google'],
    ['Google Workspace', 'google'],
    ['Google Cloud EMEA Limited', 'googlecloud'],
    ['Google Ads', 'googleads'],
    ['Hetzner Online GmbH', 'hetzner'],
    ['Clas Ohlson AB', 'clasohlson'],
    ['Kjell & Company', 'kjell'],
    ['Kjell & Co Elektronik AB', 'kjell'],
    ['Circle K Sverige AB', 'circlek'],
    ['Vattenfall AB', 'vattenfall'],
    ['Folksam ömsesidig sakförsäkring', 'folksam'],
    ['Securitas Sverige AB', 'securitas'],
    ['PostNord Sverige AB', 'postnord'],
    ['Anthropic, PBC', 'anthropic'],
    ['GitHub, Inc.', 'github'],
    ['Atlassian Pty Ltd', 'atlassian'],
    ['Figma, Inc.', 'figma'],
    ['Notion Labs, Inc.', 'notion'],
    ['Dropbox International Unlimited Company', 'dropbox'],
    ['DigitalOcean, LLC', 'digitalocean'],
    ['Vercel Inc.', 'vercel'],
    ['Cloudflare, Inc.', 'cloudflare'],
    ['HubSpot Ireland Limited', 'hubspot'],
    ['Meta Platforms Ireland Ltd', 'meta'],
    ['Uber B.V.', 'uber'],
    ['Bolt Operations OÜ', 'bolt'],
    ['Klarna Bank AB', 'klarna'],
    ['PayPal (Europe) S.à r.l. et Cie, S.C.A.', 'paypal'],
    ['Stripe Payments Europe, Ltd.', 'stripe'],
    ['Shopify International Limited', 'shopify'],
    ['IKEA AB', 'ikea'],
    ['Telenor Sverige AB', 'telenor'],
    ['Microsoft Ireland Operations Ltd', 'microsoft'],
    ['Adobe Systems Software Ireland Ltd', 'adobe'],
    ['Slack Technologies Limited', 'slack'],
    ['Canva Pty Ltd', 'canva'],
    ['LinkedIn Ireland Unlimited Company', 'linkedin'],
    ['Amazon Web Services EMEA SARL', 'aws'],
    ['Kivra AB', 'kivra'],
    ['Billo AB', 'billo'],
    ['ICA Supermarket Hornstull', 'ica'],
    ['SJ AB', 'sj'],
    ['OKQ8 Scandinavia AB', 'okq8'],
    ['Preem AB', 'preem'],
    ['Tele2 Sverige AB', 'tele2'],
    ['Espresso House Sweden AB', 'espressohouse'],
  ])('%s is %s', (name, key) => {
    expect(vendorKeyFor(name)).toBe(key)
  })
})

describe('vendorKeyFor: bank texts and merchant names', () => {
  it.each([
    ['OPENAI *CHATGPT SUBSCR', 'openai'],
    ['TELIA SVERIGE AB', 'telia'],
    ['GOOGLE *WORKSPACE', 'google'],
    ['GOOGLE*GSUITE_EXEMPEL', 'google'],
    ['GOOGLE *CLOUD 4ZX', 'googlecloud'],
    ['HETZNER ONLINE GMBH', 'hetzner'],
    ['CLAS OHLSON 1043', 'clasohlson'],
    ['CLASOHLSON.COM', 'clasohlson'],
    ['CIRCLE K 4471', 'circlek'],
    ['AMZN Mktp SE', 'amazon'],
    ['AMAZON.SE', 'amazon'],
    ['AWS EMEA', 'aws'],
    ['APPLE.COM/BILL', 'apple'],
    ['ADOBE *CREATIVE CLD', 'adobe'],
    ['SPOTIFYAB', 'spotify'],
    ['ZOOM.US 888-799-9666', 'zoom'],
    ['UBER *TRIP', 'uber'],
    ['UBER *EATS', 'uber'],
    ['BOLT.EU/O/2210', 'bolt'],
    ['FACEBK *8XKQ2', 'facebook'],
    ['MSFT * E0300ABC', 'microsoft'],
    ['SQSP* INV12345', 'squarespace'],
    ['CLAUDE.AI SUBSCRIPTION', 'claude'],
    ['ICA NARA KVARNBY', 'ica'],
    ['MAXI ICA STORMARKNAD', 'ica'],
    ['OKQ8 TORSLANDA', 'okq8'],
    ['TANKAT OKQ8 KUNGSBACKA', 'okq8'],
    ['COOP KONSUM ODENPLAN', 'coop'],
    ['SJ.SE', 'sj'],
    ['WHATSAPP', 'whatsapp'],
    ['TRANSFERWISE', 'wise'],
  ])('%s is %s', (text, key) => {
    expect(vendorKeyFor(text)).toBe(key)
  })

  it('reads the merchant behind a processor, never the processor', () => {
    expect(vendorKeyFor('PAYPAL *SPOTIFY')).toBe('spotify')
    expect(vendorKeyFor('KLARNA*IKEA')).toBe('ikea')
    expect(vendorKeyFor('PAYPAL *ADOBE SYSTEMS')).toBe('adobe')
  })

  it('names nobody when the merchant behind a processor is not known', () => {
    expect(vendorKeyFor('SUMUP *KAFFEBAREN')).toBeNull()
    expect(vendorKeyFor('PAYPAL *ACMEWIDGETS')).toBeNull()
  })

  it('reads a processor named on its own as itself', () => {
    expect(vendorKeyFor('PAYPAL EUROPE')).toBe('paypal')
    expect(vendorKeyFor('Stripe')).toBe('stripe')
  })

  it('prefers the longer name: Google Cloud over Google, Amazon Web Services over Amazon', () => {
    expect(vendorKeyFor('Google Cloud')).toBe('googlecloud')
    expect(vendorKeyFor('Amazon Web Services')).toBe('aws')
    expect(vendorKeyFor('Google Ads Ireland')).toBe('googleads')
  })
})

describe('vendorKeyFor: no false matches', () => {
  it.each([
    // Short names only count first in the text.
    'MUSICA AB',
    'AFRICA TRADING',
    'Bolthuset AB',
    'Kafé Metamorfos',
    'Nordlys Hosting AB',
    'Byggmaterial Centrum',
    'Kontorsvaror i Väst AB',
    'SJÖSTRÖM BYGG AB',
    'Tre Kronor Bygg AB',
    'Ett, två, tre',
    'Sundsvall Uber Allt',
    'Wisex Konsult',
    'Zoomia Foto AB',
    'Lindqvist Revision',
    'Glans Städservice',
    'Kjell Andersson Måleri',
    'Pineapple Studio',
    'Canvas Reklam AB',
    'Notionella Partners',
    'Applegate Consulting',
    'Okänt dokument',
    'Faktura 2231 från Kontorsvaror i Väst',
  ])('%s names no vendor', (text) => {
    expect(vendorKeyFor(text)).toBeNull()
  })

  it('reads nothing into nothing', () => {
    expect(vendorKeyFor(null)).toBeNull()
    expect(vendorKeyFor(undefined)).toBeNull()
    expect(vendorKeyFor('')).toBeNull()
    expect(vendorKeyFor(' * ')).toBeNull()
  })
})

describe('the vendor tables', () => {
  it('has a mark or a monogram for every key, and no key in both', () => {
    for (const key of Object.keys(VENDOR_MARKS)) expect(VENDOR_MONOGRAMS).not.toHaveProperty(key)
    for (const key of VENDOR_KEYS) expect(vendorLook(key)).not.toBeNull()
  })

  it('keeps every mark a single path and every colour six hex digits', () => {
    for (const mark of Object.values(VENDOR_MARKS)) {
      expect(mark.hex).toMatch(/^[0-9A-F]{6}$/)
      expect(mark.path).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\-\s]+$/)
    }
    for (const mono of Object.values(VENDOR_MONOGRAMS)) {
      expect(mono.bg).toMatch(/^[0-9A-F]{6}$/)
      expect(mono.fg).toMatch(/^[0-9A-F]{6}$/)
      expect(mono.initials.length).toBeGreaterThan(0)
      expect(mono.initials.length).toBeLessThanOrEqual(3)
    }
  })

  it('keeps every monogram readable: its letters stand out from its colour', () => {
    for (const mono of Object.values(VENDOR_MONOGRAMS)) expect(contrast(mono.bg, mono.fg)).toBeGreaterThanOrEqual(3)
  })
})

describe('vendorLook', () => {
  it('draws a mark in its colour on a white chip', () => {
    expect(vendorLook('hetzner')).toMatchObject({ kind: 'mark', fill: '#D50C2D', chip: '#FFFFFF' })
  })

  it('puts a mark too faint for white on its own colour, in black or white', () => {
    const mailchimp = vendorLook('mailchimp')
    expect(contrast('FFE01B', 'FFFFFF')).toBeLessThan(FAINT_ON_WHITE)
    expect(mailchimp).toMatchObject({ kind: 'mark', chip: '#FFE01B', fill: '#000000' })
  })

  it('draws a monogram in the brand colours', () => {
    expect(vendorLook('telia')).toEqual({ kind: 'monogram', key: 'telia', title: 'Telia', initials: 'T', bg: '#990AE3', fg: '#FFFFFF' })
    expect(vendorLook('kivra')).toMatchObject({ bg: '#00A660' })
    expect(vendorLook('peppol')).toMatchObject({ bg: '#1F4E8C' })
  })

  it('looks a name up, and has nothing for a name it does not know', () => {
    expect(vendorLookFor('TELIA SVERIGE AB')?.key).toBe('telia')
    expect(vendorLookFor('Nordlys Hosting AB')).toBeNull()
  })
})
