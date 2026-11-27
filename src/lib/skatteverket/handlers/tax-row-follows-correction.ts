/**
 * A tax account row follows the rättelse of the verifikat it names.
 *
 * A row booked from the skattekonto, or linked to a verifikat that settles
 * it, names that verifikat in skattekonto_transactions.journal_entry_id. A
 * rättelse (correctEntry) reverses the verifikat and posts the corrected one
 * in its place. Left behind, the row names the reversed original: the
 * skattekonto reconciliation reads it as a dead link, counts the row as
 * unlinked and the corrected verifikat's amount on the tax account as
 * unexplained, and linking the row again is refused until it is unlinked by
 * hand. The corrected verifikat books the row now, so the pointer moves to it.
 *
 * Only when the original was actually reversed: a storno moved out of a
 * locked year leaves the original posted, and what names it stays with it
 * (as correctEntry leaves the bank rows and the underlag there).
 *
 * The move is the pointer alone, as the module's own link and unlink write
 * it. If the rättelse changed what the verifikat carries on the tax account,
 * the reconciliation shows the difference as an amount on the verifikat that
 * no row explains, which is what it is.
 *
 * Never throws: the correction is posted, and a failure here must not reach
 * the other consumers of the event. It is logged.
 */
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { EventPayload } from '@/lib/events/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('skattekonto-row-follows-correction')

export async function moveTaxAccountRowsOnCorrection({
  original,
  corrected,
  companyId,
}: EventPayload<'journal_entry.corrected'>): Promise<void> {
  try {
    const supabase = createServiceClientNoCookies()

    const { data: entry, error: statusError } = await supabase
      .from('journal_entries')
      .select('status')
      .eq('id', original.id)
      .eq('company_id', companyId)
      .maybeSingle<{ status: string }>()
    if (statusError) {
      log.error('could not read the corrected verifikat', statusError, { originalEntryId: original.id })
      return
    }
    if (entry?.status !== 'reversed') return

    const { error: moveError } = await supabase
      .from('skattekonto_transactions')
      .update({ journal_entry_id: corrected.id })
      .eq('company_id', companyId)
      .eq('journal_entry_id', original.id)
    if (moveError) {
      log.error('could not move tax account rows to the corrected verifikat', moveError, {
        originalEntryId: original.id,
        correctedEntryId: corrected.id,
      })
    }
  } catch (err) {
    log.error('tax account rows did not follow the correction', err as Error, { originalEntryId: original.id })
  }
}
