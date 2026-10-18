import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { ArrivalSummary } from '@/lib/intake/arrivals'
import {
  formatOriginalSize,
  mailboxLabel,
  normaliseMime,
  originalIsPreviewed,
  originalViewFor,
  otherDoors,
  parseMailbox,
  primaryArrival,
  provenanceFor,
  provenanceLine,
  showableArrivals,
  sortArrivals,
  sourceLabelId,
  type MessageRef,
} from '@/lib/intake/arrival-display'

const SOURCES = [
  'intake_email', 'mailbox', 'whatsapp', 'upload', 'peppol', 'partner_api', 'mcp', 'migration',
  'system', 'bank_feed', 'bank_file', 'sie', 'billo', 'kivra', 'paypal', 'portal',
] as const

function arrival(overrides: Partial<ArrivalSummary> = {}): ArrivalSummary {
  return {
    id: 'arrival-1',
    source: 'upload',
    received_at: '2026-10-15T08:00:00Z',
    sender: {},
    subject: null,
    message_text: null,
    fetched_by: {},
    has_original: false,
    original_mime: null,
    original_size: null,
    original_file_name: null,
    original_url: null,
    outputs: [],
    ...overrides,
  }
}

const formatDate = (iso: string) => `D(${iso.slice(0, 10)})`

type Catalog = { inbox_arrivals: Record<string, unknown> }

/** The message at a dotted key in the inbox_arrivals namespace, or undefined. */
function message(catalog: Catalog, key: string): string | undefined {
  let node: unknown = catalog.inbox_arrivals
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

/** Fill {placeholders} the way next-intl does for plain arguments. */
function render(catalog: Catalog, ref: MessageRef): string {
  const template = message(catalog, ref.key)
  if (template === undefined) throw new Error(`missing message inbox_arrivals.${ref.key}`)
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => ref.values[name] ?? whole)
}

const svCatalog = sv as unknown as Catalog
const enCatalog = en as unknown as Catalog

describe('primaryArrival and sortArrivals', () => {
  it('picks the earliest delivery whatever order the list came in', () => {
    const late = arrival({ id: 'late', received_at: '2026-10-15T12:00:00Z' })
    const early = arrival({ id: 'early', received_at: '2026-10-14T09:00:00Z' })
    expect(primaryArrival([late, early])?.id).toBe('early')
    expect(sortArrivals([late, early]).map((a) => a.id)).toEqual(['early', 'late'])
  })

  it('keeps the given order for ties and puts unreadable dates last', () => {
    const a = arrival({ id: 'a', received_at: '2026-10-15T08:00:00Z' })
    const b = arrival({ id: 'b', received_at: '2026-10-15T08:00:00Z' })
    const bad = arrival({ id: 'bad', received_at: 'not a date' })
    expect(sortArrivals([bad, a, b]).map((x) => x.id)).toEqual(['a', 'b', 'bad'])
  })

  it('is null for no arrivals', () => {
    expect(primaryArrival([])).toBeNull()
  })
})

describe('parseMailbox', () => {
  it('splits a display name from its address', () => {
    expect(parseMailbox('"Leverantör AB" <faktura@lev.example>')).toEqual({ name: 'Leverantör AB', address: 'faktura@lev.example' })
    expect(parseMailbox('Leverantör AB <faktura@lev.example>')).toEqual({ name: 'Leverantör AB', address: 'faktura@lev.example' })
  })

  it('keeps a bare or bracketed address as the address', () => {
    expect(parseMailbox('faktura@lev.example')).toEqual({ name: null, address: 'faktura@lev.example' })
    expect(parseMailbox('<faktura@lev.example>')).toEqual({ name: null, address: 'faktura@lev.example' })
  })

  it('treats empty and non-string values as unknown', () => {
    expect(parseMailbox('  ')).toEqual({ name: null, address: null })
    expect(parseMailbox(null)).toEqual({ name: null, address: null })
    expect(parseMailbox(['a@b.example'])).toEqual({ name: null, address: null })
  })

  it('labels a mailbox by its name, else its address', () => {
    expect(mailboxLabel('Leverantör AB <faktura@lev.example>')).toBe('Leverantör AB')
    expect(mailboxLabel('faktura@lev.example')).toBe('faktura@lev.example')
    expect(mailboxLabel(undefined)).toBeNull()
  })
})

