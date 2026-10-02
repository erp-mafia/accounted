import { describe, expect, it } from 'vitest'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { peppolAfterIssueMessages } from '../peppol-send-service'

describe('peppolAfterIssueMessages', () => {
  it.each(['PEPPOL_SUBMISSION_REJECTED_AFTER_ISSUE', 'PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE'])(
    '%s without a verifikat or a reason is the registry text, which holds for every case',
    (code) => {
      const entry = getErrorEntry(code)!
      expect(peppolAfterIssueMessages(code, { invoice_status: 'sent', journal_entry_id: null, reason: null })).toEqual({
        messageSv: entry.message_sv,
        messageEn: entry.message_en,
      })
      // The composed sentence wins over the static one (thrown_message_sv).
      expect(entry.thrown_message_sv).toBe(true)
    },
  )

  it('says booked only when the invoice has its verifikat', () => {
    expect(peppolAfterIssueMessages('PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE', { journal_entry_id: 'je-1' })).toEqual({
      messageSv: 'Fakturan är utfärdad och bokförd, men kunde inte skickas via Peppol just nu. Försök igen om en stund, eller skicka PDF:en via e-post.',
      messageEn: 'The invoice is issued and booked, but could not be sent via Peppol right now. Try again shortly, or send the PDF by email.',
    })
  })

  it('carries the access point\'s reason on a refusal, as one clause', () => {
    const messages = peppolAfterIssueMessages('PEPPOL_SUBMISSION_REJECTED_AFTER_ISSUE', {
      journal_entry_id: 'je-1',
      reason: '  Duplicate Invoice,\n F-1 request rejected!  ',
    })
    expect(messages?.messageSv).toBe(
      'Fakturan är utfärdad och bokförd, men Peppol-operatören tog inte emot den: Duplicate Invoice, F-1 request rejected. Rätta och skicka igen, eller skicka PDF:en via e-post.',
    )
    expect(messages?.messageEn).toBe(
      'The invoice is issued and booked, but the Peppol access point did not accept it: Duplicate Invoice, F-1 request rejected. Correct it and send again, or send the PDF by email.',
    )
  })

  it('answers nothing for any other code', () => {
    expect(peppolAfterIssueMessages('PEPPOL_SUBMISSION_REJECTED', { journal_entry_id: 'je-1' })).toBeNull()
    expect(peppolAfterIssueMessages('PEPPOL_DUPLICATE_INVOICE_NUMBER', undefined)).toBeNull()
  })
})
