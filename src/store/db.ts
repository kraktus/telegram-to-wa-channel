import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { and, asc, count, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { NormalizedPost } from '../types.js'
import { jobs, state, waMessages } from './schema.js'

export type JobRecord = typeof jobs.$inferSelect
export type JobStatus = JobRecord['status']
export type JobOperation = JobRecord['operation']
export type EditEnqueueResult = 'updated-pending' | 'queued' | 'coalesced' | 'no-original'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

export class Store {
  private readonly sqlite: Database.Database
  private readonly db: BetterSQLite3Database

  constructor(dbPath: string) {
    const directory = path.dirname(path.resolve(dbPath))
    fs.mkdirSync(directory, { recursive: true })

    this.sqlite = new Database(dbPath)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('foreign_keys = ON')

    this.db = drizzle({ client: this.sqlite })
    if (!fs.existsSync(MIGRATIONS_FOLDER)) {
      this.sqlite.close()
      throw new Error(`Drizzle migrations folder not found at ${MIGRATIONS_FOLDER}`)
    }
    migrate(this.db, { migrationsFolder: MIGRATIONS_FOLDER })
    this.resetSending()
  }

  close(): void {
    this.sqlite.close()
  }

  getState(key: string): string | undefined {
    return this.db
      .select({ value: state.value })
      .from(state)
      .where(eq(state.key, key))
      .get()?.value
  }

  setState(key: string, value: string): void {
    this.db
      .insert(state)
      .values({ key, value })
      .onConflictDoUpdate({ target: state.key, set: { value } })
      .run()
  }

  deleteState(key: string): void {
    this.db.delete(state).where(eq(state.key, key)).run()
  }

  /** Returns false when the post was already enqueued (idempotency). */
  enqueue(post: NormalizedPost): boolean {
    const result = this.db
      .insert(jobs)
      .values({
        sourceChatId: post.sourceChatId,
        sourceMessageId: post.sourceMessageId,
        operation: 'send',
        payload: post,
        status: 'pending',
        attempts: 0,
        createdAt: Date.now()
      })
      .onConflictDoNothing()
      .run()
    return result.changes > 0
  }

  /**
   * Queue an edit for a post that is already in WhatsApp. If the original send
   * has not started yet, its payload is replaced instead, so the first send
   * already carries the edited content. Repeated edits coalesce into the
   * pending edit job and keep its queue position.
   */
  enqueueEdit(post: NormalizedPost): EditEnqueueResult {
    return this.db.transaction((tx): EditEnqueueResult => {
      const send = tx
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceChatId, post.sourceChatId),
            eq(jobs.sourceMessageId, post.sourceMessageId),
            eq(jobs.operation, 'send')
          )
        )
        .orderBy(desc(jobs.id))
        .limit(1)
        .get()

      if (send?.status === 'pending') {
        tx.update(jobs).set({ payload: post }).where(eq(jobs.id, send.id)).run()
        return 'updated-pending'
      }

      const mapped = tx
        .select({ sourceMessageId: waMessages.sourceMessageId })
        .from(waMessages)
        .where(
          and(
            eq(waMessages.sourceChatId, post.sourceChatId),
            eq(waMessages.sourceMessageId, post.sourceMessageId)
          )
        )
        .get()

      if ((!send || send.status === 'failed' || send.status === 'skipped') && !mapped) {
        return 'no-original'
      }

      const pendingEdit = tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceChatId, post.sourceChatId),
            eq(jobs.sourceMessageId, post.sourceMessageId),
            eq(jobs.operation, 'edit'),
            eq(jobs.status, 'pending')
          )
        )
        .orderBy(desc(jobs.id))
        .limit(1)
        .get()

      if (pendingEdit) {
        tx.update(jobs).set({ payload: post }).where(eq(jobs.id, pendingEdit.id)).run()
        return 'coalesced'
      }

      tx.insert(jobs)
        .values({
          sourceChatId: post.sourceChatId,
          sourceMessageId: post.sourceMessageId,
          operation: 'edit',
          payload: post,
          status: 'pending',
          attempts: 0,
          createdAt: Date.now()
        })
        .run()
      return 'queued'
    })
  }

  claimNext(now = Date.now()): JobRecord | undefined {
    return this.db.transaction(tx => {
      const row = tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, 'pending'),
            or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now))
          )
        )
        .orderBy(asc(jobs.id))
        .limit(1)
        .get()

      if (!row) return undefined
      tx.update(jobs).set({ status: 'sending' }).where(eq(jobs.id, row.id)).run()
      return row
    })
  }

  markDone(job: JobRecord, waJid: string, waMessageId: string): void {
    this.db.transaction(tx => {
      tx.update(jobs)
        .set({ status: 'done', lastError: null })
        .where(eq(jobs.id, job.id))
        .run()
      tx.insert(waMessages)
        .values({
          sourceChatId: job.sourceChatId,
          sourceMessageId: job.sourceMessageId,
          waJid,
          waMessageId
        })
        .onConflictDoUpdate({
          target: [waMessages.sourceChatId, waMessages.sourceMessageId],
          set: { waJid, waMessageId }
        })
        .run()
      const now = String(Date.now())
      tx.insert(state)
        .values({ key: 'last_relay_at', value: now })
        .onConflictDoUpdate({ target: state.key, set: { value: now } })
        .run()
    })
  }

  /** An edit does not change the original WhatsApp message key. */
  markEditDone(job: JobRecord): void {
    this.db
      .update(jobs)
      .set({ status: 'done', lastError: null })
      .where(eq(jobs.id, job.id))
      .run()
  }

  /** Payload of the original send, used to reject edits that change post type. */
  getSendPayload(
    sourceChatId: string,
    sourceMessageId: number
  ): NormalizedPost | undefined {
    return this.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.sourceChatId, sourceChatId),
          eq(jobs.sourceMessageId, sourceMessageId),
          eq(jobs.operation, 'send')
        )
      )
      .orderBy(desc(jobs.id))
      .limit(1)
      .get()?.payload
  }

  markRetry(job: JobRecord, error: string, delayMs: number): void {
    this.db
      .update(jobs)
      .set({
        status: 'pending',
        attempts: job.attempts + 1,
        lastError: error.slice(0, 1000),
        nextAttemptAt: Date.now() + delayMs
      })
      .where(eq(jobs.id, job.id))
      .run()
  }

  markFailed(job: JobRecord, error: string): void {
    this.db
      .update(jobs)
      .set({ status: 'failed', lastError: error.slice(0, 1000) })
      .where(eq(jobs.id, job.id))
      .run()
  }

  markSkipped(job: JobRecord, error: string): void {
    this.db
      .update(jobs)
      .set({ status: 'skipped', lastError: error.slice(0, 1000) })
      .where(eq(jobs.id, job.id))
      .run()
  }

  /** Jobs interrupted by a restart go back to the queue. */
  resetSending(): number {
    return this.db
      .update(jobs)
      .set({ status: 'pending' })
      .where(eq(jobs.status, 'sending'))
      .run().changes
  }

  queueDepth(): number {
    return (
      this.db
        .select({ n: count() })
        .from(jobs)
        .where(inArray(jobs.status, ['pending', 'sending']))
        .get()?.n ?? 0
    )
  }

  counts(): Record<JobStatus, number> {
    const rows = this.db
      .select({ status: jobs.status, n: count() })
      .from(jobs)
      .groupBy(jobs.status)
      .all()
    const result: Record<JobStatus, number> = {
      pending: 0,
      sending: 0,
      done: 0,
      failed: 0,
      skipped: 0
    }
    for (const row of rows) result[row.status] = row.n
    return result
  }

  /** Message keys for edits. */
  getWaMessage(
    sourceChatId: string,
    sourceMessageId: number
  ): { waJid: string; waMessageId: string } | undefined {
    return this.db
      .select({ waJid: waMessages.waJid, waMessageId: waMessages.waMessageId })
      .from(waMessages)
      .where(
        and(
          eq(waMessages.sourceChatId, sourceChatId),
          eq(waMessages.sourceMessageId, sourceMessageId)
        )
      )
      .get()
  }
}
