import type { Extension } from '@/lib/extensions/types'
import type { EventPayload } from '@/lib/events/types'

/**
 * Example Logger Extension
 *
 * Minimal reference implementation that logs events to the console.
 * Not wired into the loader by default: add to FIRST_PARTY_EXTENSIONS
 * in lib/extensions/loader.ts to activate.
 */
export const exampleLoggerExtension: Extension = {
  id: 'example-logger',
  name: 'Example Logger',
  version: '0.1.0',

  eventHandlers: [
    {
      eventType: 'journal_entry.committed',
      handler: async (payload: EventPayload<'journal_entry.committed'>) => {
        console.log(
          `[example-logger] Journal entry committed: ${payload.entry.voucher_series}${payload.entry.voucher_number}: ${payload.entry.description}`
        )
      },
    },
    {
      eventType: 'document.uploaded',
      handler: async (payload: EventPayload<'document.uploaded'>) => {
        console.log(
          `[example-logger] Document uploaded: ${payload.document.file_name} (${payload.document.sha256_hash.slice(0, 12)}…)`
        )
      },
    },
  ],
}
