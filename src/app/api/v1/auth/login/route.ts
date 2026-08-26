import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getConfig, requireJwtSecret } from '@/lib/config'
import { users } from '@/lib/mongo'
import { SESSION_COOKIE, signSession, type Rol } from '@/lib/auth/session'

/**
 * POST /api/v1/auth/login
 *
 * Credenciales propias del portal. Los internos de KPS acabaran entrando por el
 * OIDC corporativo (§04), pero mientras ese no exista esta es la unica via, y es
 * la que usan los proveedores en cualquier caso.
 */
export const runtime = 'nodejs'

/**
 * Mismo mensaje para usuario inexistente, contrasena mala y cuenta inactiva.
 * Distinguirlos le confirmaria a un atacante que correos estan dados de alta.
 */
const CREDENCIALES_INVALIDAS = 'Correo o contrasena incorrectos.'

export async function POST(request: Request) {
  let email: string
  let password: string

  try {
    const body = (await request.json()) as { email?: string; password?: string }
    email = (body.email ?? '').trim().toLowerCase()
    password = body.password ?? ''
  } catch {
    return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
  }

  if (!email || !password) {
    return NextResponse.json({ error: 'Escribe tu correo y tu contrasena.' }, { status: 400 })
  }

  const coleccion = await users()
  const user = await coleccion.findOne({ email })

  // Se compara el hash aunque el usuario no exista, contra uno ficticio, para
  // que el tiempo de respuesta no delate que correos estan registrados.
  const hash =
    user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin'
  const coincide = await bcrypt.compare(password, hash)

  if (!user || !user.passwordHash || !coincide || !user.active) {
    return NextResponse.json({ error: CREDENCIALES_INVALIDAS }, { status: 401 })
  }

  const config = getConfig()
  const token = await signSession(
    {
      userId: String(user._id),
      email: user.email,
      name: user.name,
      roles: user.roles as Rol[],
      supplierCode: user.supplierCode ?? null,
    },
    requireJwtSecret(),
    config.auth.jwtTtlSeconds,
  )

  await coleccion.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })

  const response = NextResponse.json({
    ok: true,
    usuario: { name: user.name, email: user.email, roles: user.roles },
  })

  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: config.auth.jwtTtlSeconds,
  })

  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 })
  return response
}
