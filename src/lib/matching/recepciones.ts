import { Decimal, moneyOrZero, round3, sum } from '../money'

/**
 * Que llego de verdad de una orden de compra.
 *
 * POR QUE ESTE MODULO EXISTE
 *
 * Business One NO guarda en la orden la cantidad recibida. De cada renglon
 * guarda dos numeros: lo pedido (`Quantity`) y lo que sigue esperando
 * (`RemainingOpenQuantity`). La tentacion es restar uno del otro y llamarlo
 * "recibido". Esa resta miente.
 *
 * Miente porque `RemainingOpenQuantity` se va a cero por DOS motivos distintos
 * que desde fuera se ven identicos:
 *
 *   a) llego todo, y
 *   b) alguien cerro el renglon a mano porque el resto ya no va a llegar.
 *
 * Caso real de la instancia de KPS, orden 1087 de Xanalab: el renglon de
 * PTBL0001 pidio 4,400 piezas, la entrada de mercancia 280 del 4-jul registro
 * 4,141, y el renglon esta cerrado con pendiente 0. La resta dice "llegaron
 * 4,400". Llegaron 4,141. En esa sola orden hay 2,031 piezas que la resta da
 * por recibidas y nunca entraron al almacen.
 *
 * La unica fuente de la cantidad fisica es la ENTRADA DE MERCANCIA, que es un
 * documento aparte y apunta a la orden por `BaseEntry` + `BaseLine`. Este
 * modulo cruza las dos cosas.
 *
 * DOS REGLAS QUE NO SON NEGOCIABLES
 *
 *   1. El cruce va por NUMERO DE RENGLON, no por codigo de articulo. Una misma
 *      orden puede pedir el mismo articulo en dos renglones —la 1119 pide
 *      PTBL0001 dos veces, 4,400 en cada uno— y cruzar por articulo repartiria
 *      mal lo recibido entre ellos.
 *
 *   2. Una entrada que no case con ningun renglon NO se descarta en silencio:
 *      sale en `huerfanas`. Tragarsela haria que una orden con mercancia
 *      registrada contra un renglon inexistente pareciera correcta.
 *
 * LIMITACION CONOCIDA: no se restan las devoluciones de compra
 * (`PurchaseReturns`). Una devolucion significa que la mercancia entro y luego
 * salio, asi que lo que este modulo llama "recibido" es "lo que llego", no "lo
 * que se quedo". Para medir el cumplimiento del proveedor esa es la cifra
 * correcta; para valorizar inventario no lo es.
 *
 * Es una funcion pura: no abre la base ni llama a SAP, para poder probarla
 * entera sin ninguna de las dos.
 */

/** Un renglon de la orden, tal y como lo devuelve el Service Layer. */
export interface LineaOrdenRecibida {
  readonly lineNum: number
  readonly itemCode?: string | null
  readonly description: string
  /** `Quantity`: lo que se pidio. */
  readonly pedido: Decimal
  /** `RemainingOpenQuantity`: lo que B1 sigue esperando. Cero si el renglon se cerro. */
  readonly abierta: Decimal
}

/** Un renglon de una entrada de mercancia que apunta a esta orden. */
export interface LineaEntrada {
  /** `DocEntry` de la entrada de mercancia. */
  readonly docEntry: number
  /** Folio visible de la entrada. */
  readonly docNum: number
  /** Fecha del documento, 'YYYY-MM-DD'. Es el dia en que llego la mercancia. */
  readonly fecha: string
  /** `BaseLine`: a que renglon de la orden corresponde. */
  readonly lineaOrden: number
  readonly itemCode?: string | null
  readonly cantidad: Decimal
  readonly almacen?: string | null
}

export type EstadoRenglon =
  /** Nada ha llegado y el renglon sigue esperando. */
  | 'SIN_RECIBIR'
  /** Llego una parte y el resto sigue esperando. */
  | 'PARCIAL'
  /** Llego todo lo pedido. */
  | 'COMPLETA'
  /** El renglon se cerro sin que llegara todo: la diferencia ya no se espera. */
  | 'CERRADA_SIN_COMPLETAR'
  /** Llego mas de lo pedido. */
  | 'EXCEDIDA'

export interface RecepcionRenglon {
  readonly lineNum: number
  readonly itemCode: string | null
  readonly description: string
  readonly pedido: Decimal
  /** Suma de las entradas de mercancia. La cantidad fisica. */
  readonly recibido: Decimal
  /** Lo que B1 sigue esperando. */
  readonly pendiente: Decimal
  /**
   * Lo que se cerro sin llegar: `pedido - recibido - pendiente`.
   *
   * Es cero mientras el renglon siga abierto. En cuanto alguien lo cierra sin
   * haber recibido todo, este numero es exactamente la mercancia que la orden
   * da por recibida y nunca entro.
   */
  readonly sinSurtir: Decimal
  /** Lo que llego de mas, si llego de mas. */
  readonly excedente: Decimal
  readonly estado: EstadoRenglon
  /** Las entregas de este renglon, en orden cronologico. */
  readonly entradas: readonly LineaEntrada[]
}

