'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface Bank {
  name: string
  country: string
  logo?: string
  bic?: string
}

const POPULAR_SWEDISH_BANKS = [
  'Swedbank',
  'SEB',
  'Nordea',
  'Handelsbanken',
  'Danske Bank',
]

interface BankSelectorProps {
  onConnect: (bank: Bank) => void
  onPsuTypeDetected?: (psuType: 'personal' | 'business') => void
  isConnecting?: boolean
  connectingBankName?: string | null
  className?: string
}

function BankCard({ bank, isConnecting, connectingBankName, onConnect }: {
  bank: Bank
  isConnecting: boolean
  connectingBankName: string | null
  onConnect: (bank: Bank) => void
}) {
  const connecting = isConnecting && connectingBankName === bank.name

  return (
    <button
      key={bank.name}
      type="button"
      disabled={isConnecting}
      onClick={() => onConnect(bank)}
      className={cn(
        'group flex items-center gap-3 p-4 border border-border rounded-lg bg-card text-left transition-all',
        'hover:border-primary hover:bg-muted',
        connecting && 'border-primary bg-muted',
        isConnecting && !connecting && 'opacity-50 cursor-not-allowed',
      )}
    >
      <div className="flex-shrink-0 w-12 h-12 rounded-lg border border-border bg-white dark:bg-gray-300 flex items-center justify-center overflow-hidden">
        {connecting ? (
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        ) : bank.logo ? (
          <img
            src={bank.logo}
            alt={bank.name}
            className="w-12 h-12 object-contain p-1"
          />
        ) : (
          <svg
            className="h-6 w-6 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
          </svg>
        )}
      </div>
      <span className="flex-1 font-medium text-foreground group-hover:text-primary truncate">
        {bank.name}
      </span>
      <svg
        className="flex-shrink-0 h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 5l7 7-7 7" />
      </svg>
    </button>
  )
}

export function BankSelector({
  onConnect,
  onPsuTypeDetected,
  isConnecting = false,
  connectingBankName = null,
  className,
}: BankSelectorProps) {
  const [banks, setBanks] = useState<Bank[]>([])
  const [isSandbox, setIsSandbox] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    async function fetchBanks() {
      try {
        const res = await fetch('/api/extensions/ext/enable-banking/banks')
        if (!res.ok) {
          // A non-OK response (500, or the 403 capability gate) has no `banks`
          // array; without this guard it falls through to the "no banks
          // available" empty state, which misreads as a successful-but-empty
          // load rather than a failure.
          setError('Kunde inte ladda banker')
          return
        }
        const data = await res.json()
        if (data.banks) {
          setBanks(data.banks as Bank[])
        }
        if (data.sandbox !== undefined) {
          setIsSandbox(data.sandbox)
        }
        if (data.psu_type && onPsuTypeDetected) {
          onPsuTypeDetected(data.psu_type)
        }
      } catch {
        setError('Kunde inte ladda banker')
      } finally {
        setIsLoading(false)
      }
    }
    fetchBanks()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onPsuTypeDetected is a stable setter, only run on mount
  }, [onPsuTypeDetected])

  const filteredBanks = banks.filter((bank) =>
    bank.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const showPopular = !isSandbox && !searchQuery
  const popularBanks = showPopular
    ? filteredBanks.filter((bank) => POPULAR_SWEDISH_BANKS.includes(bank.name))
    : []
  const otherBanks = showPopular
    ? filteredBanks.filter((bank) => !POPULAR_SWEDISH_BANKS.includes(bank.name))
    : filteredBanks

  return (
    <div className={cn('space-y-4', className)}>
      {/* Search input */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={searchRef}
          type="text"
          placeholder="Sök efter din bank..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-3 py-3 border border-border rounded-lg bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-all"
        />
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Bank grid */}
      {!isLoading && !error && (
        <>
          {filteredBanks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? `Inga banker matchar "${searchQuery}"`
                  : 'Inga banker tillgängliga'}
              </p>
              {searchQuery && (
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Försök med ett annat sökord
                </p>
              )}
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto space-y-4">
              {popularBanks.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">Populära banker</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {popularBanks.map((bank) => (
                      <BankCard key={bank.name} bank={bank} isConnecting={isConnecting} connectingBankName={connectingBankName} onConnect={onConnect} />
                    ))}
                  </div>
                </div>
              )}
              {popularBanks.length > 0 && otherBanks.length > 0 && (
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">Alla banker</h3>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {otherBanks.map((bank) => (
                  <BankCard key={bank.name} bank={bank} isConnecting={isConnecting} connectingBankName={connectingBankName} onConnect={onConnect} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Connecting overlay */}
      {isConnecting && connectingBankName && (
        <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/30">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-sm font-medium text-foreground">Ansluter till {connectingBankName}...</span>
        </div>
      )}
    </div>
  )
}
