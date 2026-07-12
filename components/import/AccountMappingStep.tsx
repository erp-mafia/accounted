'use client'

import { useState, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowRight,
  Search,
  CheckCircle,
  AlertCircle,
  XCircle,
  Filter,
} from 'lucide-react'
import type { AccountMapping } from '@/lib/import/types'
import type { BASAccount } from '@/types'
import { getAccountClassName } from '@/lib/bookkeeping/account-descriptions'

interface AccountMappingStepProps {
  mappings: AccountMapping[]
  basAccounts: BASAccount[]
  onMappingChange: (sourceAccount: string, targetAccount: string, targetName: string) => void
  onContinue: () => void
  onBack: () => void
}

type FilterType = 'all' | 'unmapped' | 'low_confidence' | 'manual'

const PAGE_SIZE = 50

export default function AccountMappingStep({
  mappings,
  basAccounts,
  onMappingChange,
  onContinue,
  onBack,
}: AccountMappingStepProps) {
  const [searchTerm, setSearchTerm] = useState('')
  // Default to showing unmapped accounts first (most actionable)
  const [filter, setFilter] = useState<FilterType>(() => {
    const hasUnmapped = mappings.some((m) => !m.targetAccount)
    return hasUnmapped ? 'unmapped' : 'all'
  })
  const [currentPage, setCurrentPage] = useState(1)

  // Filter and search mappings
  const filteredMappings = useMemo(() => {
    let result = mappings

    // Apply filter
    switch (filter) {
      case 'unmapped':
        result = result.filter((m) => !m.targetAccount)
        break
      case 'low_confidence':
        result = result.filter((m) => m.targetAccount && m.confidence < 0.7)
        break
      case 'manual':
        result = result.filter((m) => m.isOverride)
        break
    }

    // Apply search
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      result = result.filter(
        (m) =>
          m.sourceAccount.includes(term) ||
          m.sourceName.toLowerCase().includes(term) ||
          m.targetAccount?.includes(term) ||
          m.targetName?.toLowerCase().includes(term)
      )
    }

    return result
  }, [mappings, filter, searchTerm])

  // Pagination
  const totalPages = Math.ceil(filteredMappings.length / PAGE_SIZE)
  const paginatedMappings = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filteredMappings.slice(start, start + PAGE_SIZE)
  }, [filteredMappings, currentPage])

  // Reset page when filter or search changes
  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter)
    setCurrentPage(1)
  }

  const handleSearchChange = (term: string) => {
    setSearchTerm(term)
    setCurrentPage(1)
  }

  // Calculate stats
  const stats = useMemo(() => {
    const unmapped = mappings.filter((m) => !m.targetAccount).length
    const lowConfidence = mappings.filter((m) => m.targetAccount && m.confidence < 0.7).length
    const manual = mappings.filter((m) => m.isOverride).length
    return { unmapped, lowConfidence, manual }
  }, [mappings])

  const canContinue = stats.unmapped === 0

  // Group BAS accounts by class for the dropdown
  const accountsByClass = useMemo(() => {
    const groups: { [key: string]: BASAccount[] } = {}
    for (const account of basAccounts) {
      const className = getAccountClassName(account.account_class)
      if (!groups[className]) {
        groups[className] = []
      }
      groups[className].push(account)
    }
    return groups
  }, [basAccounts])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Kontomappning</CardTitle>
          <CardDescription>
            Varje konto i SIE-filen kopplas till ett konto i din kontoplan.
            De flesta matchas automatiskt: granska de osäkra nedan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Stats */}
          <div className="flex gap-4 flex-wrap">
            <Badge
              variant={filter === 'unmapped' ? 'destructive' : stats.unmapped > 0 ? 'destructive' : 'secondary'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('unmapped')}
            >
              <XCircle className="h-3 w-3 mr-1" />
              {stats.unmapped} ej mappade
            </Badge>
            <Badge
              variant={filter === 'low_confidence' ? 'default' : stats.lowConfidence > 0 ? 'secondary' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('low_confidence')}
            >
              <AlertCircle className="h-3 w-3 mr-1" />
              {stats.lowConfidence} osäkra
            </Badge>
            <Badge
              variant={filter === 'manual' ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('manual')}
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              {stats.manual} manuellt satta
            </Badge>
            <Badge
              variant={filter === 'all' ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('all')}
            >
              Visa alla ({mappings.length})
            </Badge>
          </div>

          {/* Search and filter */}
          <div className="flex gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Sök konto..."
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filter} onValueChange={(v) => handleFilterChange(v as FilterType)}>
              <SelectTrigger className="w-48">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Visa alla</SelectItem>
                <SelectItem value="unmapped">Ej mappade</SelectItem>
                <SelectItem value="low_confidence">Osäkra</SelectItem>
                <SelectItem value="manual">Manuellt satta</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Mapping table */}
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Källkonto</TableHead>
                  <TableHead>Källnamn</TableHead>
                  <TableHead className="w-12"></TableHead>
                  <TableHead className="w-64">Målkonto</TableHead>
                  <TableHead className="w-24">Konfidens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedMappings.map((mapping) => (
                  <TableRow
                    key={mapping.sourceAccount}
                    className={!mapping.targetAccount ? 'bg-destructive/5' : ''}
                  >
                    <TableCell className="font-mono">{mapping.sourceAccount}</TableCell>
                    <TableCell className="text-muted-foreground">{mapping.sourceName}</TableCell>
                    <TableCell>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={mapping.targetAccount || 'none'}
                        onValueChange={(value) => {
                          const account = basAccounts.find((a) => a.account_number === value)
                          onMappingChange(
                            mapping.sourceAccount,
                            value === 'none' ? '' : value,
                            account?.account_name || ''
                          )
                        }}
                      >
                        <SelectTrigger className={!mapping.targetAccount ? 'border-destructive' : ''}>
                          <SelectValue placeholder="Välj konto..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-80">
                          <SelectItem value="none">-- Välj konto --</SelectItem>
                          {Object.entries(accountsByClass).map(([className, accounts]) => (
                            <div key={className}>
                              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted">
                                {className}
                              </div>
                              {accounts.map((account) => (
                                <SelectItem
                                  key={account.account_number}
                                  value={account.account_number}
                                >
                                  <span className="font-mono mr-2">{account.account_number}</span>
                                  {account.account_name}
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {mapping.targetAccount && (
                        <ConfidenceBadge
                          confidence={mapping.confidence}
                          matchType={mapping.matchType}
                          isOverride={mapping.isOverride}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {paginatedMappings.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      Inga konton matchar filtret
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Visar {((currentPage - 1) * PAGE_SIZE) + 1}-{Math.min(currentPage * PAGE_SIZE, filteredMappings.length)} av {filteredMappings.length}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Föregående
                </Button>
                <div className="flex items-center gap-1 px-2">
                  <span className="text-sm">Sida {currentPage} av {totalPages}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Nästa
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          Tillbaka
        </Button>
        <Button className="min-h-11" onClick={onContinue} disabled={!canContinue}>
          {canContinue ? 'Fortsätt till granskning' : `${stats.unmapped} konton saknar mappning`}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function ConfidenceBadge({
  confidence,
  isOverride,
}: {
  confidence: number
  matchType: string  // Keep for potential future use
  isOverride: boolean
}) {
  if (isOverride) {
    return <Badge variant="default">Manuell</Badge>
  }

  if (confidence >= 0.9) {
    return <Badge variant="success">Exakt</Badge>
  }

  if (confidence >= 0.7) {
    return <Badge variant="secondary">Trolig</Badge>
  }

  return <Badge variant="outline">Osäker</Badge>
}

