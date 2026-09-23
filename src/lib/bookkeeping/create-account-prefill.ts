/**
 * Split the search string an account picker was showing when the user reached
 * for "Skapa konto" into AddAccountDialog's two prefill props.
 *
 * The combobox hands over whatever was typed, which is either a partial/full
 * account number ("8022") or a name fragment ("andelar i dotterföretag").
 * Feeding a name into initialAccountNumber would be silently dropped by the
 * dialog's digits-only filter, and feeding a number into initialAccountName
 * would put "8022" in the name field.
 */
export interface CreateAccountPrefill {
  initialAccountNumber?: string
  initialAccountName?: string
}

export function splitCreateAccountPrefill(prefill: string): CreateAccountPrefill {
  const trimmed = prefill.trim()
  if (!trimmed) return {}
  return /^\d{1,4}$/.test(trimmed)
    ? { initialAccountNumber: trimmed }
    : { initialAccountName: trimmed }
}