export interface Recepcion {
  readonly renglones: readonly RecepcionRenglon[]
  readonly pedido: Decimal
  readonly recibido: Decimal
  readonly pendiente: Decimal
  readonly sinSurtir: Decimal
  /**
   * Lo que llego de mas, sumando renglones.
   *
   * Va aparte y no restando del faltante a proposito: un renglon con 141 piezas
   * de mas no compensa otro al que le faltan 358, y presentarlo neto haria que
   * una orden con las dos cosas pareciera cuadrada. Caso real, orden 1095 de
   * Industrias Via Lactea: 99% recibido, con tres renglones excedidos y uno
   * corto.
   */
  readonly excedente: Decimal
  /** Cuantos renglones se cerraron sin haber llegado completos. */
  readonly renglonesSinSurtir: number
  /** Cuantos renglones recibieron mas de lo pedido. */
  readonly renglonesExcedidos: number
  /** Entradas de mercancia distintas que surtieron la orden, cronologicas. */
  readonly entregas: readonly { docEntry: number; docNum: number; fecha: string }[]
  /**
   * Renglones de entrada que no casan con ningun renglon de la orden. Regla 2:
   * se devuelven en vez de ignorarse.
   */
  readonly huerfanas: readonly LineaEntrada[]
  /** No hay ninguna entrada registrada contra esta orden. */
  readonly sinEntradas: boolean
}

const CERO = new Decimal(0)

/** Ordena por fecha y, a igualdad, por folio: dos entradas del mismo dia son estables. */
function cronologico(a: LineaEntrada, b: LineaEntrada): number {
  return a.fecha === b.fecha ? a.docNum - b.docNum : a.fecha < b.fecha ? -1 : 1
}

function estadoDe(
  pedido: Decimal,
  recibido: Decimal,
  pendiente: Decimal,
  sinSurtir: Decimal,
): EstadoRenglon {
  if (recibido.gt(pedido)) return 'EXCEDIDA'
  if (recibido.gte(pedido)) return 'COMPLETA'
  if (sinSurtir.gt(0)) return 'CERRADA_SIN_COMPLETAR'
  if (recibido.lte(0)) return 'SIN_RECIBIR'
  return 'PARCIAL'
}

/**
 * Cruza los renglones de una orden con las entradas de mercancia que la
 * surtieron.
 *
 * `entradas` debe traer YA solo los renglones de entrada que apuntan a esta
 * orden (`BaseType` 22 y `BaseEntry` igual a su `DocEntry`), y sin documentos
 * cancelados. Quien llama tiene el contexto para filtrarlo contra B1; esta
 * funcion no sabe de documentos, solo de cantidades.
 */
export function calcularRecepcion(input: {
  readonly orden: readonly LineaOrdenRecibida[]
  readonly entradas: readonly LineaEntrada[]
}): Recepcion {
  const { orden, entradas } = input

  const porRenglon = new Map<number, LineaEntrada[]>()
  for (const e of entradas) {
    porRenglon.set(e.lineaOrden, [...(porRenglon.get(e.lineaOrden) ?? []), e])
  }

  const numeros = new Set(orden.map((l) => l.lineNum))
  const huerfanas = entradas.filter((e) => !numeros.has(e.lineaOrden)).sort(cronologico)

  const renglones = orden.map<RecepcionRenglon>((l) => {
    const suyas = (porRenglon.get(l.lineNum) ?? []).slice().sort(cronologico)
    const recibido = round3(sum(suyas.map((e) => e.cantidad)))
    const pedido = round3(l.pedido)
    const pendiente = round3(l.abierta)
    // Clamp a cero: si llego de mas, la diferencia es excedente, no un faltante
    // negativo que restaria del total de la orden.
    const sinSurtir = Decimal.max(CERO, pedido.minus(recibido).minus(pendiente))
    const excedente = Decimal.max(CERO, recibido.minus(pedido))

    return {
      lineNum: l.lineNum,
      itemCode: l.itemCode ?? null,
      description: l.description,
      pedido,
      recibido,
      pendiente,
      sinSurtir: round3(sinSurtir),
      excedente: round3(excedente),
      estado: estadoDe(pedido, recibido, pendiente, sinSurtir),
      entradas: suyas,
    }
  })

  // Documentos distintos, no renglones: una misma entrada puede surtir varios
  // renglones de la orden y contarla dos veces exageraria el numero de entregas.
  const vistas = new Map<number, { docEntry: number; docNum: number; fecha: string }>()
  for (const e of [...entradas].sort(cronologico)) {
    if (!vistas.has(e.docEntry)) {
      vistas.set(e.docEntry, { docEntry: e.docEntry, docNum: e.docNum, fecha: e.fecha })
    }
  }

  return {
    renglones,
    pedido: round3(sum(renglones.map((r) => r.pedido))),
    recibido: round3(sum(renglones.map((r) => r.recibido))),
    pendiente: round3(sum(renglones.map((r) => r.pendiente))),
    sinSurtir: round3(sum(renglones.map((r) => r.sinSurtir))),
    excedente: round3(sum(renglones.map((r) => r.excedente))),
    renglonesSinSurtir: renglones.filter((r) => r.sinSurtir.gt(0)).length,
    renglonesExcedidos: renglones.filter((r) => r.excedente.gt(0)).length,
    entregas: [...vistas.values()],
    huerfanas,
    sinEntradas: entradas.length === 0,
  }
}

/** Atajo para construir un renglon de orden desde una linea cruda del Service Layer. */
export function renglonDesdeB1(linea: {
  LineNum: number
  ItemCode?: string | null
  ItemDescription?: string | null
  Quantity: number
  RemainingOpenQuantity?: number | null
}): LineaOrdenRecibida {
  return {
    lineNum: linea.LineNum,
    itemCode: linea.ItemCode ?? null,
    description: linea.ItemDescription ?? '',
    pedido: moneyOrZero(linea.Quantity),
    abierta: moneyOrZero(linea.RemainingOpenQuantity),
  }
}
