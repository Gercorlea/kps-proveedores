import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, esInterno, verifySession } from '@/lib/auth/session'

/**
 * Control de acceso a nivel de ruta.
 *
 * Esto es la primera puerta, no la ultima: solo decide que RUTAS se pueden
 * abrir. El aislamiento por proveedor —que ademas de entrar a /facturas solo
 * veas las tuyas— no se decide aqui, sino en cada consulta, con `supplierScope`
 * de src/lib/mongo.ts.
 *
 * Cuidado con lo que dice §02: exige que ese aislamiento lo imponga la base con
 * row-level security. MongoDB no la tiene. Nadie debe leer este archivo y
 * suponer que el motor ya protege los datos: no lo hace, y una consulta que
 * olvide `supplierScope` expone los de otro proveedor.
 */

/** Rutas que solo pueden ver los roles internos de KPS. */
// Ninguna ruta de este portal es exclusiva de KPS: la administracion y la
// bandeja de revision viven en kps-dashboard. Se deja la lista vacia en vez de
// borrar el mecanismo, que sigue haciendo falta si vuelve alguna.
const SOLO_INTERNOS: readonly string[] = []

/** Rutas accesibles sin sesion. */
const PUBLICAS = ['/login', '/registro']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLICAS.some((p) => pathname.startsWith(p))) return NextResponse.next()

  const secret = process.env.JWT_SECRET
  if (!secret) {
    // Sin secreto no se puede verificar nada. Se deja pasar y se avisa por log:
    // bloquear el portal entero por una variable ausente en desarrollo es peor
    // que servirlo sin sesion, y en produccion el arranque ya falla antes.
    console.warn('[auth] JWT_SECRET no esta definida: el control de acceso esta desactivado.')
    return NextResponse.next()
  }

  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value, secret)

  if (!session) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('desde', pathname)
    return NextResponse.redirect(url)
  }

  if (SOLO_INTERNOS.some((p) => pathname.startsWith(p)) && !esInterno(session.roles)) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.searchParams.set('sinAcceso', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  // Se excluyen los estaticos de Next, el favicon y la API: los handlers de la
  // API validan la sesion por su cuenta y devuelven 401, no una redireccion.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
}
