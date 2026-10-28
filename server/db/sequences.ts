import type { AppDatabase } from './database.js'

export function nextSequence(db: AppDatabase, name: string, initial = 1): number {
  const current = db.prepare('SELECT value FROM sequences WHERE name = ?').get(name) as
    | { value: number }
    | undefined
  const next = (current?.value ?? initial - 1) + 1
  db.prepare(
    `INSERT INTO sequences (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
  ).run(name, next)
  return next
}
