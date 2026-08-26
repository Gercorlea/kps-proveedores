import type { Filter } from 'mongodb'
import type { SessionPayload } from '../auth/session'
import { InvoiceStatus, UserRole, type InvoiceType, type Severity } from '../domain/enums'
import { formatMoney } from '../money'
import {
  auditLog,
  fromDecimal128,
  getMongo,
  invoiceEvents,
  invoices,
  suppliers,
  supplierScope,
  validationResults,
  type InvoiceDoc,
} from '../mongo'

/**
 * Bandeja de peticiones de KPS.
 *
 * Una "peticion" no es una entidad aparte: es una factura que el proveedor ya
 * envio y que sigue esperando a que alguien de KPS la resuelva. Modelarla como
 * coleccion propia obligaria a mantener dos verdades sobre el mismo documento,
 * asi que la bandeja es una consulta sobre `invoices` por estatus.
 *
 * Los datos salen de aqui ya formateados para la pantalla: los Decimal128 como
 * texto y las fechas en ISO. Podrian devolverse crudos, pero entonces cada
 * pantalla tendria que acordarse de convertir importes, y un `.toString()` de
 * mas sobre un Decimal128 es exactamente como se cuelan los errores de dinero.
 */

/** Lo que espera decision humana. */
export const ESTADOS_PENDIENTES: readonly InvoiceStatus[] = [InvoiceStatus.EN_REVISION]

/** Quien puede resolver una peticion. §02: tesoreria no revisa, paga. */
const ROLES_REVISION: readonly string[] = [UserRole.KPS_REVISION, UserRole.ADMIN_SISTEMA]

export function puedeRevisar(roles: readonly string[]): boolean {
  return roles.some((r) => ROLES_REVISION.includes(r))
}

export const DECISION = {
  APROBAR: 'APROBAR',
  CORRECCION: 'CORRECCION',
  RECHAZAR: 'RECHAZAR',
} as const
export type Decision = (typeof DECISION)[keyof typeof DECISION]

export function esDecisionValida(value: unknown): value is Decision {
  return value === DECISION.APROBAR || value === DECISION.CORRECCION || value === DECISION.RECHAZAR
}

export class ReviewError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'ReviewError'
  }
}

export interface PeticionResumen {
  folio: string
  uuid: string | null
  serie: string | null
  tipo: InvoiceType
  status: InvoiceStatus
  supplierCode: string
  proveedor: string
  total: string
  moneda: string
  enviada: string | null
  evidencias: number
  /**
   * Claves de los archivos, para enlazarlos desde la lista. Se sirven por
   * /api/v1/documents/[key], que comprueba la sesion en cada descarga: la clave
   * no autoriza nada por si sola, asi que exponerla aqui no abre ningun archivo
   * a quien no le corresponde.
   */
  xmlFileKey: string | null
  pdfFileKey: string | null
  /**
   * Cuando toca cobrar, en ISO. Sale de `DocDueDate`, que calcula Business One
   * al registrar la factura a partir de los dias de credito pactados con ese
   * proveedor —30, 60, contado, los que tenga—.
   *
   * NO la fija el portal ni quien aprueba: aprobar solo dice que la factura es
   * correcta; el cuando ya estaba decidido en las condiciones de pago. Se guarda
   * al registrar para poder ensenarla sin volver a preguntarle a SAP en cada
   * pantalla.
   *
   * Null mientras la factura no este registrada en Business One: antes de eso no
   * hay fecha que dar, y poner una estimada seria prometerle al proveedor algo
   * que nadie ha calculado.
   */
  vence: string | null
}

export interface PeticionDetalle extends PeticionResumen {
  rfcEmisor: string | null
  rfcReceptor: string | null
  fechaEmision: string | null
  subtotal: string
  trasladados: string
  retenidos: string
  metodoPago: string | null
  formaPago: string | null
  usoCfdi: string | null
  xmlFileKey: string | null
  pdfFileKey: string | null
  motivo: string | null
  revisadaPor: string | null
  revisadaEl: string | null
  evidencia: Array<{ title: string; description: string; fileKey: string; uploadedAt: string }>
  conceptos: Array<{
    linea: number
    descripcion: string
    codigo: string | null
    cantidad: string
    valorUnitario: string
    importe: string
  }>
  validaciones: Array<{ regla: string; severidad: Severity; pasa: boolean; detalle: string }>
  eventos: Array<{
    de: InvoiceStatus | null
    a: InvoiceStatus
    actor: string
    comentario: string | null
    fecha: string
  }>
}

function importe(value: unknown, moneda: string): string {
  const decimal = fromDecimal128(value as never)
  return decimal ? formatMoney(decimal, moneda) : '—'
}

/** Cuantas peticiones esperan a KPS. Alimenta el contador del menu. */
export async function contarPendientes(): Promise<number> {
  return (await invoices()).countDocuments({ status: { $in: [...ESTADOS_PENDIENTES] } })
}

