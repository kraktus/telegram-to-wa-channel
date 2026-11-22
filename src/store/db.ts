import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { NormalizedPost } from '../types.js'

export type JobStatus = 'pending' | 'sending' | 'done' | 'failed' | 'skipped'
export type JobOperation = 'send' | 'edit'
export type EditEnqueueResult = 'updated-pending' | 'queued' | 'coalesced' | 'no-original'

export interface JobRecord {
  id: number
  sourceChatId: string
  sourceMessageId: number
  operation: JobOperation
  payload: NormalizedPost
  status: JobStatus
  attempts: number
  nextAttemptAt: number | null
  lastError: string | null
  createdAt: number
}

interface JobRow {
  id: number
  source_chat_id: string
  source_message_id: number
  operation: JobOperation
  payload: string
  status: JobStatus
  attempts: number
  next_attempt_at: number | null
  last_error: string | null
  created_at: number
}

const JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_chat_id    TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  operation         TEXT NOT NULL DEFAULT 'send',
  payload           TEXT NOT NULL,
  status            TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL
);
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

${JOBS_TABLE}

CREATE TABLE IF NOT EXISTS wa_messages (
  source_chat_id    TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  wa_jid            TEXT NOT NULL,
  wa_message_id     TEXT NOT NULL,
  PRIMARY KEY (source_chat_id, source_message_id)
);
`

const JOB_INDICES = `
CREATE UNIQUE INDEX IF NOT EXISTS jobs_send_unique
  ON jobs (source_chat_id, source_message_id) WHERE operation = 'send';

