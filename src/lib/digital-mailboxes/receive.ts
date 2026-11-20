/**
 * Reading a company's Kivra or Billo mailbox into the Inkorg.
 *
 * One loop for both providers: list what the mailbox received since the
 * connection's receive_since, skip what an arrival already records, and file
 * the rest the way the v1 partner door does (src/lib/intake/partner-delivery.ts):
 * through the invoice-inbox extension's pipeline (content dedupe, extraction,
 * Arkiv), nothing booked, every document waiting in the Inkorg for a person
 * or a granted agent. Each document is an arrival under source 'kivra' or
 * 'billo' with the provider's id as source_ref, which is the idempotency key:
 * a webhook and the cron sweep that both see a document file it once.
 *
 * The first filable part (PDF or image) is the inbox item; further parts
 * (a specification, terms) are archived as underlag beside it and linked to
 * the same arrival. A content with no file part (a plain-text letter) is
 * recorded as an arrival with nothing filed, so it is not fetched again.
 *
 * Core: the pipeline is reached through the extension registry's services,
 * never imported (core builds with zero extensions).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { INBOX_UPLOAD_TYPES } from '@/lib/documents/upload-types'
import { extensionRegistry } from '@/lib/extensions/registry'
import {
  linkArrivalOutputs,
  recordArrival,
  recordDocumentArrival,
  sanitiseArrivalJson,
  type ArrivalActor,
} from '@/lib/intake/arrivals'
import {
  INVOICE_INBOX_EXTENSION_ID,
  type InboxDeliveryKind,
  type InvoiceInboxServices,
} from '@/lib/intake/partner-delivery'
import type { Logger } from '@/lib/logger'
import { connectionError, updateConnection, type DigitalMailboxConnection } from './connections'
import { isDigitalMailboxApiError } from './http'
import type { MailboxDocument, MailboxReceiver, ReceiveAccount } from './types'

/** Documents filed per connection per run; the rest wait for the next run. */
export const MAX_DOCUMENTS_PER_RUN = 25

export type DeliveryOutcome = 'filed' | 'already' | 'no_file'

export class InboxUnavailableError extends Error {
  readonly name = 'InboxUnavailableError'
}

function kindHint(kind: MailboxDocument['kind']): InboxDeliveryKind | null {
  if (kind === 'invoice') return 'supplier_invoice'
  if (kind === 'receipt') return 'receipt'
  return null
}

export function receiveAccountOf(connection: DigitalMailboxConnection): ReceiveAccount | null {
  return connection.account_ref ? { accountRef: connection.account_ref, mailboxRef: connection.mailbox_ref } : null
}

async function arrivalExists(
  service: SupabaseClient,
  companyId: string,
  source: string,
  ref: string,
): Promise<boolean> {
  const { data, error } = await service
    .from('arrivals')
    .select('id')
    .eq('company_id', companyId)
    .eq('source', source)
    .eq('source_ref', ref)
    .maybeSingle()
  if (error) throw new Error(`arrival lookup failed: ${error.message}`)
  return !!data
}

/**
 * Whom the filed documents belong to: the member who connected the mailbox
 * while still a member, else the company's first owner (the Peppol door's
 * rule). Null when the company has neither.
 */
export async function resolveInboxOwner(
  service: SupabaseClient,
  connection: Pick<DigitalMailboxConnection, 'company_id' | 'receive_connected_by'>,
): Promise<string | null> {
  if (connection.receive_connected_by) {
    const { data } = await service
      .from('company_members')
      .select('user_id')
      .eq('company_id', connection.company_id)
      .eq('user_id', connection.receive_connected_by)
      .maybeSingle()
    if (data) return connection.receive_connected_by
  }
  const { data: owner } = await service
    .from('company_members')
    .select('user_id')
    .eq('company_id', connection.company_id)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (owner as { user_id: string } | null)?.user_id ?? null
}

async function inboxServices(): Promise<InvoiceInboxServices> {
  const services = (await extensionRegistry.get(INVOICE_INBOX_EXTENSION_ID))?.services as
    | Partial<InvoiceInboxServices>
    | undefined
  if (!services?.fileInboxDelivery) {
    throw new InboxUnavailableError('the invoice-inbox extension is not enabled in this deployment')
  }
  return services as InvoiceInboxServices
}

/**
 * File one mailbox document into the company's Inkorg. Idempotent: a
 * document an arrival already records answers 'already' without a call to
 * the provider.
 */
