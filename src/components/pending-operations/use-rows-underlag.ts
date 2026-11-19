'use client'

import { useCallback, useEffect, useState } from 'react'
import { mapWithConcurrency } from '@/lib/concurrency'
import { rowUnderlagResult, rowsToRead, type RowUnderlagResult, type RowsUnderlagRead } from './review-model'

/**
 * Requests out at once. A batch is read row by row through the route the
 * single row uses, so a pool keeps the review from opening with one request
 * per row at the same instant.
 */
const READS_AT_ONCE = 4

/** A row that does not answer in this time counts as not read, so one slow request never holds the whole read back. */
const READ_TIMEOUT_MS = 15_000

const NOTHING_READ: ReadonlyMap<string, RowUnderlagResult> = new Map()

function readRowUnderlag(transactionId: string): Promise<RowUnderlagResult> {
  return fetch(`/api/transactions/${transactionId}/underlag`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((body: { data?: unknown }) => rowUnderlagResult(body.data))
    .catch((): RowUnderlagResult => ({ failed: true }))
}

interface Read {
  /** The rows it was read for: an answer for the previous proposal never shows under the next one. */
  key: string
  /** The reviewer asked for the rows past the first read. */
  all: boolean
  results: ReadonlyMap<string, RowUnderlagResult>
}

/**
 * The underlag of each bank row a samlingsverifikat names: the document
 * pinned to the row or matched to it from the inbox, read live, since a row
 * may get its receipt while the proposal waits. The first rows are read when
 * the review opens (review-model's ROWS_UNDERLAG_UNASKED), the rest when
 * `readRest` is called. A read lands whole.
 */
export function useRowsUnderlag(rowIds: readonly string[]): RowsUnderlagRead & { readRest: () => void } {
  const key = rowIds.join(',')
  const [stored, setStored] = useState<Read>({ key, all: false, results: NOTHING_READ })
  const read = stored.key === key ? stored : { key, all: false, results: NOTHING_READ }
  const wanted = rowsToRead(rowIds, read.all)
    .filter((id) => !read.results.has(id))
    .join(',')

  useEffect(() => {
    if (wanted === '') return
    let cancelled = false
    const ids = wanted.split(',')
    const unread: RowUnderlagResult = { failed: true }
    void mapWithConcurrency<string, RowUnderlagResult>(ids, READS_AT_ONCE, (id) => (cancelled ? Promise.resolve(unread) : readRowUnderlag(id))).then((answers) => {
      if (cancelled) return
      setStored((previous) => {
        const base = previous.key === key ? previous : { key, all: false, results: NOTHING_READ }
        const results = new Map(base.results)
        ids.forEach((id, index) => results.set(id, answers[index]))
        return { ...base, results }
      })
    })
    return () => {
      cancelled = true
    }
  }, [key, wanted])

  const readRest = useCallback(() => {
    setStored((previous) => ({ key, all: true, results: previous.key === key ? previous.results : NOTHING_READ }))
  }, [key])

  return { results: read.results, reading: wanted !== '', askedForRest: read.all, readRest }
}
