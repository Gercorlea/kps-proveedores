import { MongoServerError } from 'mongodb'
import type { SessionPayload } from '../auth/session'
import { parseCfdi } from '../cfdi/parser'
import { CfdiParseError, TIPO_NOTA_CREDITO } from '../cfdi/types'
import { validarExterno } from '../cfdi/validaciones-externas'
import { validarCfdi, type Validacion } from '../cfdi/validations'
import { getConfig } from '../config'
import { InvoiceStatus, InvoiceType } from '../domain/enums'
import { cotejarConEntrada, paraGuardar } from '../matching/desde-sap'
import type { MatchResult } from '../matching/types'
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
import {
  leerEntradasFacturables,
  type EntradaFacturable,
} from '../sap/entradas-facturables'
import type { B1PurchaseOrder } from '../sap/types'
import { DocumentTooLargeError, storeDocument, type ArchivoEntrante } from '../storage/documents'

/**
 * Alta de una factura desde la pantalla de una orden de compra.
 *
 * Es un camino distinto al de `submit.ts` y no una variante suya, por dos
 * diferencias que cambian todo:
 *
 *   1. QUIEN. En `submit.ts` sube el proveedor y el `supplierCode` sale de su
 *      sesion. Aqui sube KPS, cuya sesion no tiene proveedor: el proveedor sale
 *      de la ORDEN. Por eso el CardCode se pasa como dato y no se lee de la
 *      sesion, y por eso se comprueba que el RFC del emisor del CFDI sea el del
 *      proveedor de esa orden — si no, KPS estaria colgando la factura de una
 *      empresa a la orden de otra.
 *
 *   2. QUE ESTATUS. M5/S4 exigen XML *y* PDF, y M6/S3 exigen evidencia. Aqui
 *      solo hay XML, asi que la factura NO puede entrar en EN_REVISION: se
 *      guarda como BORRADOR (§10.2). Ponerla en revision con la mitad de los
 *      documentos haria que KPS revisara expedientes incompletos creyendolos
 *      completos.
 *
 * Lo que si comparte con `submit.ts`: el XML se parsea y se valida en el
 * servidor, y el UUID duplicado se rechaza. Que la carga la haga KPS no relaja
 * ninguna de las dos cosas.
 *
 * ALMACENAMIENTO. El XML se guarda local, en la coleccion `documents` de Mongo,
 * y se sirve por /api/v1/documents/[key], que comprueba la sesion en cada
 * descarga. No hay bucket de S3 ni URL publica.
 */

export const FROM_ORDER_ERROR = {
  PROVEEDOR_NO_REGISTRADO: 'PROVEEDOR_NO_REGISTRADO',
  XML_INVALIDO: 'XML_INVALIDO',
  ES_NOTA_CREDITO: 'ES_NOTA_CREDITO',
  DUPLICADO: 'DUPLICADO',
  RFC_NO_COINCIDE: 'RFC_NO_COINCIDE',
  ARCHIVO_GRANDE: 'ARCHIVO_GRANDE',
  ENTRADA_NO_VALIDA: 'ENTRADA_NO_VALIDA',
  ENTRADA_YA_FACTURADA: 'ENTRADA_YA_FACTURADA',
} as const
export type FromOrderErrorCode = (typeof FROM_ORDER_ERROR)[keyof typeof FROM_ORDER_ERROR]

export class InvoiceFromOrderError extends Error {
  constructor(
    readonly code: FromOrderErrorCode,
    readonly status: 403 | 409 | 413 | 422,
    message: string,
    readonly validaciones?: Validacion[],
  ) {
    super(message)
    this.name = 'InvoiceFromOrderError'
  }
}

export interface DatosDesdeOrden {
  /** Sesion de KPS. Se registra como actor en la bitacora. */
  actor: SessionPayload
  /** CardCode del proveedor de la orden. NO viene de la sesion. */
  cardCode: string
  /** DocNum de la orden, el numero que ve la gente. */
  poNumber: string
  /** DocEntry de la orden, la clave real en B1. */
  poDocEntry: number
  /**
   * DocEntry de la entrada de mercancia contra la que se factura.
   *
   * OBLIGATORIO. Es el `BaseEntry` del payload de `PurchaseInvoices`, y sin el
   * la factura no se puede registrar nunca en B1: no hay `DocumentLines` que
   * armar. Aceptarlo ausente dejaba entrar facturas que llegaban hasta
   * APROBADA_PAGO y ahi se atascaban, con el proveedor esperando un pago que no
   * podia procesarse y sin nada que corregir por su parte.
   *
   * La regla de negocio detras: la unidad de facturacion es la ENTRADA, no la
   * orden (§00 consecuencia 01). Una factura sin entrada cobra mercancia que,
   * hasta donde consta en Business One, no ha llegado.
   */
  goodsReceiptDocEntry: number
  xml: ArchivoEntrante
  /**
   * La orden ya leida de Business One, con sus renglones.
   *
   * La pasa quien llama porque ya la tuvo que leer para saber de quien es. Sin
   * ella el cotejo no se corre —no hay contra que comparar— y se dice asi en la
   * bitacora, en vez de dar por buena una factura que nadie comparo.
   */
  orden?: B1PurchaseOrder | null
}

