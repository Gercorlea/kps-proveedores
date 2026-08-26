import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { InvoiceStatus } from '@/lib/domain/enums'
import {
  auditLog,
  fromDecimal128,
  invoiceEvents,
  invoices,
  supplierScope,
  validationResults,
  type InvoiceDoc,
  type InvoiceLineDoc,
} from '@/lib/mongo'
import { calcularCobertura, type LineaFacturada } from '@/lib/matching/coverage'
import { money } from '@/lib/money'
import { getSapClient } from '@/lib/sap'

/**
 * POST /api/v1/invoices/[folio]/enviar
 *
 * El proveedor manda a revision una factura que tenia en BORRADOR. Es lo que
 * hace que KPS la vea en su bandeja de peticiones.
 *
 * Se separa de la carga a proposito. Subir el XML y pedir que lo revisen son
 * dos decisiones distintas: entre una y otra el proveedor mira lo que falta de
 * la orden y decide si adjunta otra factura o ya envia lo que tiene.
 *
 * AQUI SE BLOQUEA EL EXCESO. Guardar una factura que se pasa de la orden esta
 * permitido —el proveedor la ve y decide que hacer con ella—, pero enviarla no:
 * KPS no tiene que recibir una factura imposible para tener que rechazarla. Es
 * la misma regla que aplica Business One con `RemainingOpenQuantity`, adelantada
 * al portal porque aqui todavia no se registra el documento en B1.
 *
 * Cuenta lo aprobado Y lo que ya esta en revision. Si solo contara lo aprobado,
 * el proveedor podria mandar dos facturas que se pasan mientras KPS no decide
 * sobre la primera.
 */
export const runtime = 'nodejs'

