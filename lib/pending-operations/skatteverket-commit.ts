/**
 * Core ↔ Skatteverket-extension commit boundary.
 *
 * `lib/` cannot import from `@/extensions/` (CI guard, core-build.yml), so the
 * commit-side executors reach the Skatteverket extension only through the
 * registry-resolved `services` channel. This module defines the SHARED shape
 * the extension's commit services return and the recoverable-error class the
 * dispatcher uses to release an op back to `pending`: both live in core so the
 * extension (which may import core freely) and `commit.ts` agree on the
 * contract without core ever importing the extension.
 */

/** Result returned by the extension's commitSubmitVatDeclaration / commitSubmitAgi. */
export type SkvSubmitResult =
  | ({
      ok: true
      /** BankID signing deep-link. The op is "sent for signing", not filed. */
      signing_url: string
    } & Record<string, unknown>)
  | {
      ok: false
      /** Structured error code (see lib/errors/structured-errors.ts). */
      code: string
      http_status: number
      /**
       * true  → the op is fine; the connection/flag/quota isn't. Release it back
       *         to `pending` so the user can fix and re-approve the SAME op.
       * false → a wrong-data / SKV-business condition. Reject (consume) the op;
       *         the user must regenerate and re-stage.
       */
      recoverable: boolean
      error: string
    }

/** The two functions a fully-wired skatteverket extension exposes on `services`. */
export interface SkatteverketCommitServices {
  commitSubmitVatDeclaration: (
    supabase: unknown,
    userId: string,
    companyId: string,
    params: Record<string, unknown>,
  ) => Promise<SkvSubmitResult>
  commitSubmitAgi: (
    supabase: unknown,
    userId: string,
    companyId: string,
    params: Record<string, unknown>,
  ) => Promise<SkvSubmitResult>
}

/**
 * Thrown by a commit executor when the failure is recoverable (extension
 * disabled, no SKV connection, rate-limited). The dispatcher catches it,
 * releases the atomic claim back to `pending`, and surfaces { error, code,
 * http_status }: mirroring the AccountsNotInChartError release path.
 */
export class SkatteverketRecoverableError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'SkatteverketRecoverableError'
  }
}
