import { describe, expect, it } from 'vitest'
import { readableName } from '../names'

describe('readableName', () => {
  it("sets a bank's capitals in title case", () => {
    expect(readableName('MOLNTJANSTEN')).toBe('Molntjansten')
    expect(readableName('KAFE SOLROS')).toBe('Kafe Solros')
    expect(readableName('NORD-OST BYGG')).toBe('Nord-Ost Bygg')
    expect(readableName('KVARNBY JÄRN & FÄRG')).toBe('Kvarnby Järn & Färg')
  })

  it('keeps company forms, short words and words with digits as written', () => {
    expect(readableName('TELIA SVERIGE AB')).toBe('Telia Sverige AB')
    expect(readableName('HETZNER ONLINE GMBH')).toBe('Hetzner Online GmbH')
    expect(readableName('CIRCLE K 4471')).toBe('Circle K 4471')
    expect(readableName('OKQ8 SOLNA')).toBe('OKQ8 Solna')
    expect(readableName('SJ AB')).toBe('SJ AB')
    expect(readableName('KJELL & CO 1043')).toBe('Kjell & Co 1043')
  })

  it("keeps a known vendor's own spelling", () => {
    expect(readableName('IKEA KUNGENS KURVA')).toBe('IKEA Kungens Kurva')
    expect(readableName('PAYPAL *SPOTIFY')).toBe('PayPal *Spotify')
    expect(readableName('OPENAI *CHATGPT SUBSCR')).toBe('OpenAI *Chatgpt Subscr')
  })

  it('leaves punctuation where it stands', () => {
    expect(readableName('BYGGHANDELN (SVERIGE) AB,')).toBe('Bygghandeln (Sverige) AB,')
  })

  it('leaves a name someone already cased, and nothing at all, alone', () => {
    expect(readableName('Kjell & Company')).toBe('Kjell & Company')
    expect(readableName('iZettle')).toBe('iZettle')
    expect(readableName('Telia SVERIGE')).toBe('Telia SVERIGE')
    expect(readableName('1250')).toBe('1250')
    expect(readableName('')).toBe('')
    expect(readableName(null)).toBeNull()
  })
})
