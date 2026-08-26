import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { motivosQueImpidenCapturar } from '@/lib/receipts/articulos'
import {
  MOTIVO_SIN_ACCESO,
  puedeCapturarEntradas,
  puedeTocarOrdenDe,
} from '@/lib/receipts/acceso'
import {
  capturaEntradaSchema,
  crearEntradaDeMercancia,
  leerOrdenParaEntrada,
  ReceiptError,
} from '@/lib/receipts/create'

/**
 * POST /api/v1/goods-receipts
 *
 * Registra una entrada de mercancia contra una orden de compra. La entrada se
 * crea en Business One; el porque y sus reglas viven en `@/lib/receipts/create`.
 *
 * SOLO INTERNOS DE KPS. Un proveedor no da por recibida su propia mercancia: eso
 * lo hace almacen. El menu ya no le enseña la seccion, pero ocultar el enlace no
 * es seguridad —§06 exige el guard tambien aqui, en el backend, que es donde de
 * verdad se decide—.
 */
export const runtime = 'nodejs'

function problem(status: number, title: string, detail: string, extra: object = {}) {
  // RFC 7807, como pide §13.
  return NextResponse.json(
    { type: 'about:blank', title, status, detail, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) {
    return problem(401, 'Sin sesion', 'Inicia sesion para registrar una entrada de mercancia.')
  }

  if (!puedeCapturarEntradas(session)) {
    return problem(403, 'Sin permiso', MOTIVO_SIN_ACCESO)
  }

  let cuerpo: unknown
  try {
    cuerpo = await request.json()
  } catch {
    return problem(400, 'Peticion invalida', 'El cuerpo tiene que ser JSON.')
  }

  const parsed = capturaEntradaSchema.safeParse(cuerpo)
  if (!parsed.success) {
    return problem(422, 'Datos invalidos', 'Revisa los campos de la entrada.', {
      errores: parsed.error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
    })
  }

  // La orden se lee ANTES de capturar, para comprobar de quien es. El
  // `poDocEntry` viaja en el cuerpo de la peticion, asi que sin esto un
  // proveedor con la bandera encendida podria colgar una entrada de la orden de
  // otra empresa: B1 la aceptaria, porque la orden existe. `crearEntradaDeMercancia`
  // vuelve a leerla —es un viaje mas a B1— pero el permiso no puede depender de
  // que quien la escribe se acuerde de comprobarlo.
  try {
    const oc = await leerOrdenParaEntrada(parsed.data.poDocEntry)

    if (!puedeTocarOrdenDe(session, oc.CardCode)) {
      // Mismo mensaje que "no existe": distinguirlos confirmaria que esa orden
      // existe y de quien es.
      return problem(
        404,
        'Orden no encontrada',
        `No hay ninguna orden con el numero ${parsed.data.poDocEntry}.`,
      )
    }

    // Articulos que B1 no va a admitir. Se comprueba ANTES de crear porque el
    // rechazo de B1 llega como un error de HANA —"no data found" con el numero
    // de linea de un procedimiento almacenado— que no se puede ensenar a nadie.
    // Solo se miran los renglones que se estan capturando: un articulo con lote
    // en OTRO renglon de la orden no impide recibir este.
    const capturados = new Set(parsed.data.lineas.filter((l) => l.cantidad > 0).map((l) => l.lineNum))
    const codigos = (oc.DocumentLines ?? [])
      .filter((l) => capturados.has(l.LineNum))
      .map((l) => l.ItemCode)
      .filter((c): c is string => Boolean(c))

    const impedimentos = await motivosQueImpidenCapturar(codigos)
    if (impedimentos.length > 0) {
      return problem(
        422,
        'Business One no admite esta entrada',
        impedimentos.join(' '),
        { code: 'ARTICULO_NO_CAPTURABLE', motivos: impedimentos },
      )
    }
  } catch (error) {
    if (error instanceof ReceiptError) {
      return problem(error.status, 'No se pudo registrar la entrada', error.message, {
        code: error.code,
      })
    }
    throw error
  }

  try {
    const resultado = await crearEntradaDeMercancia({ ...parsed.data, actor: session })
    return NextResponse.json({ ok: true, ...resultado }, { status: 201 })
  } catch (error) {
    if (error instanceof ReceiptError) {
      return problem(error.status, 'No se pudo registrar la entrada', error.message, {
        code: error.code,
      })
    }
    throw error
  }
}