CREATE INDEX IF NOT EXISTS jobs_status_next ON jobs (status, next_attempt_at);
`

export class Store {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    const directory = path.dirname(path.resolve(dbPath))
    fs.mkdirSync(directory, { recursive: true })

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.migrateJobs()
    this.db.exec(JOB_INDICES)
    this.resetSending()
  }

  close(): void {
    this.db.close()
  }

  /**
   * v0.1 had a single job per source message. Edits need extra operations, so
   * add the `operation` column and relax the unique constraint to sends only.
   */
  private migrateJobs(): void {
    const columns = this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>
    if (columns.length === 0) return
    if (columns.some(column => column.name === 'operation')) return

    const migrate = this.db.transaction(() => {
      this.db.exec('ALTER TABLE jobs RENAME TO jobs_v1')
      this.db.exec(JOBS_TABLE)
      this.db.exec(`
        INSERT INTO jobs
          (id, source_chat_id, source_message_id, operation, payload, status,
           attempts, next_attempt_at, last_error, created_at)
        SELECT id, source_chat_id, source_message_id, 'send', payload, status,
               attempts, next_attempt_at, last_error, created_at
        FROM jobs_v1
      `)
      this.db.exec('DROP TABLE jobs_v1')
    })
    migrate()
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM state WHERE key = ?').run(key)
  }

  /** Returns false when the post was already enqueued (idempotency). */
  enqueue(post: NormalizedPost): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs
           (source_chat_id, source_message_id, operation, payload, status, attempts, created_at)
         VALUES (?, ?, 'send', ?, 'pending', 0, ?)`
      )
      .run(post.sourceChatId, post.sourceMessageId, JSON.stringify(post), Date.now())
    return result.changes > 0
  }

  /**
   * Queue an edit for a post that is already in WhatsApp. If the original send
   * has not started yet, its payload is replaced instead, so the first send
   * already carries the edited content. Repeated edits coalesce into the
   * pending edit job and keep its queue position.
   */
  enqueueEdit(post: NormalizedPost): EditEnqueueResult {
    const enqueue = this.db.transaction((): EditEnqueueResult => {
      const send = this.db
        .prepare(
          `SELECT id, status FROM jobs
           WHERE source_chat_id = ? AND source_message_id = ? AND operation = 'send'
           ORDER BY id DESC LIMIT 1`
        )
        .get(post.sourceChatId, post.sourceMessageId) as
        | { id: number; status: JobStatus }
        | undefined

      if (send?.status === 'pending') {
        this.db
          .prepare('UPDATE jobs SET payload = ? WHERE id = ?')
          .run(JSON.stringify(post), send.id)
        return 'updated-pending'
      }

      if (
        (!send || send.status === 'failed' || send.status === 'skipped') &&
        !this.getWaMessage(post.sourceChatId, post.sourceMessageId)
      ) {
        return 'no-original'
      }

      const pendingEdit = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE source_chat_id = ? AND source_message_id = ?
             AND operation = 'edit' AND status = 'pending'
           ORDER BY id DESC LIMIT 1`
        )
        .get(post.sourceChatId, post.sourceMessageId) as { id: number } | undefined

      if (pendingEdit) {
        this.db
          .prepare('UPDATE jobs SET payload = ? WHERE id = ?')
          .run(JSON.stringify(post), pendingEdit.id)
        return 'coalesced'
      }

      this.db
        .prepare(
          `INSERT INTO jobs
             (source_chat_id, source_message_id, operation, payload, status, attempts, created_at)
           VALUES (?, ?, 'edit', ?, 'pending', 0, ?)`
        )
        .run(
          post.sourceChatId,
          post.sourceMessageId,
          JSON.stringify(post),
          Date.now()
        )
      return 'queued'
    })

    return enqueue()
  }

  claimNext(now = Date.now()): JobRecord | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY id
           LIMIT 1`
        )
        .get(now) as JobRow | undefined
      if (!row) return undefined
      this.db.prepare("UPDATE jobs SET status = 'sending' WHERE id = ?").run(row.id)
      return row
    })

    const row = claim()
    if (!row) return undefined
    return {
      id: row.id,
      sourceChatId: row.source_chat_id,
      sourceMessageId: row.source_message_id,
      operation: row.operation,
      payload: JSON.parse(row.payload) as NormalizedPost,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at
    }
  }

  markDone(job: JobRecord, waJid: string, waMessageId: string): void {
    const finish = this.db.transaction(() => {
      this.db
        .prepare("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ?")
        .run(job.id)
      this.db
        .prepare(
          `INSERT OR REPLACE INTO wa_messages
             (source_chat_id, source_message_id, wa_jid, wa_message_id)
           VALUES (?, ?, ?, ?)`
        )
        .run(job.sourceChatId, job.sourceMessageId, waJid, waMessageId)
      this.setState('last_relay_at', String(Date.now()))
    })
    finish()
  }

  /** An edit does not change the original WhatsApp message key. */
  markEditDone(job: JobRecord): void {
    this.db
      .prepare("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ?")
      .run(job.id)
  }

  /** Payload of the original send, used to reject edits that change post type. */
  getSendPayload(
    sourceChatId: string,
    sourceMessageId: number
  ): NormalizedPost | undefined {
    const row = this.db
      .prepare(
        `SELECT payload FROM jobs
         WHERE source_chat_id = ? AND source_message_id = ? AND operation = 'send'
         ORDER BY id DESC LIMIT 1`
      )
      .get(sourceChatId, sourceMessageId) as { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as NormalizedPost) : undefined
  }

  markRetry(job: JobRecord, error: string, delayMs: number): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending', attempts = attempts + 1, last_error = ?, next_attempt_at = ?
         WHERE id = ?`
      )
      .run(error.slice(0, 1000), Date.now() + delayMs, job.id)
  }

  markFailed(job: JobRecord, error: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?")
      .run(error.slice(0, 1000), job.id)
  }

  markSkipped(job: JobRecord, error: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'skipped', last_error = ? WHERE id = ?")
      .run(error.slice(0, 1000), job.id)
  }

  /** Jobs interrupted by a restart go back to the queue. */
  resetSending(): number {
    return this.db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'sending'").run().changes
  }

  queueDepth(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'sending')")
      .get() as { count: number }
    return row.count
  }

  counts(): Record<JobStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')
      .all() as Array<{ status: JobStatus; count: number }>
    const result: Record<JobStatus, number> = {
      pending: 0,
      sending: 0,
      done: 0,
      failed: 0,
      skipped: 0
    }
    for (const row of rows) result[row.status] = row.count
    return result
  }

  /** Message keys for future edit/delete support. */
  getWaMessage(sourceChatId: string, sourceMessageId: number):
    | { waJid: string; waMessageId: string }
    | undefined {
    const row = this.db
      .prepare(
        'SELECT wa_jid, wa_message_id FROM wa_messages WHERE source_chat_id = ? AND source_message_id = ?'
      )
      .get(sourceChatId, sourceMessageId) as { wa_jid: string; wa_message_id: string } | undefined
    if (!row) return undefined
    return { waJid: row.wa_jid, waMessageId: row.wa_message_id }
  }
}
