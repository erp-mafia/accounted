'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

interface ExtensionDataRecord {
  id: string
  key: string
  value: Record<string, unknown>
  created_at: string
  updated_at: string
}

export function useExtensionData(sector: string, slug: string) {
  const [data, setData] = useState<ExtensionDataRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const basePath = `/api/extensions/${sector}/${slug}/data`
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch(basePath)
      if (res.ok) {
        const json = await res.json()
        if (mountedRef.current) setData(json.data ?? [])
      }
    } finally {
      if (mountedRef.current) setIsLoading(false)
    }
  }, [basePath])

  useEffect(() => {
    refresh()
  }, [refresh])

  const save = useCallback(async (key: string, value: Record<string, unknown>) => {
    const res = await fetch(basePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    if (res.ok) {
      const json = await res.json()
      setData(prev => {
        const idx = prev.findIndex(d => d.key === key)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = json.data
          return updated
        }
        return [...prev, json.data]
      })
      return json.data
    }
    return null
  }, [basePath])

  const remove = useCallback(async (key: string) => {
    const res = await fetch(`${basePath}?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      setData(prev => prev.filter(d => d.key !== key))
    }
  }, [basePath])

  const getByPrefix = useCallback(async (prefix: string): Promise<ExtensionDataRecord[]> => {
    const res = await fetch(`${basePath}?prefix=${encodeURIComponent(prefix)}`)
    if (res.ok) {
      const json = await res.json()
      return json.data ?? []
    }
    return []
  }, [basePath])

  const getByKey = useCallback((key: string) => {
    return data.find(d => d.key === key) ?? null
  }, [data])

  return { data, isLoading, save, remove, getByPrefix, getByKey, refresh }
}
