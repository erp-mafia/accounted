/**
 * What a failed BankID consent means to the person, in Swedish and English.
 *
 * The connector relays the provider's own code (failureCode, providerCode) and
 * never prose; these texts are the Swedish meanings Open Payments publishes
 * for its response messages (dev_docs/open-payments/error_messages.md), with
 * an English counterpart. The same table is published under the `bankFeed`
 * namespace of src/messages so the browser can localise a code itself
 * (failure-text.test.ts keeps the two in step).
 *
 * A code whose action is in the online bank (an agreement, a right, a
 * BankID setting, KYC) is permanent for the flow: trying again here cannot
 * help, so the step shows the text and no Försök igen.
 */

export interface FailureText {
  sv: string
  en: string
}

export const OPEN_BANKING_FAILURE_TEXTS: Readonly<Record<string, FailureText>> = {
  ACCESS_EXCEEDED: {
    sv: 'Åtkomsten till kontot har överskridit det tillåtna antalet per dag.',
    en: 'The account has been read more times today than the consent allows.',
  },
  ACCESS_EXPIRED: {
    sv: 'Åtkomsten till banken har gått ut. Koppla banken igen med BankID.',
    en: 'Access to the bank has expired. Connect the bank again with BankID.',
  },
  AUTHENTICATION_FAILED: {
    sv: 'Autentiseringen misslyckades. Försök igen.',
    en: 'Authentication failed. Try again.',
  },
  AUTHENTICATION_SESSION_EXPIRED: {
    sv: 'Autentiseringssessionen gick ut. Starta om och slutför BankID inom 30 sekunder.',
    en: 'The authentication session expired. Start again and finish BankID within 30 seconds.',
  },
  AUTHENTICATION_SESSION_ONGOING: {
    sv: 'En annan inloggningssession pågår redan. Vänta några minuter och försök igen.',
    en: 'Another login session is already in progress. Wait a few minutes and try again.',
  },
  AUTHENTICATION_SESSION_PSU_CANCELLED: {
    sv: 'Användaren avbröt autentiseringen.',
    en: 'The user cancelled the authentication.',
  },
  AUTHENTICATION_STATUS_FAILED: {
    sv: 'Misslyckades med att få autentiseringsstatus. Försök igen.',
    en: 'The authentication status could not be read. Try again.',
  },
  BANK_AGREEMENT_MISSING: {
    sv: 'Avtal med internetbanken saknas. Logga in i internetbanken och kontrollera kontoinställningarna.',
    en: 'The online bank agreement is missing. Log in to the online bank and check the account settings.',
  },
  BANK_INVALID_RESPONSE: {
    sv: 'Banken returnerade ett oväntat svar och begäran kunde inte slutföras.',
    en: 'The bank returned an unexpected response and the request could not be completed.',
  },
  BANK_REQUEST_LIMIT_EXCEEDED: {
    sv: 'För många förfrågningar till banken. Försök igen om en stund.',
    en: 'Too many requests to the bank. Try again in a moment.',
  },
  BANK_SERVICE_UNAVAILABLE: {
    sv: 'Problem med bankens API-tjänst. Försök igen om en stund.',
    en: 'The bank\'s API service has problems. Try again in a moment.',
  },
  BANKID_EXTENDED_USE_REQUIRED: {
    sv: 'Aktivera Mobilt BankID för utökad användning i internetbanken och försök igen.',
    en: 'Activate Mobile BankID for extended use in the online bank and try again.',
  },
  BANKID_NOT_ACTIVATED: {
    sv: 'BankID är inte aktiverat för banken. Logga in i internetbanken med Mobilt BankID först.',
    en: 'BankID is not activated for the bank. Log in to the online bank with Mobile BankID first.',
  },
  CONSENT_EXPIRED: {
    sv: 'Medgivandet har gått ut. Koppla banken igen med BankID.',
    en: 'The consent has expired. Connect the bank again with BankID.',
  },
  CONSENT_INVALID: {
    sv: 'Inget giltigt medgivande hittades. Koppla banken igen med BankID.',
    en: 'No valid consent was found. Connect the bank again with BankID.',
  },
  CONSENT_REVOKED: {
    sv: 'Medgivandet återkallades av användaren. Koppla banken igen med BankID.',
    en: 'The consent was revoked by the user. Connect the bank again with BankID.',
  },
  INTERNAL_SERVER_ERROR: {
    sv: 'Problem med API-tjänsten. Försök igen om en stund.',
    en: 'The API service has problems. Try again in a moment.',
  },
  KYC_INVALID: {
    sv: 'Banken behöver uppdaterad kundkännedom. Fyll i den i internetbanken och försök igen.',
    en: 'The bank needs updated customer due diligence. Complete it in the online bank and try again.',
  },
  PSU_ACCOUNT_MISSING: {
    sv: 'Användaren har inget konto i den valda banken. Välj rätt bankkontor och kontrollera att kontot är aktivt.',
    en: 'The user has no account at the chosen bank. Pick the right bank office and check that the account is active.',
  },
  PSU_ACCOUNT_MULTIPLE_AFFILIATED_BANKS: {
    sv: 'Användaren har konton i flera anslutna banker. Välj vilken sparbank kopplingen gäller.',
    en: 'The user has accounts at several affiliated banks. Pick which savings bank the connection is for.',
  },
  // Connect's code for a bank's refusal that names the PSU-Authoriser-ID header
  // (the provider documents none): fixed here by filling in the field, so
  // not permanent.
  PSU_AUTHORISER_ID_MISSING: {
    sv: 'Nordea Corporate Netbank behöver ert inloggnings-ID. Fyll i det och försök igen.',
    en: 'Nordea Corporate Netbank needs your logon ID. Fill it in and try again.',
  },
  PSU_CREDENTIALS_INVALID: {
    sv: 'Det valda avtalet överensstämmer inte med företagets organisationsnummer. Kontrollera uppgifterna.',
    en: 'The selected agreement does not match the company\'s organisation number. Check the details.',
  },
  PSU_OPEN_BANKING_RIGHTS_MISSING: {
    sv: 'Behörighet saknas för att utföra förfrågningar i Open Banking. Lägg till tredjepartstjänster (API/Open Banking) i internetbanken.',
    en: 'Not authorised to perform Open Banking requests. Add third-party services (API/Open Banking) in the online bank.',
  },
  PSU_RIGHTS_MISSING: {
    sv: 'Misslyckades på grund av ogiltig eller saknad användar- eller åtkomsträttighet. Ändra användarens rättigheter i internetbanken.',
    en: 'Failed because of an invalid or missing user or access right. Change the user\'s rights in the online bank.',
  },
  RESOURCE_UNKNOWN: {
    sv: 'Resursen hittades inte. Den är felaktig, borttagen eller har gått ut.',
    en: 'The resource was not found. It is incorrect, removed or expired.',
  },
  SCA_REDIRECT_UNSUPPORTED: {
    sv: 'Banken vill att du signerar på sin egen sida. Starta om och välj att signera på bankens sida.',
    en: 'The bank wants you to sign on its own page. Start again and choose to sign on the bank\'s page.',
  },
  SIGNING_SESSION_EXPIRED: {
    sv: 'Signeringssessionen gick ut. Starta om och signera inom 30 sekunder.',
    en: 'The signing session expired. Start again and sign within 30 seconds.',
  },
  SIGNING_SESSION_PSU_CANCELLED: {
    sv: 'Användaren avbröt signeringen.',
    en: 'The user cancelled the signing.',
  },
  SIGNING_UNSUCCESSFUL: {
    sv: 'Signeringen misslyckades. Försök igen.',
    en: 'The signing was unsuccessful. Try again.',
  },
  STRONGER_AUTHENTICATION_NEEDED: {
    sv: 'Starkare autentisering krävs.',
    en: 'Stronger authentication is needed.',
  },
  UNEXPECTED_ERROR: {
    sv: 'Okänt felmeddelande från banken. Försök igen.',
    en: 'Unknown error message from the bank. Try again.',
  },
}

