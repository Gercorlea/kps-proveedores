import { ObjectId, type Filter } from 'mongodb'
import {
  AVISO_POR_ESTATUS,
  ETIQUETA_AVISO,
  NotificationType,
  TONO_AVISO,
  type InvoiceStatus,
  type TonoEstatus,
} from '../domain/enums'
import {
  documentCounters,
  invoiceEvents,
  invoices,
  notifications,
  supplierScope,
  type InvoiceDoc,
  type NotificationDoc,
} from '../mongo'

/**
 * Avisos del proveedor.
 *
 * DE DONDE SALEN. Casi todos se MATERIALIZAN desde la bitacora de facturas
 * (§11): cada cambio de estatus que decide KPS escribe su evento, y de ahi nace
 * el aviso. Se hace asi, y no pidiendole a cada sitio que resuelve una peticion
 * que ademas cree el aviso, porque los cambios no vienen todos de este portal
 * —el registro en SAP y el pago los escribe kps-dashboard—, y un aviso que
 * dependa de que cada escritor se acuerde de crearlo es un aviso que algun dia
 * no sale. Colgado de la bitacora, cualquier app que respete §11 lo genera sin
 * saber que existe la campana.
 *
 * POR QUE HAY COLECCION Y NO SE DERIVA AL VUELO. Por el "visto": derivando en
 * cada lectura, o no hay estado de leido, o vive en el navegador y el proveedor
 * vuelve a ver como nuevo desde su casa lo que ya leyo en la oficina. Ademas hay
 * avisos que no son de ninguna factura —la cuenta retenida, un recado de KPS— y
 * esos no tienen bitacora de donde salir.
 *
 * La materializacion es idempotente por el indice unico de `sourceEventId`, asi
 * que corre en cada consulta sin llevar cursor ni marca de agua.
 */

/** Cuantos eventos se miran hacia atras al materializar. */
const VENTANA_EVENTOS = 200

/** Tope duro de avisos que devuelve una consulta. */
const TOPE = 100

export interface Aviso {
  id: string
  folio: string
  tipo: NotificationType
  titulo: string
  mensaje: string
  tono: TonoEstatus
  link: string | null
  facturaFolio: string | null
  ordenCompra: string | null
  leido: boolean
  cuando: string
}

/**
 * Folio del aviso.
 *
 * Contador atomico como el de las facturas, y no "el mayor folio + 1" como en el
 * dashboard de planta: alli dos altas simultaneas leian el mismo maximo y la
 * segunda moria por clave duplicada. `$inc` no tiene esa carrera.
 */
async function siguienteFolio(): Promise<string> {
  const year = new Date().getFullYear()
  const contador = await (
    await documentCounters()
  ).findOneAndUpdate(
    { scope: 'AVISO', year },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  )
  return `AVI-${year}-${String(contador?.value ?? 1).padStart(4, '0')}`
}

/** El texto del aviso. Dice QUE paso y con QUE factura, en ese orden. */
function mensajeDeFactura(
  tipo: NotificationType,
  factura: { folio: string; poNumber?: string | null },
  comentario: string | null,
): string {
  const que = comentario?.trim()
  const donde = factura.poNumber ? `${factura.folio} (OC ${factura.poNumber})` : factura.folio

  switch (tipo) {
    case NotificationType.FACTURA_DEVUELTA:
      return que
        ? `Tu factura ${donde} necesita correccion: ${que}`
        : `Tu factura ${donde} te fue devuelta para correccion.`
    case NotificationType.FACTURA_RECHAZADA:
      return que ? `Tu factura ${donde} fue rechazada: ${que}` : `Tu factura ${donde} fue rechazada.`
    case NotificationType.FACTURA_DUPLICADA:
      return `Tu factura ${donde} ya estaba cargada, asi que se marco como duplicada.`
    case NotificationType.FACTURA_APROBADA:
      return `KPS aprobo para pago tu factura ${donde}.`
    case NotificationType.FACTURA_REGISTRADA:
      return `Tu factura ${donde} quedo registrada en Business One.`
    case NotificationType.FACTURA_EN_PAGO:
      return `Tu factura ${donde} paso a cuentas por pagar.`
    case NotificationType.FACTURA_PAGADA:
      return `Se pago tu factura ${donde}. Sube el recibo: mientras falte, tus siguientes pagos quedan retenidos.`
    case NotificationType.NOTA_CREDITO:
      return que
        ? `Tu factura ${donde} necesita nota de credito: ${que}`
        : `Tu factura ${donde} necesita una nota de credito.`
    default:
      return que ?? `Hay novedades con tu factura ${donde}.`
  }
}