describe('provenanceLine', () => {
  it('says who mailed it to the inbox address, in Swedish and English', () => {
    const ref = provenanceLine(
      arrival({ source: 'intake_email', sender: { from: 'Leverantör AB <faktura@lev.example>', to: ['acme@inbox.example'] } }),
      { formatDate },
    )
    expect(ref).toEqual({ key: 'line.intake_email_from', values: { from: 'Leverantör AB', date: 'D(2026-10-15)' } })
    expect(render(svCatalog, ref)).toBe('Mejlad av Leverantör AB till inkorgsadressen · D(2026-10-15)')
    expect(render(enCatalog, ref)).toBe('Emailed by Leverantör AB to the inbox address · D(2026-10-15)')
  })

  it('drops the sender when the mail had none', () => {
    expect(provenanceLine(arrival({ source: 'intake_email' }), { formatDate }).key).toBe('line.intake_email')
  })

  it('names the mailbox provider from the item, as a brand', () => {
    const gmail = provenanceLine(arrival({ source: 'mailbox' }), { formatDate, mailProvider: 'gmail' })
    expect(render(svCatalog, gmail)).toBe('Hämtad ur kopplad mejlbox (Gmail) · D(2026-10-15)')
    const outlook = provenanceLine(arrival({ source: 'mailbox' }), { formatDate, mailProvider: 'microsoft' })
    expect(outlook.values.provider).toBe('Outlook')
    expect(provenanceLine(arrival({ source: 'mailbox' }), { formatDate, mailProvider: 'yahoo' }).key).toBe('line.mailbox')
    expect(provenanceLine(arrival({ source: 'mailbox' }), { formatDate }).key).toBe('line.mailbox')
  })

  it('names the WhatsApp number only in its masked form', () => {
    const ref = provenanceLine(
      arrival({ source: 'whatsapp', sender: { phone_masked: '+46 70*** **12', phone_link_id: 'x', user_id: 'u' } }),
      { formatDate },
    )
    expect(render(svCatalog, ref)).toBe('Skickad i WhatsApp från +46 70*** **12 · D(2026-10-15)')
    // A backfilled WhatsApp arrival has no masked number.
    expect(provenanceLine(arrival({ source: 'whatsapp', sender: { phone_link_id: 'x' } }), { formatDate }).key).toBe('line.whatsapp')
  })

  it('says an e-invoice came over Peppol, with the sender when known', () => {
    const named = provenanceLine(arrival({ source: 'peppol', sender: { name: 'Leverantör AB', endpoint: '0007:5560000000' } }), { formatDate })
    expect(render(svCatalog, named)).toBe('E-faktura via Peppol från Leverantör AB · D(2026-10-15)')
    const bare = provenanceLine(arrival({ source: 'peppol' }), { formatDate })
    expect(render(svCatalog, bare)).toBe('E-faktura via Peppol · D(2026-10-15)')
  })

  it('says "av dig" only for the signed-in user\'s own upload', () => {
    const own = arrival({ source: 'upload', fetched_by: { type: 'user', user_id: 'user-1' } })
    expect(render(svCatalog, provenanceLine(own, { formatDate, currentUserId: 'user-1' }))).toBe('Uppladdad av dig · D(2026-10-15)')
    expect(provenanceLine(own, { formatDate, currentUserId: 'user-2' }).key).toBe('line.upload')
    expect(provenanceLine(own, { formatDate }).key).toBe('line.upload')
  })

  it('names the MCP client by its label when there is one', () => {
    const labelled = provenanceLine(arrival({ source: 'mcp', fetched_by: { type: 'mcp_oauth', label: 'Claude' } }), { formatDate })
    expect(render(svCatalog, labelled)).toBe('Skickad av Claude via MCP · D(2026-10-15)')
    expect(provenanceLine(arrival({ source: 'mcp', fetched_by: { type: 'api_key' } }), { formatDate }).key).toBe('line.mcp')
  })

  it('falls back to a plain "received" line for a door it does not know', () => {
    const ref = provenanceLine(arrival({ source: 'carrier_pigeon' }), { formatDate })
    expect(render(svCatalog, ref)).toBe('Inkommen · D(2026-10-15)')
  })
})

