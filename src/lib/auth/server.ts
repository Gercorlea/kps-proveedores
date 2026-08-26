import { cookies } from 'next/headers'
import { SESSION_COOKIE, esInterno, verifySession, type SessionPayload } from './session'

/**
 * Lectura de la sesion del lado del servidor.
 *
 * `session.ts` solo firma y verifica, porque lo importa el middleware y ese
 * corre en edge, donde no existe `next/headers`. Este modulo es la mitad que si
 * puede tocar cookies: lo usan los componentes de servidor y los handlers de la
 * API, nunca el middleware.
 *
 * El middleware ya bloquea las rutas de pagina, pero NO las de `/api/` —esta
 * excluido en su matcher a proposito—, asi que cada handler tiene que exigir la
 * sesion por su cuenta. De ahi `requireInterno`.
 */

export async function getSession(): Promise<SessionPayload | null> {
  const secret = process.env.JWT_SECRET
  if (!secret) return null
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return verifySession(token, secret)
}

/** Error con el codigo HTTP ya decidido, para que el handler no lo adivine. */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Exige sesion de un rol interno de KPS. Devuelve la sesion para que el handler
 * pueda registrar en la bitacora quien hizo el cambio: §11 pide actor en cada
 * evento, y sin devolverlo aqui el handler tendria que volver a leer la cookie.
 */
export async function requireInterno(): Promise<SessionPayload> {
  const session = await getSession()
  if (!session) throw new AuthError(401, 'Necesitas iniciar sesion.')
  if (!esInterno(session.roles)) {
    throw new AuthError(403, 'Esta operacion es solo para personal de KPS.')
  }
  return session
}
