import pino from 'pino'
import pretty from 'pino-pretty'
import type { Config } from './config.js'
import { resolveLogConsole } from './config.js'
import type { TelegramLogSink } from './telegram/log-sink.js'

export type AppLogger = pino.Logger

export function createLogger(config: Config, sink?: TelegramLogSink): AppLogger {
  const level = config.LOG_LEVEL
  const consoleStream =
    resolveLogConsole(config.LOG_CONSOLE) === 'pretty'
      ? pretty({
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,app',
          singleLine: true
        })
      : process.stdout

  // Stream-level filtering is left at trace so the logger level is the single
  // switch (needed for the /debug toggle); the Telegram sink applies its own
  // level routing.
  const streams: pino.StreamEntry[] = [{ level: 'trace', stream: consoleStream }]
  if (sink) streams.push({ level: 'trace', stream: sink })

  return pino(
    {
      level,
      base: { app: 'relay' },
      redact: {
        paths: [
          'token',
          '*.token',
          'botToken',
          '*.botToken',
          'phone',
          '*.phone',
          'pairingCode',
          '*.pairingCode',
          'creds',
          '*.creds'
        ],
        censor: '[redacted]'
      }
    },
    pino.multistream(streams)
  )
}
