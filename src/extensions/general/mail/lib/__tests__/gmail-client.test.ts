/**
 * Reading a message well enough to know whether it carries an underlag.
 *
 * The case that matters is the one a provkörning caught: asking Gmail for
 * `format=metadata` returns headers and no `payload.parts`, so every message
 * looks attachment-free and the hunt can never file anything. These tests pin
 * the format and the MIME walk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clearMessageCache, getMailboxAddress, getMessageSummary } from '../gmail-client'
import { MAIL_HTML_FIXTURES } from '@/tests/fixtures/mail-html'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args))

function respond(message: Record<string, unknown>) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(message),
    text: () => Promise.resolve(''),
  })
}

const HEADERS = [
  { name: 'Subject', value: 'Faktura-20251070' },
  { name: 'From', value: 'info@tic.io' },
]

beforeEach(() => {
  vi.clearAllMocks()
  // The cache is keyed by message id, and these tests reuse ids.
  clearMessageCache()
})

describe('getMessageSummary', () => {
  it('asks for the full message, because metadata omits the parts tree', async () => {
    respond({ id: 'm1', payload: { headers: HEADERS } })
    await getMessageSummary('token', 'm1', 'conn-1', 'invoice@example.se')

    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain('format=full')
    // The bug this replaces: metadata returns no payload.parts at all.
    expect(url).not.toContain('format=metadata')
  })

  it('finds a PDF nested inside a forwarded message', async () => {
    // Forwarding is how most of these receipts arrive, and it buries the
    // attachment two levels down inside a message/rfc822 part.
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { size: 12 } },
          {
            mimeType: 'message/rfc822',
            parts: [
              {
                mimeType: 'multipart/mixed',
                parts: [
                  { mimeType: 'text/html', body: { size: 900 } },
                  {
                    mimeType: 'application/pdf',
                    filename: 'faktura.pdf',
                    body: { attachmentId: 'att-deep', size: 51200 },
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@example.se')
    expect(candidate.attachmentIds).toEqual(['att-deep'])
    expect(candidate.bodyIsReceipt).toBe(false)
  })

  it('does not mistake an inline logo for an underlag', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'logo', size: 400 } },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@example.se')
    expect(candidate.attachmentIds).toEqual([])
    expect(candidate.bodyIsReceipt).toBe(true)
  })

  it('reports a genuinely attachment-free mail as a body receipt', async () => {
    respond({
      id: 'm1',
      payload: { headers: HEADERS, mimeType: 'text/html', body: { size: 4000 } },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@example.se')
    expect(candidate.bodyIsReceipt).toBe(true)
    expect(candidate.subject).toBe('Faktura-20251070')
  })
})

/**
 * One receipt mail answers many purchases' queries, so the same message was
 * downloaded dozens of times per press. Content never changes, so reading it
 * once is both correct and the difference between a press that fits its time
 * budget and one that does not.
 */
describe('message reads are not repeated', () => {
  it('fetches a given message once per mailbox', async () => {
    respond({ id: 'cache-me', payload: { headers: HEADERS } })

    await getMessageSummary('token', 'cache-me', 'conn-1', 'invoice@example.se')
    await getMessageSummary('token', 'cache-me', 'conn-1', 'invoice@example.se')
    await getMessageSummary('token', 'cache-me', 'conn-1', 'invoice@example.se')

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps mailboxes apart, since a hit in one says nothing about the other', async () => {
    respond({ id: 'shared', payload: { headers: HEADERS } })

    await getMessageSummary('token', 'shared', 'conn-1', 'invoice@example.se')
    await getMessageSummary('token', 'shared', 'conn-2', 'owner@example.com')

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('getMailboxAddress', () => {
  it('reads the address from the Gmail profile endpoint, which gmail.readonly covers', async () => {
    respond({ emailAddress: 'Owner@Example.test', messagesTotal: 12 })
    const address = await getMailboxAddress('token')
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    )
    expect(address).toBe('Owner@Example.test')
  })

  it('returns null when the profile carries no address', async () => {
    respond({ messagesTotal: 0 })
    expect(await getMailboxAddress('token')).toBeNull()
  })
})

describe('the body text of a message', () => {
  function respondWithHtml(html: string) {
    respond({ id: 'm-html', payload: { headers: HEADERS, mimeType: 'text/html', body: { data: Buffer.from(html, 'utf8').toString('base64url') } } })
  }

  const READ: Record<string, string> = {
    'an Outlook invoice mail':
      'Hej, Bifogat finns faktura 2025-0042 f&ouml;r november. Att betala: 12 500,00 kr inkl. moms. F&ouml;rfallodag 2025-12-31. Bankgiro 123-4567, OCR 20250042. Med v&auml;nliga h&auml;lsningar Anna Exempel Exempel Leverant&ouml;r AB',
    'a web shop receipt':
      'Ditt kvitto fr&aring;n Exempelbutiken Tack f&ouml;r ditt k&ouml;p! Ordernummer: 100-2381 Kontorsstol Ergo & fotst&ouml;d 2&#160;990,00 kr Frakt 49,00 kr Totalt 3&#160;039,00 kr Varav moms 25 %: 607,80 kr',
    'a receipt forwarded from Gmail':
      '---------- Forwarded message --------- Från: Exempel Hosting &lt;faktura@hosting.example&gt; Date: tis 25 nov. 2025 kl 09:14 Subject: Kvitto för betalning #48213 To: &lt;ekonomi@foretaget.example&gt; Hej! Vi har tagit emot din betalning på 1 249,00 kr för perioden 2025-11-01 till 2025-11-30. Webbhotell Bas: 999,00 kr Domän foretaget.example: 250,00 kr Kortet slutar på 4242. Detta mejl kan inte besvaras.',
    'a page saved from a supplier portal':
      'Faktura 7781 window.dataLayer = window.dataLayer || []; if (a d) { track(\'view\') } .no-print{display:none} Exempel Leverant&ouml;r AB Faktura 7781 Fakturadatum: 2025-11-03 Förfallodag: 2025-12-03 Konsulttimmar, 10 h 9&#x00A0;500,00 Moms 25 % 2 375,00 Summa att betala: 11 875,00 SEK Bet.villkor 30 dagar netto. Dr&ouml;jsm&aring;lsr&auml;nta enligt r&auml;ntelagen. <!-- generated 2025-11-03T08:00:00Z',
  }

  it.each(MAIL_HTML_FIXTURES)('reads %s as before', async (name, html) => {
    respondWithHtml(html)
    const candidate = await getMessageSummary('token', 'm-html', 'conn-1', 'invoice@example.se')
    expect(candidate.bodyText).toBe(READ[name])
  })

  // Each of these took seconds per 100 KB, searching the rest of the body
  // again from every opening. The bound is checked after each size, the
  // smaller first, so a slow step fails here instead of hanging the run.
  it.each([
    ['style blocks that never end', '<style'],
    ['tags without their >', '<'],
  ])('answers at once for a body made of %s', async (_, unit) => {
    let spent = 0
    for (const kb of [256, 1024]) {
      clearMessageCache()
      respondWithHtml(unit.repeat(Math.floor((kb * 1024) / unit.length)))
      const started = Date.now()
      await getMessageSummary('token', 'm-html', 'conn-1', 'invoice@example.se')
      spent += Date.now() - started
      expect(spent).toBeLessThan(2000)
    }
  })
})
