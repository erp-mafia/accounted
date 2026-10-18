import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { DocumentUploadSource, InboxItemSource } from '@/types'
import {
  INTAKE_SOURCE_IDS,
  INTAKE_SOURCES,
  inboxSourceForIntake,
  intakeSourceForInboxItem,
  intakeSourceFromChannel,
  intakeSourceFromInboxSource,
  intakeSourceFromProcessingChannel,
  intakeSourceFromUploadSource,
  isIntakeSourceId,
  type IntakeSourceId,
} from '../sources'

describe('the canonical intake sources', () => {
  it('are exactly the agreed ids, in the agreed order (the arrivals table uses the same strings)', () => {
    expect(INTAKE_SOURCE_IDS).toEqual([
      'intake_email',
      'mailbox',
      'whatsapp',
      'upload',
      'peppol',
      'partner_api',
      'mcp',
      'migration',
      'system',
      'bank_feed',
      'bank_file',
      'sie',
      'billo',
      'kivra',
      'paypal',
      'portal',
    ])
  })

  it('register every id once, under its own key, with a kind and a live flag', () => {
    expect(Object.keys(INTAKE_SOURCES).sort()).toEqual([...INTAKE_SOURCE_IDS].sort())
    for (const id of INTAKE_SOURCE_IDS) {
      const entry = INTAKE_SOURCES[id]
      expect(entry.id).toBe(id)
      expect(['document', 'bank', 'ledger']).toContain(entry.kind)
      expect(typeof entry.live).toBe('boolean')
    }
  })

  it('mark only the doors that deliver today as live', () => {
    const planned = INTAKE_SOURCE_IDS.filter((id) => !INTAKE_SOURCES[id].live)
    expect(planned).toEqual(['billo', 'kivra', 'paypal', 'portal'])
  })

  it('put the bank and ledger doors in their kinds', () => {
    const of = (kind: string) => INTAKE_SOURCE_IDS.filter((id) => INTAKE_SOURCES[id].kind === kind)
    expect(of('bank')).toEqual(['bank_feed', 'bank_file', 'paypal'])
    expect(of('ledger')).toEqual(['migration', 'sie'])
  })

  it('have a Swedish and an English label for every id', () => {
    const svLabels = (sv as unknown as Record<string, Record<string, string>>).intake_sources
    const enLabels = (en as unknown as Record<string, Record<string, string>>).intake_sources
    for (const id of INTAKE_SOURCE_IDS) {
      const [namespace, key] = INTAKE_SOURCES[id].labelKey.split('.')
      expect(namespace).toBe('intake_sources')
      expect(svLabels[key], `sv ${id}`).toEqual(expect.any(String))
      expect(enLabels[key], `en ${id}`).toEqual(expect.any(String))
    }
    expect(Object.keys(svLabels).sort()).toEqual(Object.keys(enLabels).sort())
  })

  it('recognise only the canonical ids', () => {
    for (const id of INTAKE_SOURCE_IDS) expect(isIntakeSourceId(id)).toBe(true)
    for (const value of ['api', 'mail_hunt', 'email', 'file_upload', 'gmail', '', null, undefined, 3, {}]) {
      expect(isIntakeSourceId(value)).toBe(false)
    }
  })
})

