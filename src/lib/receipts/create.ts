import { z } from 'zod'
import type { SessionPayload } from '../auth/session'
import { Decimal, moneyOrZero, round3 } from '../money'
import { auditLog } from '../mongo'
import { getSapClient, SapError } from '../sap'
import { calcularRecepcion, renglonDesdeB1 } from '../matching/recepciones'
import { leerEntradasDeOrdenes } from '../sap/entradas'
import { leerRestricciones } from './articulos'
import { B1_OBJECT_TYPE, type B1PurchaseOrder } from '../sap/types'

/**
 * Alta de una entrada de mercancia (GRPO) contra una orden de compra.
 *
 * QUE ES ESTO Y POR QUE EXISTE. En la operacion real la entrada la registra
 * almacen dentro de Business One cuando el camion descarga; el portal solo la
 * lee. Esta captura existe para poder recorrer el flujo de mercancia de punta a
 * punta en la empresa de pruebas sin depender de que alguien entre a B1: sin
 * entrada no hay nada que facturar, porque la unidad de facturacion de este
 * flujo es la ENTRADA, no la orden (§00 consecuencia 01).
 *
 * DONDE SE ESCRIBE. En Business One, no en Mongo. La coleccion `goodsReceipts`
 * existe en el esquema pero nadie la lee: las dos pantallas que muestran lo
 * recibido —/ordenes y /ordenes/[docEntry]— consultan B1 en vivo a traves de
 * `leerEntradasDeOrdenes`. Una entrada guardada solo en Mongo no apareceria en
 * ninguna de las dos y no habilitaria la facturacion, que es justo para lo que
 * se captura.
 *
 * SE COPIA DE LA ORDEN, NO SE CAPTURA A MANO. Cada linea va con BaseType 22 +
 * BaseEntry + BaseLine (regla OC5), asi B1 hereda articulo, precio, almacen e
 * impuestos del renglon y ademas descuenta lo abierto. Mandar descripcion y
 * precio sueltos crearia una entrada que no cuelga de la orden, y el renglon
 * seguiria abierto para siempre.
 *
 * SOBRE §04 PRINCIPIO 2. El principio dice que ninguna llamada a SAP ocurre
 * dentro de un request HTTP, y esto es una ESCRITURA hecha en linea, asi que lo
 * incumple. Es deliberado y acotado: montar un worker de cola para una
 * herramienta de captura de pruebas cuesta mas de lo que protege, y quien la usa
 * esta esperando el resultado delante de la pantalla. Toda escritura del flujo
 * real —registrar la factura en B1, adjuntar el CFDI— si tiene que ir por cola.
 */

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export const capturaEntradaSchema = z.object({
  /** DocEntry de la orden que se surte. */
  poDocEntry: z.number().int().positive(),
  /** Fecha de entrada al almacen, 'YYYY-MM-DD'. */
  fecha: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe venir como AAAA-MM-DD.')
    .optional(),
  comentario: z.string().trim().max(254).optional(),
  /**
   * Cuanto llego de cada renglon. Se identifican por `LineNum` de la orden y no
   * por su posicion en el arreglo: la pantalla puede mandar solo los renglones
   * que el usuario toco, y el orden de las lineas en B1 no es estable.
   */
  lineas: z
    .array(
      z.object({
        lineNum: z.number().int().min(0),
        cantidad: z.number().nonnegative().finite(),
        /**
         * Lotes de este renglon. Obligatorio solo si el articulo se maneja por
         * lote; el servidor lo comprueba contra el maestro de articulos, no
         * contra lo que diga el formulario.
         */
        lotes: z
          .array(
            z.object({
              numero: z.string().trim().min(1, 'El lote necesita numero.').max(36),
              cantidad: z.number().positive().finite(),
              /** Caducidad, 'AAAA-MM-DD'. */
              caducidad: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, 'La caducidad debe venir como AAAA-MM-DD.')
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1, 'Indica al menos un renglon.'),
})

export type CapturaEntrada = z.infer<typeof capturaEntradaSchema>

export interface DatosEntrada extends CapturaEntrada {
  /** Sesion de KPS. Se registra como actor en la bitacora. */
  actor: SessionPayload
}

export interface ResultadoEntrada {
  docEntry: number
  docNum: number
  poNumber: string
  cardCode: string
  fecha: string
  /** Renglones que se mandaron, ya resueltos contra la orden. */
  lineas: Array<{ lineNum: number; descripcion: string; cantidad: string }>
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export const RECEIPT_ERROR = {
  ORDEN_NO_EXISTE: 'ORDEN_NO_EXISTE',
  ORDEN_CERRADA: 'ORDEN_CERRADA',
  ORDEN_CANCELADA: 'ORDEN_CANCELADA',
  RENGLON_NO_EXISTE: 'RENGLON_NO_EXISTE',
  SIN_CANTIDADES: 'SIN_CANTIDADES',
  EXCEDE_PENDIENTE: 'EXCEDE_PENDIENTE',
  FALTA_LOTE: 'FALTA_LOTE',
  LOTE_NO_CUADRA: 'LOTE_NO_CUADRA',
  SAP: 'SAP',
} as const
export type ReceiptErrorCode = (typeof RECEIPT_ERROR)[keyof typeof RECEIPT_ERROR]

export class ReceiptError extends Error {
  constructor(
    readonly code: ReceiptErrorCode,
    readonly status: 404 | 409 | 422 | 502,
    message: string,
  ) {
    super(message)
    this.name = 'ReceiptError'
  }
}

// ---------------------------------------------------------------------------
// Lectura de la orden
// ---------------------------------------------------------------------------

/**
 * Cuanto queda abierto en un renglon.
 *
 * `RemainingOpenQuantity` es lo que B1 considera pendiente. Cuando no viene —hay
 * `$select` que no lo traen— se cae a la cantidad pedida, que es el limite mas
 * permisivo posible; B1 rechazara igualmente el exceso al crear. Se prefiere
 * dejar pasar y que decida B1 antes que bloquear una captura legitima por un
 * campo ausente.
 */
function pendienteDe(linea: { Quantity: number; RemainingOpenQuantity?: number | null }): Decimal {
  const abierta = linea.RemainingOpenQuantity
  if (abierta === null || abierta === undefined) return moneyOrZero(linea.Quantity)
  return moneyOrZero(abierta)
}

/**
 * Cuanto admite B1 todavia en cada renglon, por numero de renglon.
 *
 * `RemainingOpenQuantity` no basta: en la orden 1120 B1 lo devuelve en 10 con el
 * renglon abierto aunque esas 10 ya se recibieron, y luego rechaza la entrada
 * con el error (81) de tolerancia. Cruzar con las entradas ya registradas da el
 * limite que B1 va a aplicar de verdad, y permite negarlo aqui con un mensaje
 * que se entiende en vez de dejar salir el de HANA en crudo.
 *
 * Devuelve un mapa vacio si B1 no contesta: se cae a `pendienteDe`, que es el
 * limite mas permisivo. Quedarse sin este dato no puede bloquear una captura
 * legitima, porque B1 sigue teniendo la ultima palabra al crear.
 */
async function limitesReales(oc: B1PurchaseOrder): Promise<Map<number, Decimal>> {
  try {
    const { porOrden } = await leerEntradasDeOrdenes({
      ordenes: [{ DocEntry: oc.DocEntry, DocDate: oc.DocDate }],
      cardCode: oc.CardCode,
    })
    const recepcion = calcularRecepcion({
      orden: (oc.DocumentLines ?? []).map(renglonDesdeB1),
      entradas: porOrden.get(oc.DocEntry) ?? [],
    })
    return new Map(recepcion.renglones.map((r) => [r.lineNum, r.recibible]))
  } catch {
    return new Map()
  }
}

export async function leerOrdenParaEntrada(poDocEntry: number): Promise<B1PurchaseOrder> {
  let oc: B1PurchaseOrder | null
  try {
    oc = await getSapClient().getPurchaseOrder(poDocEntry)
  } catch (error) {
    const mensaje = error instanceof SapError ? error.message : 'No se pudo consultar Business One.'
    throw new ReceiptError(RECEIPT_ERROR.SAP, 502, mensaje)
  }

  if (!oc) {
    throw new ReceiptError(
      RECEIPT_ERROR.ORDEN_NO_EXISTE,
      404,
      `No hay ninguna orden con el numero ${poDocEntry}.`,
    )
  }
  return oc
}

/** Una orden cancelada o cerrada ya no admite entradas. B1 lo rechaza; se dice antes y mejor. */
export function comprobarOrdenAbierta(oc: B1PurchaseOrder): void {
  if (oc.Cancelled === 'tYES') {
    throw new ReceiptError(
      RECEIPT_ERROR.ORDEN_CANCELADA,
      409,
      `La OC ${oc.DocNum} esta cancelada en Business One: no puede recibir mercancia.`,
    )
  }
  if (oc.DocumentStatus !== 'bost_Open') {
    throw new ReceiptError(
      RECEIPT_ERROR.ORDEN_CERRADA,
      409,
      `La OC ${oc.DocNum} ya no esta abierta en Business One: no admite mas entradas.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

/** Hoy en UTC como 'YYYY-MM-DD'. B1 espera la fecha sin hora ni zona. */
function hoy(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Traduce los rechazos de B1 que tienen una causa concreta y accionable.
 *
 * El Service Layer contesta en ingles y sin contexto. El de lotes y numeros de
 * serie es con diferencia el que mas se topa: un articulo gestionado asi no se
 * puede recibir indicando solo la cantidad, hay que decir QUE lote entro, y esta
 * pantalla todavia no lo captura. Dicho con esas palabras, quien lo lea sabe que
 * no es un fallo del portal y deja de reintentar.
 */
function explicarRechazo(mensaje: string): string {
  // (81) es la tolerancia de cantidad: B1 dice que la entrada recibe mas de lo
  // que el renglon admite. El guard de `limitesReales` lo atrapa antes, pero si
  // la lectura de entradas fallo el rechazo llega hasta aqui, y en crudo dice
  // "Quantity falls into negative inventory" sin nombrar el renglon.
  if (/\(81\)|negative inventory|tolerance/i.test(mensaje)) {
    return `Business One rechazo la entrada porque alguno de los renglones ya tiene toda su mercancia recibida, aunque la orden lo siga mostrando abierto. Revisa las entregas ya registradas de esta orden antes de volver a capturar. (Respuesta de SAP: "${mensaje}")`
  }
  if (/batch|serial/i.test(mensaje)) {
    return `Business One no acepto la identificacion de lotes o numeros de serie de esta entrada. Suele ser una de dos: el articulo se maneja por NUMERO DE SERIE —que esta pantalla todavia no captura— o el almacen exige indicar la ubicacion y no se pudo resolver. Registra esa entrada directamente en Business One. (Respuesta de SAP: "${mensaje}")`
  }
  return mensaje
}

export async function crearEntradaDeMercancia(datos: DatosEntrada): Promise<ResultadoEntrada> {
  const { actor, poDocEntry } = datos

  const oc = await leerOrdenParaEntrada(poDocEntry)
  comprobarOrdenAbierta(oc)

  const renglones = oc.DocumentLines ?? []
  const limites = await limitesReales(oc)

  // Los ceros se descartan aqui y no en la pantalla: el formulario manda todos
  // los renglones y B1 rechaza una linea en cero. Descartarlos sin comprobar que
  // queda alguno dejaria pasar un "no llego nada" como entrada vacia.
  const conCantidad = datos.lineas.filter((l) => l.cantidad > 0)
  if (conCantidad.length === 0) {
    throw new ReceiptError(
      RECEIPT_ERROR.SIN_CANTIDADES,
      422,
      'No capturaste ninguna cantidad. Una entrada de mercancia sin piezas no registra nada.',
    )
  }

  const resueltas: Array<{
    lineNum: number
    itemCode: string | null
    /** `WarehouseCode` del renglon. Decide si hace falta reparto por ubicacion. */
    almacen: string | null
    descripcion: string
    cantidad: Decimal
    lotes: Array<{ numero: string; cantidad: number; caducidad?: string }>
  }> = []
  for (const linea of conCantidad) {
    const renglon = renglones.find((r) => r.LineNum === linea.lineNum)
    if (!renglon) {
      throw new ReceiptError(
        RECEIPT_ERROR.RENGLON_NO_EXISTE,
        422,
        `La OC ${oc.DocNum} no tiene el renglon ${linea.lineNum}.`,
      )
    }

    const cantidad = round3(moneyOrZero(linea.cantidad))
    // El limite real cruza lo abierto en B1 con lo que ya entro al almacen. Solo
    // se cae al campo crudo cuando no se pudieron leer las entradas.
    const pendiente = limites.get(linea.lineNum) ?? pendienteDe(renglon)
    if (cantidad.gt(pendiente)) {
      const descripcion = renglon.ItemDescription ?? renglon.ItemCode ?? `renglon ${linea.lineNum}`
      // Con el limite en cero el renglon ya esta surtido. Decir "solo quedan 0
      // pendientes" sonaria a fallo del portal cuando lo que pasa es que no hay
      // nada que recibir, asi que ese caso se explica aparte.
      throw new ReceiptError(
        RECEIPT_ERROR.EXCEDE_PENDIENTE,
        422,
        pendiente.lte(0)
          ? `En "${descripcion}" ya se recibio todo lo que pedia la OC ${oc.DocNum}. Business One no admite otra entrada contra ese renglon, aunque siga apareciendo abierto. Si de verdad llego mas mercancia, hay que ampliar la orden en Business One.`
          : `En "${descripcion}" capturaste ${cantidad.toString()} pero solo quedan ${pendiente.toString()} pendientes. Business One no admite recibir por encima de lo abierto.`,
      )
    }

    resueltas.push({
      lineNum: linea.lineNum,
      itemCode: renglon.ItemCode ?? null,
      almacen: renglon.WarehouseCode ?? null,
      descripcion: renglon.ItemDescription ?? renglon.ItemCode ?? `Renglon ${linea.lineNum}`,
      cantidad,
      lotes: linea.lotes ?? [],
    })
  }

  // --- Lotes -------------------------------------------------------------
  // Que renglones los exigen lo dice el MAESTRO DE ARTICULOS, no el formulario:
  // fiarse de lo que mande el cliente permitiria omitirlos quitando el campo, y
  // el rechazo de B1 llegaria en ingles y sin decir cual falta.
  const restricciones = await leerRestricciones(
    resueltas.map((l) => l.itemCode).filter((c): c is string => Boolean(c)),
  )

  for (const l of resueltas) {
    const r = l.itemCode ? restricciones.get(l.itemCode) : undefined
    if (!r?.lote) {
      // Un articulo sin lote no admite `BatchNumbers`: B1 rechaza el documento
      // entero si se los mandas. Se descartan en silencio porque el formulario
      // puede traerlos de un renglon que el usuario cambio.
      l.lotes = []
      continue
    }

    if (l.lotes.length === 0) {
      throw new ReceiptError(
        RECEIPT_ERROR.FALTA_LOTE,
        422,
        `${l.itemCode} se maneja por lote: indica que lote llego y cuanto de cada uno. Business One no admite recibirlo sin esa informacion.`,
      )
    }

    // Las cantidades de los lotes tienen que sumar EXACTO lo recibido. B1 lo
    // comprueba tambien, pero su mensaje no dice cuanto falta ni de que renglon.
    const suma = l.lotes.reduce((acc, x) => acc.plus(round3(moneyOrZero(x.cantidad))), moneyOrZero(0))
    if (!suma.equals(l.cantidad)) {
      throw new ReceiptError(
        RECEIPT_ERROR.LOTE_NO_CUADRA,
        422,
        `En "${l.descripcion}" recibiste ${l.cantidad.toString()} pero los lotes suman ${suma.toString()}. Las cantidades de los lotes tienen que sumar exactamente lo que llego.`,
      )
    }

    // Dos renglones del mismo lote son un error de captura: el usuario tecleo el
    // mismo numero dos veces en vez de sumar las piezas.
    const numeros = l.lotes.map((x) => x.numero.trim().toUpperCase())
    if (new Set(numeros).size !== numeros.length) {
      throw new ReceiptError(
        RECEIPT_ERROR.LOTE_NO_CUADRA,
        422,
        `En "${l.descripcion}" repetiste un numero de lote. Si llego mas de una caja del mismo lote, junta las piezas en un solo renglon.`,
      )
    }
  }

  // --- Ubicaciones -------------------------------------------------------
  // El almacen 1 de KPS tiene ubicaciones activas, y B1 no acepta un renglon que
  // entre ahi sin decir a que ubicacion va. Lo desconcertante es que, cuando el
  // articulo ademas lleva lote, el rechazo dice "Cannot add row without complete
  // selection of batch/serial numbers" aunque los lotes esten completos y lo que
  // falte sea esto.
  //
  // Se usa la UBICACION DE SISTEMA, que es la que B1 elige por su cuenta cuando
  // la entrada se captura desde su propio cliente. Repartir por ubicaciones
  // concretas es trabajo de almacen y se hace alli.
  let bins: ReadonlyMap<string, number> = new Map()
  try {
    bins = await getSapClient().binsDeSistema(
      resueltas.map((l) => l.almacen).filter((a): a is string => Boolean(a)),
    )
  } catch {
    // Sin ubicaciones conocidas se manda sin reparto. Si el almacen las exigia,
    // B1 lo dira; inventarse una ubicacion seria peor.
  }

  const fecha = datos.fecha ?? hoy()

  let creada
  try {
    creada = await getSapClient().createPurchaseDeliveryNote({
      // El proveedor sale de la ORDEN, nunca del formulario: aceptarlo del
      // cliente permitiria colgar una entrada de la orden de otra empresa.
      CardCode: oc.CardCode,
      DocDate: fecha,
      ...(datos.comentario ? { Comments: datos.comentario } : {}),
      DocumentLines: resueltas.map((l) => ({
        BaseType: B1_OBJECT_TYPE.PurchaseOrder,
        BaseEntry: oc.DocEntry,
        BaseLine: l.lineNum,
        Quantity: l.cantidad.toNumber(),
        // `BaseLineNumber` es el renglon al que pertenece el lote, y va DENTRO
        // de cada lote: B1 no lo deduce de la posicion en el arreglo.
        ...(l.lotes.length > 0
          ? {
              BatchNumbers: l.lotes.map((x) => ({
                BatchNumber: x.numero.trim(),
                Quantity: round3(moneyOrZero(x.cantidad)).toNumber(),
                BaseLineNumber: l.lineNum,
                ...(x.caducidad ? { ExpiryDate: x.caducidad } : {}),
                AddmisionDate: fecha,
              })),
            }
          : {}),
        // Reparto por ubicacion, solo si el almacen las usa.
        //
        // Con lotes va UNA por lote, enlazada por su posicion en `BatchNumbers`
        // mediante `SerialAndBatchNumbersBaseLine`: es lo que le dice a B1
        // cuanto de CADA lote entra en la ubicacion. Sin lotes basta una por el
        // total del renglon.
        ...(l.almacen && bins.has(l.almacen)
          ? {
              DocumentLinesBinAllocations:
                l.lotes.length > 0
                  ? l.lotes.map((x, i) => ({
                      BinAbsEntry: bins.get(l.almacen as string) as number,
                      Quantity: round3(moneyOrZero(x.cantidad)).toNumber(),
                      BaseLineNumber: l.lineNum,
                      SerialAndBatchNumbersBaseLine: i,
                    }))
                  : [
                      {
                        BinAbsEntry: bins.get(l.almacen) as number,
                        Quantity: l.cantidad.toNumber(),
                        BaseLineNumber: l.lineNum,
                      },
                    ],
            }
          : {}),
      })),
    })
  } catch (error) {
    const crudo =
      error instanceof SapError ? error.message : 'Business One rechazo la entrada y no dijo por que.'
    throw new ReceiptError(RECEIPT_ERROR.SAP, 502, explicarRechazo(crudo))
  }

  // La bitacora se escribe DESPUES y fuera de transaccion: el documento ya vive
  // en B1 y no hay forma de deshacerlo desde aqui, asi que un fallo al
  // registrarlo no debe presentarse como que la entrada no se creo. Si esto
  // falla queda el documento en B1 sin rastro local, que es el menor de los dos
  // males.
  try {
    await (
      await auditLog()
    ).insertOne({
      entityType: 'goodsReceipt',
      entityId: String(creada.DocEntry),
      action: 'ENTRADA_CAPTURADA',
      actorId: actor.userId,
      actorRole: actor.roles.join(','),
      before: null,
      after: {
        docEntry: creada.DocEntry,
        docNum: creada.DocNum,
        poNumber: String(oc.DocNum),
        poDocEntry: oc.DocEntry,
        cardCode: oc.CardCode,
        fecha,
        lineas: resueltas.map((l) => ({ lineNum: l.lineNum, cantidad: l.cantidad.toString() })),
      },
      comment: `Entrada de mercancia capturada desde el portal contra la OC ${oc.DocNum}.`,
      createdAt: new Date(),
    })
  } catch (error) {
    console.error(
      '[entradas] la entrada se creo en B1 pero no se pudo registrar en la bitacora:',
      error,
    )
  }

  return {
    docEntry: creada.DocEntry,
    docNum: creada.DocNum,
    poNumber: String(oc.DocNum),
    cardCode: oc.CardCode,
    fecha,
    lineas: resueltas.map((l) => ({
      lineNum: l.lineNum,
      descripcion: l.descripcion,
      cantidad: l.cantidad.toString(),
    })),
  }
}
