import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { backfillOwnershipToFirstUser } from './ownership.js'
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
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(schemaSql)
        ensureColumn(db, 'accounts', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
        ensureColumn(db, 'repositories', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
        ensureColumn(db, 'work_items', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
        ensureColumn(db, 'pipelines', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
        ensureColumn(db, 'feishu_inbox', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
        ensureColumn(db, 'feishu_agent_commands', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
        ensureColumn(db, 'feishu_integrations', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
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
        migrateOwnershipTables(db)
        migrateAccountPlatforms(db)
        backfillOwnershipToFirstUser(db)
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
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_work_items_archived ON work_items(source, archived_at)',
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_repo ON work_items(repo_id)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_work_items_project_line ON work_items(project_line)',
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_client_status ON feishu_agent_commands(client_id, status, created_at)',
  )
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_delivery_job ON pipelines(delivery_job_id) WHERE delivery_job_id IS NOT NULL',
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_user_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories(owner_user_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items(owner_user_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_pipelines_owner ON pipelines(owner_user_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_feishu_inbox_owner ON feishu_inbox(owner_user_id)')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_feishu_integrations_owner ON feishu_integrations(owner_user_id)',
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_owner ON feishu_agent_commands(owner_user_id, status, created_at)',
  )

  return db
}

const ownershipTableDefinitions: Record<
  string,
  { tableSql: string; legacyPattern: RegExp }
> = {
  accounts: {
    legacyPattern: /UNIQUE\s*\(\s*platform\s*,\s*username\s*\)/i,
    tableSql: `CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL CHECK (platform IN ('git', 'figma', 'feishu', 'build', 'device')),
      username TEXT NOT NULL,
      label TEXT NOT NULL,
      service_url TEXT NOT NULL DEFAULT '',
      secret_ciphertext TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      secret_hint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'expiring')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_user_id, platform, username)
    )`,
  },
  repositories: {
    legacyPattern: /url\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i,
    tableSql: `CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      branch TEXT NOT NULL,
      local_path TEXT NOT NULL DEFAULT '',
      build_enabled INTEGER NOT NULL DEFAULT 1 CHECK (build_enabled IN (0, 1)),
      build_account_id TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      last_sync TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('healthy', 'warning')),
      latest_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_user_id, url)
    )`,
  },
  work_items: {
    legacyPattern: /UNIQUE\s*\(\s*source\s*,\s*external_id\s*\)/i,
    tableSql: `CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('requirement', 'defect')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('紧急', '高', '中', '低')),
      status TEXT NOT NULL CHECK (status IN ('待处理', '进行中', '已交付', '已关闭')),
      repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
      branch TEXT NOT NULL,
      owner TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('local', 'feishu')),
      external_id TEXT,
      feishu_status TEXT,
      project_line TEXT,
      design_reference TEXT,
      requirement_breakdown TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_user_id, source, external_id)
    )`,
  },
  feishu_inbox: {
    legacyPattern: /external_id\s+TEXT\s+PRIMARY\s+KEY/i,
    tableSql: `CREATE TABLE feishu_inbox (
      external_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('requirement', 'defect')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('紧急', '高', '中', '低')),
      repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
      owner TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_user_id, external_id)
    )`,
  },
}

function migrateOwnershipTables(db: AppDatabase): void {
  for (const [table, definition] of Object.entries(ownershipTableDefinitions)) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined
    if (!row || !definition.legacyPattern.test(row.sql)) continue
    rebuildOwnedTable(db, table, definition.tableSql)
  }
}

function migrateAccountPlatforms(db: AppDatabase): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
    .get() as { sql: string } | undefined
  if (!row || row.sql.includes("'figma'")) return
  rebuildOwnedTable(
    db,
    'accounts',
    `CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL CHECK (platform IN ('git', 'figma', 'feishu', 'build', 'device')),
      username TEXT NOT NULL,
      label TEXT NOT NULL,
      service_url TEXT NOT NULL DEFAULT '',
      secret_ciphertext TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      secret_hint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'expiring')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_user_id, platform, username)
    )`,
  )
}

function rebuildOwnedTable(db: AppDatabase, table: string, tableSql: string): void {
  const temporaryTable = `${table}_owner_migration`
  db.exec(`DROP TABLE IF EXISTS ${temporaryTable}`)
  db.exec(tableSql.replace(`CREATE TABLE ${table} `, `CREATE TABLE ${temporaryTable} `))

  const oldColumns = (db.pragma(`table_info(${table})`) as { name: string }[]).map(
    (column) => column.name,
  )
  const newColumns = (db.pragma(`table_info(${temporaryTable})`) as { name: string }[]).map(
    (column) => column.name,
  )
  const sharedColumns = newColumns.filter((column) => oldColumns.includes(column))
  const columnList = sharedColumns.join(', ')
  db.exec(
    `INSERT INTO ${temporaryTable} (${columnList}) SELECT ${columnList} FROM ${table}`,
  )
  db.exec(`DROP TABLE ${table}`)
  db.exec(`ALTER TABLE ${temporaryTable} RENAME TO ${table}`)
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
  ensureColumn(db, 'feishu_agent_commands', 'owner_user_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'feishu_agent_commands', 'claimed_at', 'TEXT')
  ensureColumn(db, 'feishu_agent_commands', 'completed_at', 'TEXT')
  if (
    table.sql.includes("'configure_repo_paths'") &&
    table.sql.includes("'build_job_read'") &&
    table.sql.includes("'build_trigger'")
  ) {
    return
  }

  db.exec('DROP INDEX IF EXISTS idx_feishu_agent_commands_status')
  db.exec('ALTER TABLE feishu_agent_commands RENAME TO feishu_agent_commands_legacy')
  db.exec(`
    CREATE TABLE feishu_agent_commands (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL DEFAULT 'primary',
      command_type TEXT NOT NULL CHECK (command_type IN ('login_start', 'sync', 'rotate_token', 'configure_repo_paths', 'delivery_start', 'build_job_read', 'build_trigger')),
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
      (id, owner_user_id, client_id, command_type, status, payload_json, result_json, error, created_at, updated_at, claimed_at, completed_at)
    SELECT id, '', client_id, command_type, status, payload_json, result_json, error, created_at, updated_at, claimed_at, completed_at
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
