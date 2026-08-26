import { describe, expect, it } from 'vitest'
import { money } from '../../money'
import {
  calcularRecepcion,
  renglonDesdeB1,
  type LineaEntrada,
  type LineaOrdenRecibida,
} from '../recepciones'

/**
 * Los casos salen de datos reales de la instancia de KPS, porque el error que
 * este modulo evita solo aparece ahi: en el papel "pedido menos pendiente" da
 * lo recibido, y en B1 no.
 */

type EntradaSpec = Omit<Partial<LineaEntrada>, 'cantidad' | 'lineaOrden'> & {
  lineaOrden: number
  cantidad: number
}

function entrada(over: EntradaSpec): LineaEntrada {
  return {
    docEntry: over.docEntry ?? 1,
    docNum: over.docNum ?? 280,
    fecha: over.fecha ?? '2026-07-04',
    lineaOrden: over.lineaOrden,
    itemCode: over.itemCode ?? 'PTBL0001',
    cantidad: money(over.cantidad),
    almacen: over.almacen ?? '1',
  }
}

type RenglonSpec = Omit<Partial<LineaOrdenRecibida>, 'lineNum' | 'pedido' | 'abierta'> & {
  lineNum: number
  pedido: number
  abierta: number
}

function renglon(over: RenglonSpec): LineaOrdenRecibida {
  return {
    lineNum: over.lineNum,
    itemCode: over.itemCode ?? 'PTBL0001',
    description: over.description ?? 'Bloom Greens Fresa Kiwi',
    pedido: money(over.pedido),
    abierta: money(over.abierta),
  }
}