/**
 * Razon social por codigo de proveedor, en una sola consulta.
 *
 * Sin esto la lista haria una lectura por fila. Con `$lookup` lo resolveria el
 * motor, pero la agregacion obliga a mapear el documento entero a mano y aqui
 * solo hace falta el nombre.
 */
async function nombresDeProveedor(codigos: readonly string[]): Promise<Map<string, string>> {
  if (codigos.length === 0) return new Map()
  const docs = await (await suppliers())
    .find(
      { supplierCode: { $in: [...new Set(codigos)] } },
      { projection: { supplierCode: 1, legalName: 1 } },
    )
    .toArray()
  return new Map(docs.map((d) => [d.supplierCode!, d.legalName]))
}

async function listar(filtro: Filter<InvoiceDoc>): Promise<PeticionResumen[]> {
  const docs = await (await invoices())
    .find(filtro)
    .sort({ submittedAt: -1, createdAt: -1 })
    .limit(200)
    .toArray()

  const nombres = await nombresDeProveedor(docs.map((d) => d.supplierCode))

  return docs.map((d) => ({
    folio: d.folio,
    uuid: d.uuid ?? null,
    serie: d.serie ?? null,
    tipo: d.type,
    status: d.status,
    supplierCode: d.supplierCode,
    proveedor: nombres.get(d.supplierCode) ?? d.supplierCode,
    total: importe(d.total, d.currency ?? 'MXN'),
    moneda: d.currency ?? 'MXN',
    enviada: (d.submittedAt ?? d.createdAt)?.toISOString() ?? null,
    evidencias: d.evidence?.length ?? 0,
    xmlFileKey: d.xmlFileKey ?? null,
    pdfFileKey: d.pdfFileKey ?? null,
    vence: (d as { sapDocDueDate?: Date | null }).sapDocDueDate?.toISOString() ?? null,
  }))
}

/** La bandeja de KPS: todo lo que enviaron los proveedores. */
export async function listarPeticiones(opciones: {
  soloPendientes: boolean
}): Promise<PeticionResumen[]> {
  return listar(opciones.soloPendientes ? { status: { $in: [...ESTADOS_PENDIENTES] } } : {})
}

/**
 * Las facturas de un proveedor, para su propia pantalla.
 *
 * El filtro sale de `supplierScope` y no de un `{ supplierCode }` escrito aqui:
 * §02 exige que TODA consulta sobre datos de proveedor pase por el, porque
 * MongoDB no tiene row-level security y ese aislamiento vive en la aplicacion.
 */
export async function listarFacturasDelProveedor(ctx: {
  supplierCode?: string | null
  internal: boolean
}): Promise<PeticionResumen[]> {
  return listar(supplierScope<InvoiceDoc>({}, ctx))
}

export async function obtenerPeticion(folio: string): Promise<PeticionDetalle | null> {
  const doc = await (await invoices()).findOne({ folio })
  if (!doc) return null

  const moneda = doc.currency ?? 'MXN'
  const [nombres, reglas, eventos] = await Promise.all([
    nombresDeProveedor([doc.supplierCode]),
    (await validationResults()).find({ invoiceFolio: folio }).sort({ ranAt: 1 }).toArray(),
    (await invoiceEvents()).find({ invoiceFolio: folio }).sort({ createdAt: 1 }).toArray(),
  ])

  return {
    folio: doc.folio,
    uuid: doc.uuid ?? null,
    serie: doc.serie ?? null,
    tipo: doc.type,
    status: doc.status,
    supplierCode: doc.supplierCode,
    proveedor: nombres.get(doc.supplierCode) ?? doc.supplierCode,
    total: importe(doc.total, moneda),
    moneda,
    enviada: (doc.submittedAt ?? doc.createdAt)?.toISOString() ?? null,
    evidencias: doc.evidence?.length ?? 0,

    rfcEmisor: doc.issuerTaxId ?? null,
    rfcReceptor: doc.receiverTaxId ?? null,
    fechaEmision: doc.issueDate?.toISOString() ?? null,
    subtotal: importe(doc.subtotal, moneda),
    trasladados: importe(doc.taxTransferred, moneda),
    retenidos: importe(doc.taxWithheld, moneda),
    metodoPago: doc.paymentMethod ?? null,
    formaPago: doc.paymentForm ?? null,
    usoCfdi: doc.cfdiUse ?? null,
    xmlFileKey: doc.xmlFileKey ?? null,
    pdfFileKey: doc.pdfFileKey ?? null,
    vence: (doc as { sapDocDueDate?: Date | null }).sapDocDueDate?.toISOString() ?? null,
    motivo: doc.rejectionReason ?? null,
    revisadaPor: doc.reviewedBy ?? null,
    revisadaEl: doc.reviewedAt?.toISOString() ?? null,

    evidencia: (doc.evidence ?? []).map((e) => ({
      title: e.title,
      description: e.description,
      fileKey: e.fileKey,
      uploadedAt: e.uploadedAt.toISOString(),
    })),
    conceptos: (doc.lines ?? []).map((l) => ({
      linea: l.lineNumber,
      descripcion: l.description,
      codigo: l.noIdentidad ?? null,
      cantidad: fromDecimal128(l.quantity)?.toFixed(3) ?? '—',
      valorUnitario: fromDecimal128(l.unitValue)?.toFixed(4) ?? '—',
      importe: fromDecimal128(l.amount)?.toFixed(2) ?? '—',
    })),
    validaciones: reglas.map((r) => ({
      regla: r.rule,
      severidad: r.severity,
      pasa: r.passed,
      detalle: r.detail,
    })),
    eventos: eventos.map((e) => ({
      de: e.fromStatus ?? null,
      a: e.toStatus,
      actor: e.actorRole,
      comentario: e.comment ?? null,
      fecha: e.createdAt.toISOString(),
    })),
  }
}

