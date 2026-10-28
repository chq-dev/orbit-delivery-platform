import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_VERSION, schemaSql } from './schema.js'

export type AppDatabase = Database.Database

export interface DatabaseOptions {
  filename: string
}

export function createDatabase(options: DatabaseOptions): AppDatabase {
  if (options.filename !== ':memory:') {
    mkdirSync(dirname(options.filename), { recursive: true })
  }

  const db = new Database(options.filename)
  if (options.filename !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${currentVersion} 高于当前程序支持的版本 ${SCHEMA_VERSION}`)
  }
  if (currentVersion < SCHEMA_VERSION) {
    db.transaction(() => {
      db.exec(schemaSql)
      ensureColumn(db, 'repositories', 'local_path', "TEXT NOT NULL DEFAULT ''")
      ensureColumn(db, 'pipelines', 'local_path', "TEXT NOT NULL DEFAULT ''")
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
  }

  return db
}

function ensureColumn(
  db: AppDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[]
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