describe('calcularRecepcion', () => {
  it('sin entradas dice que no ha llegado nada', () => {
    const r = calcularRecepcion({
      orden: [renglon({ lineNum: 0, pedido: 4400, abierta: 4400 })],
      entradas: [],
    })

    expect(r.sinEntradas).toBe(true)
    expect(r.recibido.toString()).toBe('0')
    expect(r.pendiente.toString()).toBe('4400')
    expect(r.renglones[0].estado).toBe('SIN_RECIBIR')
    expect(r.entregas).toHaveLength(0)
  })

  /** OC 1061 de N&N: se pidieron 10,000, la entrada 309 trajo 5,136, sigue abierta. */
  it('renglon abierto a medio surtir queda PARCIAL y no inventa faltantes', () => {
    const r = calcularRecepcion({
      orden: [renglon({ lineNum: 0, itemCode: 'PTMB0028', pedido: 10000, abierta: 4864 })],
      entradas: [entrada({ lineaOrden: 0, itemCode: 'PTMB0028', cantidad: 5136, docNum: 309 })],
    })

    const l = r.renglones[0]
    expect(l.estado).toBe('PARCIAL')
    expect(l.recibido.toString()).toBe('5136')
    expect(l.pendiente.toString()).toBe('4864')
    // Sigue abierta: lo que falta se espera, no se perdio.
    expect(l.sinSurtir.toString()).toBe('0')
  })

  /**
   * EL CASO QUE MOTIVA EL MODULO. OC 1087 de Xanalab, renglon 0: se pidieron
   * 4,400, la entrada 280 trajo 4,141 y alguien cerro el renglon. B1 deja
   * `RemainingOpenQuantity` en 0, asi que "pedido menos pendiente" da 4,400.
   * Llegaron 4,141.
   */
  it('renglon cerrado sin completarse NO cuenta como recibido lo que nunca llego', () => {
    const r = calcularRecepcion({
      orden: [renglon({ lineNum: 0, pedido: 4400, abierta: 0 })],
      entradas: [entrada({ lineaOrden: 0, cantidad: 4141 })],
    })

    const l = r.renglones[0]
    expect(l.recibido.toString()).toBe('4141')
    expect(l.recibido.toString()).not.toBe('4400')
    expect(l.sinSurtir.toString()).toBe('259')
    expect(l.pendiente.toString()).toBe('0')
    expect(l.estado).toBe('CERRADA_SIN_COMPLETAR')
    expect(r.renglonesSinSurtir).toBe(1)
  })

  it('renglon cerrado habiendo llegado todo queda COMPLETA y sin faltante', () => {
    const r = calcularRecepcion({
      orden: [renglon({ lineNum: 6, itemCode: 'PTBL0018', pedido: 2000, abierta: 0 })],
      entradas: [entrada({ lineaOrden: 6, itemCode: 'PTBL0018', cantidad: 2000 })],
    })

    expect(r.renglones[0].estado).toBe('COMPLETA')
    expect(r.renglones[0].sinSurtir.toString()).toBe('0')
    expect(r.renglonesSinSurtir).toBe(0)
  })

  /**
   * OC 1119: pide PTBL0001 en dos renglones de 4,400. Cruzar por articulo
   * repartiria mal lo recibido; el cruce va por numero de renglon.
   */
  it('dos renglones del mismo articulo no se mezclan', () => {
    const r = calcularRecepcion({
      orden: [
        renglon({ lineNum: 0, pedido: 4400, abierta: 4400 }),
        renglon({ lineNum: 1, pedido: 4400, abierta: 4400 }),
      ],
      entradas: [entrada({ lineaOrden: 1, cantidad: 4400 })],
    })

    expect(r.renglones[0].recibido.toString()).toBe('0')
    expect(r.renglones[0].estado).toBe('SIN_RECIBIR')
    expect(r.renglones[1].recibido.toString()).toBe('4400')
    expect(r.renglones[1].estado).toBe('COMPLETA')
  })

  it('varias entregas al mismo renglon se suman y salen en orden', () => {
    const r = calcularRecepcion({
      orden: [renglon({ lineNum: 0, pedido: 10000, abierta: 2000 })],
      entradas: [
        entrada({ lineaOrden: 0, cantidad: 3000, docEntry: 2, docNum: 245, fecha: '2026-06-16' }),
        entrada({ lineaOrden: 0, cantidad: 5000, docEntry: 1, docNum: 239, fecha: '2026-06-10' }),
      ],
    })

    expect(r.renglones[0].recibido.toString()).toBe('8000')
    expect(r.renglones[0].entradas.map((e) => e.docNum)).toEqual([239, 245])
    expect(r.entregas).toHaveLength(2)
  })

  it('una entrega que surte dos renglones cuenta como UNA entrega', () => {
    const r = calcularRecepcion({
      orden: [
        renglon({ lineNum: 0, pedido: 5000, abierta: 0 }),
        renglon({ lineNum: 10, itemCode: 'PTML0003', pedido: 5000, abierta: 3328 }),
      ],
      entradas: [
        entrada({ lineaOrden: 0, cantidad: 5000, docEntry: 7, docNum: 280 }),
        entrada({ lineaOrden: 10, cantidad: 1672, docEntry: 7, docNum: 280, itemCode: 'PTML0003' }),
      ],
    })

    expect(r.entregas).toHaveLength(1)
    expect(r.entregas[0].docNum).toBe(280)
    expect(r.recibido.toString()).toBe('6672')
  })

  it('una entrada que no casa con ningun renglon sale como huerfana, no se traga', () => {
    const r = calcularRecepcion({
      orden: [renglon({ lineNum: 0, pedido: 4400, abierta: 4400 })],
      entradas: [entrada({ lineaOrden: -1, cantidad: 100 })],
    })

    expect(r.huerfanas).toHaveLength(1)
    expect(r.huerfanas[0].cantidad.toString()).toBe('100')
    // No se suma a ninguna linea.
    expect(r.renglones[0].recibido.toString()).toBe('0')
    expect(r.recibido.toString()).toBe('0')
  })

  it('recibir de mas se marca como excedente y no deja un faltante negativo', () => {
    const r = calcularRecepcion({
      orden: [renglon({ lineNum: 0, pedido: 4400, abierta: 0 })],
      entradas: [entrada({ lineaOrden: 0, cantidad: 4500 })],
    })

    expect(r.renglones[0].estado).toBe('EXCEDIDA')
    expect(r.renglones[0].excedente.toString()).toBe('100')
    expect(r.renglones[0].sinSurtir.toString()).toBe('0')
    expect(r.sinSurtir.toString()).toBe('0')
  })

  /**
   * Orden 1095 de Industrias Via Lactea: el proveedor mando de mas en tres
   * articulos y de menos en otro. El exceso NO puede tapar el faltante.
   */
  it('el exceso de un renglon no compensa el faltante de otro', () => {
    const r = calcularRecepcion({
      orden: [
        renglon({ lineNum: 0, itemCode: 'PTAN0001', pedido: 1600, abierta: 0 }),
        renglon({ lineNum: 1, itemCode: 'PTAN0003', pedido: 1620, abierta: 0 }),
        renglon({ lineNum: 2, itemCode: 'PTAN0015', pedido: 1600, abierta: 358 }),
        renglon({ lineNum: 3, itemCode: 'PTAN0016', pedido: 1693, abierta: 0 }),
      ],
      entradas: [
        entrada({ lineaOrden: 0, itemCode: 'PTAN0001', cantidad: 1603, docNum: 301 }),
        entrada({ lineaOrden: 1, itemCode: 'PTAN0003', cantidad: 1761, docNum: 301 }),
        entrada({ lineaOrden: 2, itemCode: 'PTAN0015', cantidad: 1242, docNum: 301 }),
        entrada({ lineaOrden: 3, itemCode: 'PTAN0016', cantidad: 1853, docNum: 301 }),
      ],
    })

    expect(r.recibido.toString()).toBe('6459')
    expect(r.renglonesExcedidos).toBe(3)
    expect(r.excedente.toString()).toBe('304')
    // El renglon 2 sigue abierto, asi que sus 358 son pendiente, no faltante.
    expect(r.pendiente.toString()).toBe('358')
    expect(r.sinSurtir.toString()).toBe('0')
    // Y el exceso NO se resta del pendiente.
    expect(r.excedente.minus(r.pendiente).toString()).not.toBe('0')
  })

  it('suma la orden entera separando lo pendiente de lo que ya no llegara', () => {
    const r = calcularRecepcion({
      orden: [
        // cerrado corto: faltaron 259 que ya no vienen
        renglon({ lineNum: 0, pedido: 4400, abierta: 0 }),
        // abierto a medias: faltan 20,690 que si se esperan
        renglon({ lineNum: 8, itemCode: 'PTMB0028', pedido: 25000, abierta: 20690 }),
      ],
      entradas: [
        entrada({ lineaOrden: 0, cantidad: 4141 }),
        entrada({ lineaOrden: 8, itemCode: 'PTMB0028', cantidad: 4310, docEntry: 3, docNum: 276 }),
      ],
    })

    expect(r.pedido.toString()).toBe('29400')
    expect(r.recibido.toString()).toBe('8451')
    expect(r.pendiente.toString()).toBe('20690')
    expect(r.sinSurtir.toString()).toBe('259')
    expect(r.renglonesSinSurtir).toBe(1)
  })
})

describe('renglonDesdeB1', () => {
  it('trata el pendiente ausente como cero en vez de reventar', () => {
    const l = renglonDesdeB1({
      LineNum: 0,
      ItemCode: 'PTBL0001',
      ItemDescription: 'Bloom Greens Fresa Kiwi',
      Quantity: 4400,
      RemainingOpenQuantity: null,
    })

    expect(l.pedido.toString()).toBe('4400')
    expect(l.abierta.toString()).toBe('0')
  })
})
