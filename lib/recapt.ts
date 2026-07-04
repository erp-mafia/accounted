// Recapt's identify SDK keeps the last-known uid in memory and in
// localStorage. Passing `uid: undefined` is not a documented logout
// signal: on some SDK versions it's coerced to the previous value.
// We send an explicit empty-string uid (the SDK's "anonymous" marker),
// then clear any persisted Recapt keys from localStorage so the next
// pageload doesn't re-identify the logged-out user from cache.
export function clearRecaptIdentity(): void {
  if (typeof window === 'undefined') return
  try {
    if (typeof window.recapt === 'function') {
      window.recapt('identify', {
        uid: '',
        email: undefined,
        nickname: undefined,
      })
    }
    // Defense-in-depth: wipe any Recapt-namespaced storage on logout so
    // a shared device cannot resurrect the previous user's identity on
    // the next page load.
    if (typeof window.localStorage !== 'undefined') {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const key = window.localStorage.key(i)
        if (key && (key.startsWith('recapt') || key.startsWith('glimt'))) {
          window.localStorage.removeItem(key)
        }
      }
    }
  } catch {
    // best-effort: we're already in a logout flow
  }
}
