import { describe, expect, it } from 'vitest'
import { isExcludedDomain } from '../excluded'

describe('isExcludedDomain', () => {
  it.each([
    // Skatteverket: its API terms forbid its logo in the app.
    'skatteverket.se',
    'www.skatteverket.se',
    // Banks
    'nordea.se',
    'handelsbanken.se',
    'swedbank.se',
    'seb.se',
    'sebgroup.com',
    'danskebank.se',
    'lansforsakringar.se',
    'lf.se',
    'avanza.se',
    'icabanken.se',
    'sparbankensyd.se',
    'revolut.com',
    'wise.com',
    'klarna.com',
    'paypal.com',
    'stripe.com',
    'svea.com',
    'lunar.app',
    // Free-mail and ISP mail
    'gmail.com',
    'googlemail.com',
    'hotmail.com',
    'hotmail.se',
    'outlook.com',
    'outlook.se',
    'live.se',
    'icloud.com',
    'me.com',
    'yahoo.com',
    'yahoo.se',
    'telia.com',
    'bredband.net',
    'spray.se',
    'comhem.se',
    'proton.me',
    // Platforms that send on behalf of others
    'billogram.com',
    'billogram.se',
    'fortnox.se',
    'visma.se',
    'visma.com',
    'kivra.com',
    'kivra.se',
    'mailgun.org',
    'sendgrid.net',
    'amazonses.com',
    'pagero.com',
    'inexchange.se',
    'peppol.eu',
  ])('never fetches %s', (domain) => {
    expect(isExcludedDomain(domain)).toBe(true)
  })

  it.each(['telia.se', 'tele2.se', 'loopia.se', 'hallon.se', 'bokio.se', 'linear.app', 'systembolaget.se', 'sl.se', 'x.ai'])(
    'fetches the brand site %s',
    (domain) => {
      expect(isExcludedDomain(domain)).toBe(false)
    },
  )

  it('treats an unparseable host as excluded', () => {
    expect(isExcludedDomain('localhost')).toBe(true)
    expect(isExcludedDomain('127.0.0.1')).toBe(true)
    expect(isExcludedDomain('')).toBe(true)
  })
})
