import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * crm#1101, the three defects of the Bokför dialogs reached from
 * Transaktioner:
 *
 *  1. An attached file pushed Stäng and Bokför out of the review dialog,
 *     because header, body and buttons scrolled as one box.
 *  2. Its kontoväljare answered "Hittade inget konto" for a standard BAS
 *     account the company had not activated, where the other booking
 *     dialogs list it as activated at booking.
 *  3. A document attached in either dialog lived in the dialog's state until
 *     the booking linked it, so closing the dialog forgot it.
 *
 * The decisions run as code in underlag-controller.test.ts (what the row
 * holds, in every ordering of pins, removals and bookings),
 * booking-dialog-uploads.test.ts (overlapping uploads and removals),
 * review-underlag.test.ts and bas-catalog-client.test.ts. Vitest runs in
 * `node` and never renders components, so, like the sibling dialog tests,
 * the wiring of those decisions into the dialogs is pinned with file-level
 * assertions.
 */

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const REVIEW_SRC = read('../QuickReviewDialog.tsx')
const BOOKING_SRC = read('../TransactionBookingDialog.tsx')
const MATCH_SRC = read('../InvoiceMatchDialog.tsx')
// The match dialog's and the supplier payment dialog's Bokföring card.
const CARD_SRC = read('../../bookkeeping/PaymentPreviewLinesCard.tsx')
const SUPPLIER_PAY_SRC = read('../../supplier-invoices/SupplierPaymentDialog.tsx')
const PICKER_SRC = read('../TemplatePicker.tsx')
const HOOK_SRC = read('../use-transaction-underlag.ts')
const HELD_SRC = read('../use-held-underlag.ts')
const SCREEN_SRC = read('../../bookkeeping/BookingScreen.tsx')
const ZONE_SRC = read('../../bookkeeping/DocumentUploadZone.tsx')
const ATTACH_SRC = read('../TransactionAttachDocumentDialog.tsx')
const CATALOG_HOOK_SRC = read('../../../lib/hooks/use-bas-catalog.ts')
const PAGE_SRC = read('../../../app/(dashboard)/transactions/page.tsx')
const messages = (locale: 'sv' | 'en') =>
  JSON.parse(read(`../../../messages/${locale}.json`)) as Record<string, Record<string, string>>

describe('review dialog layout: the buttons stay in view', () => {
  it('only the body scrolls; the dialog itself no longer does', () => {
    // The height cap is DialogContent's own (100dvh less the 72px top and a
    // bottom margin); the review only turns its scroll off.
    expect(REVIEW_SRC).toContain('className="flex flex-col gap-0 overflow-hidden p-0"')
    expect(REVIEW_SRC).toContain('scrollbar-visible min-h-0 flex-1 overflow-y-auto')
    expect(REVIEW_SRC).not.toContain('max-h-[85vh] overflow-y-auto')
    expect(REVIEW_SRC).not.toContain('max-h-[90vh] overflow-y-auto')
  })

  it('Stäng and Bokför sit in a DialogFooter after the scrolling body has closed', () => {
    const bodyStart = REVIEW_SRC.indexOf('<div className="scrollbar-visible min-h-0 flex-1 overflow-y-auto')
    const footerStart = REVIEW_SRC.indexOf('<DialogFooter>')
    const footerEnd = REVIEW_SRC.indexOf('</DialogFooter>')
    expect(bodyStart).toBeGreaterThan(-1)
    expect(footerStart).toBeGreaterThan(bodyStart)
    // Between the body's opening tag and the footer, every div is closed
    // again except the footer's own wrapper: the footer is not in the body.
    const between = REVIEW_SRC.slice(bodyStart, footerStart)
    const opened = (between.match(/<div[\s>]/g) ?? []).length
    const closed = (between.match(/<\/div>/g) ?? []).length
    expect(opened - closed).toBe(1)
    const footer = REVIEW_SRC.slice(footerStart, footerEnd)
    expect(footer).toContain("{t('close')}")
    expect(footer).toContain('onClick={handleConfirm}')
  })

  it('the receipt column beside the review is sized from the body, so its file row is never under the footer', () => {
    expect(REVIEW_SRC).toContain('md:h-[min(36rem,calc(100dvh-17rem))]')
    expect(REVIEW_SRC).not.toContain('lg:h-[72vh]')
  })
})

