import { Decimal, moneyOrZero } from '../money'
import { getSapClient } from './index'
import { B1_OBJECT_TYPE, type B1PurchaseDeliveryNote } from './types'

/**
 * Las entradas de mercancia de una orden que TODAVIA se pueden facturar.
 *
 * POR QUE EXISTE, APARTE DE `entradas.ts`. Aquel modulo cuenta cuanto llego
 * —cifra fisica, incluye lo ya facturado— y sirve para saber si el proveedor
 * cumplio. Este responde otra pregunta: "de estas entradas, cual puedo
 * facturar?". Una entrada ya facturada sigue contando como recibida y NO puede
 * volver a facturarse, asi que mezclar las dos listas ofreceria al proveedor
 * entradas que B1 rechazaria.
 *
 * PARA QUE SE USA. Es el dato que le falta a la factura para poder registrarse
 * en B1: el payload de `PurchaseInvoices` copia de la entrada con
 * `BaseType: 20` + `BaseEntry` + `BaseLine`, y ese `BaseEntry` es el `DocEntry`
 * que devuelve esta funcion. Sin el no hay `DocumentLines` que mandar.
 *
 * QUE SE DESCARTA Y POR QUE:
 *   - Canceladas (`Cancelled === 'tYES'`): no metieron nada al almacen.
 *   - Cerradas (`DocumentStatus !== 'bost_Open'`): ya se facturaron enteras.
 *   - Renglones sin saldo abierto: B1 rechaza una linea en cero.
 *
 * AISLAMIENTO. `cardCode` viaja en el $filter hacia B1, no en un descarte
 * posterior. Es obligatorio: esta lista se le ensena a un proveedor y traer las
 * entradas de todos seria una fuga entre proveedores (§02).
 */

/** Tope de paginas. Mismo criterio que `entradas.ts`. */
const MAX_PAGINAS = 25

export interface RenglonFacturable {
  /** `LineNum` de la entrada. Es el `BaseLine` del payload de la factura. */
  readonly lineNum: number
  /** `BaseLine` hacia la orden: con que renglon de la OC enlaza este. */
  readonly poLineNum: number
  readonly itemCode: string | null
  readonly descripcion: string
  /** Lo que llego en este renglon. */
  readonly recibida: Decimal
  /** Lo que queda por facturar. Es lo que se puede mandar como `Quantity`. */
  readonly abierta: Decimal
  readonly unidad: string | null
  // --- Importes. Los pide el cotejo, no la creacion de la factura ---------
  // El payload de B1 no manda precios: los recalcula el propio B1 al copiar de
  // la entrada. Estos tres campos existen para poder comparar contra el CFDI
  // ANTES de mandar nada, y decirle al proveedor en que renglon y por cuanto
  // difiere en vez de dejar que B1 lo rechace con un error opaco.
  /** Precio unitario del renglon en la entrada. */
  readonly precio: Decimal
  /** Importe del renglon sin impuestos (`LineTotal`). */
  readonly importe: Decimal
  /** Impuestos del renglon (`TaxTotal`). El cotejo compara total CON IVA (M7). */
  readonly impuesto: Decimal
}

export interface EntradaFacturable {
  /** `DocEntry` de la entrada. Es el `BaseEntry` del payload de la factura. */
  readonly docEntry: number
  /** `DocNum`: el numero que ve la gente. Se guarda en `goodsReceiptNumber`. */
  readonly docNum: number
  /** 'YYYY-MM-DD'. */
  readonly fecha: string
  readonly cardCode: string
  readonly moneda: string | null
  readonly total: number | null
  readonly renglones: readonly RenglonFacturable[]
}

export interface EntradasFacturables {
  readonly entradas: readonly EntradaFacturable[]
  /**
   * Se alcanzo el tope de paginas. La lista es un MINIMO: puede haber mas
   * entradas facturables que no se leyeron. Quien lo pinte tiene que decirlo,
   * porque presentarlo como completo haria que el proveedor concluyera que su
   * entrada no existe cuando solo no se llego a ella.
   */
  readonly truncado: boolean
}

/**
 * Cuanto queda abierto en un renglon de entrada.
 *
 * Cuando `RemainingOpenQuantity` no viene —hay `$select` que no lo traen— se cae
 * a la cantidad recibida, que es el limite mas permisivo. B1 rechazara igual el
 * exceso al crear la factura; se prefiere dejar pasar y que decida B1 antes que
 * esconder una entrada legitima por un campo ausente.
 */
