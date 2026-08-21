/**
 * Core <-> Skatteverket-extension read boundary for filed VAT declarations.
 *
 * `lib/` and `app/api/v1/` cannot import from `@/extensions/` (CI guard,
 * core-build.yml), so the v1 REST read endpoint reaches the Skatteverket
 * extension only through the registry-resolved `services` channel: same
 * pattern as lib/pending-operations/skatteverket-commit.ts. This module
 * defines the SHARED shapes so the extension (which may import core freely)
 * and the v1 route agree on the contract without core ever importing the
 * extension.
 */

import type { VatPeriodType } from '@/types'

/** Which Skatteverket view(s) to fetch. */
export type SkvVatDeclarationState = 'submitted' | 'decided' | 'both'

export interface SkvVatDeclarationStatusInput {
  periodType: VatPeriodType
  year: number
  /** 1-12 for monthly, 1-4 for quarterly, 1 for yearly. */
  period: number
  /** Defaults to 'both'. */
  state?: SkvVatDeclarationState
}

/** Result returned by the extension's fetchVatDeclarationStatus. */
export type SkvVatDeclarationStatusResult =
  | {
      ok: true
      /** 12-digit Skatteverket redovisare identifier for the company. */
      redovisare: string
      /** Skatteverket period identifier (YYYYMM: the period's last month). */
      redovisningsperiod: string
      /**
       * Skatteverket's /inlamnat body (the declaration as filed), or null when
       * nothing has been submitted for the period or state='decided'.
       */
      submitted: unknown
      /**
       * Skatteverket's /beslutat body (the beslut), or null when Skatteverket
       * has not decided the period yet or state='submitted'.
       */
      decided: unknown
    }
  | {
      ok: false
      /** Structured error code (see lib/errors/structured-errors.ts). */
      code: string
      http_status: number
      error: string
    }

/** Read services a fully-wired skatteverket extension exposes on `services`. */
export interface SkatteverketReadServices {
  fetchVatDeclarationStatus: (
    supabase: unknown,
    userId: string,
    companyId: string,
    input: SkvVatDeclarationStatusInput,
  ) => Promise<SkvVatDeclarationStatusResult>
}
