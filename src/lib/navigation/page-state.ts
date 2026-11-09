/** Decode view preferences defensively; storage must never prevent opening a page. */
export function decodePageState<T>(raw: string | null, initial: T): T {
  if (raw === null) return initial
  try {
    const saved = JSON.parse(raw)
    if (initial instanceof Set) return Array.isArray(saved) ? new Set(saved) as T : initial
    if (saved === null) return initial === null ? saved : initial
    if (initial === null) return typeof saved === 'object' && !Array.isArray(saved) ? saved : initial
    return typeof saved === typeof initial && Array.isArray(saved) === Array.isArray(initial) ? saved : initial
  } catch { return initial }
}
