import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { listarAvisos, marcarLeido, materializarAvisos } from '@/lib/notifications'

/**
 * Avisos del proveedor de la sesion.
 *
 * DE QUIEN SON LOS AVISOS LO DECIDE LA COOKIE, nunca la peticion. El dashboard
 * de planta los pide con `?userId=&role=` y se fia de lo que le manden: aqui eso
 * seria un fallo de aislamiento —cambiar un parametro y leer los avisos de otro
 * proveedor—, asi que el `supplierCode` sale de la sesion firmada y no hay forma
 * de pedir los de otro.
 *
 * GET   -> los ultimos avisos y cuantos van sin leer.
 * PATCH -> marca uno como leido (`{ id }`) o todos (`{ todos: true }`).
 */
export const runtime = 'nodejs'

function problem(status: number, title: string, detail: string) {
  return NextResponse.json(
    { type: 'about:blank', title, status, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return problem(401, 'Sin sesion', 'Inicia sesion para ver tus avisos.')

  // Un interno de KPS no tiene proveedor, asi que no tiene avisos: se le pinta
  // la campana vacia en vez de devolverle un error que no puede resolver.
  if (!session.supplierCode) return NextResponse.json({ avisos: [], noLeidos: 0 })

  const pedido = Number(new URL(request.url).searchParams.get('limite'))
  const limite = Number.isFinite(pedido) && pedido > 0 ? pedido : 20

  // Se materializa antes de leer: es lo que hace que un cambio escrito por
  // kps-dashboard aparezca en la campana sin que aquella app sepa que existe.
  // Si falla se sigue adelante con lo ya guardado: una campana incompleta es
  // mejor que una que tumba la topbar.
  try {
    await materializarAvisos(session.supplierCode)
  } catch (error) {
    console.warn('[avisos] no se pudieron materializar:', error)
  }

  try {
    const lista = await listarAvisos({
      supplierCode: session.supplierCode,
      userId: session.userId,
      limite,
    })
    return NextResponse.json(lista)
  } catch (error) {
    console.warn('[avisos] no se pudieron leer:', error)
    return problem(503, 'Avisos no disponibles', 'No se pudieron leer tus avisos ahora mismo.')
  }
}

export async function PATCH(request: Request) {
  const session = await getSession()
  if (!session) return problem(401, 'Sin sesion', 'Inicia sesion para marcar tus avisos.')
  if (!session.supplierCode) return NextResponse.json({ ok: true, marcados: 0 })

  let cuerpo: { id?: string; todos?: boolean } = {}
  try {
    cuerpo = (await request.json()) as { id?: string; todos?: boolean }
  } catch {
    return problem(400, 'Cuerpo invalido', 'Se esperaba un JSON con `id` o con `todos`.')
  }

  if (!cuerpo.todos && !cuerpo.id) {
    return problem(400, 'Falta que marcar', 'Manda el `id` de un aviso o `todos: true`.')
  }

  const marcados = await marcarLeido({
    supplierCode: session.supplierCode,
    userId: session.userId,
    id: cuerpo.todos ? null : cuerpo.id,
  })

  return NextResponse.json({ ok: true, marcados })
}
