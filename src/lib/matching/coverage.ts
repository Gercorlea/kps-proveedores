import { Decimal, money } from '../money'

/**
 * Cobertura de una orden de compra.
 *
 * Responde a la pregunta que hace el proveedor al subir una factura: "¿ya
 * cubri la orden, o me falta?". Y a la que hace KPS al revisarla: "¿esto
 * completa la orden o la deja a medias?".
 *
 * TRES REGLAS QUE NO SON NEGOCIABLES
 *
 *   1. Solo cuenta lo APROBADO. Una factura en borrador, en revision o
 *      rechazada no consume la orden. Si contara antes de aprobarse, un
 *      proveedor cerraria una orden subiendo un XML que KPS todavia no ha
 *      mirado, y rechazarla dejaria la cuenta descuadrada.
 *
 *   2. Se compara CANTIDAD por linea, no importe. Es lo que pide la regla M7 y
 *      es lo unico que permite decir "te faltan 200 piezas" en vez de "te
 *      faltan 11,000 pesos", que al proveedor no le dice que enviar.
 *
 *   3. Un concepto del CFDI que no case con ninguna linea NO se ignora. Se
 *      devuelve aparte. Descartarlo en silencio haria que una factura con
 *      articulos que la orden no pidio pareciera correcta.
 *
 * Es una funcion pura: no abre la base ni llama a SAP, para poder probarla
 * entera sin ninguna de las dos.
 */

export interface LineaOrden {
  readonly lineNum: number
  readonly itemCode?: string | null
  readonly description: string
  /** Cantidad pedida en la orden. */
  readonly quantity: Decimal
  readonly unitPrice: Decimal
}

/** Una linea de cualquier factura: la que se esta subiendo o una ya aprobada. */
export interface LineaFacturada {
  readonly itemCode?: string | null
  readonly description: string
  readonly quantity: Decimal
}

export interface CoberturaLinea {
  readonly lineNum: number
  readonly itemCode: string | null
  readonly description: string
  readonly ordenado: Decimal
  /** Cantidad ya cubierta por facturas aprobadas antes de esta. */
  readonly facturadoAntes: Decimal
  /** Cantidad que aporta la factura que se esta subiendo. */
  readonly enEsta: Decimal
  /** Lo que seguiria faltando si esta factura se aprueba. Nunca negativo. */
  readonly restante: Decimal
  /** Cuanto se pasa de lo pedido, si se pasa. Nunca negativo. */
  readonly excedente: Decimal
}

export type EstadoCobertura =
  /** Nadie ha facturado nada todavia. */
  | 'SIN_FACTURAR'
  /** Se cubrio parte. Quedan cantidades pendientes. */
  | 'PARCIAL'
  /** Todas las lineas quedan cubiertas exactamente. */
  | 'COMPLETA'
  /** Alguna linea se factura por encima de lo pedido. */
  | 'EXCEDE'

export interface Cobertura {
  readonly lineas: readonly CoberturaLinea[]
  readonly estado: EstadoCobertura
  /** Conceptos del CFDI que no corresponden a ninguna linea de la orden. */
  readonly sinCorrespondencia: readonly LineaFacturada[]
  /** True si, aprobando esta factura, la orden queda cubierta del todo. */
  readonly quedaCompleta: boolean
  /** Cuantas lineas siguen faltando. */
  readonly lineasPendientes: number
}

const CERO = money(0)

/**
 * Normaliza para emparejar: sin acentos, sin espacios de sobra y en
 * minusculas. Los catalogos de B1 y los CFDI casi nunca escriben igual la
 * misma descripcion.
 */
function clave(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Suma las cantidades de las facturas por linea de orden.
 *
 * El emparejamiento va primero por `NoIdentificacion` del CFDI contra el
 * `ItemCode` de B1 —que es el dato pensado para esto— y solo si falta se cae a
 * la descripcion. Emparejar por posicion seria peor que no emparejar: una
 * factura con las lineas en otro orden cuadraria mal sin avisar.
 */
function agrupar(
  orden: readonly LineaOrden[],
  facturadas: readonly LineaFacturada[],
): { porLinea: Map<number, Decimal>; sueltas: LineaFacturada[] } {
  const porCodigo = new Map<string, LineaOrden>()
  const porDescripcion = new Map<string, LineaOrden>()
  for (const l of orden) {
    if (l.itemCode) porCodigo.set(clave(l.itemCode), l)
    // La primera gana: si la orden repite descripcion, se acumula en una sola
    // linea. Es preferible a repartir a ojo entre lineas indistinguibles.
    const d = clave(l.description)
    if (!porDescripcion.has(d)) porDescripcion.set(d, l)
  }

  const porLinea = new Map<number, Decimal>()
  const sueltas: LineaFacturada[] = []

  for (const f of facturadas) {
    const destino =
      (f.itemCode ? porCodigo.get(clave(f.itemCode)) : undefined) ??
      porDescripcion.get(clave(f.description))

    if (!destino) {
      sueltas.push(f)
      continue
    }
    porLinea.set(destino.lineNum, (porLinea.get(destino.lineNum) ?? CERO).plus(f.quantity))
  }

  return { porLinea, sueltas }
}

export interface EntradaCobertura {
  readonly orden: readonly LineaOrden[]
  /** Lineas de las facturas YA APROBADAS de esta orden. */
  readonly aprobadas: readonly LineaFacturada[]
  /** Lineas de la factura que se esta subiendo. Vacio para ver solo el estado. */
  readonly enCurso?: readonly LineaFacturada[]
}

export function calcularCobertura(entrada: EntradaCobertura): Cobertura {
  const previas = agrupar(entrada.orden, entrada.aprobadas)
  const actual = agrupar(entrada.orden, entrada.enCurso ?? [])

  const lineas: CoberturaLinea[] = entrada.orden.map((l) => {
    const facturadoAntes = previas.porLinea.get(l.lineNum) ?? CERO
    const enEsta = actual.porLinea.get(l.lineNum) ?? CERO
    const total = facturadoAntes.plus(enEsta)
    const diferencia = l.quantity.minus(total)

    return {
      lineNum: l.lineNum,
      itemCode: l.itemCode ?? null,
      description: l.description,
      ordenado: l.quantity,
      facturadoAntes,
      enEsta,
      // Se acotan a cero en vez de dejarlos negativos: "faltan -50" no lo lee
      // nadie bien, y el exceso tiene su propio campo.
      restante: diferencia.greaterThan(0) ? diferencia : CERO,
      excedente: diferencia.lessThan(0) ? diferencia.negated() : CERO,
    }
  })

  const excede = lineas.some((l) => l.excedente.greaterThan(0))
  const pendientes = lineas.filter((l) => l.restante.greaterThan(0))
  const nadaFacturado = lineas.every((l) => l.facturadoAntes.isZero() && l.enEsta.isZero())

  const estado: EstadoCobertura = excede
    ? 'EXCEDE'
    : nadaFacturado
      ? 'SIN_FACTURAR'
      : pendientes.length > 0
        ? 'PARCIAL'
        : 'COMPLETA'

  return {
    lineas,
    estado,
    // Las sueltas de la factura en curso son las que importan al proveedor
    // ahora; las de facturas viejas ya se revisaron en su momento.
    sinCorrespondencia: actual.sueltas,
    quedaCompleta: !excede && pendientes.length === 0,
    lineasPendientes: pendientes.length,
  }
}
