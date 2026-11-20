/**
 * What the nightly sandbox cleanup makes of one user whose teardown the RPC
 * reports as failed (cleanup_expired_sandbox_users, migration
 * 20261109185036: user_id, kind, sqlstate, message, table, constraint,
 * context).
 *
 * cleanup_sandbox_user refuses, by design, a sandbox user who has anything
 * outside the sandbox set: a membership in a real company, a company they
 * created, vouchers or documents they authored there. Such a user became a
 * customer and must never be torn down, so the refusal is the right outcome
 * every night for as long as the account lives: it is counted as kept, not
 * as a failure. Everything else (a new RESTRICT foreign key, a timeout) is a
 * teardown gap of ours and stays a failure.
 */
export interface SandboxCleanupFailure {
  user_id?: string
  kind?: string
  sqlstate?: string
  message?: string
  table?: string
  constraint?: string
  context?: string
}

/** RAISE EXCEPTION without an errcode: the guards of cleanup_sandbox_user. */
const RAISED_BY_GUARD = 'P0001'

/** The guard's own sentence (migration 20261023003000), whatever the user id in it. */
const HAS_REAL_COMPANY_DATA = /has data in a company that is not a sandbox/

/**
 * 'kept': the user has data in a real company and is left alone on purpose.
 * 'failed': the teardown should have worked and did not.
 */
export function sandboxTeardownOutcome(failure: SandboxCleanupFailure): 'kept' | 'failed' {
  return failure.kind === 'sandbox' &&
    failure.sqlstate === RAISED_BY_GUARD &&
    typeof failure.message === 'string' &&
    HAS_REAL_COMPANY_DATA.test(failure.message)
    ? 'kept'
    : 'failed'
}