/**
 * Escribe los avisos que le faltan al proveedor a partir de su bitacora.
 *
 * Solo mira SUS facturas: leer todos los eventos y filtrar despues pondria en
 * memoria la bitacora de todos los proveedores, que es justo lo que §02 evita.
 */
export async function materializarAvisos(supplierCode: string): Promise<void> {
  const mias = await (await invoices())
    .find(supplierScope<InvoiceDoc>({}, { supplierCode, internal: false }), {
      projection: { folio: 1, poNumber: 1 },
    })
    .limit(500)
    .toArray()
  if (mias.length === 0) return

  const orden = new Map(mias.map((f) => [f.folio, f.poNumber ?? null]))
  const interesan = Object.keys(AVISO_POR_ESTATUS) as InvoiceStatus[]

  const eventos = await (await invoiceEvents())
    .find({ invoiceFolio: { $in: [...orden.keys()] }, toStatus: { $in: interesan } })
    .sort({ createdAt: -1 })
    .limit(VENTANA_EVENTOS)
    .toArray()
  if (eventos.length === 0) return

  // Que eventos ya tienen aviso. Se pregunta ANTES de escribir para no pedir un
  // folio por cada evento ya materializado: el indice unico impediria el
  // duplicado, pero el contador ya habria avanzado y la serie saldria con
  // agujeros en cada visita a la campana.
  const ids = eventos.map((e) => String(e._id))
  const yaEstan = new Set(
    (
      await (await notifications())
        .find({ sourceEventId: { $in: ids } }, { projection: { sourceEventId: 1 } })
        .toArray()
    ).map((n) => n.sourceEventId),
  )

  // Del mas viejo al mas nuevo, para que los folios sigan el orden de los hechos.
  const pendientes = eventos.filter((e) => !yaEstan.has(String(e._id))).reverse()
  if (pendientes.length === 0) return

  const nuevos: NotificationDoc[] = []
  for (const e of pendientes) {
    const tipo = AVISO_POR_ESTATUS[e.toStatus]
    if (!tipo) continue
    const poNumber = orden.get(e.invoiceFolio) ?? null
    nuevos.push({
      notificationId: await siguienteFolio(),
      supplierCode,
      type: tipo,
      title: ETIQUETA_AVISO[tipo],
      message: mensajeDeFactura(tipo, { folio: e.invoiceFolio, poNumber }, e.comment ?? null),
      tone: TONO_AVISO[tipo],
      link: `/facturas?folio=${encodeURIComponent(e.invoiceFolio)}`,
      invoiceFolio: e.invoiceFolio,
      poNumber,
      sourceEventId: String(e._id),
      readBy: [],
      createdBy: null,
      // La fecha del HECHO, no la de la escritura: si el aviso se materializa
      // tres dias despues, fecharlo hoy le diria al proveedor que acaba de pasar
      // algo que ya paso.
      createdAt: e.createdAt,
    })
  }
  if (nuevos.length === 0) return

  // `ordered: false` para que un choque —otra pestaña materializando lo mismo a
  // la vez— no se lleve por delante los avisos siguientes.
  try {
    await (await notifications()).insertMany(nuevos, { ordered: false })
  } catch (error) {
    const errores = (error as { writeErrors?: Array<{ code?: number }> })?.writeErrors ?? []
    const soloDuplicados =
      (error as { code?: number })?.code === 11000 ||
      (errores.length > 0 && errores.every((w) => w.code === 11000))
    if (!soloDuplicados) throw error
  }
}

