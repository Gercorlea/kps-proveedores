import { MongoServerError } from 'mongodb'
import type { SessionPayload } from '../auth/session'
import { parseCfdi } from '../cfdi/parser'
import { CfdiParseError, TIPO_NOTA_CREDITO } from '../cfdi/types'
import { validarExterno } from '../cfdi/validaciones-externas'
import { bloqueantes, validarCfdi, type Validacion } from '../cfdi/validations'
import { getConfig } from '../config'
import { InvoiceStatus, InvoiceType, SupplierType } from '../domain/enums'
import {
  auditLog,
  documentCounters,
  getMongo,
  invoiceEvents,
  invoices,
  suppliers,
  toDecimal128,
  validationResults,
  type InvoiceDoc,
  type InvoiceLineDoc,
} from '../mongo'
import { DocumentTooLargeError, storeDocument, type ArchivoEntrante } from '../storage/documents'

/**
 * Envio de una factura a revision: la "peticion" que despues atiende KPS.
 *
 * Esto es lo que ocurre cuando el proveedor pulsa "Enviar a revision" en P06.
 * Hasta ahora ese boton no guardaba nada; aqui la carga se convierte en un
 * documento de `invoices` con estatus EN_REVISION, sus archivos, el resultado de
 * cada validacion y un evento de bitacora.
 *
 * DOS PRINCIPIOS QUE ESTE MODULO NO NEGOCIA
 *
 *   1. El XML se vuelve a parsear y a validar aqui. Lo que el navegador enseño
 *      en la vista previa es informativo; si el servidor se fiara de ello,
 *      bastaria un `fetch` a mano para colar una factura que no cuadra.
 *   2. Nada se acepta a medias. Si una regla BLOQUEANTE falla, no se escribe la
 *      factura: el proveedor recibe la lista de lo que esta mal.
 *
 * ALCANCE. §10.2 hace pasar la factura por EN_VALIDACION y EN_COTEJO antes de
 * EN_REVISION. Esos dos estados son de la cola de trabajo, que no existe, y el
 * cotejo necesita la entrada de mercancia de SAP, que no esta conectada a este
 * flujo. La factura entra directamente en EN_REVISION y el evento de bitacora lo
 * dice con todas sus letras, para que nadie lea "EN_REVISION" y suponga que el
 * cotejo se corrio y salio bien.
 */

export const SUBMIT_ERROR = {
  SIN_PROVEEDOR: 'SIN_PROVEEDOR',
  PROVEEDOR_DESCONOCIDO: 'PROVEEDOR_DESCONOCIDO',
  FALTA_ARCHIVO: 'FALTA_ARCHIVO',
  ARCHIVO_GRANDE: 'ARCHIVO_GRANDE',
  XML_INVALIDO: 'XML_INVALIDO',
  ES_NOTA_CREDITO: 'ES_NOTA_CREDITO',
  VALIDACION: 'VALIDACION',
  DUPLICADO: 'DUPLICADO',
} as const
export type SubmitErrorCode = (typeof SUBMIT_ERROR)[keyof typeof SUBMIT_ERROR]

export class InvoiceSubmitError extends Error {
  constructor(
    readonly code: SubmitErrorCode,
    readonly status: 400 | 403 | 409 | 413 | 422,
    message: string,
    /** Las reglas que fallaron, cuando el motivo es una validacion. */
    readonly validaciones?: readonly Validacion[],
  ) {
    super(message)
    this.name = 'InvoiceSubmitError'
  }
}

export interface EvidenciaEntrante {
  archivo: ArchivoEntrante
  titulo: string
  descripcion: string
}

export interface DatosEnvio {
  session: SessionPayload
  xml: ArchivoEntrante
  pdf: ArchivoEntrante
  evidencia: EvidenciaEntrante
}

export interface ResultadoEnvio {
  folio: string
  uuid: string
  status: InvoiceStatus
  total: string
  currency: string
  validaciones: Validacion[]
}

/**
 * Folio consecutivo del portal. Se toma ANTES de abrir la transaccion: si el
 * envio falla despues, se pierde un numero. Un hueco en la numeracion interna no
 * le importa a nadie —el folio fiscal es el del CFDI, no este— y meter el
 * contador dentro alargaria la transaccion sin ganar nada.
 */
async function siguienteFolio(): Promise<string> {
  const year = new Date().getUTCFullYear()
  const contadores = await documentCounters()
  const contador = await contadores.findOneAndUpdate(
    { scope: 'FACTURA', year },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  )
  return `FAC-${year}-${String(contador?.value ?? 1).padStart(3, '0')}`
}

