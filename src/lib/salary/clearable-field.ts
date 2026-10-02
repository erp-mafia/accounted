/**
 * The PATCH value an employee edit form sends for an optional field it loaded
 * from the stored row (#3008).
 *
 * The update contract on every employee door: a value sets the column, null
 * clears it, an absent key leaves it unchanged. The edit form used to send
 * `value || undefined`, so an emptied slutdatum (or email, bank account, ...)
 * dropped out of the JSON body and the stored value came back after save.
 *
 *   - input has text                   -> the text, as typed
 *   - input empty, the row had a value -> null: the user emptied it, clear it
 *   - input empty, the row had none    -> undefined: nothing to clear, omit
 *   - no input at all (FormData.get returned null: the field was not
 *     rendered or was disabled)        -> undefined: never clear what the
 *                                          user could not see or edit
 *
 * Only for inputs that are seeded from the row: a field the form never
 * loaded must stay absent from the patch, or an unrelated save would wipe it.
 */
export function clearableField(input: unknown, loaded: string | null | undefined): string | null | undefined {
  if (typeof input !== 'string') return undefined
  if (input.trim() !== '') return input
  return loaded != null && loaded !== '' ? null : undefined
}
