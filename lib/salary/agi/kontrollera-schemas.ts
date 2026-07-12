import { z } from 'zod'

/**
 * Zod schemas for Skatteverket AGI pre-flight kontrollera endpoints.
 * Matches the v1.7 §7 (HU) and §8 (IU) JSON spec exactly, with strict()
 * to reject unknown properties: without this guard, a caller could inject
 * fields like agRegistreradId or personnummer overrides into the payload
 * we forward verbatim to SKV.
 *
 * Conventions used by Skatteverket:
 *   - IDENTITET: 12 digits (orgnr prefixed "16" + 10 digits, or personnummer YYYYMMDDXXXX)
 *   - redovisningsPeriod: YYYYMM
 *   - amount fields: integer SEK (no decimals)
 *   - boolean kryss fields: true/false (JSON): SKV converts to <FK>1</FK> in XML
 */

// 12-digit IDENTITET pattern. Slightly looser than the XSD regex used in
// xml-generator.ts (we don't re-validate samordningsnummer arithmetic here)
// because SKV will reject malformed values on its end with a clearer
// felmeddelande than we can surface: what matters here is that we don't
// forward an obviously bogus or oversized string.
const IDENTITET = z
  .string()
  .regex(/^\d{12}$/, 'Förväntat 12-siffrigt IDENTITET (orgnr eller personnummer).')

const REDOVISNINGSPERIOD = z
  .string()
  .regex(/^\d{6}$/, 'Förväntat YYYYMM.')
  // First period the API accepts; same constraint as xml-generator.
  .refine((s) => Number.parseInt(s, 10) >= 201807, {
    message: 'Redovisningsperioden är tidigare än 201807 (AGI API minimum).',
  })

// SEK amount as non-negative integer with a sanity cap matching SKV's
// internal BELOPP10 (10-digit) ceiling. Bigger values are rejected locally
// rather than forwarded.
const AMOUNT = z.number().int().nonnegative().max(9_999_999_999)

const SPEC_NUMBER = z.number().int().min(1).max(999_999_999)

export const AGIKontrolleraHUSchema = z
  .object({
    agRegistreradId: IDENTITET,
    redovisningsPeriod: REDOVISNINGSPERIOD,
    summaSkatteavdr: AMOUNT.optional(),
    summaArbAvgSlf: AMOUNT.optional(),
    totalSjuklonekostnad: AMOUNT.optional(),
  })
  .strict()

export type AGIKontrolleraHU = z.infer<typeof AGIKontrolleraHUSchema>

export const AGIKontrolleraIUSchema = z
  .object({
    agRegistreradId: IDENTITET,
    redovisningsPeriod: REDOVISNINGSPERIOD,
    betalningsmottagarId: IDENTITET,
    specifikationsnummer: SPEC_NUMBER,

    // Cash + tax: FK011 / FK001
    kontantErsattningUlagAG: AMOUNT.optional(),
    avdrPrelSkatt: AMOUNT.optional(),

    // Benefit amounts (UlagAG variants)
    skatteplBilformanUlagAG: AMOUNT.optional(),       // FK013
    drivmVidBilformanUlagAG: AMOUNT.optional(),       // FK018
    kostformanUlagAG: AMOUNT.optional(),              // FK015
    skatteplOvrigaFormanerUlagAG: AMOUNT.optional(),  // FK012

    // Housing benefit KRYSS flags
    bostadsformanSmahusUlagAG: z.boolean().optional(),    // FK041
    bostadsformanEjSmahusUlagAG: z.boolean().optional(),  // FK043

    // F-skatt / ej UlagSA variants
    kontantErsattningEjUlagSA: AMOUNT.optional(),         // FK131
    skatteplBilformanEjUlagSA: AMOUNT.optional(),         // FK133
    drivmVidBilformanEjUlagSA: AMOUNT.optional(),         // FK134
    kostformanEjUlagSA: AMOUNT.optional(),                // FK139
    skatteplOvrigaFormanerEjUlagSA: AMOUNT.optional(),    // FK132
    bostadsformanSmahusEjUlagSA: z.boolean().optional(),  // FK137
    bostadsformanEjSmahusEjUlagSA: z.boolean().optional(),// FK138

    // Flags
    formanHarJusterats: z.boolean().optional(),  // FK048
    forstaAnstalld: z.boolean().optional(),      // FK062
    vaxaStod: z.boolean().optional(),            // FK063
    borttag: z.boolean().optional(),             // FK205
  })
  .strict()
  .refine(
    (iu) => !(iu.forstaAnstalld === true && iu.vaxaStod === true),
    {
      message: 'FK062 (ForstaAnstalld) och FK063 (VaxaStod) är ömsesidigt uteslutande.',
      path: ['vaxaStod'],
    },
  )

export type AGIKontrolleraIU = z.infer<typeof AGIKontrolleraIUSchema>

/**
 * Hard cap on the raw JSON body for kontrollera endpoints. Even a fully
 * legal IU is < 4 KB serialised; 64 KB is a generous safety margin that
 * still trivially rejects pathological inputs before they reach Zod.
 */
export const AGI_KONTROLLERA_MAX_BYTES = 64 * 1024
