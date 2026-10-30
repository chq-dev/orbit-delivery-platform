export const SCHEMA_VERSION = 14

export const schemaSql = `
CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK (value >= 0)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('git', 'feishu', 'build', 'device')),
  username TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  secret_hint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expiring')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, username)
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  local_path TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  last_sync TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'warning')),
  latest_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
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
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS work_item_attachments (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  data_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_item_attachments_item
  ON work_item_attachments(work_item_id, created_at);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('requirement', 'defect')),
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  local_path TEXT NOT NULL DEFAULT '',
  commit_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed')),
  progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
  current_stage INTEGER NOT NULL CHECK (current_stage BETWEEN 0 AND 9),
  triggered_by TEXT NOT NULL,
  auto_commit INTEGER NOT NULL CHECK (auto_commit IN (0, 1)),
  auto_close INTEGER NOT NULL CHECK (auto_close IN (0, 1)),
  simulation INTEGER NOT NULL CHECK (simulation IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipelines_work_item ON pipelines(work_item_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_status ON pipelines(status);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_index INTEGER NOT NULL CHECK (stage_index BETWEEN 0 AND 8),
  stage_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
  duration TEXT,
  log TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (pipeline_id, stage_index)
);

CREATE TABLE IF NOT EXISTS pipeline_reports (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('design', 'integration')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_id, kind)
);

CREATE TABLE IF NOT EXISTS pipeline_report_sections (
  report_id TEXT NOT NULL REFERENCES pipeline_reports(id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (report_id, section_index)
);

CREATE TABLE IF NOT EXISTS test_reports (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL UNIQUE REFERENCES pipelines(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'warning', 'failed')),
  total INTEGER NOT NULL CHECK (total >= 0),
  passed INTEGER NOT NULL CHECK (passed >= 0),
  failed INTEGER NOT NULL CHECK (failed >= 0),
  skipped INTEGER NOT NULL CHECK (skipped >= 0),
  duration TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_suites (
  report_id TEXT NOT NULL REFERENCES test_reports(id) ON DELETE CASCADE,
  suite_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  duration TEXT NOT NULL,
  PRIMARY KEY (report_id, suite_index)
);

CREATE TABLE IF NOT EXISTS failed_cases (
  report_id TEXT NOT NULL REFERENCES test_reports(id) ON DELETE CASCADE,
  case_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  suite TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (report_id, case_index)
);

CREATE TABLE IF NOT EXISTS feishu_inbox (
  external_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('requirement', 'defect')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('紧急', '高', '中', '低')),
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_integrations (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_secret_ciphertext TEXT NOT NULL,
  plugin_secret_iv TEXT NOT NULL,
  plugin_secret_tag TEXT NOT NULL,
  plugin_secret_hint TEXT NOT NULL,
  user_key TEXT NOT NULL,
  default_repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  requirement_type_key TEXT NOT NULL,
  defect_type_key TEXT NOT NULL,
  default_owner TEXT NOT NULL,
  close_transition_id TEXT,
  webhook_secret_ciphertext TEXT,
  webhook_secret_iv TEXT,
  webhook_secret_tag TEXT,
  webhook_secret_hint TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'error')),
  last_sync_at TEXT,
  last_sync_status TEXT CHECK (last_sync_status IN ('success', 'failed')),
  last_sync_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_sync_logs (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES feishu_integrations(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'event', 'schedule')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  fetched INTEGER NOT NULL CHECK (fetched >= 0),
  upserted INTEGER NOT NULL CHECK (upserted >= 0),
  skipped INTEGER NOT NULL CHECK (skipped >= 0),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_access_tokens (
  integration_id TEXT PRIMARY KEY REFERENCES feishu_integrations(id) ON DELETE CASCADE,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_event_dedup (
  event_key TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_sync_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_agent_state (
  id TEXT PRIMARY KEY,
  health_json TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_agent_commands (
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
);

CREATE TABLE IF NOT EXISTS feishu_outbox (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES feishu_integrations(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('close')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_item_id, action)
);

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_repo ON work_items(repo_id);
CREATE INDEX IF NOT EXISTS idx_feishu_sync_logs_created ON feishu_sync_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_feishu_outbox_pending ON feishu_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_feishu_agent_commands_status ON feishu_agent_commands(status, created_at);
`
