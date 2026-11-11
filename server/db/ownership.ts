import type { AppDatabase } from './database.js'

export function primaryUserId(db: AppDatabase): string | undefined {
  const row = db
    .prepare('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1')
    .get() as { id: string } | undefined
  return row?.id
}

export function isPrimaryUser(db: AppDatabase, userId?: string): boolean {
  if (!userId) return false
  return primaryUserId(db) === userId
}

export function defaultOwnerUserId(db: AppDatabase, requested?: string): string {
  if (requested) return requested
  return primaryUserId(db) ?? ''
}

export function backfillOwnershipToUser(db: AppDatabase, userId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE accounts SET owner_user_id = ? WHERE owner_user_id = ''").run(userId)
    db.prepare(
      `UPDATE repositories
       SET owner_user_id = COALESCE(
         NULLIF((SELECT owner_user_id FROM accounts WHERE accounts.id = repositories.account_id), ''),
         ?
       )
       WHERE owner_user_id = ''`,
    ).run(userId)
    db.prepare(
      `UPDATE work_items
       SET owner_user_id = COALESCE(
         NULLIF((SELECT owner_user_id FROM repositories WHERE repositories.id = work_items.repo_id), ''),
         ?
       )
       WHERE owner_user_id = ''`,
    ).run(userId)
    db.prepare(
      `UPDATE pipelines
       SET owner_user_id = COALESCE(
         NULLIF((SELECT owner_user_id FROM work_items WHERE work_items.id = pipelines.work_item_id), ''),
         ?
       )
       WHERE owner_user_id = ''`,
    ).run(userId)
    db.prepare(
      `UPDATE feishu_inbox
       SET owner_user_id = COALESCE(
         NULLIF((SELECT owner_user_id FROM repositories WHERE repositories.id = feishu_inbox.repo_id), ''),
         ?
       )
       WHERE owner_user_id = ''`,
    ).run(userId)
    db.prepare(
      `UPDATE feishu_integrations
       SET owner_user_id = COALESCE(
         NULLIF((SELECT owner_user_id FROM repositories WHERE repositories.id = feishu_integrations.default_repo_id), ''),
         ?
       )
       WHERE owner_user_id = ''`,
    ).run(userId)
    db.prepare("UPDATE feishu_agent_commands SET owner_user_id = ? WHERE owner_user_id = ''").run(
      userId,
    )
    db.prepare("UPDATE feishu_agent_state SET owner_user_id = ? WHERE owner_user_id = ''").run(
      userId,
    )
    db.prepare(
      "UPDATE feishu_agent_credentials SET owner_user_id = ? WHERE owner_user_id = ''",
    ).run(userId)
    db.prepare(
      "UPDATE feishu_agent_pairings SET owner_user_id = ? WHERE owner_user_id = ''",
    ).run(userId)
  })()
}

export function backfillOwnershipToFirstUser(db: AppDatabase): void {
  const userId = primaryUserId(db)
  if (userId) backfillOwnershipToUser(db, userId)
}

export function claimUnownedDataForUser(db: AppDatabase, userId: string): void {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
  if (row.count !== 1) return
  backfillOwnershipToUser(db, userId)
}
