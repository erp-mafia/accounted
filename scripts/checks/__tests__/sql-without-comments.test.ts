/**
 * sqlWithoutComments must call two versions equal only when they differ in
 * comments. A false "equal" would let a changed function past the pg coverage
 * gate, so every case below that changes SQL has to come out different.
 */
import { describe, it, expect } from 'vitest'
import { sqlWithoutComments } from '../sql-without-comments.mjs'

const base = [
  '-- a note',
  '-- second line',
  'CREATE TABLE t (a int); -- trailing',
  '',
  "COMMENT ON TABLE t IS 'keep  two  spaces -- not a comment';",
  'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $fn$',
  '  -- body comment',
  '  SELECT 1;',
  '$fn$;',
  '/* block */',
  'SELECT "odd  name" FROM t;',
  '',
].join('\n')

const same = (after: string) => sqlWithoutComments(after) === sqlWithoutComments(base)

describe('sqlWithoutComments: comment edits are no difference', () => {
  it.each([
    ['a comment line is reworded', base.replace('-- a note', '-- another note entirely')],
    ['a comment line is deleted', base.replace('-- second line\n', '')],
    ['a comment line is added', base.replace('CREATE TABLE', '-- new\nCREATE TABLE')],
    ['a trailing comment is removed', base.replace(' -- trailing', '')],
    ['a block comment is removed', base.replace('/* block */\n', '')],
    ['a block comment is reworded, nested', base.replace('/* block */', '/* outer /* inner */ still */')],
  ])('%s', (_name, after) => {
    expect(same(after)).toBe(true)
  })
})

describe('sqlWithoutComments: any change to SQL is a difference', () => {
  it.each([
    ['a column type changes', base.replace('a int', 'a bigint')],
    ['a statement is added', `${base}DROP TABLE t;\n`],
    ['a statement is commented out', base.replace('SELECT "odd', '-- SELECT "odd')],
    ['a statement is put in a block comment', base.replace('CREATE TABLE t (a int);', '/* CREATE TABLE t (a int); */')],
    ['whitespace inside a string changes', base.replace('two  spaces', 'two spaces')],
    ['comment-like text inside a string changes', base.replace('-- not a comment', '-- still not')],
    ['a comment inside a function body changes', base.replace('-- body comment', '-- other')],
    ['whitespace inside a function body changes', base.replace('  SELECT 1;', ' SELECT 1;')],
    ['code inside a function body changes', base.replace('SELECT 1;', 'SELECT 2;')],
    ['whitespace inside a quoted identifier changes', base.replace('"odd  name"', '"odd name"')],
  ])('%s', (_name, after) => {
    expect(same(after)).toBe(false)
  })
})

describe('sqlWithoutComments: quoting', () => {
  it('reads a doubled quote as part of the string', () => {
    const a = "SELECT 'it''s -- here'; -- note"
    expect(sqlWithoutComments(a)).toBe("SELECT 'it''s -- here';")
  })

  it('reads a backslash quote inside an E string', () => {
    const a = "SELECT E'a\\' -- still inside'; -- note"
    expect(sqlWithoutComments(a)).toBe("SELECT E'a\\' -- still inside';")
  })

  it('does not read a positional parameter as a dollar quote', () => {
    const a = 'SELECT $1, $2 -- note\nFROM t'
    expect(sqlWithoutComments(a)).toBe('SELECT $1, $2 FROM t')
  })

  it('keeps a tagged body up to its own tag, not the first $$', () => {
    const a = 'DO $outer$ BEGIN PERFORM $$ -- x $$; END $outer$; -- note'
    expect(sqlWithoutComments(a)).toBe('DO $outer$ BEGIN PERFORM $$ -- x $$; END $outer$;')
  })

  it('keeps an unterminated string to the end, so nothing after it is dropped', () => {
    const a = "SELECT 'open -- not a comment"
    expect(sqlWithoutComments(a)).toBe(a)
  })
})
