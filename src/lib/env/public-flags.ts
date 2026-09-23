/**
 * Runtime reads of `NEXT_PUBLIC_*` boolean flags.
 *
 * The Docker image is generic: it is built once with sentinel values
 * (`ENV NEXT_PUBLIC_SELF_HOSTED=__NEXT_PUBLIC_SELF_HOSTED__` in the Dockerfile)
 * and `docker-entrypoint.sh` seds the operator's real values into `.next` at
 * container start. That contract has one requirement nobody wrote down: the
 * sentinel must still BE in the build output for sed to find.
 *
 * Writing `process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'` breaks it. The
 * bundler inlines the sentinel, leaving `"__NEXT_PUBLIC_SELF_HOSTED__" ===
 * 'true'`, which the minifier constant-folds to `false` and then
 * dead-code-eliminates. Variable name and sentinel both disappear, sed has
 * nothing to replace, and the flag is permanently false no matter what the
 * operator configures.
 *
 * That shipped: every Docker self-host ran with the entitlement paywall live,
 * so `ai`, `bank_sync`, `skatteverket` and `email_send` went dark 30 days after
 * company creation (diagnosed 2026-08-17 against a running NAS instance, where
 * the compiled gate read `function r(){return"true"!==process.env.FORCE_PAYWALL
 * &&"true"===process.env.DISABLE_PAYWALL}` with the self-hosted branch gone).
 * The un-prefixed `FORCE_PAYWALL`/`DISABLE_PAYWALL` survived precisely because
 * they are never inlined.
 *
 * The fix is to keep the sentinel out of a foldable comparison. Reading it as a
 * VALUE (a function argument) preserves the string literal in the bundle; the
 * comparison then happens at runtime, after sed has done its work. The Set
 * lookup is the belt to that suspenders: a minifier can fold `x === 'true'`,
 * but not `SET.has(x)`.
 *
 * Use `flagEnabled(process.env.NEXT_PUBLIC_WHATEVER)` for any public boolean
 * flag. `scripts/checks/no-new-antipatterns.mjs` (folded-public-flag) fails the
 * build on a direct comparison so this cannot regress silently again.
 */

/**
 * Values that mean "on". Deliberately a Set: `x === 'true'` is foldable when
 * `x` is a build-time constant, `TRUTHY_VALUES.has(x)` is not.
 */
const TRUTHY_VALUES = new Set(['true'])

/**
 * Whether a `NEXT_PUBLIC_*` flag is switched on.
 *
 * Pass the env read as an argument, never compare it in place:
 *
 *     flagEnabled(process.env.NEXT_PUBLIC_BANKID_ENABLED)   // correct
 *     process.env.NEXT_PUBLIC_BANKID_ENABLED === 'true'     // folded away in Docker
 */
export function flagEnabled(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_VALUES.has(value)
}

/**
 * Whether this is a self-hosted deployment (Docker), as opposed to the hosted
 * product. Self-hosted disables forced MFA, session timeouts, analytics and the
 * entitlement paywall, and lifts the hosted upload ceiling.
 *
 * Named accessor rather than a bare `flagEnabled` call because five modules ask
 * this same question and the answer decides legal-ish behaviour (what an AGPL
 * operator's own instance is allowed to do without paying us).
 */
export function isSelfHosted(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_SELF_HOSTED)
}
