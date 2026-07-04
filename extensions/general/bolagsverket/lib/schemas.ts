/**
 * Zod schemas for the Bolagsverket response payloads we actually dereference.
 * Parsed at the HTTP-client boundary (lib/client.ts) so a contract drift on
 * Bolagsverket's side surfaces as a clear "unexpected response shape from
 * <endpoint>" error instead of an opaque TypeError deep inside the
 * submission flow.
 *
 * Schemas are deliberately loose (`.passthrough()`): we only pin the fields
 * we read: see types.ts for the full hand-written DTOs.
 */

import { z } from 'zod'

// skapa-inlamningtoken (v2.1 + v1.1): token + avtalstext gate fields.
export const InlamningTokenSvarSchema = z
  .object({
    token: z.string().min(1),
    avtalstext: z.string(),
    avtalstextAndrad: z.string(),
  })
  .passthrough()

// kontrollera (v2.1): utfall drives the warn/error gate.
export const KontrolleraSvarSchema = z
  .object({
    orgnr: z.string().optional(),
    utfall: z
      .array(
        z
          .object({
            kod: z.string().optional(),
            text: z.string().optional(),
            typ: z.string().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough()

// inlamning (v2.1): handlingsinfo.idnummer correlates webhooks; sha256 and
// url are persisted on the submission row.
export const InlamningSvarSchema = z
  .object({
    handlingsinfo: z
      .object({
        idnummer: z.string().min(1),
        sha256checksumma: z.string(),
      })
      .passthrough(),
    url: z.string(),
  })
  .passthrough()

// skapa-kontrollsumma (v1.1).
export const KontrollsummaSvarSchema = z
  .object({
    kontrollsumma: z.string().min(1),
    algoritm: z.string(),
  })
  .passthrough()