describe('intakeSourceFromUploadSource', () => {
  // Every value the document_attachments_upload_source_check allows.
  const cases: Array<[DocumentUploadSource, IntakeSourceId]> = [
    ['camera', 'upload'],
    ['file_upload', 'upload'],
    ['scan', 'upload'],
    ['email', 'intake_email'],
    ['e_invoice', 'peppol'],
    ['system', 'system'],
    ['whatsapp', 'whatsapp'],
    ['mail_hunt', 'mailbox'],
    ['api', 'partner_api'],
  ]
  it.each(cases)('%s reads as %s', (legacy, canonical) => {
    expect(intakeSourceFromUploadSource(legacy)).toBe(canonical)
  })

  it("lets the caller name the door behind 'api'", () => {
    expect(intakeSourceFromUploadSource('api', { caller: 'mcp' })).toBe('mcp')
    expect(intakeSourceFromUploadSource('api', { caller: 'migration' })).toBe('migration')
    expect(intakeSourceFromUploadSource('api', { caller: 'bank_feed' })).toBe('bank_feed')
    expect(intakeSourceFromUploadSource('api', { caller: 'partner_api' })).toBe('partner_api')
  })

  it("reads the bank sync's raw-answer archive as bank_feed, and a caller hint wins over the name", () => {
    const name = 'psd2-response_conn_acc_2026-10-15T08-00-00-000Z_p1.json'
    expect(intakeSourceFromUploadSource('api', { fileName: name })).toBe('bank_feed')
    expect(intakeSourceFromUploadSource('api', { fileName: 'kvitto.pdf' })).toBe('partner_api')
    expect(intakeSourceFromUploadSource('api', { caller: 'mcp', fileName: name })).toBe('mcp')
  })

  it('ignores hints for every value but api', () => {
    expect(intakeSourceFromUploadSource('file_upload', { caller: 'mcp' })).toBe('upload')
  })

  it('answers null for a missing or unknown value', () => {
    expect(intakeSourceFromUploadSource(null)).toBeNull()
    expect(intakeSourceFromUploadSource(undefined)).toBeNull()
    expect(intakeSourceFromUploadSource('fax')).toBeNull()
  })
})

describe('intakeSourceFromInboxSource', () => {
  // Every value the invoice_inbox_items_source_check allows.
  const cases: Array<[InboxItemSource, IntakeSourceId]> = [
    ['email', 'intake_email'],
    ['upload', 'upload'],
    ['whatsapp', 'whatsapp'],
    ['mail_hunt', 'mailbox'],
    ['peppol', 'peppol'],
  ]
  it.each(cases)('%s reads as %s', (legacy, canonical) => {
    expect(intakeSourceFromInboxSource(legacy)).toBe(canonical)
  })

  it('answers null for a missing or unknown value', () => {
    expect(intakeSourceFromInboxSource(null)).toBeNull()
    expect(intakeSourceFromInboxSource('api')).toBeNull()
  })
})

describe('intakeSourceFromChannel', () => {
  it.each([
    ['whatsapp', 'whatsapp'],
    ['mail_hunt', 'mailbox'],
    ['peppol', 'peppol'],
  ])('channel_context.channel %s reads as %s', (legacy, canonical) => {
    expect(intakeSourceFromChannel(legacy)).toBe(canonical)
  })

  it('answers null for anything else', () => {
    expect(intakeSourceFromChannel(undefined)).toBeNull()
    expect(intakeSourceFromChannel('sms')).toBeNull()
  })
})

describe('intakeSourceFromProcessingChannel', () => {
  it.each([
    ['upload', 'upload'],
    ['email', 'intake_email'],
    ['whatsapp', 'whatsapp'],
    ['mail_hunt', 'mailbox'],
    ['peppol', 'peppol'],
    ['mcp', 'mcp'],
  ])('payload.channel %s reads as %s', (legacy, canonical) => {
    expect(intakeSourceFromProcessingChannel(legacy)).toBe(canonical)
  })

  it("reads 'app' (a person approving in the dashboard) as no door", () => {
    expect(intakeSourceFromProcessingChannel('app')).toBeNull()
    expect(intakeSourceFromProcessingChannel(null)).toBeNull()
  })
})