export async function submitInvoice(datos: DatosEnvio): Promise<ResultadoEnvio> {
  const { session } = datos

  // --- Quien sube ---------------------------------------------------------
  if (!session.supplierCode) {
    throw new InvoiceSubmitError(
      SUBMIT_ERROR.SIN_PROVEEDOR,
      403,
      'Tu cuenta no esta vinculada a ningun proveedor, asi que no puede cargar facturas.',
    )
  }

  const proveedor = await (await suppliers()).findOne({ supplierCode: session.supplierCode })
  if (!proveedor) {
    throw new InvoiceSubmitError(
      SUBMIT_ERROR.PROVEEDOR_DESCONOCIDO,
      403,
      `Tu cuenta apunta al proveedor ${session.supplierCode}, que no existe en el portal. Avisa a KPS.`,
    )
  }

  const esDeServicio = proveedor.type === SupplierType.SERVICIO

  // --- El XML -------------------------------------------------------------
  let cfdi
  try {
    cfdi = parseCfdi(datos.xml.bytes)
  } catch (error) {
    if (error instanceof CfdiParseError) {
      throw new InvoiceSubmitError(SUBMIT_ERROR.XML_INVALIDO, 422, error.message)
    }
    throw error
  }

  if (cfdi.tipoDeComprobante === TIPO_NOTA_CREDITO) {
    throw new InvoiceSubmitError(
      SUBMIT_ERROR.ES_NOTA_CREDITO,
      422,
      'Ese XML es una nota de credito, no una factura. Las notas de credito se cargan desde la factura que corrigen.',
    )
  }

  // --- Validaciones (§12.2) ----------------------------------------------
  const coleccionFacturas = await invoices()
  const yaCargada = await coleccionFacturas.findOne(
    { uuid: cfdi.timbre.uuid },
    { projection: { folio: 1 } },
  )

  const contexto = {
    rfcKps: getConfig().kps.taxId,
    proveedor: {
      taxId: proveedor.taxId,
      legalName: proveedor.legalName,
      status: proveedor.status,
      blocked: proveedor.blocked,
      blockReason: proveedor.blockReason,
    },
    uuidDuplicado: yaCargada !== null,
  }
  const validaciones = validarCfdi(cfdi, contexto)

  // SAT_VIGENTE y LISTA_69B salen a internet, asi que no caben en `validarCfdi`,
  // que es pura. Se corren ANTES de decidir: una factura cancelada ante el SAT o
  // de un emisor definitivo del 69-B no debe llegar a escribirse.
  //
  // Ninguna de las dos lanza. Si el SAT esta caido salen como "no comprobado" y
  // no bloquean: el proveedor no puede arreglar una caida del SAT.
  validaciones.push(...(await validarExterno(cfdi)))

  const fallidas = bloqueantes(validaciones)

  if (fallidas.length > 0) {
    throw new InvoiceSubmitError(
      yaCargada ? SUBMIT_ERROR.DUPLICADO : SUBMIT_ERROR.VALIDACION,
      yaCargada ? 409 : 422,
      yaCargada
        ? `Esta factura ya se cargo con el folio ${yaCargada.folio}.`
        : 'La factura no paso las validaciones del portal.',
      fallidas,
    )
  }

  // --- Archivos -----------------------------------------------------------
  const meta = { supplierCode: proveedor.supplierCode, uploadedBy: session.userId }
  let xmlFileKey: string
  let pdfFileKey: string
  let evidenciaFileKey: string
  try {
    ;[xmlFileKey, pdfFileKey, evidenciaFileKey] = await Promise.all([
      storeDocument(datos.xml, { ...meta, purpose: 'XML' }),
      storeDocument(datos.pdf, { ...meta, purpose: 'PDF' }),
      storeDocument(datos.evidencia.archivo, { ...meta, purpose: 'EVIDENCIA' }),
    ])
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      throw new InvoiceSubmitError(SUBMIT_ERROR.ARCHIVO_GRANDE, 413, error.message)
    }
    throw error
  }

  // --- Documento de la factura -------------------------------------------
  const lines: InvoiceLineDoc[] = cfdi.conceptos.map((c) => ({
    lineNumber: c.lineNumber,
    claveProdServ: c.claveProdServ,
    claveUnidad: c.claveUnidad,
    noIdentidad: c.noIdentificacion ?? null,
    description: c.descripcion,
    // Cantidad a 3 decimales y valor unitario a 6, los del CFDI. Redondear el
    // unitario a 2 falsearia el importe en cuanto haya fracciones de centavo.
    quantity: toDecimal128(c.cantidad, 3),
    unitValue: toDecimal128(c.valorUnitario, 6),
    amount: toDecimal128(c.importe),
    discount: toDecimal128(c.descuento),
    taxTransferred: toDecimal128(c.totalTrasladados),
    taxWithheld: toDecimal128(c.totalRetenidos),
  }))

  const ahora = new Date()
  const folio = await siguienteFolio()

  const factura: InvoiceDoc = {
    folio,
    // El tipo de factura sigue al tipo de proveedor: uno de mercancia factura
    // contra entrada, uno de servicios factura sin orden de compra (§05).
    type: esDeServicio ? InvoiceType.SERVICIO : InvoiceType.MERCANCIA,
    supplierCode: session.supplierCode,
    status: InvoiceStatus.EN_REVISION,

    uuid: cfdi.timbre.uuid,
    serie: cfdi.serie ?? null,
    issueDate: cfdi.fecha,
    issuerTaxId: cfdi.emisor.rfc,
    receiverTaxId: cfdi.receptor.rfc,
    subtotal: toDecimal128(cfdi.subTotal),
    taxTransferred: toDecimal128(cfdi.impuestos.totalTrasladados),
    taxWithheld: toDecimal128(cfdi.impuestos.totalRetenidos),
    // El desglose, para que Business One pueda registrar la retencion con su
    // `WTCode` en vez de tener que suponerlo del importe total.
    taxWithholdings: cfdi.impuestos.retenciones.map((r) => ({
      impuesto: r.impuesto,
      tipoFactor: r.tipoFactor,
      tasaOCuota: r.tasaOCuota ? r.tasaOCuota.toString() : null,
      base: r.base.toFixed(2),
      importe: r.importe.toFixed(2),
    })),
    total: toDecimal128(cfdi.total),
    currency: cfdi.moneda,
    exchangeRate: cfdi.tipoCambio ? toDecimal128(cfdi.tipoCambio, 6) : null,
    paymentMethod: cfdi.metodoPago ?? null,
    paymentForm: cfdi.formaPago ?? null,
    cfdiUse: cfdi.receptor.usoCFDI,
    lines,

    xmlFileKey,
    pdfFileKey,
    evidence: [
      {
        title: datos.evidencia.titulo,
        description: datos.evidencia.descripcion,
        fileKey: evidenciaFileKey,
        uploadedAt: ahora,
      },
    ],

    submittedAt: ahora,
    createdAt: ahora,
    updatedAt: ahora,
  }

  const client = await getMongo()
  const sesion = client.startSession()
  try {
    // §11: el evento de bitacora se escribe en la misma transaccion que el
    // cambio de estatus. Exige replica set —Atlas lo es; un mongod suelto no—.
    await sesion.withTransaction(async () => {
      await coleccionFacturas.insertOne(factura, { session: sesion })

      await (
        await validationResults()
      ).insertMany(
        validaciones.map((v) => ({
          invoiceFolio: folio,
          rule: v.regla,
          severity: v.severidad,
          passed: v.pasa,
          detail: v.detalle,
          automated: true,
          ranAt: ahora,
        })),
        { session: sesion },
      )

      await (
        await invoiceEvents()
      ).insertOne(
        {
          invoiceFolio: folio,
          fromStatus: null,
          toStatus: InvoiceStatus.EN_REVISION,
          actorId: session.userId,
          actorRole: session.roles.join(','),
          // Dos textos distintos porque son dos hechos distintos: en mercancia
          // el cotejo existe y no se corrio, en servicios no existe cotejo que
          // correr. Un solo texto haria que KPS leyera una comprobacion
          // pendiente donde nunca la hubo.
          comment: esDeServicio
            ? 'El proveedor cargo el XML, el PDF y la evidencia. Paso las validaciones automaticas del portal. Una factura de servicio no lleva cotejo: no hay entrada de mercancia contra la cual compararla, asi que el respaldo es la evidencia.'
            : 'El proveedor cargo el XML, el PDF y la evidencia. Paso las validaciones automaticas del portal; el cotejo contra la entrada de mercancia NO se corrio: Business One no esta conectado a este flujo.',
          payload: { uuid: cfdi.timbre.uuid, total: cfdi.total.toFixed(2), moneda: cfdi.moneda },
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
          action: 'FACTURA_ENVIADA',
          actorId: session.userId,
          actorRole: session.roles.join(','),
          before: null,
          after: { status: InvoiceStatus.EN_REVISION, uuid: cfdi.timbre.uuid },
          comment: `Peticion de revision de ${proveedor.legalName}.`,
          createdAt: ahora,
        },
        { session: sesion },
      )
    })
  } catch (error) {
    // El indice unico de `uuid` es la ultima defensa contra el duplicado: dos
    // envios simultaneos del mismo XML pasan los dos la comprobacion de arriba y
    // solo uno consigue escribir.
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new InvoiceSubmitError(
        SUBMIT_ERROR.DUPLICADO,
        409,
        'Esta factura ya se cargo en el portal.',
      )
    }
    throw error
  } finally {
    await sesion.endSession()
  }

  return {
    folio,
    uuid: cfdi.timbre.uuid,
    status: InvoiceStatus.EN_REVISION,
    total: cfdi.total.toFixed(2),
    currency: cfdi.moneda,
    validaciones,
  }
}