/**
 * Aviso escrito a mano, sin evento detras: la cuenta retenida, un recado de KPS.
 * Devuelve el folio, o null si no se pudo guardar.
 */
export async function crearAviso(datos: {
  supplierCode: string
  tipo: NotificationType
  mensaje: string
  titulo?: string
  link?: string | null
  facturaFolio?: string | null
  creadoPor?: string | null
}): Promise<string | null> {
  const notificationId = await siguienteFolio()
  try {
    await (
      await notifications()
    ).insertOne({
      notificationId,
      supplierCode: datos.supplierCode,
      type: datos.tipo,
      title: datos.titulo ?? ETIQUETA_AVISO[datos.tipo],
      message: datos.mensaje,
      tone: TONO_AVISO[datos.tipo],
      link: datos.link ?? null,
      invoiceFolio: datos.facturaFolio ?? null,
      poNumber: null,
      sourceEventId: null,
      readBy: [],
      createdBy: datos.creadoPor ?? null,
      createdAt: new Date(),
    })
    return notificationId
  } catch (error) {
    console.warn('[avisos] no se pudo guardar el aviso:', error)
    return null
  }
}

export interface ListaAvisos {
  avisos: Aviso[]
  noLeidos: number
}

/** Los avisos del proveedor, con el "visto" resuelto para ESTE usuario. */
export async function listarAvisos(datos: {
  supplierCode: string
  userId: string
  limite?: number
}): Promise<ListaAvisos> {
  const limite = Math.min(Math.max(datos.limite ?? 20, 1), TOPE)
  const coleccion = await notifications()
  const filtro = { supplierCode: datos.supplierCode }

  const [docs, noLeidos] = await Promise.all([
    coleccion.find(filtro).sort({ createdAt: -1 }).limit(limite).toArray(),
    // El conteo va sobre TODOS los suyos, no solo sobre la pagina que se pinta:
    // si no, la campana se quedaria clavada en el tamano de la pagina.
    coleccion.countDocuments({ ...filtro, readBy: { $ne: datos.userId } }),
  ])

  return {
    noLeidos,
    avisos: docs.map((n) => ({
      id: String(n._id),
      folio: n.notificationId,
      tipo: n.type,
      titulo: n.title,
      mensaje: n.message,
      tono: n.tone,
      link: n.link ?? null,
      facturaFolio: n.invoiceFolio ?? null,
      ordenCompra: n.poNumber ?? null,
      leido: (n.readBy ?? []).includes(datos.userId),
      cuando: n.createdAt.toISOString(),
    })),
  }
}

/**
 * Marca como leido. Sin `id` marca todos los del proveedor.
 *
 * El filtro lleva SIEMPRE el supplierCode aunque el id ya sea unico: sin el, un
 * id adivinado marcaria el aviso de otra empresa (§02).
 */
export async function marcarLeido(datos: {
  supplierCode: string
  userId: string
  id?: string | null
}): Promise<number> {
  const coleccion = await notifications()
  const filtro: Record<string, unknown> = {
    supplierCode: datos.supplierCode,
    readBy: { $ne: datos.userId },
  }

  if (datos.id) {
    // Un id con forma invalida es "no existe", no un error: viene de la URL.
    if (!ObjectId.isValid(datos.id)) return 0
    filtro._id = new ObjectId(datos.id)
  }

  // $addToSet y no $push: pulsar dos veces el mismo aviso no tiene por que
  // dejar al usuario repetido en la lista.
  const r = await coleccion.updateMany(filtro as unknown as Filter<NotificationDoc>, {
    $addToSet: { readBy: datos.userId },
  })
  return r.modifiedCount
}
