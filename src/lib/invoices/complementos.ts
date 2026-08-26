import type { SessionPayload } from '../auth/session'
import { parseCfdi } from '../cfdi/parser'
import { CfdiParseError, METODO_PPD, TIPO_PAGO } from '../cfdi/types'
import { InvoiceStatus } from '../domain/enums'
import { formatMoney } from '../money'
import {
  auditLog,
  fromDecimal128,
  invoiceEvents,
  invoices,
  supplierScope,
  type InvoiceDoc,
} from '../mongo'
import { DocumentTooLargeError, storeDocument, type ArchivoEntrante } from '../storage/documents'

/**
 * Complemento de pago (REP) — CFDI de tipo P.
 *
 * QUIEN LO DEBE Y QUIEN NO. Solo las facturas PPD llevan complemento. Una PUE se
 * cobra al emitirse y el pago ya va dentro del propio CFDI, asi que exigirle un
 * REP a un proveedor PUE es pedirle un documento que la ley no contempla —y, si
 * ademas se le retienen pagos por no entregarlo, retenerle dinero por nada—.
 *
 * EL PLAZO NO LO INVENTA EL PORTAL. La regla 2.7.1.32 de la RMF da como fecha
 * limite el dia 5 natural del mes siguiente a aquel en que se recibio el pago, y
 * el articulo 84 del CFF castiga cada comprobante no emitido con multa. Por eso
 * la fecha se calcula y se enseña: es la del SAT, no un plazo de cortesia.
 */

/** Multa del art. 84 CFF por comprobante no emitido, para explicar la urgencia. */
export const MULTA_CFF = 'de $17,020 a $97,330 por cada comprobante'

/** Solo PPD debe complemento. Ante un metodo ausente o raro, no se exige. */
export function requiereComplemento(paymentMethod: string | null | undefined): boolean {
  return paymentMethod?.toUpperCase() === METODO_PPD
}

/**
 * Dia 5 natural del mes siguiente al pago (RMF 2.7.1.32).
 *
 * Se construye en UTC para que el limite no se mueva un dia segun donde este el
 * servidor: la fecha es la misma en Tijuana que en Cancun.
 */
export function fechaLimiteComplemento(pagadaEl: Date): Date {
  return new Date(Date.UTC(pagadaEl.getUTCFullYear(), pagadaEl.getUTCMonth() + 1, 5, 23, 59, 59))
}

export interface ComplementoPendiente {
  folio: string
  uuid: string | null
  total: string
  moneda: string
  pagadaEl: string | null
  /** Fecha limite legal, en ISO. Null si no se sabe cuando se pago. */
  limite: string | null
  /** Dias que faltan; negativo si ya vencio. Null si no hay fecha de pago. */
  diasRestantes: number | null
}

const DIA_MS = 24 * 60 * 60 * 1000

/**
 * Las facturas que esperan complemento: pagadas, PPD y sin REP cargado.
 *
 * El filtro por metodo de pago va aqui y no en la pantalla a proposito. Si la
 * lista trajera tambien las PUE para que la vista las escondiera, cualquier
 * pantalla nueva que olvidara filtrarlas volveria a pedirselas al proveedor.
 */
export async function complementosPendientes(ctx: {
  supplierCode?: string | null
  internal: boolean
}): Promise<ComplementoPendiente[]> {
  const docs = await (await invoices())
    .find(
      supplierScope<InvoiceDoc>(
        {
          status: InvoiceStatus.PAGADA,
          paymentMethod: METODO_PPD,
          paymentReceipt: { $in: [null] },
        },
        ctx,
      ),
    )
    .sort({ paidAt: 1 })
    .limit(200)
    .toArray()

  const ahora = Date.now()

  return docs.map((d) => {
    const pagada = d.paidAt ?? d.paidMarkedAt ?? null
    const limite = pagada ? fechaLimiteComplemento(pagada) : null
    return {
      folio: d.folio,
      uuid: d.uuid ?? null,
      total: fromDecimal128(d.total)
        ? formatMoney(fromDecimal128(d.total)!, d.currency ?? 'MXN')
        : '—',
      moneda: d.currency ?? 'MXN',
      pagadaEl: pagada?.toISOString() ?? null,
      limite: limite?.toISOString() ?? null,
      diasRestantes: limite ? Math.ceil((limite.getTime() - ahora) / DIA_MS) : null,
    }
  })
}

export const COMPLEMENTO_ERROR = {
  NO_ENCONTRADA: 'NO_ENCONTRADA',
  NO_PAGADA: 'NO_PAGADA',
  NO_APLICA: 'NO_APLICA',
  YA_CARGADO: 'YA_CARGADO',
  XML_INVALIDO: 'XML_INVALIDO',
  NO_ES_COMPLEMENTO: 'NO_ES_COMPLEMENTO',
  RFC_AJENO: 'RFC_AJENO',
  NO_SALDA_LA_FACTURA: 'NO_SALDA_LA_FACTURA',
  ARCHIVO_GRANDE: 'ARCHIVO_GRANDE',
} as const
export type ComplementoErrorCode = (typeof COMPLEMENTO_ERROR)[keyof typeof COMPLEMENTO_ERROR]

