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
      ensureColumn(db, 'work_items', 'archived_at', 'TEXT')
      ensureColumn(db, 'work_items', 'feishu_status', 'TEXT')
      ensureColumn(db, 'work_items', 'project_line', 'TEXT')
      ensureColumn(db, 'work_items', 'design_reference', 'TEXT')
      ensureColumn(db, 'work_items', 'requirement_breakdown', 'TEXT')
      migrateFeishuAgentCommands(db)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_work_items_archived ON work_items(source, archived_at)',
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_work_items_project_line ON work_items(project_line)',
      )
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_work_items_archived ON work_items(source, archived_at)',
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_work_items_project_line ON work_items(project_line)',
  )

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

function migrateFeishuAgentCommands(db: AppDatabase): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feishu_agent_commands'")
    .get() as { sql: string } | undefined
  if (!table) return
  if (table.sql.includes("'delivery_start'")) {
    ensureColumn(db, 'feishu_agent_commands', 'payload_json', 'TEXT')
    return
  }

  db.exec('DROP INDEX IF EXISTS idx_feishu_agent_commands_status')
  db.exec('ALTER TABLE feishu_agent_commands RENAME TO feishu_agent_commands_legacy')
  db.exec(`
    CREATE TABLE feishu_agent_commands (
      id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL CHECK (command_type IN ('login_start', 'sync', 'rotate_token', 'delivery_start')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      payload_json TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT
    )
  `)
  db.exec(`
    INSERT INTO feishu_agent_commands
      (id, command_type, status, payload_json, result_json, error, created_at, updated_at, claimed_at, completed_at)
    SELECT id, command_type, status, NULL, result_json, error, created_at, updated_at, claimed_at, completed_at
    FROM feishu_agent_commands_legacy
  `)
  db.exec('DROP TABLE feishu_agent_commands_legacy')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_status ON feishu_agent_commands(status, created_at)',
  )
}