export interface ResultadoDesdeOrden {
  folio: string
  uuid: string
  status: InvoiceStatus
  total: string
  currency: string
  /** Clave del XML guardado. Se sirve por /api/v1/documents/[key]. */
  xmlFileKey: string
  validaciones: Validacion[]
  faltan: string[]
  /** Resultado del cotejo contra la entrada. Null si no se pudo correr. */
  cotejo: MatchResult | null
}

/** Mismo formato de folio que `submit.ts`: los dos caminos comparten contador. */
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

/**
 * Comprueba que la entrada elegida sea facturable y sea de ESTA orden.
 *
 * NUNCA devuelve null: sin entrada no hay factura. Esa es la regla, y es la
 * misma que impone B1 —el payload copia de la entrada con `BaseType: 20`— asi
 * que aceptar una factura sin ella solo aplaza el rechazo hasta un momento en el
 * que el proveedor ya no puede hacer nada.
 *
 * Si la lectura de B1 falla se rechaza la carga en vez de dejar pasar sin
 * comprobar. Es lo contrario de lo prudente en una lectura de adorno, pero aqui
 * no lo es: dar por buena una entrada que no se pudo verificar permitiria
 * facturar contra la entrada de otra orden, o de otro proveedor.
 */
async function resolverEntrada(input: {
  docEntry: number
  poDocEntry: number
  poNumber: string
  cardCode: string
}): Promise<EntradaFacturable> {
  let facturables
  try {
    const { entradas } = await leerEntradasFacturables({
      poDocEntry: input.poDocEntry,
      cardCode: input.cardCode,
    })
    facturables = entradas
  } catch (error) {
    throw new InvoiceFromOrderError(
      FROM_ORDER_ERROR.ENTRADA_NO_VALIDA,
      422,
      `No se pudo comprobar en Business One que la entrada ${input.docEntry} sea de la OC ${input.poNumber}. Intentalo de nuevo en un momento. (${error instanceof Error ? error.message : 'error desconocido'})`,
    )
  }

  const elegida = facturables.find((e) => e.docEntry === input.docEntry)
  if (!elegida) {
    throw new InvoiceFromOrderError(
      FROM_ORDER_ERROR.ENTRADA_NO_VALIDA,
      422,
      `La entrada ${input.docEntry} no esta entre las de la OC ${input.poNumber} que se pueden facturar. O ya se facturo, o se cancelo, o pertenece a otra orden.`,
    )
  }

  // Regla M3: una factura por entrada. El indice unico de `goodsReceiptNumber`
  // es la defensa de verdad —dos cargas simultaneas pasan las dos por aqui—,
  // pero comprobarlo antes permite decirlo con el folio de la otra factura en
  // vez de con un error de clave duplicada.
  const yaFacturada = await (
    await invoices()
  ).findOne({ goodsReceiptNumber: String(elegida.docNum) }, { projection: { folio: 1 } })

  if (yaFacturada) {
    throw new InvoiceFromOrderError(
      FROM_ORDER_ERROR.ENTRADA_YA_FACTURADA,
      409,
      `La entrada ${elegida.docNum} ya se facturo con el folio ${yaFacturada.folio}. Cada entrada de mercancia se factura una sola vez.`,
    )
  }

  return elegida
}

