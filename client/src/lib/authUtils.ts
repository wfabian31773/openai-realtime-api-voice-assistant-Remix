import { AxiosError } from 'axios'

export function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof AxiosError) {
    return error.response?.status === 401
  }
  return false
}