describe('otherDoors', () => {
  it('lists the doors after the first, each once, in order of use', () => {
    const doors = otherDoors([
      arrival({ id: '3', source: 'whatsapp', received_at: '2026-10-17T08:00:00Z' }),
      arrival({ id: '1', source: 'intake_email', received_at: '2026-10-15T08:00:00Z' }),
      arrival({ id: '2', source: 'upload', received_at: '2026-10-16T08:00:00Z' }),
      arrival({ id: '4', source: 'upload', received_at: '2026-10-18T08:00:00Z' }),
    ])
    expect(doors).toEqual(['upload', 'whatsapp'])
  })

  it('counts the first door again when the same delivery repeated', () => {
    expect(
      otherDoors([
        arrival({ id: '1', source: 'intake_email', received_at: '2026-10-15T08:00:00Z' }),
        arrival({ id: '2', source: 'intake_email', received_at: '2026-10-16T08:00:00Z' }),
      ]),
    ).toEqual(['intake_email'])
  })

  it('is empty for a single arrival and maps unknown doors to one label', () => {
    expect(otherDoors([arrival()])).toEqual([])
    expect(otherDoors([arrival({ id: '1' }), arrival({ id: '2', source: 'fax', received_at: '2026-10-16T08:00:00Z' })])).toEqual(['unknown'])
  })
})

describe('originalViewFor', () => {
  it('shows a kept mail as its envelope and text, with the .eml to download', () => {
    const view = originalViewFor(
      arrival({
        source: 'intake_email',
        sender: { from: 'faktura@lev.example', to: ['acme@inbox.example'], cc: [], reply_to: [] },
        subject: 'Faktura 1001',
        message_text: 'Hej! Se bifogad faktura.',
        has_original: true,
        original_mime: 'message/rfc822',
        original_file_name: 'em_1.eml',
        original_url: 'https://storage.example/signed-eml',
      }),
    )
    expect(view).toEqual({
      kind: 'mail',
      from: 'faktura@lev.example',
      to: ['acme@inbox.example'],
      cc: [],
      subject: 'Faktura 1001',
      receivedAt: '2026-10-15T08:00:00Z',
      text: 'Hej! Se bifogad faktura.',
      kept: true,
      url: 'https://storage.example/signed-eml',
      fileName: 'em_1.eml',
    })
  })

  it('shows a mail whose .eml was never kept by its text alone, with nothing to download', () => {
    const view = originalViewFor(
      arrival({ source: 'intake_email', sender: { from: 'a@b.example' }, subject: 'Kvitto', message_text: 'Tack för köpet' }),
    )
    expect(view).toMatchObject({ kind: 'mail', kept: false, url: null, fileName: null, text: 'Tack för köpet' })
  })

  it('has nothing to show for a hunted mail (envelope only) or a WhatsApp photo', () => {
    expect(originalViewFor(arrival({ source: 'mailbox', sender: { from: 'a@b.example' }, subject: 'Kvitto' })).kind).toBe('none')
    expect(originalViewFor(arrival({ source: 'whatsapp', sender: { phone_masked: '+46 70*** **12' } })).kind).toBe('none')
  })

  it('shows XML as an e-invoice, whatever its parameters', () => {
    for (const mime of ['application/xml', 'text/xml', 'Text/XML; charset=utf-8', 'application/ubl+xml']) {
      const view = originalViewFor(
        arrival({
          source: 'peppol',
          sender: { name: 'Leverantör AB', endpoint: '0007:5560000000', org_number: '556000-0000' },
          has_original: true,
          original_mime: mime,
          original_file_name: 'faktura.xml',
          original_url: 'https://storage.example/signed-xml',
        }),
      )
      expect(view).toEqual({
        kind: 'einvoice',
        senderName: 'Leverantör AB',
        endpoint: '0007:5560000000',
        orgNumber: '556000-0000',
        receivedAt: '2026-10-15T08:00:00Z',
        url: 'https://storage.example/signed-xml',
        fileName: 'faktura.xml',
      })
    }
  })

  it('reads an original with no recorded type by its door or file name', () => {
    expect(originalViewFor(arrival({ source: 'peppol', has_original: true })).kind).toBe('einvoice')
    expect(originalViewFor(arrival({ has_original: true, original_file_name: 'x.eml' })).kind).toBe('mail')
    expect(originalViewFor(arrival({ has_original: true, original_file_name: 'x.XML' })).kind).toBe('einvoice')
    expect(originalViewFor(arrival({ has_original: true, original_file_name: 'x.pdf' })).kind).toBe('file')
  })

  it('shows anything else as the file, an SVG included', () => {
    expect(
      originalViewFor(
        arrival({
          has_original: true,
          original_mime: 'application/pdf',
          original_size: 4096,
          original_file_name: 'kvitto.pdf',
          original_url: 'https://storage.example/signed-pdf',
        }),
      ),
    ).toEqual({
      kind: 'file',
      fileName: 'kvitto.pdf',
      mime: 'application/pdf',
      size: 4096,
      receivedAt: '2026-10-15T08:00:00Z',
      url: 'https://storage.example/signed-pdf',
    })
    expect(originalViewFor(arrival({ has_original: true, original_mime: 'image/svg+xml' })).kind).toBe('file')
  })

  it('keeps a kept original showable when its URL could not be signed', () => {
    const view = originalViewFor(arrival({ has_original: true, original_mime: 'message/rfc822', original_url: null }))
    expect(view).toMatchObject({ kind: 'mail', kept: true, url: null })
  })

  it('normalises mime types', () => {
    expect(normaliseMime(' Message/RFC822 ')).toBe('message/rfc822')
    expect(normaliseMime('')).toBeNull()
    expect(normaliseMime(null)).toBeNull()
  })
})