export async function createInvoiceFromOrder(datos: DatosDesdeOrden): Promise<ResultadoDesdeOrden> {
  const { actor, cardCode, poNumber, poDocEntry } = datos

  // --- El proveedor de la orden -------------------------------------------
  const proveedor = await (await suppliers()).findOne({ supplierCode: cardCode })
  if (!proveedor) {
    throw new InvoiceFromOrderError(
      FROM_ORDER_ERROR.PROVEEDOR_NO_REGISTRADO,
      409,
      `El proveedor ${cardCode} existe en Business One pero no esta registrado en el portal. Registralo primero en Proveedores y elige si es de mercancia o de servicios.`,
    )
  }

  // --- La entrada de mercancia --------------------------------------------
  // Se comprueba contra B1 y no contra lo que manda el formulario: aceptar el
  // DocEntry a ciegas dejaria facturar contra la entrada de otra orden, o de
  // otro proveedor, y B1 lo aceptaria sin rechistar porque el documento existe.
  const entrada = await resolverEntrada({
    docEntry: datos.goodsReceiptDocEntry,
    poDocEntry,
    poNumber,
    cardCode,
  })

  // --- El XML --------------------------------------------------------------
  let cfdi
  try {
    cfdi = parseCfdi(datos.xml.bytes)
  } catch (error) {
    if (error instanceof CfdiParseError) {
      throw new InvoiceFromOrderError(FROM_ORDER_ERROR.XML_INVALIDO, 422, error.message)
    }
    throw error
  }

  if (cfdi.tipoDeComprobante === TIPO_NOTA_CREDITO) {
    throw new InvoiceFromOrderError(
      FROM_ORDER_ERROR.ES_NOTA_CREDITO,
      422,
      'Ese XML es una nota de credito, no una factura. Las notas de credito se cargan desde la factura que corrigen.',
    )
  }

  // El emisor tiene que ser el proveedor de ESTA orden. Sin esta comprobacion,
  // cargar el XML equivocado colgaria la factura de una empresa a la orden de
  // otra, y el error solo saldria a la luz al pagar.
  const rfcEmisor = cfdi.emisor.rfc.trim().toUpperCase()
  if (rfcEmisor !== proveedor.taxId.trim().toUpperCase()) {
    throw new InvoiceFromOrderError(
      FROM_ORDER_ERROR.RFC_NO_COINCIDE,
      422,
      `El XML lo emite ${rfcEmisor}, pero la OC ${poNumber} es del proveedor ${cardCode} con RFC ${proveedor.taxId}. Esa factura no corresponde a esta orden.`,
    )
  }

  // --- Duplicado y validaciones -------------------------------------------
  const coleccionFacturas = await invoices()
  const yaCargada = await coleccionFacturas.findOne(
    { uuid: cfdi.timbre.uuid },
    { projection: { folio: 1 } },
  )
  if (yaCargada) {
    throw new InvoiceFromOrderError(
      FROM_ORDER_ERROR.DUPLICADO,
      409,
      `Esta factura ya se cargo con el folio ${yaCargada.folio}. El UUID ${cfdi.timbre.uuid} no se puede cargar dos veces.`,
    )
  }

  const validaciones = validarCfdi(cfdi, {
    rfcKps: getConfig().kps.taxId,
    proveedor: {
      taxId: proveedor.taxId,
      legalName: proveedor.legalName,
      status: proveedor.status,
      blocked: proveedor.blocked,
      blockReason: proveedor.blockReason,
    },
    uuidDuplicado: false,
  })

  // --- Lo que hay que preguntar fuera -------------------------------------
  // SAT_VIGENTE y LISTA_69B salen a internet, asi que no caben en `validarCfdi`,
  // que es pura. Ninguna de las dos lanza: un SAT caido sale como "no
  // comprobado", nunca como un rechazo.
  validaciones.push(...(await validarExterno(cfdi)))

  // --- Cotejo three-way (§06) ---------------------------------------------
  // ES LO QUE IMPIDE EL DESCUADRE. Business One copia los importes de la ENTRADA
  // al registrar la factura, no del CFDI: una factura que dice 29,000 contra una
  // entrada que vale 29 se registra por 29 y B1 no protesta. La diferencia solo
  // aparece meses despues, al cuadrar la cuenta de dotacion. Aqui se ve al
  // cargar, con el renglon y el importe exactos.
  //
  // Sin la orden no se coteja. No se lee de B1 por nuestra cuenta a proposito:
  // quien llama ya la tuvo que leer para saber de quien es, y una segunda
  // lectura solo anadiria una llamada mas que puede fallar.
  let cotejo: MatchResult | null = null
  if (datos.orden) {
    const { resultado, validaciones: reglasCotejo } = cotejarConEntrada({
      orden: datos.orden,
      entrada,
      cfdi,
    })
    cotejo = resultado
    validaciones.push(...reglasCotejo)
  } else {
    validaciones.push({
      regla: 'COTEJO_CANTIDAD',
      severidad: 'INFO',
      pasa: false,
      detalle:
        'No se cotejo: quien cargo la factura no aporto la orden de compra. Nadie ha comparado lo facturado contra lo recibido.',
    })
  }

  // A diferencia de `submit.ts`, una validacion bloqueante NO impide guardar: lo
  // que se esta creando es un BORRADOR, y un borrador con reglas en rojo es
  // justamente lo que hay que poder ver para corregirlo. Lo que si impide
  // guardar es el duplicado y el RFC ajeno, que son de arriba, porque esos no se
  // corrigen cambiando un dato: son la factura equivocada.

  // --- El archivo ----------------------------------------------------------
  // Fuera de la transaccion a proposito: una transaccion de Mongo cabe en un
  // solo registro del oplog (16 MB) y el binario la reventaria. Si lo de abajo
  // falla, aqui queda un blob huerfano —sobra espacio— en vez de una factura
  // apuntando a un archivo inexistente.
  let xmlFileKey: string
  try {
    xmlFileKey = await storeDocument(datos.xml, {
      purpose: 'XML',
      supplierCode: proveedor.supplierCode,
      uploadedBy: actor.userId,
    })
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      throw new InvoiceFromOrderError(FROM_ORDER_ERROR.ARCHIVO_GRANDE, 413, error.message)
    }
    throw error
  }

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
    // Viene de una orden de compra, asi que es del flujo de mercancia.
    type: InvoiceType.MERCANCIA,
    supplierCode: cardCode,
    status: InvoiceStatus.BORRADOR,

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
    paymentMethod: cfdi.metodoPago ?? null,
    paymentForm: cfdi.formaPago ?? null,
    cfdiUse: cfdi.receptor.usoCFDI ?? null,
    lines,

    poNumber,
    poDocEntry,
    // La entrada es lo que hace registrable la factura en B1: `baseEntry` es el
    // `BaseEntry` del payload y `goodsReceiptNumber` el numero que ve la gente,
    // ademas del que lleva el indice unico de la regla M3.
    goodsReceiptNumber: String(entrada.docNum),
    baseEntry: entrada.docEntry,

    // El cotejo, tal como quedo al cargar. Es la constancia de por que se
    // aprobo o se rechazo la factura, y lo que el dashboard mira antes de
    // registrarla en Business One.
    matchOutcome: cotejo?.outcome ?? null,
    matchResult: cotejo ? paraGuardar(cotejo) : null,

    xmlFileKey,
    // Todavia no hay PDF ni evidencia: por eso es BORRADOR.
    pdfFileKey: null,
    evidence: [],

    createdAt: ahora,
    updatedAt: ahora,
  }

  const faltan = ['el PDF de la factura', 'la evidencia con titulo y descripcion']

  const client = await getMongo()
  const sesion = client.startSession()
  try {
    // §11: el evento de bitacora se escribe en la misma transaccion que el alta.
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
          toStatus: InvoiceStatus.BORRADOR,
          actorId: actor.userId,
          actorRole: actor.roles.join(','),
          comment: `KPS cargo el XML desde la OC ${poNumber}. Queda en BORRADOR: faltan ${faltan.join(' y ')}. ${
            cotejo
              ? `Cotejo contra la entrada ${entrada.docNum}: ${cotejo.summary}`
              : 'El cotejo contra la entrada de mercancia NO se corrio: no se aporto la orden.'
          }`,
          payload: {
            uuid: cfdi.timbre.uuid,
            total: cfdi.total.toFixed(2),
            moneda: cfdi.moneda,
            poNumber,
            poDocEntry,
          },
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
          action: 'FACTURA_CARGADA_DESDE_OC',
          actorId: actor.userId,
          actorRole: actor.roles.join(','),
          before: null,
          after: { status: InvoiceStatus.BORRADOR, uuid: cfdi.timbre.uuid, poNumber },
          comment: `XML de ${proveedor.legalName} cargado contra la OC ${poNumber}.`,
          createdAt: ahora,
        },
        { session: sesion },
      )
    })
  } catch (error) {
    // El indice unico de `uuid` es la ultima defensa: dos cargas simultaneas del
    // mismo XML pasan las dos la comprobacion de arriba y solo una escribe.
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new InvoiceFromOrderError(
        FROM_ORDER_ERROR.DUPLICADO,
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
    status: InvoiceStatus.BORRADOR,
    total: cfdi.total.toFixed(2),
    currency: cfdi.moneda,
    xmlFileKey,
    validaciones,
    faltan,
    cotejo,
  }
}
