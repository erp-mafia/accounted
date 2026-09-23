import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { SIECreateAccountsSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Determine account type based on account class (first digit)
 */
function getAccountType(accountNumber: string): 'asset' | 'equity' | 'liability' | 'revenue' | 'expense' {
  const firstDigit = parseInt(accountNumber.charAt(0), 10)

  switch (firstDigit) {
    case 1:
      return 'asset'
    case 2:
      // 20xx-20xx is equity, 21xx-29xx is liability
      const group = parseInt(accountNumber.substring(0, 2), 10)
      return group <= 20 ? 'equity' : 'liability'
    case 3:
      return 'revenue'
    case 4:
    case 5:
    case 6:
    case 7:
      return 'expense'
    case 8:
      // 8xxx can be either revenue (83xx interest income) or expense
      const subGroup = parseInt(accountNumber.substring(0, 2), 10)
      return subGroup >= 83 && subGroup <= 84 ? 'revenue' : 'expense'
    default:
      return 'expense'
  }
}

/**
 * Determine normal balance based on account type
 */
function getNormalBalance(accountType: string): 'debit' | 'credit' {
  switch (accountType) {
    case 'asset':
    case 'expense':
      return 'debit'
    case 'equity':
    case 'liability':
    case 'revenue':
      return 'credit'
    default:
      return 'debit'
  }
}

/**
 * POST /api/import/sie/create-accounts
 * Create missing accounts from SIE file definitions
 */
export const POST = withRouteContext(
  'sie_import.create_accounts',
  async (request, { supabase, user, companyId, log, requestId }) => {
    try {
      const body = await request.json()
      const checked = SIECreateAccountsSchema.safeParse(body)
      if (!checked.success) {
        return errorResponse(checked.error, log, { requestId, details: {
          issues: checked.error.issues.map(issue => {
            const number = issue.path[0] === 'accounts' && typeof issue.path[1] === 'number' &&
              issue.path[2] === 'number' && Array.isArray(body?.accounts)
              ? body.accounts[issue.path[1]]?.number : undefined
            return {
              field: issue.path.join('.'), message: issue.message, code: issue.code,
              ...(typeof number === 'string' && /^\d{1,40}$/.test(number) ? { sourceAccount: number } : {}),
            }
          }),
        } })
      }
      const { accounts } = checked.data

      // Prepare accounts for upsert (idempotent, safe to retry)
      const accountsToUpsert = accounts.map(account => {
        const accountClass = parseInt(account.number.charAt(0), 10) || 1
        const accountGroup = account.number.substring(0, 2)
        const accountType = getAccountType(account.number)
        const normalBalance = getNormalBalance(accountType)

        return {
          user_id: user.id,
          company_id: companyId,
          account_number: account.number,
          account_name: account.name,
          account_class: accountClass,
          account_group: accountGroup,
          account_type: accountType,
          normal_balance: normalBalance,
          plan_type: 'full_bas',
          is_active: true,
          is_system_account: false, // User-created via import
          sort_order: parseInt(account.number, 10) || 0,
        }
      })

      // Upsert in batches of 100 to avoid timeout
      // ignoreDuplicates skips rows that already exist (no update)
      const batchSize = 100
      let totalCreated = 0

      for (let i = 0; i < accountsToUpsert.length; i += batchSize) {
        const batch = accountsToUpsert.slice(i, i + batchSize)

        const { data: upserted, error } = await supabase
          .from('chart_of_accounts')
          .upsert(batch, {
            onConflict: 'company_id,account_number',
            ignoreDuplicates: true,
            count: 'exact',
          })
          .select('account_number')

        if (error) {
          console.error('Error upserting accounts batch:', error)
          return NextResponse.json({
            error: `Kunde inte skapa konton (batch ${Math.floor(i / batchSize) + 1}): ${getUserErrorMessage(error)}. ${totalCreated} konton skapades innan felet.`,
            created: totalCreated,
          }, { status: 500 })
        }

        totalCreated += upserted?.length ?? batch.length
      }

      return NextResponse.json({
        success: true,
        created: totalCreated,
        message: `Created ${totalCreated} new accounts`,
      })

    } catch (error) {
      if (error instanceof SyntaxError) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
      console.error('Create accounts error:', error)
      return NextResponse.json(
        { error: `Kunde inte skapa konton: ${error instanceof Error ? getUserErrorMessage(error) : 'Okänt fel'}. Försök igen.` },
        { status: 500 }
      )
    }
  },
  { requireWrite: true },
)
