import os from 'node:os'
import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

const boolFromEnv = (fallback: boolean) =>
  z
    .preprocess(value => {
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
      return value
    }, z.boolean())
    .default(fallback)

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional())

const envSchema = z
  .object({
    TG_BOT_TOKEN: z.string().min(10, 'TG_BOT_TOKEN looks too short'),
    TG_SOURCE_CHAT_ID: z.string().min(1),
    TG_ADMIN_USER_ID: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional()
    ),
    // On the first run (no stored offset), replay Telegram's pending update
    // queue instead of skipping to the newest post. Bot API retains ~24h.
    TG_BACKFILL: boolFromEnv(false),

    WA_CHANNEL_INVITE: optionalString,
    WA_CHANNEL_JID: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^\d+@newsletter$/, 'WA_CHANNEL_JID must look like <id>@newsletter')
        .optional()
    ),
    WA_PHONE_NUMBER: z
      .string()
      .regex(/^[1-9]\d{6,14}$/, 'WA_PHONE_NUMBER must be E.164 digits without "+" (e.g. 33612345678)'),

    // How the device is linked on first run. Both methods can be started at
    // runtime with /login (code) and /qr (photo); this is the default.
    WA_LOGIN_METHOD: z.enum(['pairing_code', 'qr']).default('pairing_code'),

    WA_AUTH_DIR: z.string().min(1).default('./data/wa-auth'),
    WA_DB_PATH: z.string().min(1).default('./data/relay.db'),

    RELAY_EDITS: boolFromEnv(false),
    MAX_MEDIA_MB: z.coerce.number().positive().default(20),
    // PDFs are posted page-by-page as images; cap the number of pages per post.
    PDF_MAX_PAGES: z.coerce.number().int().min(1).max(200).default(30),
    SEND_DELAY_MS: z.coerce.number().int().min(0).default(1000),
    DRY_RUN: boolFromEnv(false),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_CONSOLE: z.enum(['auto', 'json', 'pretty']).default('auto'),
    LOG_DIGEST_MS: z.coerce.number().int().min(1000).default(300_000),
    LOG_RING_SIZE: z.coerce.number().int().min(50).default(1000),

    HEALTH_PORT: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(65535).optional()
    )
  })
  .superRefine((value, ctx) => {
    if (!value.WA_CHANNEL_INVITE && !value.WA_CHANNEL_JID) {
      ctx.addIssue({
        code: 'custom',
        message: 'Set WA_CHANNEL_INVITE or WA_CHANNEL_JID',
        path: ['WA_CHANNEL_INVITE']
      })
    }
  })

export type Config = z.infer<typeof envSchema>

export const DEFAULT_ENV_FILE = path.join(
  os.homedir(),
  'dev',
  'secrets',
  'telegram-to-wa-channel',
  '.env'
)

/**
 * Load the secrets file into process.env. Real process env wins because dotenv
 * never overwrites variables that are already set.
 */
export function bootstrapEnv(envFile = process.env.ENV_FILE ?? DEFAULT_ENV_FILE): string {
  const result = dotenv.config({ path: envFile, quiet: true })
  if (result.error && !process.env.TG_BOT_TOKEN) {
    throw new Error(
      `No config: set ENV_FILE or create ${envFile} (chmod 600), see .env.example`
    )
  }
  return envFile
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid configuration: ${details}`)
  }
  return parsed.data
}

export function resolveLogConsole(value: Config['LOG_CONSOLE']): 'json' | 'pretty' {
  if (value === 'auto') return process.stdout.isTTY ? 'pretty' : 'json'
  return value
}