const DOC = 'doc-shown'
const FIRST_VERSION = 'doc-first-version'

/** An upload-shaped arrival: its original is the document it filed. */
function filed(source: string, documentId: string, overrides: Partial<ArrivalSummary> = {}): ArrivalSummary {
  return arrival({
    id: `${source}-${documentId}`,
    source,
    has_original: true,
    original_mime: 'application/pdf',
    original_file_name: 'kvitto.pdf',
    original_url: 'https://storage.example/signed-pdf',
    outputs: [
      { kind: 'document', id: documentId, role: 'attachment' },
      { kind: 'inbox_item', id: 'item-1', role: 'attachment' },
    ],
    ...overrides,
  })
}

describe('originalIsPreviewed', () => {
  it('is true for an upload, MCP or API file that is the previewed document', () => {
    for (const source of ['upload', 'mcp', 'partner_api']) {
      expect(originalIsPreviewed(filed(source, DOC), DOC), source).toBe(true)
    }
  })

  it('is false for the original of an earlier version: that file is not the one shown', () => {
    expect(originalIsPreviewed(filed('upload', FIRST_VERSION), DOC)).toBe(false)
  })

  it('takes a self-original door as the previewed file when it cannot tell', () => {
    expect(originalIsPreviewed(filed('upload', DOC))).toBe(true)
    expect(originalIsPreviewed(filed('mcp', DOC, { outputs: [] }), DOC)).toBe(true)
  })

  it('is true for a Peppol XML that is itself the previewed document, false beside a rendering', () => {
    const xmlOnly = arrival({
      source: 'peppol',
      has_original: true,
      original_mime: 'application/xml',
      outputs: [
        { kind: 'document', id: DOC, role: 'xml' },
        { kind: 'inbox_item', id: 'item-1', role: 'xml' },
      ],
    })
    expect(originalIsPreviewed(xmlOnly, DOC)).toBe(true)
    const withRendering = arrival({
      source: 'peppol',
      has_original: true,
      original_mime: 'application/xml',
      outputs: [
        { kind: 'document', id: 'doc-xml', role: 'xml' },
        { kind: 'document', id: DOC, role: 'rendering' },
        { kind: 'inbox_item', id: 'item-1', role: 'rendering' },
      ],
    })
    expect(originalIsPreviewed(withRendering, DOC)).toBe(false)
  })

  it('is false for a mail, whose .eml is always a copy of its own, and for no original at all', () => {
    const mail = arrival({
      source: 'intake_email',
      has_original: true,
      original_mime: 'message/rfc822',
      outputs: [{ kind: 'document', id: DOC, role: 'attachment' }],
    })
    expect(originalIsPreviewed(mail, DOC)).toBe(false)
    expect(originalIsPreviewed(arrival({ source: 'upload', has_original: false }), DOC)).toBe(false)
  })
})

describe('showableArrivals', () => {
  it('keeps only arrivals with something to show besides the previewed file, first delivery first', () => {
    const hunted = arrival({ id: 'hunt', source: 'mailbox', received_at: '2026-10-14T08:00:00Z', subject: 'Kvitto' })
    const mailed = arrival({ id: 'mail', source: 'intake_email', received_at: '2026-10-16T08:00:00Z', has_original: true, original_mime: 'message/rfc822' })
    const uploaded = filed('upload', DOC, { id: 'upload', received_at: '2026-10-15T08:00:00Z' })
    const earlier = filed('upload', FIRST_VERSION, { id: 'earlier', received_at: '2026-10-13T08:00:00Z' })
    expect(showableArrivals([mailed, hunted, uploaded, earlier], DOC).map((a) => a.id)).toEqual(['earlier', 'mail'])
  })
})