function abiertaDe(linea: { Quantity: number; RemainingOpenQuantity?: number | null }): Decimal {
  const abierta = linea.RemainingOpenQuantity
  if (abierta === null || abierta === undefined) return moneyOrZero(linea.Quantity)
  return moneyOrZero(abierta)
}

/** Convierte una nota de B1 a la forma del portal, o null si no hay nada que facturar. */
function aFacturable(nota: B1PurchaseDeliveryNote, poDocEntry: number): EntradaFacturable | null {
  const renglones: RenglonFacturable[] = []

  for (const l of nota.DocumentLines ?? []) {
    // Solo los renglones que cuelgan de ESTA orden. Una entrada puede surtir
    // varias ordenes a la vez, y facturar un renglon de otra orden colaria
    // mercancia ajena en la factura.
    if (l.BaseType !== B1_OBJECT_TYPE.PurchaseOrder) continue
    if (l.BaseEntry !== poDocEntry) continue

    const abierta = abiertaDe(l)
    if (abierta.lessThanOrEqualTo(0)) continue

    renglones.push({
      lineNum: l.LineNum,
      // `BaseLine` es el renglon de la ORDEN del que se copio este. Se cae al
      // propio LineNum cuando B1 no lo manda: en una entrada copiada de una sola
      // orden los dos suelen coincidir, y es mejor cotejar contra un renglon
      // probable que no cotejar.
      poLineNum: l.BaseLine ?? l.LineNum,
      itemCode: l.ItemCode ?? null,
      descripcion: l.ItemDescription ?? l.ItemCode ?? `Renglon ${l.LineNum}`,
      recibida: moneyOrZero(l.Quantity),
      abierta,
      unidad: l.MeasureUnit ?? l.UoMCode ?? null,
      precio: moneyOrZero(l.Price ?? l.UnitPrice),
      importe: moneyOrZero(l.LineTotal),
      impuesto: moneyOrZero(l.TaxTotal),
    })
  }

  if (renglones.length === 0) return null

  return {
    docEntry: nota.DocEntry,
    docNum: nota.DocNum,
    fecha: (nota.DocDate ?? '').slice(0, 10),
    cardCode: nota.CardCode,
    moneda: nota.DocCurrency ?? null,
    total: nota.DocTotal ?? null,
    renglones,
  }
}

/**
 * Lista las entradas facturables de una orden.
 *
 * `docDateFrom` se ancla en la fecha de la orden: una entrada nunca es anterior
 * a la orden que surte, asi que ese filtro recorta el historico sin poder
 * dejarse fuera ninguna entrada valida. Va en UTC a proposito —construir el Date
 * desde la cadena completa desplazaria el dia segun la zona del servidor y
 * podria excluir una entrada registrada el mismo dia que la orden—.
 */
export async function leerEntradasFacturables(input: {
  /** `DocEntry` de la orden de compra. */
  readonly poDocEntry: number
  /** `DocDate` de la orden, 'YYYY-MM-DD'. Acota la busqueda hacia atras. */
  readonly poDocDate?: string | null
  /** CardCode del proveedor. Obligatorio: esta lista se le ensena a el. */
  readonly cardCode: string
}): Promise<EntradasFacturables> {
  const sap = getSapClient()
  const desde = (input.poDocDate ?? '').slice(0, 10)

  const entradas: EntradaFacturable[] = []
  let skip = 0
  let paginas = 0
  let truncado = false

  for (;;) {
    const page = await sap.listPurchaseDeliveryNotesWithLines({
      cardCode: input.cardCode,
      ...(desde ? { docDateFrom: new Date(`${desde}T00:00:00Z`) } : {}),
      skip,
    })

    for (const nota of page.items) {
      if (nota.Cancelled === 'tYES') continue
      // Cerrada = ya facturada entera. B1 rechaza copiar de ella.
      if (nota.DocumentStatus !== 'bost_Open') continue

      const facturable = aFacturable(nota, input.poDocEntry)
      if (facturable) entradas.push(facturable)
    }

    if (page.nextSkip === undefined || page.items.length === 0) break
    if (++paginas >= MAX_PAGINAS) {
      truncado = true
      break
    }
    skip = page.nextSkip
  }

  // Mas reciente primero: es la que el proveedor esta facturando casi siempre.
  entradas.sort((a, b) => b.docEntry - a.docEntry)

  return { entradas, truncado }
}
