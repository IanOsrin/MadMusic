import pg from 'pg'
import Database from 'better-sqlite3'
import { readdir, readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

const url = process.env.DATABASE_URL || 'sqlite:./madmusic.db'
const isSqlite = !url.startsWith('postgres')

// Translate PostgreSQL-specific syntax to SQLite equivalents
function toSqlite(sql) {
  return sql
    .replace(/\bBIGSERIAL\b/g, 'INTEGER')
    .replace(/\bSERIAL\b/g, 'INTEGER')
    .replace(/\bTIMESTAMPTZ\b/g, 'TEXT')
    .replace(/\bNUMERIC\(\d+,\s*\d+\)/g, 'REAL')
    .replace(/\bBOOLEAN\b/g, 'INTEGER')
    .replace(/\bDATE\b/g, 'TEXT')
    .replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\bADD COLUMN IF NOT EXISTS\b/gi, 'ADD COLUMN')
}

let _query
let _db  // exposed for multi-statement exec in migrations

if (!isSqlite) {
  const pool = new pg.Pool({ connectionString: url })
  _query = (sql, params) => pool.query(sql, params).then(r => r.rows)
} else {
  const dbPath = url.replace(/^sqlite:/, '')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  _db = db

  _query = (sql, params = []) => {
    const translated = toSqlite(sql).replace(/\$\d+/g, '?')
    const isDml = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(sql)
    const hasReturning = /\bRETURNING\b/i.test(sql)
    if (isDml && !hasReturning) {
      return db.prepare(translated).run(params)
    }
    return db.prepare(translated).all(params)
  }
}

export const query = _query

export async function runMigrations() {
  if (isSqlite) {
    _db.exec(toSqlite(`CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      filename TEXT UNIQUE,
      ran_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`))
  } else {
    await query(`CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY, filename TEXT UNIQUE, ran_at TIMESTAMPTZ DEFAULT now()
    )`)
  }

  const dir = join(__dir, '../migrations')
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()

  for (const file of files) {
    const already = await query('SELECT 1 FROM _migrations WHERE filename = $1', [file])
    if (already.length) continue

    let sql = await readFile(join(dir, file), 'utf8')

    if (isSqlite) {
      // Run each statement separately — better-sqlite3 doesn't support multi-statement exec via prepare
      const statements = toSqlite(sql)
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        _db.prepare(stmt).run()
      }
    } else {
      await query(sql)
    }

    await query('INSERT INTO _migrations(filename) VALUES ($1)', [file])
    console.log(`[DB] Ran migration: ${file}`)
  }
}