/** A donde lleva cada decision (§10.2). */
const DESTINO: Record<Decision, InvoiceStatus> = {
  APROBAR: InvoiceStatus.APROBADA_PAGO,
  CORRECCION: InvoiceStatus.EN_CORRECCION,
  RECHAZAR: InvoiceStatus.RECHAZADA,
}

const ACCION: Record<Decision, string> = {
  APROBAR: 'FACTURA_APROBADA',
  CORRECCION: 'FACTURA_DEVUELTA',
  RECHAZAR: 'FACTURA_RECHAZADA',
}

export interface ResultadoDecision {
  folio: string
  de: InvoiceStatus
  a: InvoiceStatus
}

/**
 * Resuelve una peticion.
 *
 * Devolver y rechazar exigen motivo escrito: el proveedor recibe ese texto y sin
 * el no sabe que corregir. Aprobar no lo exige, pero lo guarda si lo hay.
 */
export async function decidirPeticion(datos: {
  folio: string
  decision: Decision
  comentario: string
  actor: SessionPayload
}): Promise<ResultadoDecision> {
  const { folio, decision, actor } = datos
  const comentario = datos.comentario.trim()

  if (!puedeRevisar(actor.roles)) {
    throw new ReviewError(
      403,
      'Solo revision de cuentas por pagar o el administrador pueden resolver una peticion.',
    )
  }

  if (decision !== DECISION.APROBAR && comentario.length === 0) {
    throw new ReviewError(
      400,
      'Escribe el motivo: es lo que va a leer el proveedor para saber que hacer.',
    )
  }

  const coleccion = await invoices()
  const factura = await coleccion.findOne({ folio })
  if (!factura) throw new ReviewError(404, `No existe ninguna factura con folio ${folio}.`)

  // Se comprueba el estado ANTES y se vuelve a exigir en el update: entre las
  // dos lineas cabe que otra persona resuelva la misma peticion.
  if (!ESTADOS_PENDIENTES.includes(factura.status)) {
    throw new ReviewError(
      409,
      `Esta peticion ya se atendio: esta en ${factura.status}. Recarga la pantalla.`,
    )
  }

  const destino = DESTINO[decision]
  const ahora = new Date()

  const client = await getMongo()
  const sesion = client.startSession()
  try {
    await sesion.withTransaction(async () => {
      const cambio = await coleccion.updateOne(
        { folio, status: { $in: [...ESTADOS_PENDIENTES] } },
        {
          $set: {
            status: destino,
            reviewedBy: actor.email,
            reviewedAt: ahora,
            rejectionReason: decision === DECISION.APROBAR ? null : comentario,
            updatedAt: ahora,
          },
        },
        { session: sesion },
      )
      if (cambio.matchedCount === 0) {
        throw new ReviewError(409, 'Otra persona resolvio esta peticion mientras la mirabas.')
      }

      // §11: la bitacora va en la misma transaccion que el cambio de estatus.
      await (
        await invoiceEvents()
      ).insertOne(
        {
          invoiceFolio: folio,
          fromStatus: factura.status,
          toStatus: destino,
          actorId: actor.userId,
          actorRole: actor.roles.join(','),
          comment: comentario || null,
          createdAt: ahora,
        },
        { session: sesion },
      )

      await (
        await auditLog()
      ).insertOne(
        {
          entityType: 'invoice',
          entityId: folio,
          action: ACCION[decision],
          actorId: actor.userId,
          actorRole: actor.roles.join(','),
          before: { status: factura.status },
          after: { status: destino },
          comment: comentario || null,
          createdAt: ahora,
        },
        { session: sesion },
      )
    })
  } finally {
    await sesion.endSession()
  }

  return { folio, de: factura.status, a: destino }
}
