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
      ensureColumn(
        db,
        'repositories',
        'build_enabled',
        'INTEGER NOT NULL DEFAULT 1 CHECK (build_enabled IN (0, 1))',
      )
      ensureColumn(db, 'repositories', 'build_account_id', "TEXT NOT NULL DEFAULT ''")
      ensureColumn(db, 'pipelines', 'local_path', "TEXT NOT NULL DEFAULT ''")
      ensureColumn(db, 'pipelines', 'delivery_job_id', 'TEXT')
      ensureColumn(db, 'accounts', 'service_url', "TEXT NOT NULL DEFAULT ''")
      ensureColumn(db, 'work_items', 'archived_at', 'TEXT')
      ensureColumn(db, 'work_items', 'feishu_status', 'TEXT')
      ensureColumn(db, 'work_items', 'project_line', 'TEXT')
      ensureColumn(db, 'work_items', 'design_reference', 'TEXT')
      ensureColumn(db, 'work_items', 'requirement_breakdown', 'TEXT')
      ensureColumn(db, 'feishu_agent_state', 'client_name', "TEXT NOT NULL DEFAULT ''")
      ensureColumn(db, 'feishu_agent_state', 'machine_name', "TEXT NOT NULL DEFAULT ''")
      ensureColumn(
        db,
        'feishu_agent_commands',
        'client_id',
        "TEXT NOT NULL DEFAULT 'primary'",
      )
      migratePipelineReportKinds(db)
      migrateFeishuAgentCommands(db)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_work_items_archived ON work_items(source, archived_at)',
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_work_items_project_line ON work_items(project_line)',
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_client_status ON feishu_agent_commands(client_id, status, created_at)',
      )
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_delivery_job ON pipelines(delivery_job_id) WHERE delivery_job_id IS NOT NULL',
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
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_client_status ON feishu_agent_commands(client_id, status, created_at)',
  )
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_delivery_job ON pipelines(delivery_job_id) WHERE delivery_job_id IS NOT NULL',
  )

  return db
}

function migratePipelineReportKinds(db: AppDatabase): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_reports'")
    .get() as { sql: string } | undefined
  if (!table || !/kind\s+TEXT\s+NOT\s+NULL\s+CHECK/i.test(table.sql)) return

  db.exec('ALTER TABLE pipeline_report_sections RENAME TO pipeline_report_sections_legacy')
  db.exec('ALTER TABLE pipeline_reports RENAME TO pipeline_reports_legacy')
  db.exec(`
    CREATE TABLE pipeline_reports (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (pipeline_id, kind)
    )
  `)
  db.exec(`
    CREATE TABLE pipeline_report_sections (
      report_id TEXT NOT NULL REFERENCES pipeline_reports(id) ON DELETE CASCADE,
      section_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (report_id, section_index)
    )
  `)
  db.exec(`
    INSERT INTO pipeline_reports (id, pipeline_id, kind, title, summary, created_at)
    SELECT id, pipeline_id, kind, title, summary, created_at
    FROM pipeline_reports_legacy
  `)
  db.exec(`
    INSERT INTO pipeline_report_sections (report_id, section_index, title, content)
    SELECT report_id, section_index, title, content
    FROM pipeline_report_sections_legacy
  `)
  db.exec('DROP TABLE pipeline_report_sections_legacy')
  db.exec('DROP TABLE pipeline_reports_legacy')
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
  ensureColumn(db, 'feishu_agent_commands', 'payload_json', 'TEXT')
  ensureColumn(db, 'feishu_agent_commands', 'client_id', "TEXT NOT NULL DEFAULT 'primary'")
  ensureColumn(db, 'feishu_agent_commands', 'claimed_at', 'TEXT')
  ensureColumn(db, 'feishu_agent_commands', 'completed_at', 'TEXT')
  if (table.sql.includes("'delivery_start'") && table.sql.includes("'build_trigger'")) {
    return
  }

  db.exec('DROP INDEX IF EXISTS idx_feishu_agent_commands_status')
  db.exec('ALTER TABLE feishu_agent_commands RENAME TO feishu_agent_commands_legacy')
  db.exec(`
    CREATE TABLE feishu_agent_commands (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL DEFAULT 'primary',
      command_type TEXT NOT NULL CHECK (command_type IN ('login_start', 'sync', 'rotate_token', 'delivery_start', 'build_job_read', 'build_trigger')),
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
      (id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at, claimed_at, completed_at)
    SELECT id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at, claimed_at, completed_at
    FROM feishu_agent_commands_legacy
  `)
  db.exec('DROP TABLE feishu_agent_commands_legacy')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_status ON feishu_agent_commands(status, created_at)',
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_client_status ON feishu_agent_commands(client_id, status, created_at)',
  )
}
