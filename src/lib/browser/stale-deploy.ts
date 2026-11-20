/**
 * A click that called a Server Action the server no longer has.
 *
 * A tab opened before a deploy holds the old build's action ids. After the
 * deploy, calling one answers 404 and Next.js throws UnrecognizedActionError
 * ("Server Action ... was not found on the server"). The call sites
 * (company switch, company profile lookup) do not catch it, so the click
 * just died: a spinner that never stops and an unhandled rejection in
 * PostHog. Nothing the user can do in that tab works until it is reloaded.
 *
 * instrumentation-client.ts installs one listener per page for uncaught
 * errors and rejections; when it sees this error it announces a stale deploy,
 * and DeployReloadPrompt shows its existing "new version, reload" card. The
 * error still reaches PostHog's own handlers, so the count stays measurable.
 */

/** Window event DeployReloadPrompt listens for. */
export const STALE_DEPLOY_EVENT = 'accounted:stale-deploy'

/**
 * Next.js sets this name in the error's constructor
 * (next/dist/client/components/unrecognized-action-error). Matched by name
 * rather than with `unstable_isUnrecognizedActionError` so the check does not
 * depend on an unstable export or on the error class being the same module
 * instance as ours.
 */
export function isStaleDeployError(error: unknown): boolean {
  return error instanceof Error && error.name === 'UnrecognizedActionError'
}

/** Announce that this tab runs an older build than the server. */
export function announceStaleDeploy(target: EventTarget): void {
  target.dispatchEvent(new Event(STALE_DEPLOY_EVENT))
}

/** Watch `win` for the error, from a click or anywhere else. Returns the uninstall. */
export function installStaleDeployListener(win: Window): () => void {
  const onError = (event: Event) => {
    if (isStaleDeployError((event as ErrorEvent).error)) announceStaleDeploy(win)
  }
  const onRejection = (event: Event) => {
    if (isStaleDeployError((event as PromiseRejectionEvent).reason)) announceStaleDeploy(win)
  }
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)
  return () => {
    win.removeEventListener('error', onError)
    win.removeEventListener('unhandledrejection', onRejection)
  }
}

/** Call `onStale` when a stale deploy is announced on `win`. Returns the unsubscribe. */
export function onStaleDeploy(win: Window, onStale: () => void): () => void {
  win.addEventListener(STALE_DEPLOY_EVENT, onStale)
  return () => win.removeEventListener(STALE_DEPLOY_EVENT, onStale)
}
