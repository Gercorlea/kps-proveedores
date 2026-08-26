import { NextResponse } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth/session'

/**
 * GET /api/v1/auth/logout
 *
 * Es GET y no POST a proposito: el enlace "Salir" de la topbar es un `<a>`, y
 * un `<a>` no puede hacer POST sin JavaScript. El riesgo de CSRF aqui es que
 * alguien te cierre la sesion, que es molesto pero no destructivo.
 */
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL('/login', request.url))
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 })
  return response
}