export async function deliverMailboxDocument(
  service: SupabaseClient,
  args: {
    connection: DigitalMailboxConnection
    receiver: MailboxReceiver
    ref: string
    ownerId: string
    actor: ArrivalActor
    log: Logger
  },
): Promise<DeliveryOutcome> {
  const { connection, receiver, ref, ownerId, actor, log } = args
  const companyId = connection.company_id
  const source = connection.provider
  const account = receiveAccountOf(connection)
  if (!account) throw new Error('the connection has no provider account yet')

  if (await arrivalExists(service, companyId, source, ref)) return 'already'

  const { document, files } = await receiver.getDocument(account, ref)
  const filable = files.filter((f) => INBOX_UPLOAD_TYPES.includes(f.contentType) && f.bytes.byteLength > 0)
  const sender: Record<string, string> = {}
  if (document.senderName) sender.name = document.senderName
  if (document.senderOrgNumber) sender.org_number = document.senderOrgNumber
  const sourceMeta = {
    kind: document.kind,
    provider_meta: sanitiseArrivalJson(document.meta),
  }

  const [main, ...rest] = filable
  if (!main) {
    await recordArrival(service, {
      companyId,
      source,
      sourceRef: ref,
      receivedAt: document.receivedAt ?? new Date(),
      sender,
      subject: document.subject,
      fetchedBy: actor,
      sourceMeta: { ...sourceMeta, skipped: 'no_file_part' },
    })
    log.info('mailbox document has no file to file', { companyId, provider: source, ref })
    return 'no_file'
  }

  const services = await inboxServices()
  const delivered = await services.fileInboxDelivery(service, {
    userId: ownerId,
    companyId,
    file: { name: main.name, buffer: main.bytes, type: main.contentType },
    kindHint: kindHint(document.kind),
    senderName: document.senderName,
    subject: document.subject,
    receivedAt: document.receivedAt,
    channelContext: { intake_source: source, external_ref: ref },
  })

  const recorded = await recordDocumentArrival(service, {
    companyId,
    source,
    documentId: delivered.document_id,
    inboxItemId: delivered.inbox_item_id,
    sourceRef: ref,
    fetchedBy: actor,
    sender,
    subject: document.subject,
    receivedAt: document.receivedAt ?? new Date(),
    sourceMeta,
  })

  // The other parts are underlag of the same delivery: archived (deduped on
  // content) and linked to the arrival, never filed as items of their own.
  for (const part of rest) {
    try {
      const doc = await uploadDocument(
        service,
        ownerId,
        companyId,
        { name: part.name, buffer: part.bytes, type: part.contentType },
        { upload_source: 'api', dedupeByContent: true },
      )
      if (recorded) await linkArrivalOutputs(service, recorded.arrival, [{ kind: 'document', id: doc.id, role: 'attachment' }])
    } catch (err) {
      log.warn('mailbox document part could not be archived', {
        companyId,
        provider: source,
        ref,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return 'filed'
}

export interface SyncResult {
  filed: number
  already: number
  noFile: number
  failed: number
  /** True when more documents wait than one run files. */
  more: boolean
}

/**
 * Read one connection's mailbox. A provider or storage failure on one
 * document is logged and counted, and the run goes on; a failure to list is
 * recorded on the connection (last_error) and thrown to the caller.
 */
export async function syncConnection(
  service: SupabaseClient,
  args: {
    connection: DigitalMailboxConnection
    receiver: MailboxReceiver
    actor: ArrivalActor
    log: Logger
    maxDocuments?: number
  },
): Promise<SyncResult> {
  const { connection, receiver, actor, log } = args
  const result: SyncResult = { filed: 0, already: 0, noFile: 0, failed: 0, more: false }
  const account = receiveAccountOf(connection)
  if (!account || connection.receive_state !== 'active') return result

  const ownerId = await resolveInboxOwner(service, connection)
  if (!ownerId) {
    await updateConnection(service, connection, connectionError('Företaget saknar ägare att lägga dokumenten hos.'))
    return result
  }

  let listed
  try {
    listed = await receiver.listDocuments(account, connection.receive_since ? new Date(connection.receive_since) : null)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await updateConnection(service, connection, connectionError(reason))
    throw err
  }

  // Oldest first, so an interrupted run leaves the newest for the next one
  // in the order they arrived.
  listed.sort((a, b) => (Date.parse(a.receivedAt ?? '') || 0) - (Date.parse(b.receivedAt ?? '') || 0))
  const max = args.maxDocuments ?? MAX_DOCUMENTS_PER_RUN
  let attempted = 0
  let lastError: string | null = null
  for (const item of listed) {
    if (await arrivalExists(service, connection.company_id, connection.provider, item.ref)) {
      result.already++
      continue
    }
    if (attempted >= max) {
      result.more = true
      break
    }
    attempted++
    try {
      const outcome = await deliverMailboxDocument(service, { connection, receiver, ref: item.ref, ownerId, actor, log })
      if (outcome === 'filed') result.filed++
      else if (outcome === 'no_file') result.noFile++
      else result.already++
    } catch (err) {
      if (err instanceof InboxUnavailableError) throw err
      result.failed++
      lastError = err instanceof Error ? err.message : String(err)
      log.warn('mailbox document could not be filed', {
        companyId: connection.company_id,
        provider: connection.provider,
        ref: item.ref,
        reason: lastError,
        providerKind: isDigitalMailboxApiError(err) ? err.kind : null,
      })
    }
  }

  await updateConnection(service, connection, {
    last_synced_at: new Date().toISOString(),
    ...(lastError ? connectionError(lastError) : { last_error: null, last_error_at: null }),
  })
  return result
}
