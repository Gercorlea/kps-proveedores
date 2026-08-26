import { SignJWT, jwtVerify } from 'jose'

/**
 * Sesion del portal.
 *
 * Se firma con jose y no con una libreria de node porque el middleware corre en
 * el runtime edge, donde no hay `crypto` de node ni Prisma. El middleware solo
 * verifica la firma; consultar al usuario en la base es cosa de los handlers.
 */

export const SESSION_COOKIE = 'kps_session'

/**
 * Roles del portal. Espejo del enum UserRole de Prisma, declarado a mano para
 * no importar el cliente de Prisma —que no funciona en edge— desde el middleware.
 */
export type Rol =
  | 'PROVEEDOR_MERCANCIA'
  | 'PROVEEDOR_SERVICIO'
  | 'KPS_ALTAS'
  | 'KPS_REVISION'
  | 'KPS_PAGOS'
  | 'KPS_COMPRAS'
  | 'ADMIN_SISTEMA'

export interface SessionPayload {
  userId: string
  email: string
  name: string
  roles: Rol[]
  /** CardCode del proveedor. Ausente en usuarios internos de KPS. */
  supplierCode?: string | null
}

const ROLES_INTERNOS: readonly Rol[] = [
  'KPS_ALTAS',
  'KPS_REVISION',
  'KPS_PAGOS',
  'KPS_COMPRAS',
  'ADMIN_SISTEMA',
]

export function esInterno(roles: readonly Rol[]): boolean {
  return roles.some((r) => ROLES_INTERNOS.includes(r))
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(payload.userId)
    .sign(secretKey(secret))
}

/**
 * Devuelve null en vez de lanzar: una cookie caducada o manipulada no es un
 * error del servidor, es simplemente una sesion que no vale.
 */
export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey(secret))
    const { userId, email, name, roles, supplierCode } = payload as unknown as SessionPayload
    if (!userId || !Array.isArray(roles)) return null
    return { userId, email, name, roles, supplierCode: supplierCode ?? null }
  } catch {
    return null
  }
}