/**
 * Codes the person resolves in the online bank, not by trying again here
 * (the provider's Action column: "Login to online bank and check bank
 * account settings", "Add third party services (API/Open Banking) in online
 * bank", "Edit user rights in online bank", "Complete KYC in online
 * banking", "activate Mobile BankID for extended use", "Check end user
 * credentials", "Select relevant bank office").
 */
export const OPEN_BANKING_PERMANENT_FAILURES: ReadonlySet<string> = new Set([
  'BANK_AGREEMENT_MISSING',
  'BANKID_EXTENDED_USE_REQUIRED',
  'BANKID_NOT_ACTIVATED',
  'KYC_INVALID',
  'PSU_ACCOUNT_MISSING',
  'PSU_CREDENTIALS_INVALID',
  'PSU_OPEN_BANKING_RIGHTS_MISSING',
  'PSU_RIGHTS_MISSING',
])

/** Whether a provider failure code is one the person must act on in the online bank: no automatic retry offer. */
export function isPermanentConsentFailure(code: string | null | undefined): boolean {
  return Boolean(code) && OPEN_BANKING_PERMANENT_FAILURES.has(code!.trim().toUpperCase())
}

/** The provider's catch-all: a code with a sentence that names no cause ("Okänt felmeddelande från banken"). */
const OPEN_BANKING_CATCH_ALL = 'UNEXPECTED_ERROR'

/**
 * Whether a refusal's provider code tells the person something to act on: a
 * code with a sentence of its own here, the catch-all left out. A refusal
 * without one ends in the generic line, so a flow that can still do
 * something itself does that first (a restart creates the consent anew,
 * service.ts restartBankFeedConsent).
 */
export function refusalNamesReason(code: string | null | undefined): boolean {
  const key = code?.trim().toUpperCase()
  if (!key || key === OPEN_BANKING_CATCH_ALL) return false
  return OPEN_BANKING_FAILURE_TEXTS[key] !== undefined
}

export const OPEN_BANKING_GENERIC_FAILURE: FailureText = {
  sv: 'BankID-signeringen kunde inte slutföras. Försök igen.',
  en: 'The BankID signing could not be completed. Try again.',
}

/** The person's sentence for a provider failure code; the generic one when the code is unknown or absent. */
export function consentFailureText(code: string | null | undefined): FailureText {
  if (!code) return OPEN_BANKING_GENERIC_FAILURE
  return OPEN_BANKING_FAILURE_TEXTS[code.trim().toUpperCase()] ?? OPEN_BANKING_GENERIC_FAILURE
}
