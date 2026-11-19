import { describe, expect, it } from 'vitest'
import {
  SLOT_LOCK_KEY,
  baseDatabaseUrl,
  claimSlot,
  databaseOf,
  runInBaseDatabase,
  withDatabase,
  workerCount,
  workerDatabase,
} from '../parallel'

const BASE = 'postgresql://postgres:secret@localhost:5432/postgres'

describe('workerCount', () => {
  it('is 0, the serial suite, unless PG_REAL_WORKERS is 2 or more', () => {
    expect(workerCount({})).toBe(0)
    expect(workerCount({ PG_REAL_WORKERS: '' })).toBe(0)
    expect(workerCount({ PG_REAL_WORKERS: '1' })).toBe(0)
    expect(workerCount({ PG_REAL_WORKERS: 'four' })).toBe(0)
    expect(workerCount({ PG_REAL_WORKERS: '-4' })).toBe(0)
  })

  it('reads the number and stops at 16', () => {
    expect(workerCount({ PG_REAL_WORKERS: '4' })).toBe(4)
    expect(workerCount({ PG_REAL_WORKERS: ' 3 ' })).toBe(3)
    expect(workerCount({ PG_REAL_WORKERS: '40' })).toBe(16)
  })
})

describe('database addresses', () => {
  it('keeps the server and the login and changes the database', () => {
    expect(withDatabase(BASE, workerDatabase(2))).toBe('postgresql://postgres:secret@localhost:5432/pg_real_w2')
    expect(databaseOf(withDatabase(BASE, 'template1'))).toBe('template1')
    expect(databaseOf(BASE)).toBe('postgres')
  })

  it('finds the migrated database again after DATABASE_URL was pointed at a copy', () => {
    expect(baseDatabaseUrl({ DATABASE_URL: BASE })).toBe(BASE)
    expect(baseDatabaseUrl({ DATABASE_URL: withDatabase(BASE, 'pg_real_w1'), PG_REAL_BASE_URL: BASE })).toBe(BASE)
  })
})

describe('runInBaseDatabase', () => {
  it('moves a file on a worker back to the migrated database', () => {
    const env = { DATABASE_URL: withDatabase(BASE, 'pg_real_w3'), PG_REAL_BASE_URL: BASE }
    runInBaseDatabase(env)
    expect(env.DATABASE_URL).toBe(BASE)
  })

  it('changes nothing in a serial run', () => {
    const env = { DATABASE_URL: BASE }
    runInBaseDatabase(env)
    expect(env).toEqual({ DATABASE_URL: BASE })
  })
})

describe('claimSlot', () => {
  function clientWhere(free: (slot: number, call: number) => boolean) {
    const asked: number[] = []
    return {
      asked,
      query: async (_sql: string, values: unknown[]) => {
        expect(values[0]).toBe(SLOT_LOCK_KEY)
        const slot = values[1] as number
        asked.push(slot)
        return { rows: [{ locked: free(slot, asked.length) }] }
      },
    }
  }

  it('takes the first database nobody holds', async () => {
    const client = clientWhere((slot) => slot === 3)
    expect(await claimSlot(client, 4)).toBe(3)
    expect(client.asked).toEqual([1, 2, 3])
  })

  it('waits and asks again while every database is taken', async () => {
    const waits: number[] = []
    const client = clientWhere((slot, call) => call > 2 && slot === 1)
    expect(await claimSlot(client, 2, async (ms) => void waits.push(ms))).toBe(1)
    expect(client.asked).toEqual([1, 2, 1])
    expect(waits).toEqual([100])
  })

  it('gives up with a message after the last round', async () => {
    const client = clientWhere(() => false)
    await expect(claimSlot(client, 2, async () => {})).rejects.toThrow('no free worker database among 2')
  })
})