describe('kontoväljare: inactive BAS accounts are listed', () => {
  it('one hook offers the catalogue once the chart is known, deactivated accounts only on request', () => {
    expect(CATALOG_HOOK_SRC).toContain('includeDeactivated ? bas : getSelectableCorrectionCatalog(chart, bas)')
    expect(CATALOG_HOOK_SRC).toContain('useAccounts(false)')
  })

  it('the review lists both kinds with the shared label and activates the pick before booking', () => {
    expect(REVIEW_SRC).toContain('const { catalog: basCatalog, chart: wholeChart } = useBasCatalog({ includeDeactivated: true })')
    expect(REVIEW_SRC).toContain('catalog={basCatalog}')
    expect(REVIEW_SRC).toContain("notActivatedLabel={tJournal('account_not_activated')}")
    // The categorize route refuses an override that is not active, so the
    // account must be active before the booking call.
    const activate = REVIEW_SRC.indexOf('activateBasAccounts([proposal.booking.account], wholeChart)')
    const booking = REVIEW_SRC.indexOf('await onConfirm(transaction.id, proposal')
    expect(activate).toBeGreaterThan(-1)
    expect(booking).toBeGreaterThan(activate)
  })

  it("the review activates only the account the person picked in its kontoväljare, never one a proposal brought", () => {
    // A deactivated account the assistant or the opening proposal books on
    // keeps the route's refusal and its "Aktivera och bokför".
    expect(REVIEW_SRC).toContain(
      "if (proposal.booking.kind === 'account' && proposal.booking.account === pickedToActivate && wholeChart) {",
    )
    // Set in one place only: the kontoväljare's onChange, for a catalogue
    // account the active chart lacks.
    expect(REVIEW_SRC.match(/setPickedToActivate\(/g) ?? []).toHaveLength(1)
    const onChange = REVIEW_SRC.slice(
      REVIEW_SRC.indexOf('const handleAccountChange = useCallback('),
      REVIEW_SRC.indexOf('const takeAssistantPick = useCallback('),
    )
    expect(onChange).toContain('setPickedToActivate(pickNeedsActivation(account, accounts, basCatalog) ? account : null)')
    expect(REVIEW_SRC).toContain('onChange={handleAccountChange}')
  })

  it('the payment Bokföring card lists the catalogue without deactivated accounts: its engine path never reactivates one', () => {
    // One card for the bank match and the supplier payment: both post the
    // edited rows through createJournalEntry, which seeds a standard account
    // the chart lacks but never a deliberately deactivated one.
    expect(CARD_SRC).toContain('const { catalog } = useBasCatalog()')
    expect(CARD_SRC).toContain('catalog={catalog}')
    expect(CARD_SRC).toContain("notActivatedLabel={tJournal('account_not_activated')}")
    expect(MATCH_SRC).toContain('<PaymentPreviewLinesCard')
    expect(SUPPLIER_PAY_SRC).toContain('<PaymentPreviewLinesCard')
  })

  it("the bank row's template picker finds catalogue accounts in its Konton search, marked the same way", () => {
    expect(PICKER_SRC).toMatch(/export function BankRowTemplatePicker\(props: TemplatePickerProps\) \{\s*const \{ catalog \} = useBasCatalog\(\)\s*return <TemplatePicker \{\.\.\.props\} accountCatalog=\{catalog\} \/>/)
    expect(PICKER_SRC).toContain('buildAccountIndex({ active: chartAccounts.filter((a) => a.is_active !== false), catalog: accountCatalog })')
    expect(PICKER_SRC).toContain("const note = account.isActive ? t('opens_editor_badge') : tJournal('account_not_activated')")
    // Only the transactions page opts in; the supplier invoice line picker
    // keeps the plain picker.
    expect(PAGE_SRC).toContain("import('@/components/transactions/TemplatePicker').then((m) => m.BankRowTemplatePicker)")
  })

  it('the label exists in both locales', () => {
    for (const locale of ['sv', 'en'] as const) {
      expect(messages(locale).journal_form.account_not_activated, locale).toBeTruthy()
    }
  })
})

describe('underlag survives closing a booking dialog', () => {
  it('the hook runs the shared controller over the attach route and its DELETE', () => {
    expect(HOOK_SRC).toContain('createUnderlagController({')
    expect(HOOK_SRC).toContain('pin: pinUnderlag,')
    expect(HOOK_SRC).toContain('unpin: unpinUnderlag,')
    // Writes asked for under an older render decide on the latest read.
    expect(HOOK_SRC).toMatch(/useEffect\(\(\) => \{\s*controller\.configure\(\{\s*read: \(\) => \(\{ transactionId, documentId: readId \}\),/)
    // A refused pin says why; offline or a server error promises the link at booking.
    expect(HOOK_SRC).toMatch(/pinRefused\(refusal\.status\)\s*\?\s*getErrorMessage\(refusal\.body/)
  })

  it('the x on the underlag the row had before is confirmed first, with the copy of the row\'s own "Ta bort underlag"', () => {
    expect(HOOK_SRC).toContain("title: tDetach('confirm_title')")
    expect(HOOK_SRC).toContain("description: tDetach('confirm_body', row)")
    expect(HOOK_SRC).toContain('outcome.released = await controller.release()')
    expect(HOOK_SRC).toContain("toast({ title: tDetach('toast_done') })")
  })

  for (const [name, src, hook] of [
    ['QuickReviewDialog', REVIEW_SRC, 'underlagState'],
  ] as const) {
    it(`${name} reads and writes the row's underlag through the shared hook`, () => {
      expect(src).toMatch(/useTransactionUnderlag\(\{\s*transactionId: transaction\?\.id \?\? null,\s*rowDocumentId: transaction\?\.document_id \?\? null,\s*open,\s*onChange: onUnderlagChange,\s*\}\)/)
    })

    it(`${name} offers every finished upload and every pick to the row`, () => {
      expect(src).toContain('onUploaded={claimUpload}')
      expect(src).toContain('onFilesChange={handleFilesChange}')
      expect(src).toContain('void claimUnderlag(doc.document_id, doc.supplier_name ?? doc.file_name)')
    })

    it(`${name} lets a removed document go through the controller, listed until the row has let it go`, () => {
      expect(src).toContain('const removed = removedUpload(uploadedFiles, update(uploadedFiles))')
      expect(src).toContain('void letGo(removed.id)')
      expect(src).toContain('if (!(await withdrawUnderlag(docId))) return')
      expect(src).toContain('onRemove={() => void letGo(doc.document_id)}')
    })

    it(`${name} applies every other change from the upload zone to its latest list`, () => {
      // The sequences themselves run in booking-dialog-uploads.test.ts.
      expect(src).toContain('function handleFilesChange(update: UploadedFilesUpdate) {')
      const handler = src.slice(src.indexOf('function handleFilesChange('), src.indexOf('function handleFilesChange(') + 400)
      expect(handler).toContain('setUploadedFiles(update)')
      expect(handler).not.toMatch(/setUploadedFiles\(next\)/)
    })

    it(`${name} confirms before taking off the underlag the row had before it opened`, () => {
      expect(src).toContain(`const released = await ${hook}.detachEarlier({`)
      expect(src).toContain('onRemove={() => void detachEarlierUnderlag()}')
      // Inside the dialog's content, so the confirm never dismisses it.
      const confirm = src.indexOf(`<DestructiveConfirmDialog {...${hook}.confirmProps} />`)
      expect(confirm).toBeGreaterThan(-1)
      expect(src.indexOf('</DialogContent>')).toBeGreaterThan(confirm)
    })

    it(`${name} links everything attached, the pinned document included, once nothing is on its way, minus what was let go`, () => {
      const settled = src.indexOf('await underlagSettled()')
      const targets = src.search(/underlagLinkTargets\(\{ files: uploadedFiles, inboxDocs: pickedInboxDocs \}, (?:transaction\.id|transactionId)\)\.filter\(/)
      expect(settled).toBeGreaterThan(-1)
      expect(targets).toBeGreaterThan(settled)
      expect(src).toContain(`(target) => !${hook}.isLetGo(target.documentId),`)
      expect(src).toMatch(/linkDocuments\(targets, journalEntryId\)/)
      // The old per-dialog link loops are gone.
      expect(src).not.toContain('`/api/documents/${file.id}/link`')
    })
  }

  // The manual booking dialog and the booking screen hold the row's underlag
  // through one hook (use-held-underlag.ts); the decisions above run there.
  it('useHeldUnderlag reads and writes the row\'s underlag through the shared hook', () => {
    expect(HELD_SRC).toContain('const underlag = useTransactionUnderlag(options)')
  })

  it('useHeldUnderlag offers every finished upload and every pick to the row', () => {
    expect(HELD_SRC).toContain('if (file.id) void claim(file.id, file.fileName)')
    expect(HELD_SRC).toContain('void claim(doc.document_id, doc.supplier_name ?? doc.file_name)')
  })

  it('useHeldUnderlag lets a removed document go through the controller, listed until the row has let it go', () => {
    expect(HELD_SRC).toContain('const gone = removedUpload(attached.files, update(attached.files))')
    expect(HELD_SRC).toContain('void letGo(gone.id)')
    expect(HELD_SRC).toContain('if (!(await withdraw(documentId))) return')
    expect(HELD_SRC).toContain('setAttached((current) => withoutDocument(current, documentId))')
  })

  it('useHeldUnderlag applies every other change from the upload zone to its latest list', () => {
    expect(HELD_SRC).toContain('setAttached((current) => ({ files: update(current.files), inboxDocs: current.inboxDocs }))')
  })

  it('useHeldUnderlag confirms before taking off the underlag the row had before', () => {
    expect(HELD_SRC).toContain('const released = await underlag.detachEarlier(row)')
  })

  it('useHeldUnderlag links everything attached, the pinned document included, once nothing is on its way, minus what was let go', () => {
    const settled = HELD_SRC.indexOf('const ownUnderlag = await settled()')
    const targets = HELD_SRC.indexOf('underlagLinkTargets(latest.current, transactionId).filter((target) => !isLetGo(target.documentId))')
    expect(settled).toBeGreaterThan(-1)
    expect(targets).toBeGreaterThan(settled)
    expect(HELD_SRC).toMatch(/linkDocuments\(targets, journalEntryId\)/)
  })

  for (const [name, src, open, txId] of [
    ['TransactionBookingDialog', BOOKING_SRC, 'open,\\s*onChange: onUnderlagChange,', 'transactionId'],
    ['BookingScreen', SCREEN_SRC, 'open: true,', 'transaction.id'],
  ] as const) {
    it(`${name} holds the row's underlag through useHeldUnderlag and wires every door to it`, () => {
      expect(src).toMatch(new RegExp(`useHeldUnderlag\\(\\{\\s*transactionId: transaction\\??\\.id(?: \\?\\? null)?,\\s*rowDocumentId: transaction\\??\\.document_id \\?\\? null,\\s*${open}\\s*\\}\\)`))
      expect(src).toContain('onUploaded={claimUpload}')
      expect(src).toContain('onSelect={attachments.pickInboxDoc}')
      expect(src).toContain('onRemove={() => void letGo(doc.document_id)}')
      expect(src).toContain('onRemove={() => void detachEarlierUnderlag()}')
      expect(src).toContain('<DestructiveConfirmDialog {...underlag.confirmProps} />')
      expect(src).toContain(`await attachments.link(journalEntryId, ${txId})`)
    })
  }

  it('both hosts hand every change from their upload zones to the hook', () => {
    expect(BOOKING_SRC).toContain('const handleFilesChange = attachments.onFilesChange')
    expect(BOOKING_SRC.match(/onFilesChange=\{handleFilesChange\}/g)?.length).toBe(2)
    expect(SCREEN_SRC.match(/onFilesChange=\{attachments\.onFilesChange\}/g)?.length).toBe(2)
  })

  it('TransactionBookingDialog keeps the confirm inside its content, so the confirm never dismisses it', () => {
    const confirm = BOOKING_SRC.indexOf('<DestructiveConfirmDialog {...underlag.confirmProps} />')
    expect(confirm).toBeGreaterThan(-1)
    expect(BOOKING_SRC.indexOf('</DialogContent>')).toBeGreaterThan(confirm)
  })

  it('the upload zone hands every host updates of its latest list, never a list built at the drop', () => {
    expect(ZONE_SRC).toContain('onFilesChange: (update: UploadedFilesUpdate) => void')
    expect(ZONE_SRC).toContain('onFilesChange(addUploads(validFiles))')
    expect(ZONE_SRC).toContain('onFilesChange(finishUpload(result))')
    expect(ZONE_SRC).toContain('onFilesChange(removeUpload(uploadKey))')
    expect(ZONE_SRC).not.toContain('currentFiles')
    // The attach dialog decides about its pick on the update, and the list
    // takes the update as it is.
    expect(ATTACH_SRC).toContain('if (update(uploadedFiles).length > 0) setPickedDoc(null)')
    expect(ATTACH_SRC).toContain('setUploadedFiles(update)')
  })

  it('the duplicate guard\'s match goes through the booked flow, so what was attached lands on the existing verifikat', () => {
    expect(BOOKING_SRC).toContain('onDuplicateMatched={(journalEntryId) => handleBooked(transaction.id, journalEntryId, true)}')
  })

  it('the review books only once nothing is on its way, and locks its underlag while it books', () => {
    const settled = REVIEW_SRC.indexOf('await underlagSettled()')
    const booking = REVIEW_SRC.indexOf('await onConfirm(transaction.id, proposal')
    expect(settled).toBeGreaterThan(-1)
    expect(booking).toBeGreaterThan(settled)
    const footer = REVIEW_SRC.slice(REVIEW_SRC.indexOf('<DialogFooter>'), REVIEW_SRC.indexOf('</DialogFooter>'))
    expect(footer).toMatch(/sekConversionMissing \|\|\s*uploadInFlight\(uploadedFiles\) \|\|\s*underlagState\.busy/)
    expect(REVIEW_SRC).toMatch(/onUploaded=\{claimUpload\}\s*compact\s*disabled=\{isProcessing\}/)
    // A disabled zone takes no removal either.
    expect(ZONE_SRC).toContain("disabled={disabled || file.status === 'uploading'}")
  })

  it('the page keeps its rows in step with both dialogs', () => {
    expect(PAGE_SRC).toContain('function handleUnderlagChanged(transactionId: string, documentId: string | null)')
    expect(PAGE_SRC.match(/onUnderlagChange=\{handleUnderlagChanged\}/g) ?? []).toHaveLength(2)
  })

  it('ships its sentences in both locales', () => {
    for (const locale of ['sv', 'en'] as const) {
      const copy = messages(locale).tx_booking_underlag
      expect(copy, locale).toBeTruthy()
      for (const key of ['file_fallback', 'pin_failed_title', 'pin_failed_description']) {
        expect(copy[key], `${locale}.${key}`).toBeTruthy()
      }
      const detach = messages(locale).tx_detach
      for (const key of ['menu_item', 'confirm_title', 'confirm_body', 'confirm_label', 'cancel_label', 'toast_done', 'toast_failed']) {
        expect(detach[key], `${locale}.tx_detach.${key}`).toBeTruthy()
      }
      // next-intl throws on an unsupplied placeholder.
      expect(detach.confirm_body).toContain('{description}')
      expect(detach.confirm_body).toContain('{amount}')
    }
  })
})
