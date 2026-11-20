import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Wiring pin for crm#1097. Vitest runs in node and never renders a component,
 * so the source shape is pinned instead: a connection's details in settings
 * and the account picker split the accounts with the same function and say
 * the same thing about a card account that mirrors the main account; the row
 * offers the picker by the one name the page uses, only through
 * offersAccountChoice (whose rules are unit-tested in connection-state), and
 * the card and claimed-elsewhere lines carry no action. The counts agree on
 * every surface, and the picker says before the save what an account switched
 * on later gets (nextScheduledSyncFrom).
 */
const EXTENSION_DIR = path.resolve(__dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(EXTENSION_DIR, 'components', file), 'utf8')
const STATUS = read('BankConnectionStatus.tsx')
const PICKER = read('AccountPickerDialog.tsx')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** The JSX block that renders `marker`, up to the end of its conditional. */
function blockAround(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  const start = source.lastIndexOf('{', source.lastIndexOf('&& (', at))
  const end = source.indexOf(')}', at + marker.length)
  expect(end).toBeGreaterThan(at)
  return source.slice(start, end + 2)
}

describe('bank connection details (crm#1097)', () => {
  it('split accounts like the picker, so a card account is never a "Synkas ej" row', () => {
    expect(STATUS).toContain('partitionAccounts(accounts)')
    expect(STATUS).not.toContain('partitionByClaim(')
    expect(PICKER).toContain('partitionAccounts(accounts)')
  })

  it('say what the picker says about a card account, with no action on that line', () => {
    expect(STATUS).toContain('describeMirrorCards(mirrorCards)')
    expect(PICKER).toContain('describeMirrorCards(mirrorCards)')
    const cardLine = blockAround(STATUS, 'describeMirrorCards(mirrorCards)')
    expect(cardLine).not.toContain('onClick')
    expect(cardLine).not.toContain('<Button')
  })

  it('keep the claimed-elsewhere line free of actions', () => {
    const claimedLine = blockAround(STATUS, 'describeClaimedElsewhere(claimedElsewhere)')
    expect(claimedLine).not.toContain('onClick')
    expect(claimedLine).not.toContain('<Button')
  })

  it('offer "Välj konton" beside the account count only through offersAccountChoice', () => {
    const gate = STATUS.indexOf('offersAccountChoice(connection, accounts, now)')
    expect(gate).toBeGreaterThan(-1)
    const action = STATUS.slice(gate, STATUS.indexOf('</Button>', gate))
    expect(action).toContain('onManageAccounts(connection.id)')
    expect(action).toContain('Välj konton')
    // It sits before the details body, on the line that says what syncs.
    const countLine = STATUS.indexOf('{enabledCount} av {ownAccounts.length}')
    expect(countLine).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(countLine)
    expect(gate).toBeLessThan(STATUS.indexOf('{detailsOpen && ('))
    // Named with its bank, like the row's "..." menu, so several rows'
    // buttons are told apart by a screen reader.
    expect(action).toContain('aria-label={`Välj konton för ${connection.bank_name}`}')
  })

  it('count one account in the singular, now that a card account is not counted', () => {
    // A typical Svea connection is one main account plus the card account.
    expect(STATUS).toContain("{enabledCount} av {ownAccounts.length} {ownAccounts.length === 1 ? 'konto' : 'konton'} synkas")
    expect(STATUS).toContain("ownAccounts.length === 1 ? 'konto tillgängligt' : 'konton tillgängliga'")
    expect(PICKER).toContain("${selectableCount === 1 ? 'konto' : 'konton'} kommer synkas")
  })

  it('count the saved selection like the picker and the details, not the route total', () => {
    // total_count counts every stored account: the card account and the
    // accounts left with another company too.
    expect(PICKER).toContain('${data.enabled_count} av ${selectableCount}')
    expect(PICKER).not.toContain('data.total_count')
  })

  it('say before the save that an account switched on gets no history from the connection start', () => {
    const line = blockAround(PICKER, 'formatDate(newAccountsSyncFrom)')
    expect(line).toContain('!isInitialSelection && newAccountsSyncFrom && switchesAccountOn')
    expect(line).toContain('bankfil')
    expect(line).toContain('Tryck Synka')
    expect(line).toContain('120 dagar')
    expect(read('BankingSettingsPanel.tsx')).toContain(
      'newAccountsSyncFrom={hasBankSync ? nextScheduledSyncFrom(pickerConnection, stateNow) : null}',
    )
  })

  it('never call the picker "Hantera konton", a control the page does not have', () => {
    const offenders = sourceFiles(EXTENSION_DIR).filter((file) =>
      fs.readFileSync(file, 'utf8').includes('Hantera konton'),
    )
    expect(offenders).toEqual([])
  })
})