function problem(status: number, title: string, detail: string, extra: object = {}) {
  return NextResponse.json(
    { type: 'about:blank', title, status, detail, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

/** Estados en los que una factura ya ocupa cantidad de la orden. */
const OCUPAN: readonly InvoiceStatus[] = [
  InvoiceStatus.EN_REVISION,
  InvoiceStatus.NC_EN_REVISION,
  InvoiceStatus.APROBADA_PAGO,
  InvoiceStatus.REGISTRADA_SAP,
  InvoiceStatus.CUENTAS_POR_PAGAR,
  InvoiceStatus.PAGADA,
  InvoiceStatus.CERRADA,
]

function lineasDe(lines: InvoiceLineDoc[] | undefined): LineaFacturada[] {
  return (lines ?? []).map((l) => ({
    itemCode: l.noIdentidad ?? null,
    description: l.description,
    quantity: fromDecimal128(l.quantity) ?? money(0),
  }))
}

/**
 * Devuelve el motivo si esta factura hace que la orden se pase, o null si cabe.
 *
 * Ante la duda —no hay orden, B1 no responde— deja pasar. Bloquear un envio
 * legitimo porque el Service Layer tuvo un mal minuto es peor que dejar que KPS
 * lo revise: alli el exceso se ve igual.
 */
async function revisarExceso(factura: InvoiceDoc): Promise<string | null> {
  // `poDocEntry` y no `baseEntry`: el que identifica la ORDEN es el primero.
  // `baseEntry` guarda la ENTRADA de mercancia, que es de donde copia el payload
  // de la factura, y leer la orden con el traeria otro documento.
  if (!factura.poNumber || !factura.poDocEntry) return null

  let orden
  try {
    orden = await getSapClient().getPurchaseOrder(factura.poDocEntry)
  } catch {
    return null
  }
  if (!orden?.DocumentLines?.length) return null

  const otras = await (await invoices())
    .find(
      {
        poNumber: factura.poNumber,
        supplierCode: factura.supplierCode,
        status: { $in: [...OCUPAN] },
        folio: { $ne: factura.folio },
      },
      { projection: { lines: 1 } },
    )
    .toArray()

  const cobertura = calcularCobertura({
    orden: orden.DocumentLines.map((l) => ({
      lineNum: l.LineNum,
      itemCode: l.ItemCode ?? null,
      description: l.ItemDescription ?? '',
      quantity: money(l.Quantity ?? 0),
      unitPrice: money(l.UnitPrice ?? l.Price ?? 0),
    })),
    aprobadas: otras.flatMap((o) => lineasDe(o.lines)),
    enCurso: lineasDe(factura.lines),
  })

  if (cobertura.estado !== 'EXCEDE') return null

  // Se dice EN QUE linea y POR CUANTO: "excede la orden" a secas no le dice al
  // proveedor que quitar de la factura.
  const detalle = cobertura.lineas
    .filter((l) => l.excedente.greaterThan(0))
    .map((l) => `${l.itemCode ?? l.description}: ${l.excedente.toString()} de mas`)
    .join('; ')

  return `Esta factura, sumada a las que ya enviaste de la OC ${factura.poNumber}, se pasa de lo que pide la orden — ${detalle}. Corrige el CFDI o retira alguna de las anteriores antes de enviarla.`
}

/**
 * Devuelve el descuadre si la factura no cuadra con su entrada, o null si cuadra.
 *
 * SE LEE EL COTEJO GUARDADO, no se recalcula. El cotejo se corrio al cargar el
 * XML con los datos que Business One tenia en ese momento, y volver a llamar a
 * B1 aqui anadiria una lectura cara que puede fallar justo cuando el proveedor
 * pulsa el boton.
 *
 * SIN COTEJO NO SE BLOQUEA. Una factura cargada antes de que el cotejo existiera
 * —o cargada sin la orden— no lleva `matchResult`. Retenerla castigaria al
 * proveedor por un hueco nuestro; KPS la vera igual en su bandeja.
 *
 * `canProceed` ya distingue los casos que §06 permite: una factura POR DEBAJO de
 * lo recibido pasa, porque la entrada conserva el saldo por facturar. La que no
 * pasa es la que cobra de mas, y esa hay que corregirla antes, no despues.
 */
function revisarCotejo(
  factura: InvoiceDoc,
): { mensaje: string; diferencias: string[] } | null {
  const cotejo = factura.matchResult
  if (!cotejo || typeof cotejo !== 'object') return null
  if (cotejo.canProceed !== false) return null

  const diferencias = Array.isArray(cotejo.differences)
    ? cotejo.differences
        .map((d) => (d && typeof d === 'object' ? String((d as { message?: unknown }).message ?? '') : ''))
        .filter((m) => m.length > 0)
    : []

  const resumen = typeof cotejo.summary === 'string' ? cotejo.summary : ''

  return {
    // Se dice QUE hacer, no solo que esta mal: si el proveedor facturo de mas, lo
    // que arregla la factura es una nueva o una nota de credito, y saberlo le
    // ahorra un viaje a preguntar.
    mensaje: `${resumen} Business One registrara la factura con los importes de la entrada ${cotejo.receiptNumber ?? ''}, no con los de tu CFDI, asi que enviarla asi dejaria una diferencia que nadie podria cuadrar despues. Corrige el CFDI y vuelve a cargarlo.`.trim(),
    diferencias,
  }
}

/**
 * Las reglas BLOQUEANTES que fallaron al cargar el XML.
 *
 * POR QUE SE COMPRUEBA AQUI Y NO AL GUARDAR. Cargar el XML desde la orden crea
 * un BORRADOR, y un borrador con reglas en rojo es justamente lo que hay que
 * poder ver para corregirlo: si el guardado las rechazara, el proveedor recibiria
 * un error y nada que mirar. Enviarla a KPS es otra cosa — ahi la factura sale de
 * sus manos y entra en una bandeja de revision.
 *
 * NO SE VUELVEN A CORRER. Se leen las que quedaron escritas al cargar. Volver a
 * consultar al SAT y a bajar el CSV del 69-B aqui duplicaria la espera del
 * proveedor para contestar lo mismo.
 */
async function revisarValidaciones(folio: string): Promise<string[]> {
  const filas = await (await validationResults())
    .find(
      { invoiceFolio: folio, severity: 'BLOQUEANTE', passed: false },
      { projection: { rule: 1, detail: 1 } },
    )
    .toArray()
  return filas.map((f) => f.detail || f.rule)
}

export async function POST(_request: Request, { params }: { params: Promise<{ folio: string }> }) {
  const session = await getSession()
  if (!session) return problem(401, 'Sin sesion', 'Inicia sesion para enviar la factura.')

  const { folio } = await params
  const coleccion = await invoices()

  // El aislamiento va en la consulta (§02). Buscar por folio y comprobar despues
  // de quien es dejaria la factura ajena ya leida en memoria del proceso.
  const factura = await coleccion.findOne(
    supplierScope<InvoiceDoc>(
      { folio },
      { supplierCode: session.supplierCode, internal: esInterno(session.roles) },
    ),
  )

  // Mismo 404 para "no existe" y "no es tuya": distinguirlas confirmaria que ese
  // folio existe y de quien es.
  if (!factura) {
    return problem(404, 'Factura no encontrada', `No hay ninguna factura con folio ${folio}.`)
  }

  if (factura.status !== InvoiceStatus.BORRADOR) {
    return problem(
      409,
      'La factura ya se envio',
      `${folio} esta en ${factura.status}, asi que ya salio de borrador. No se envia dos veces.`,
    )
  }

  // --- Que no arrastre una regla en rojo -----------------------------------
  const enRojo = await revisarValidaciones(folio)
  if (enRojo.length > 0) {
    return problem(
      409,
      'La factura no paso las validaciones',
      `${folio} tiene ${enRojo.length === 1 ? 'una validacion' : `${enRojo.length} validaciones`} sin resolver, asi que no se puede mandar a revision. Corrige el CFDI y vuelve a cargarlo.`,
      { code: 'VALIDACION', validaciones: enRojo },
    )
  }

  // --- Que no se pase de la orden -----------------------------------------
  const exceso = await revisarExceso(factura)
  if (exceso) {
    return problem(409, 'La factura excede la orden', exceso, { code: 'EXCEDE_ORDEN' })
  }

  // --- Que cuadre con la entrada de mercancia -----------------------------
  const descuadre = revisarCotejo(factura)
  if (descuadre) {
    return problem(409, 'La factura no cuadra con la entrada', descuadre.mensaje, {
      code: 'COTEJO_NO_CUADRA',
      diferencias: descuadre.diferencias,
    })
  }

  const ahora = new Date()

  // El filtro repite el estado: dos pestañas abiertas podrian enviar la misma
  // factura a la vez, y sin esta condicion la segunda escribiria encima.
  const r = await coleccion.updateOne(
    { folio, status: InvoiceStatus.BORRADOR },
    { $set: { status: InvoiceStatus.EN_REVISION, submittedAt: ahora, updatedAt: ahora } },
  )

  if (r.matchedCount === 0) {
    return problem(409, 'La factura ya se envio', `${folio} acaba de enviarse desde otro sitio.`)
  }

  // §11: un evento de bitacora por cada cambio de estatus, con quien y cuando.
  await (
    await invoiceEvents()
  ).insertOne({
    invoiceFolio: folio,
    fromStatus: InvoiceStatus.BORRADOR,
    toStatus: InvoiceStatus.EN_REVISION,
    actorId: session.userId,
    actorRole: session.roles.join(','),
    comment: factura.poNumber
      ? `El proveedor envio a revision la factura de la OC ${factura.poNumber}.`
      : 'El proveedor envio la factura a revision.',
    payload: { uuid: factura.uuid ?? null, poNumber: factura.poNumber ?? null },
    createdAt: ahora,
  })

  await (
    await auditLog()
  ).insertOne({
    entityType: 'invoice',
    entityId: folio,
    action: 'FACTURA_ENVIADA',
    actorId: session.userId,
    actorRole: session.roles.join(','),
    before: { status: InvoiceStatus.BORRADOR },
    after: { status: InvoiceStatus.EN_REVISION },
    comment: null,
    createdAt: ahora,
  })

  return NextResponse.json({ ok: true, folio, status: InvoiceStatus.EN_REVISION })
}
