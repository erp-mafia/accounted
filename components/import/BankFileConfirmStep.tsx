'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ArrowLeft,
  Loader2,
  Play,
  FileText,
  Link2,
  Calendar,
  Landmark,
  AlertTriangle,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import type { BankFileParseResult } from '@/lib/import/bank-file/types'

interface BankAccount {
  account_number: string
  account_name: string
}

interface BankFileConfirmStepProps {
  parseResult: BankFileParseResult
  onExecute: (options: { skip_duplicates: boolean; auto_categorize: boolean; settlement_account?: string }) => void
  onBack: () => void
  isLoading: boolean
}

export default function BankFileConfirmStep({
  parseResult,
  onExecute,
  onBack,
  isLoading,
}: BankFileConfirmStepProps) {
  const { transactions, stats, date_from, date_to, issues } = parseResult
  const refsCount = transactions.filter((t) => t.reference).length
  const warnings = issues.filter((i) => i.severity === 'warning')

  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([])
  const [selectedAccount, setSelectedAccount] = useState('1930')

  useEffect(() => {
    async function fetchBankAccounts() {
      const supabase = createClient()
      const { data } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name')
        .eq('is_active', true)
        .gte('account_number', '1900')
        .lte('account_number', '1999')
        .order('account_number')

      if (data && data.length > 0) {
        setBankAccounts(data)
        // Default to 1930 if available, otherwise first account
        const has1930 = data.some(a => a.account_number === '1930')
        if (!has1930) setSelectedAccount(data[0].account_number)
      }
    }
    fetchBankAccounts()
  }, [])

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 space-y-6">
        <div className="relative">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
        </div>
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">Importerar transaktioner...</p>
          <p className="text-sm text-muted-foreground">
            {stats.parsed_rows} transaktioner bearbetas
          </p>
        </div>
        <div className="w-48 h-1 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full animate-pulse" style={{ width: '60%' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Bekräfta import</CardTitle>
          <CardDescription>
            Granska sammanfattningen och importera transaktionerna.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <FileText className="h-4 w-4" />
                <span className="text-xs">Transaktioner</span>
              </div>
              <p className="text-xl font-display tabular-nums">{stats.parsed_rows}</p>
              {stats.skipped_rows > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {stats.skipped_rows} rader hoppades över
                </p>
              )}
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Calendar className="h-4 w-4" />
                <span className="text-xs">Period</span>
              </div>
              <p className="text-sm font-medium">
                {date_from}: {date_to}
              </p>
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-xs">Inkomster</span>
              </div>
              <p className="text-xl font-display tabular-nums">
                {formatCurrency(stats.total_income)}
              </p>
            </div>

            <div className="p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="text-xs">Utgifter</span>
              </div>
              <p className="text-xl font-display tabular-nums">
                {formatCurrency(stats.total_expenses)}
              </p>
            </div>
          </div>

          {/* Bank account selector */}
          {bankAccounts.length > 1 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Landmark className="h-4 w-4 text-muted-foreground" />
                Bankkonto
              </Label>
              <Select value={selectedAccount} onValueChange={setSelectedAccount}>
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((account) => (
                    <SelectItem key={account.account_number} value={account.account_number}>
                      <span className="font-mono">{account.account_number}</span>
                      {' '}
                      {account.account_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Välj vilket bankkonto transaktionerna ska bokföras mot.
              </p>
            </div>
          )}

          {/* Additional info */}
          {refsCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Link2 className="h-3 w-3" />
              {refsCount} med OCR/referens
            </div>
          )}
        </CardContent>
      </Card>

      {/* Skipped rows: surfaced here because the manual-mapping path skips the
          preview step where these warnings would otherwise be shown. */}
      {warnings.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              {warnings.length} {warnings.length === 1 ? 'rad' : 'rader'} hoppades över
            </CardTitle>
            <CardDescription>
              Dessa rader kunde inte läsas och importeras inte. Kontrollera att inga transaktioner saknas.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {warnings.slice(0, 10).map((issue, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  Rad {issue.row}: {issue.message}
                </p>
              ))}
              {warnings.length > 10 && (
                <p className="text-xs text-muted-foreground font-medium">
                  …och {warnings.length - 10} till
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onBack} disabled={isLoading}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
        <Button
          className="min-h-11"
          onClick={() => onExecute({
            skip_duplicates: true,
            auto_categorize: false,
            settlement_account: selectedAccount !== '1930' ? selectedAccount : undefined,
          })}
          disabled={isLoading}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Importerar...
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              Importera {stats.parsed_rows} transaktioner
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
