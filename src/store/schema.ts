import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'
import type { NormalizedPost } from '../types.js'

export const state = sqliteTable('state', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceChatId: text('source_chat_id').notNull(),
    sourceMessageId: integer('source_message_id').notNull(),
    operation: text('operation', { enum: ['send', 'edit'] }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<NormalizedPost>().notNull(),
    status: text('status', {
      enum: ['pending', 'sending', 'done', 'failed', 'skipped']
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull()
  },
  table => [
    uniqueIndex('jobs_send_unique')
      .on(table.sourceChatId, table.sourceMessageId)
      .where(sql`${table.operation} = 'send'`),
    index('jobs_status_next').on(table.status, table.nextAttemptAt)
  ]
)

export const waMessages = sqliteTable(
  'wa_messages',
  {
    sourceChatId: text('source_chat_id').notNull(),
    sourceMessageId: integer('source_message_id').notNull(),
    waJid: text('wa_jid').notNull(),
    waMessageId: text('wa_message_id').notNull()
  },
  table => [primaryKey({ columns: [table.sourceChatId, table.sourceMessageId] })]
)