export class ComplementoError extends Error {
  constructor(
    readonly code: ComplementoErrorCode,
    readonly status: 403 | 404 | 409 | 413 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'ComplementoError'
  }
}

/**
 * Registra el complemento de una factura y la cierra.
 *
 * La comprobacion que de verdad importa es la ultima: que el REP declare como
 * saldada ESTA factura, comparando su UUID contra los `DoctoRelacionado`. Sin
 * ella bastaria subir cualquier complemento propio para desbloquear cualquier
 * factura, y el bloqueo por recibo pendiente dejaria de significar nada.
 */
export async function registrarComplemento(datos: {
  session: SessionPayload
  folio: string
  xml: ArchivoEntrante
}): Promise<{ folio: string; uuid: string; status: InvoiceStatus }> {
  const { session, folio } = datos

  const coleccion = await invoices()
  const factura = await coleccion.findOne(
    supplierScope<InvoiceDoc>({ folio }, { supplierCode: session.supplierCode, internal: false }),
  )
  if (!factura) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.NO_ENCONTRADA,
      404,
      `No tienes ninguna factura con folio ${folio}.`,
    )
  }

  if (factura.status !== InvoiceStatus.PAGADA) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.NO_PAGADA,
      409,
      'El complemento se emite cuando el pago ya se recibio, y esta factura todavia no esta marcada como pagada.',
    )
  }

  if (!requiereComplemento(factura.paymentMethod)) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.NO_APLICA,
      422,
      'Esta factura es PUE: se pago en una sola exhibicion y no lleva complemento.',
    )
  }

  if (factura.paymentReceipt) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.YA_CARGADO,
      409,
      `El complemento de ${folio} ya se habia cargado.`,
    )
  }

  let cfdi
  try {
    cfdi = parseCfdi(datos.xml.bytes)
  } catch (error) {
    if (error instanceof CfdiParseError) {
      throw new ComplementoError(COMPLEMENTO_ERROR.XML_INVALIDO, 422, error.message)
    }
    throw error
  }

  if (cfdi.tipoDeComprobante !== TIPO_PAGO) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.NO_ES_COMPLEMENTO,
      422,
      'Ese XML no es un complemento de pago. Un complemento es un CFDI de tipo P, no la factura ni una nota de credito.',
    )
  }

  if (cfdi.emisor.rfc.toUpperCase() !== (factura.issuerTaxId ?? '').toUpperCase()) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.RFC_AJENO,
      422,
      `El complemento lo emite ${cfdi.emisor.rfc} y la factura la emitio ${factura.issuerTaxId}. Tienen que ser el mismo RFC.`,
    )
  }

  const uuidFactura = (factura.uuid ?? '').toUpperCase()
  const salda = cfdi.pagos.some((p) => p.documentos.some((d) => d.uuid === uuidFactura))
  if (!salda) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.NO_SALDA_LA_FACTURA,
      422,
      `Este complemento no menciona la factura ${folio}. Revisa que el UUID ${uuidFactura} este entre sus documentos relacionados.`,
    )
  }

  let fileKey: string
  try {
    fileKey = await storeDocument(datos.xml, {
      supplierCode: factura.supplierCode,
      uploadedBy: session.userId,
      purpose: 'COMPLEMENTO',
    })
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      throw new ComplementoError(COMPLEMENTO_ERROR.ARCHIVO_GRANDE, 413, error.message)
    }
    throw error
  }

  const ahora = new Date()

  // Se vuelve a exigir el estado en el filtro: entre la lectura de arriba y este
  // update cabe otro envio del mismo complemento.
  const cambio = await coleccion.updateOne(
    { folio, paymentReceipt: { $in: [null] } },
    {
      $set: {
        status: InvoiceStatus.CERRADA,
        paymentReceipt: {
          fileKey,
          uuid: cfdi.timbre.uuid,
          uploadedAt: ahora,
          registeredBy: session.userId,
          registeredAt: ahora,
        },
        updatedAt: ahora,
      },
    },
  )
  if (cambio.matchedCount === 0) {
    throw new ComplementoError(
      COMPLEMENTO_ERROR.YA_CARGADO,
      409,
      `El complemento de ${folio} ya se habia cargado.`,
    )
  }

  await (
    await invoiceEvents()
  ).insertOne({
    invoiceFolio: folio,
    fromStatus: InvoiceStatus.PAGADA,
    toStatus: InvoiceStatus.CERRADA,
    actorId: session.userId,
    actorRole: session.roles.join(','),
    comment: `El proveedor cargo el complemento de pago ${cfdi.timbre.uuid}.`,
    payload: { uuid: cfdi.timbre.uuid },
    createdAt: ahora,
  })

  await (
    await auditLog()
  ).insertOne({
    entityType: 'invoice',
    entityId: folio,
    action: 'COMPLEMENTO_CARGADO',
    actorId: session.userId,
    actorRole: session.roles.join(','),
    before: { status: InvoiceStatus.PAGADA },
    after: { status: InvoiceStatus.CERRADA, complemento: cfdi.timbre.uuid },
    comment: null,
    createdAt: ahora,
  })

  return { folio, uuid: cfdi.timbre.uuid, status: InvoiceStatus.CERRADA }
}
