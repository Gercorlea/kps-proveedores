import type { LineaEntrada } from '../matching/recepciones'
import { moneyOrZero } from '../money'
import { getSapClient } from './index'
import { B1_OBJECT_TYPE } from './types'

/**
 * Lee de Business One las entradas de mercancia que surtieron unas ordenes.
 *
 * POR QUE HACE FALTA. La orden no guarda cuanto llego: guarda cuanto falta, y
 * ese numero se va a cero tanto si llego todo como si alguien cerro el renglon
 * porque el resto ya no viene. La cantidad fisica solo esta en la entrada de
 * mercancia. El calculo vive en `../matching/recepciones`; esto es solo la
 * lectura.
 *
 * POR QUE EL CRUCE SE HACE AQUI Y NO EN B1. El enlace entrada -> orden vive en
 * la linea (`BaseEntry` + `BaseLine`), y este Service Layer no admite filtrar
 * por campos de linea: `DocumentLines/any(...)` responde "Invalid symbol in the
 * filter condition". Asi que se acota lo que si se puede acotar del lado de B1
 * —el proveedor, y la fecha de la orden mas antigua, porque una entrada nunca
 * es anterior a la orden que surte— y el cruce fino se hace despues de leer.
 *
 * AISLAMIENTO. `cardCode` va en el $filter que se manda a B1, no en un descarte
 * posterior. Quien llama debe pasarlo siempre que la sesion sea de un proveedor;
 * omitirlo trae las entradas de todos y solo vale para usuarios internos.
 */

/**
 * Tope de paginas por llamada. Con el filtro de proveedor y fecha no deberia
 * acercarse; esta para que un dato raro en B1 no deje la pagina dando vueltas.
 */
const MAX_PAGINAS = 25

export interface EntradasDeOrdenes {
  /** Renglones de entrada agrupados por el `DocEntry` de la orden que surten. */
  readonly porOrden: ReadonlyMap<number, readonly LineaEntrada[]>
  /**
   * Se alcanzo el tope de paginas. Lo leido es un MINIMO, no el total, y quien
   * lo pinte tiene que decirlo: presentarlo como definitivo convertiria una
   * lectura incompleta en un faltante inventado.
   */
  readonly truncado: boolean
}

/** La fecha mas antigua del lote, 'YYYY-MM-DD'. Ninguna entrada puede precederla. */
function masAntigua(ordenes: readonly { DocDate?: string | null }[]): string | null {
  let min: string | null = null
  for (const o of ordenes) {
    const f = (o.DocDate ?? '').slice(0, 10)
    if (!f) continue
    if (min === null || f < min) min = f
  }
  return min
}

export async function leerEntradasDeOrdenes(input: {
  readonly ordenes: readonly { DocEntry: number; DocDate?: string | null }[]
  /** CardCode del proveedor. Se omite solo para usuarios internos de KPS. */
  readonly cardCode?: string | null
}): Promise<EntradasDeOrdenes> {
  const porOrden = new Map<number, LineaEntrada[]>()
  if (input.ordenes.length === 0) return { porOrden, truncado: false }

  const objetivo = new Set(input.ordenes.map((o) => o.DocEntry))
  const desde = masAntigua(input.ordenes)
  const sap = getSapClient()

  let skip = 0
  let paginas = 0
  let truncado = false

  for (;;) {
    const page = await sap.listPurchaseDeliveryNotesWithLines({
      ...(input.cardCode ? { cardCode: input.cardCode } : {}),
      // Anclada en UTC a proposito: construir el Date desde la cadena completa
      // desplazaria el dia segun la zona del servidor y podria dejar fuera una
      // entrada registrada el mismo dia que la orden.
      ...(desde ? { docDateFrom: new Date(`${desde}T00:00:00Z`) } : {}),
      skip,
    })

    for (const nota of page.items) {
      // Una entrada cancelada no metio nada al almacen. Contarla inventaria
      // mercancia que nunca existio.
      if (nota.Cancelled === 'tYES') continue
      for (const l of nota.DocumentLines ?? []) {
        if (l.BaseType !== B1_OBJECT_TYPE.PurchaseOrder) continue
        if (l.BaseEntry === null || l.BaseEntry === undefined) continue
        if (!objetivo.has(l.BaseEntry)) continue
        porOrden.set(l.BaseEntry, [
          ...(porOrden.get(l.BaseEntry) ?? []),
          {
            docEntry: nota.DocEntry,
            docNum: nota.DocNum,
            fecha: (nota.DocDate ?? '').slice(0, 10),
            // Sin BaseLine no se sabe a que renglon fue: se deja un numero que
            // no existe para que salga como huerfana en vez de sumarse al
            // renglon 0 y falsear su recibido.
            lineaOrden: l.BaseLine ?? -1,
            itemCode: l.ItemCode ?? null,
            cantidad: moneyOrZero(l.Quantity),
            almacen: l.WarehouseCode ?? null,
          },
        ])
      }
    }

    if (page.nextSkip === undefined || page.items.length === 0) break
    if (++paginas >= MAX_PAGINAS) {
      truncado = true
      break
    }
    skip = page.nextSkip
  }

  return { porOrden, truncado }
}
