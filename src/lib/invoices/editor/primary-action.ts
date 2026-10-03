import type { InvoiceDocumentType } from '@/types'
import type { ChannelOption, EditorChannel, EmailBlockReason } from './channel'

/**
 * What the invoice editor's top-bar primary and its caret menu do, and what
 * they are called. The label follows the document type, the accounting
 * method and the channel, so it never promises a booking that will not
 * happen (kontantmetoden, deferred booking, a quote) or an email that will
 * not be sent.
 */

/** What a click on an editor action starts. */
export type EditorIntent =
  /** Persist the document, then send it on this channel (through the confirm dialog). */
  | { kind: 'send'; channel: EditorChannel }
  /** "Skapa utan att skicka": a numbered document, nothing sent (through the confirm dialog). */
  | { kind: 'create' }
  /** "Spara som utkast": an unnumbered draft, no dialog. */
  | { kind: 'save_draft' }
  /** Edit mode: PATCH the draft, no dialog. */
  | { kind: 'save_changes' }
  /** Mottagen självfaktura: registered and booked at once. */
  | { kind: 'register_self_billed' }

/** i18n keys (namespace invoice_editor_shell) of the action labels. */
export type EditorActionLabel =
  | 'action_send_and_book'
  | 'action_send'
  | 'action_send_quote'
  | 'action_mark_sent_book_download'
  | 'action_mark_sent_download'
  | 'action_send_peppol'
  | 'action_save_changes'
  | 'action_register_self_billed'
  | 'action_create_without_sending'
  | 'action_save_as_draft'
  | 'channel_email'
  | 'channel_manual'
  | 'channel_peppol'

export interface BookingContext {
  accountingMethod: 'accrual' | 'cash'
  /** company_settings.defer_invoice_booking (#967): issued without a voucher. */
  deferInvoiceBooking: boolean
}

/**
 * Whether sending this document books a verifikation now. Only a faktura
 * books at issue, and only under faktureringsmetoden without deferred
 * booking; proformas, quotes and delivery notes never do
 * (issue-and-book-invoice: isRealInvoice).
 */
export function booksOnIssue(documentType: InvoiceDocumentType, booking: BookingContext): boolean {
  return documentType === 'invoice' && booking.accountingMethod === 'accrual' && !booking.deferInvoiceBooking
}

export interface SendLabelContext {
  documentType: InvoiceDocumentType
  channel: EditorChannel
  booksOnIssue: boolean
}

/** The label of a send on this channel: the primary's face and the confirm button. */
export function resolveSendLabel(ctx: SendLabelContext): EditorActionLabel {
  const books = ctx.booksOnIssue && ctx.documentType === 'invoice'
  if (ctx.channel === 'peppol') return 'action_send_peppol'
  if (ctx.channel === 'email') {
    if (ctx.documentType === 'quote') return 'action_send_quote'
    return books ? 'action_send_and_book' : 'action_send'
  }
  return books ? 'action_mark_sent_book_download' : 'action_mark_sent_download'
}

export interface PrimaryContext extends SendLabelContext {
  /** 'copy' counts as create: the copy is a new document. */
  mode: 'create' | 'edit'
  isSelfBilled: boolean
}

export interface EditorAction {
  intent: EditorIntent
  label: EditorActionLabel
}

/**
 * The top-bar primary. Edit mode saves (sending a saved draft is in the caret
 * menu); a received självfaktura registers; everything else sends on the
 * effective channel.
 */
export function resolvePrimaryAction(ctx: PrimaryContext): EditorAction {
  if (ctx.isSelfBilled) return { intent: { kind: 'register_self_billed' }, label: 'action_register_self_billed' }
  if (ctx.mode === 'edit') return { intent: { kind: 'save_changes' }, label: 'action_save_changes' }
  return { intent: { kind: 'send', channel: ctx.channel }, label: resolveSendLabel(ctx) }
}

export interface MenuChannelEntry extends EditorAction {
  channel: EditorChannel
  /** The channel the primary currently uses (the menu's check mark). */
  selected: boolean
  available: boolean
  reason: EmailBlockReason | null
}

export interface EditorMenu {
  channels: MenuChannelEntry[]
  actions: EditorAction[]
}

export interface MenuContext extends PrimaryContext {
  channelOptions: ChannelOption[]
}

/**
 * The caret menu: the channels (picking one sends on it, through the
 * confirm dialog), then "Spara som utkast" (a new faktura only: quotes and
 * delivery notes are numbered at insert, so a "draft" of one would already
 * hold a number) and "Skapa utan att skicka" (create mode). A received
 * självfaktura has no menu.
 */
export function resolveEditorMenu(ctx: MenuContext): EditorMenu | null {
  if (ctx.isSelfBilled) return null
  const channelLabel: Record<EditorChannel, EditorActionLabel> = {
    email: 'channel_email',
    manual: 'channel_manual',
    peppol: 'channel_peppol',
  }
  const channels: MenuChannelEntry[] = ctx.channelOptions.map((option) => ({
    channel: option.channel,
    intent: { kind: 'send', channel: option.channel },
    label: channelLabel[option.channel],
    // In edit mode the primary saves, so no channel is "the primary's".
    selected: ctx.mode === 'create' && option.channel === ctx.channel,
    available: option.available,
    reason: option.reason,
  }))
  const actions: EditorAction[] = []
  if (ctx.mode === 'create') {
    if (ctx.documentType === 'invoice') {
      actions.push({ intent: { kind: 'save_draft' }, label: 'action_save_as_draft' })
    }
    actions.push({ intent: { kind: 'create' }, label: 'action_create_without_sending' })
  }
  return { channels, actions }
}
