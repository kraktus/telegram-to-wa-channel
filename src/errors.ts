/** An error that must not be retried (bad media, unsupported type, permission denied...). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentError'
  }
}

export function isPermanentError(error: unknown): error is PermanentError {
  return error instanceof PermanentError
}
