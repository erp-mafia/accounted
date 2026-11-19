import { describe, it, expect } from 'vitest'
import { drawsPdfInPage } from '../pdf-embed'

/**
 * Which browsers get the page's own PDF drawing instead of an
 * <object type="application/pdf"> (crm#1689, accounted#178): Safari left the
 * invoice editor's PDF pane blank, while Chrome, Edge and Firefox on a
 * computer paint it.
 */
const UA = {
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15',
  edgeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
}

describe('drawsPdfInPage', () => {
  it('draws in the page on Safari and on every iOS browser (all WebKit)', () => {
    for (const ua of [UA.safariMac, UA.safariIphone, UA.chromeIos, UA.firefoxIos, UA.edgeIos]) {
      expect(drawsPdfInPage(ua, true)).toBe(true)
    }
  })

  it('keeps the browser viewer in Chrome, Edge and Firefox on a computer', () => {
    for (const ua of [UA.chromeMac, UA.edgeWindows, UA.firefoxMac]) {
      expect(drawsPdfInPage(ua, true)).toBe(false)
      expect(drawsPdfInPage(ua, undefined)).toBe(false)
    }
  })

  it('draws in the page wherever the browser says it has no PDF viewer', () => {
    expect(drawsPdfInPage(UA.chromeAndroid, false)).toBe(true)
    expect(drawsPdfInPage(UA.chromeMac, false)).toBe(true)
  })

  it('keeps the viewer when nothing is known (server render)', () => {
    expect(drawsPdfInPage(null, undefined)).toBe(false)
    expect(drawsPdfInPage('', undefined)).toBe(false)
  })
})
