/**
 * The codes Bankgirot's Autogiro reports carry, in the new file layout, with
 * the manual's own wording. Source: Bankgirot, "Bg Autogiro Teknisk manual"
 * (november 2021): 8.2.3 (betalningsstatuskoder, återbetalningskoder), 8.3.3
 * (informationskoder and kommentarskoder in TK73) and 8.4.3 (kommentarskoder
 * for rejected payments). Codes the manual lists as withdrawn are left out;
 * a report carrying one shows the bare code.
 */

/** TK82/TK32 position 80 in Betalningsspecifikation. 1, 2 and 9 appear only when stopped payments are reported on file. */
export const PAYMENT_STATUS_CODES = {
  '0': 'Godkänd betalning, betalningen är genomförd.',
  '1': 'Täckning saknas, betalningen har inte genomförts.',
  '2': 'Koppling till Autogiro saknas (bankkontot avslutat) eller betalarens bank har inte godkänt uttaget. Betalningen har inte genomförts.',
  '9': 'Förnyad täckning, betalningen har inte genomförts men nytt försök ska göras om avtal finns.',
} as const

/** TK77 positions 78-79: why the payer got the money back. */
export const REFUND_REASON_CODES = {
  '01': 'Medgivande har inte lämnats till betalningsmottagaren.',
  '02': 'Medgivande har återkallats.',
  '03': 'Beloppet angavs inte när medgivandet tecknades och överstiger vad betalaren rimligen kunde ha förväntat sig.',
} as const

/** TK73 positions 62-63: what the mandate record is about. */
export const MANDATE_INFORMATION_CODES = {
  '03': 'Makulering, initierad av betalningsmottagaren.',
  '04': 'Nyupplägg, initierat av betalningsmottagaren.',
  '05': 'Byte av betalarnummer, initierat av betalningsmottagaren.',
  '10': 'Makulerat eftersom betalningsmottagarens bankgironummer är avslutat.',
  '42': 'Svar på kontoförfrågan från bank på ny betalare i Autogiro.',
  '43': 'Makulerat eller borttaget på grund av obesvarad kontoförfrågan.',
  '44': 'Makulerat eftersom betalarens bankgironummer är avslutat.',
  '46': 'Makulering, initierad av betalaren eller betalarens bank.',
} as const

/** TK73 positions 64-65: the outcome or reason for the information code. */
export const MANDATE_COMMENT_CODES = {
  '02': 'Medgivandet är makulerat på initiativ av betalaren eller betalarens bank.',
  '03': 'Kontoslaget är inte godkänt för Autogiro.',
  '04': 'Medgivandet saknas i Bankgirots medgivanderegister.',
  '05': 'Felaktiga bankkonto- eller personuppgifter.',
  '07': 'Makulerat eller borttaget på grund av obesvarad kontoförfrågan.',
  '09': 'Betalarens bankgironummer saknas hos Bankgirot.',
  '10': 'Medgivandet finns redan upplagt i Bankgirots register eller är under förfrågan.',
  '20': 'Felaktigt person- eller organisationsnummer, eller avtal om medgivande med bankgironummer saknas.',
  '21': 'Felaktigt betalarnummer.',
  '23': 'Felaktigt bankkontonummer.',
  '29': 'Mottagarens bankgironummer är felaktigt.',
  '30': 'Mottagarens bankgironummer är avregistrerat.',
  '32': 'Nytt medgivande.',
  '33': 'Makulerad.',
  '98': 'Medgivandet är makulerat eftersom betalarens bankgironummer är makulerat.',
} as const

/** TK82/TK32 positions 59-60 in Avvisade betalningar: why Bankgirot rejected the payment. */
export const REJECTION_COMMENT_CODES = {
  '01': 'Utgår, medgivande saknas.',
  '02': 'Utgår, kontot är inte godkänt eller är avslutat.',
  '04': 'Felaktigt betalarnummer.',
  '06': 'Felaktig periodkod.',
  '07': 'Felaktigt antal för självförnyande uppdrag.',
  '08': 'Belopp inte numeriskt.',
  '09': 'Förbud mot utbetalningar.',
  '10': 'Bankgironumret saknas hos Bankgirot.',
  '12': 'Felaktigt betalningsdatum.',
  '13': 'Passerat betalningsdatum.',
  '15': 'Mottagarens bankgironummer i öppningsposten och i transaktionsposten är inte detsamma.',
  '24': 'Beloppet överstiger maxbeloppet.',
} as const

/** The manual's description of a code, or null when the table does not know it. */
export function describeCode(table: Readonly<Record<string, string>>, code: string): string | null {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code]! : null
}