describe('intakeSourceForInboxItem', () => {
  it('takes the stamp a writer left in channel_context first', () => {
    expect(intakeSourceForInboxItem({ source: 'upload', channel_context: { intake_source: 'partner_api' }, document_upload_source: 'api' })).toBe('partner_api')
    expect(intakeSourceForInboxItem({ source: 'email', channel_context: { intake_source: 'upload' } })).toBe('upload')
  })

  it('ignores a stamp that is not a canonical id', () => {
    expect(intakeSourceForInboxItem({ source: 'upload', channel_context: { intake_source: 'api' }, document_upload_source: 'file_upload' })).toBe('upload')
  })

  it('reads a receipt-hunt item as mailbox whichever provider the mailbox is: the provider is metadata, not a door', () => {
    expect(intakeSourceForInboxItem({ source: 'mail_hunt', channel_context: { channel: 'mail_hunt', mail_provider: 'gmail' } as never })).toBe('mailbox')
    expect(intakeSourceForInboxItem({ source: 'mail_hunt', channel_context: { channel: 'mail_hunt', mail_provider: 'microsoft' } as never })).toBe('mailbox')
  })

  it('reads the channel next', () => {
    expect(intakeSourceForInboxItem({ source: 'mail_hunt', channel_context: { channel: 'mail_hunt' } })).toBe('mailbox')
    expect(intakeSourceForInboxItem({ source: 'whatsapp', channel_context: { channel: 'whatsapp' } })).toBe('whatsapp')
    expect(intakeSourceForInboxItem({ source: 'peppol', channel_context: { channel: 'peppol' } })).toBe('peppol')
  })

  it('reads the source column for the doors with a value of their own', () => {
    expect(intakeSourceForInboxItem({ source: 'email' })).toBe('intake_email')
    expect(intakeSourceForInboxItem({ source: 'whatsapp', channel_context: null })).toBe('whatsapp')
    expect(intakeSourceForInboxItem({ source: 'mail_hunt' })).toBe('mailbox')
    expect(intakeSourceForInboxItem({ source: 'peppol' })).toBe('peppol')
  })

  it("reads an 'upload' item over an 'api' document as an MCP upload", () => {
    expect(intakeSourceForInboxItem({ source: 'upload', document_upload_source: 'api' })).toBe('mcp')
  })

  it("reads any other 'upload' item through its document, and an unread document as upload", () => {
    expect(intakeSourceForInboxItem({ source: 'upload', document_upload_source: 'file_upload' })).toBe('upload')
    expect(intakeSourceForInboxItem({ source: 'upload', document_upload_source: 'camera' })).toBe('upload')
    expect(intakeSourceForInboxItem({ source: 'upload', document_upload_source: 'email' })).toBe('intake_email')
    expect(intakeSourceForInboxItem({ source: 'upload', document_upload_source: 'system' })).toBe('system')
    expect(intakeSourceForInboxItem({ source: 'upload', document_upload_source: null })).toBe('upload')
    expect(intakeSourceForInboxItem({ source: 'upload' })).toBe('upload')
  })

  it('answers null for an item whose source is unknown and carries no context', () => {
    expect(intakeSourceForInboxItem({ source: 'fax' })).toBeNull()
  })
})

describe('inboxSourceForIntake', () => {
  it('keeps the four doors that have an inbox source value of their own', () => {
    expect(inboxSourceForIntake('intake_email')).toBe('email')
    expect(inboxSourceForIntake('mailbox')).toBe('mail_hunt')
    expect(inboxSourceForIntake('whatsapp')).toBe('whatsapp')
    expect(inboxSourceForIntake('peppol')).toBe('peppol')
  })

  it('files every other door as upload, the value the CHECK allows', () => {
    for (const id of INTAKE_SOURCE_IDS.filter((i) => !['intake_email', 'mailbox', 'whatsapp', 'peppol'].includes(i))) {
      expect(inboxSourceForIntake(id)).toBe('upload')
    }
  })

  it('round-trips through intakeSourceFromInboxSource for the four own values', () => {
    for (const id of ['intake_email', 'mailbox', 'whatsapp', 'peppol'] as const) {
      expect(intakeSourceFromInboxSource(inboxSourceForIntake(id))).toBe(id)
    }
  })
})
