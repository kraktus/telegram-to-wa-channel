import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import type { Api } from 'grammy'
import { PermanentError } from '../errors.js'
import type { AppLogger } from '../logger.js'

let ffmpegChecked = false
let ffmpegPresent = false

export function hasFfmpeg(): boolean {
  if (!ffmpegChecked) {
    ffmpegChecked = true
    try {
      const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
      ffmpegPresent = result.status === 0
    } catch {
      ffmpegPresent = false
    }
  }
  return ffmpegPresent
}

/** Download a Telegram file, refusing anything above maxBytes. */
export async function downloadTelegramFile(
  api: Api,
  botToken: string,
  fileId: string,
  maxBytes: number,
  logger: AppLogger
): Promise<Buffer> {
  let file: Awaited<ReturnType<Api['getFile']>>
  try {
    file = await api.getFile(fileId)
  } catch (error) {
    const code = (error as { error_code?: number }).error_code
    if (code === 400 || code === 404) {
      throw new PermanentError(`Telegram cannot provide this file (HTTP ${code})`)
    }
    throw error
  }

  if (typeof file.file_size === 'number' && file.file_size > maxBytes) {
    throw new PermanentError(
      `media too large (${Math.round(file.file_size / 1024 / 1024)} MB > ${Math.round(maxBytes / 1024 / 1024)} MB)`
    )
  }
  if (!file.file_path) {
    throw new PermanentError('Telegram did not return a file_path')
  }

  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
  const response = await fetch(url)
  if (!response.ok) {
    if (response.status === 400 || response.status === 404) {
      throw new PermanentError(`Telegram file download failed with HTTP ${response.status}`)
    }
    throw new Error(`Telegram file download failed with HTTP ${response.status}`)
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) {
    throw new PermanentError(`media too large (${Math.round(declared / 1024 / 1024)} MB)`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) {
    throw new PermanentError(`media too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`)
  }
  logger.debug({ bytes: buffer.byteLength }, 'telegram media downloaded')
  return buffer
}

export async function detectMime(buffer: Buffer): Promise<string | undefined> {
  try {
    return (await fileTypeFromBuffer(buffer))?.mime
  } catch {
    return undefined
  }
}

/** Transcode any audio/video input to mono Ogg/Opus, which WhatsApp plays as a voice note. */
export async function transcodeToOpusOgg(input: Buffer): Promise<Buffer> {
  if (!hasFfmpeg()) {
    throw new PermanentError('ffmpeg is not installed; cannot build a WhatsApp voice note')
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-audio-'))
  const inputPath = path.join(directory, 'input')
  const outputPath = path.join(directory, 'output.ogg')

  try {
    await fs.writeFile(inputPath, input)
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-c:a',
        'libopus',
        '-b:a',
        '64k',
        '-f',
        'ogg',
        outputPath
      ])
      const errors: Buffer[] = []
      child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
      child.on('error', reject)
      child.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg exited with ${code}: ${Buffer.concat(errors).toString().slice(0, 300)}`))
      })
    })
    return await fs.readFile(outputPath)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
