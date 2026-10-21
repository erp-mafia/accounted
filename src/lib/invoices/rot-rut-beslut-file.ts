import { z } from 'zod'

/**
 * Skatteverkets beslutsfil for rot/rut: the decision JSON the user downloads
 * from the e-tjänst once a begäran om utbetalning has been processed. It has
 * two readers: the import that records each beslut on the payout request
 * filed here (rot-rut-beslut-import, on the server), and the batch allocation
 * dialog, which picks the invoices one payout settled when the begäran were
 * filed in another system (beslutFileToPaste in invoice-number-paste, in the
 * browser, so the buyers' personnummer never leave the page).
 *
 * Its own module rather than lib/api/schemas, which re-exports the schema:
 * the dialog would otherwise ship every API schema to the browser.
 */
export const RotRutBeslutFileSchema = z.object({
  version: z.string(),
  // Utförarens orgnr, 12 digits with 16-prefix in SKV's file.
  utforare: z.string().regex(/^\d{10,12}$/),
  beslut: z
    .array(
      z.object({
        // NamnPaBegaran as submitted (1-16 chars); the primary match key
        // against rot_rut_payout_requests.name.
        namn: z.string().min(1),
        referensnummer: z.string().regex(/^\d{11}(-\d+)?$/),
        arenden: z
          .array(
            z.object({
              personnummer: z.string().regex(/^\d{12}$/),
              fakturanummer: z.string().max(20).optional(),
              // Whole kronor; 0 = avslag for the ärende.
              godkantBelopp: z.number().int().min(0),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})

export type RotRutBeslutFile = z.infer<typeof RotRutBeslutFileSchema>

/** The beslutsfil in a file's text, or null when the text is not one. */
export function readBeslutFile(text: string): RotRutBeslutFile | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = RotRutBeslutFileSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Normalize an org number to SKV's 12-digit form (16-prefixed). */
export function normalizeOrgNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 10 ? `16${digits}` : digits
}

/**
 * Whether a beslutsfil is this company's: its utförare is the company's org
 * number (company_settings.org_number). A company without one is refused, as
 * a file for another utförare must never record or pick anything here.
 */
export function beslutFileIsForCompany(file: Pick<RotRutBeslutFile, 'utforare'>, orgNumber: string | null): boolean {
  return !!orgNumber && normalizeOrgNumber(orgNumber) === normalizeOrgNumber(file.utforare)
}
