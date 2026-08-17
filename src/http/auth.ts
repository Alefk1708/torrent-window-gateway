import type { FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { HttpError } from '../errors.js'
import { constantTimeEqual } from '../security/credentials.js'

export function isAdminRequest(request: FastifyRequest, config: AppConfig): boolean {
  const authorization = request.headers.authorization
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  const headerKey = request.headers['x-api-key']
  const explicitKey = typeof headerKey === 'string' ? headerKey : ''
  const bearerValid = bearer !== '' && constantTimeEqual(bearer, config.apiKey)
  const headerValid = explicitKey !== '' && constantTimeEqual(explicitKey, config.apiKey)
  return bearerValid || headerValid
}

export function requireAdmin(request: FastifyRequest, config: AppConfig): void {
  if (!isAdminRequest(request, config)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'A valid API key is required')
  }
}

export function playbackTokenFromRequest(request: FastifyRequest): string {
  const header = request.headers['x-playback-token']
  if (typeof header === 'string' && header !== '') return header
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) {
    const bearer = authorization.slice(7).trim()
    if (bearer !== '') return bearer
  }
  const query = request.query as Record<string, unknown>
  const token = query.token
  return typeof token === 'string' ? token : ''
}