describe('provenanceFor', () => {
  it('is null when no arrival is recorded, so the Inkorg keeps its older rendering', () => {
    expect(provenanceFor([], { formatDate })).toBeNull()
  })

  it('describes the first delivery and the doors after it', () => {
    const display = provenanceFor(
      [
        arrival({ id: 'up', source: 'upload', received_at: '2026-10-16T08:00:00Z', has_original: true, original_mime: 'application/pdf' }),
        arrival({
          id: 'mail',
          source: 'intake_email',
          received_at: '2026-10-15T08:00:00Z',
          sender: { from: 'faktura@lev.example' },
          subject: '  Faktura 1001  ',
          has_original: true,
          original_mime: 'message/rfc822',
        }),
      ],
      { formatDate },
    )
    expect(display?.primary.id).toBe('mail')
    expect(display?.line).toEqual({ key: 'line.intake_email_from', values: { from: 'faktura@lev.example', date: 'D(2026-10-15)' } })
    expect(display?.subject).toBe('Faktura 1001')
    expect(display?.alsoVia).toEqual(['upload'])
    expect(display?.canShowOriginal).toBe(true)
  })

  it('offers no original when nothing was kept', () => {
    const display = provenanceFor([arrival({ source: 'mailbox', subject: 'Kvitto' })], { formatDate, mailProvider: 'gmail' })
    expect(display?.canShowOriginal).toBe(false)
    expect(display?.alsoVia).toEqual([])
  })

  it('offers no original when the only one is the previewed file itself', () => {
    for (const source of ['upload', 'mcp', 'partner_api']) {
      expect(provenanceFor([filed(source, DOC)], { formatDate, documentId: DOC })?.canShowOriginal, source).toBe(false)
    }
  })

  it('offers the original when one arrival brought a different file, even beside the previewed one', () => {
    const mailed = arrival({ id: 'mail', source: 'intake_email', received_at: '2026-10-16T08:00:00Z', has_original: true, original_mime: 'message/rfc822' })
    expect(provenanceFor([filed('upload', DOC), mailed], { formatDate, documentId: DOC })?.canShowOriginal).toBe(true)
    expect(provenanceFor([filed('upload', FIRST_VERSION)], { formatDate, documentId: DOC })?.canShowOriginal).toBe(true)
  })
})

describe('messages', () => {
  it('has every line the helper can produce, with its placeholders, in both languages', () => {
    const refs: MessageRef[] = []
    for (const source of [...SOURCES, 'unknown_door']) {
      const variants: Array<Partial<ArrivalSummary>> = [
        {},
        { sender: { from: 'A <a@b.example>', phone_masked: '+46 70*** **12', name: 'A' }, fetched_by: { user_id: 'u', label: 'L' } },
      ]
      for (const v of variants) {
        refs.push(provenanceLine(arrival({ source, ...v }), { formatDate, currentUserId: 'u', mailProvider: 'gmail' }))
        refs.push(provenanceLine(arrival({ source, ...v }), { formatDate }))
      }
    }
    for (const ref of refs) {
      for (const catalog of [svCatalog, enCatalog]) {
        const out = render(catalog, ref)
        expect(out, ref.key).not.toMatch(/\{\w+\}/)
        expect(out, ref.key).toContain('D(2026-10-15)')
      }
    }
  })

  it('has a door label for every source and for an unknown one, in both languages', () => {
    for (const id of [...SOURCES.map(sourceLabelId), 'unknown']) {
      expect(message(svCatalog, `source.${id}`), id).toBeTruthy()
      expect(message(enCatalog, `source.${id}`), id).toBeTruthy()
    }
  })

  it('has the same keys in Swedish and English', () => {
    const keys = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
        : [prefix]
    expect(keys(enCatalog.inbox_arrivals).sort()).toEqual(keys(svCatalog.inbox_arrivals).sort())
  })

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(svCatalog.inbox_arrivals)).not.toMatch(/[\u2013\u2014]/)
    expect(JSON.stringify(enCatalog.inbox_arrivals)).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('formatOriginalSize', () => {
  it('formats bytes, kilobytes and megabytes for the locale', () => {
    expect(formatOriginalSize(512, 'sv')).toBe('512 B')
    expect(formatOriginalSize(4300, 'sv')).toBe('4,2 kB')
    expect(formatOriginalSize(4300, 'en')).toBe('4.2 kB')
    expect(formatOriginalSize(1.5 * 1024 * 1024, 'sv')).toBe('1,5 MB')
  })

  it('is null for an unknown size', () => {
    expect(formatOriginalSize(null, 'sv')).toBeNull()
    expect(formatOriginalSize(-1, 'sv')).toBeNull()
    expect(formatOriginalSize(Number.NaN, 'sv')).toBeNull()
  })
})
