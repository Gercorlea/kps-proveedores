import { describe, expect, it } from 'vitest'
import { money } from '../../money'
import { calcularCobertura, type LineaOrden } from '../coverage'

/**
 * El flujo que describen estas pruebas, en palabras de KPS:
 *
 *   "sube la factura, el programa compara con lo que tiene la orden de compra,
 *    si hace falta cantidad aparece cuanto hace falta... si le falta parcial
 *    que aparezca parcial y si subio todo aparezca completado"
 *
 * Cada caso de esa frase es un test.
 */

const ORDEN: LineaOrden[] = [
  {
    lineNum: 0,
    itemCode: 'PTBL0001',
    description: 'Bloom Greens Fresa Kiwi',
    quantity: money(4400),
    unitPrice: money(55),
  },
  {
    lineNum: 1,
    itemCode: 'PTBL0008',
    description: 'Bloom Pre Workout',
    quantity: money(3500),
    unitPrice: money(55),
  },
]

describe('calcularCobertura', () => {
  it('sin facturas dice SIN_FACTURAR y todo pendiente', () => {
    const c = calcularCobertura({ orden: ORDEN, aprobadas: [] })
    expect(c.estado).toBe('SIN_FACTURAR')
    expect(c.lineasPendientes).toBe(2)
    expect(c.lineas[0].restante.toString()).toBe('4400')
    expect(c.quedaCompleta).toBe(false)
  })

  it('cubriendo todo queda COMPLETA', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [],
      enCurso: [
        { itemCode: 'PTBL0001', description: 'Bloom Greens Fresa Kiwi', quantity: money(4400) },
        { itemCode: 'PTBL0008', description: 'Bloom Pre Workout', quantity: money(3500) },
      ],
    })
    expect(c.estado).toBe('COMPLETA')
    expect(c.quedaCompleta).toBe(true)
    expect(c.lineasPendientes).toBe(0)
  })

  it('cubriendo de menos queda PARCIAL y dice cuanto falta', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [],
      enCurso: [
        { itemCode: 'PTBL0001', description: 'Bloom Greens Fresa Kiwi', quantity: money(4000) },
      ],
    })
    expect(c.estado).toBe('PARCIAL')
    expect(c.lineas[0].restante.toString()).toBe('400')
    expect(c.lineas[1].restante.toString()).toBe('3500')
    expect(c.lineasPendientes).toBe(2)
  })

  it('acumula lo ya aprobado con lo que se esta subiendo', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [
        { itemCode: 'PTBL0001', description: 'Bloom Greens Fresa Kiwi', quantity: money(3000) },
      ],
      enCurso: [
        { itemCode: 'PTBL0001', description: 'Bloom Greens Fresa Kiwi', quantity: money(1400) },
      ],
    })
    expect(c.lineas[0].facturadoAntes.toString()).toBe('3000')
    expect(c.lineas[0].enEsta.toString()).toBe('1400')
    expect(c.lineas[0].restante.isZero()).toBe(true)
    // La segunda linea sigue sin tocarse, asi que la orden no esta completa.
    expect(c.estado).toBe('PARCIAL')
  })

  it('facturar de mas es EXCEDE, no COMPLETA', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [],
      enCurso: [
        { itemCode: 'PTBL0001', description: 'Bloom Greens Fresa Kiwi', quantity: money(4600) },
        { itemCode: 'PTBL0008', description: 'Bloom Pre Workout', quantity: money(3500) },
      ],
    })
    expect(c.estado).toBe('EXCEDE')
    expect(c.lineas[0].excedente.toString()).toBe('200')
    expect(c.lineas[0].restante.isZero()).toBe(true)
    expect(c.quedaCompleta).toBe(false)
  })

  it('empareja por descripcion cuando el CFDI no trae NoIdentificacion', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [],
      // Sin itemCode y con acentos y espacios distintos: aun asi debe casar.
      enCurso: [{ description: '  BLOOM  GRÉENS Fresa Kiwi ', quantity: money(4400) }],
    })
    expect(c.lineas[0].enEsta.toString()).toBe('4400')
    expect(c.sinCorrespondencia).toHaveLength(0)
  })

  it('un concepto que la orden no pidio se devuelve aparte, no se ignora', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [],
      enCurso: [
        { itemCode: 'OTRO-999', description: 'Producto que nadie pidio', quantity: money(10) },
      ],
    })
    expect(c.sinCorrespondencia).toHaveLength(1)
    expect(c.sinCorrespondencia[0].itemCode).toBe('OTRO-999')
    // No cuenta como cobertura de ninguna linea.
    expect(c.lineas.every((l) => l.enEsta.isZero())).toBe(true)
  })

  it('el codigo manda sobre la descripcion al emparejar', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [],
      // El codigo apunta a la linea 1 aunque la descripcion sea la de la 0.
      enCurso: [
        { itemCode: 'PTBL0008', description: 'Bloom Greens Fresa Kiwi', quantity: money(100) },
      ],
    })
    expect(c.lineas[0].enEsta.isZero()).toBe(true)
    expect(c.lineas[1].enEsta.toString()).toBe('100')
  })

  it('suma varias lineas del CFDI que apuntan al mismo articulo', () => {
    const c = calcularCobertura({
      orden: ORDEN,
      aprobadas: [],
      enCurso: [
        { itemCode: 'PTBL0001', description: 'Bloom Greens Fresa Kiwi', quantity: money(2000) },
        { itemCode: 'PTBL0001', description: 'Bloom Greens Fresa Kiwi', quantity: money(2400) },
      ],
    })
    expect(c.lineas[0].enEsta.toString()).toBe('4400')
    expect(c.lineas[0].restante.isZero()).toBe(true)
  })

  it('las cantidades con decimales no pierden precision', () => {
    const orden: LineaOrden[] = [
      {
        lineNum: 0,
        itemCode: 'KG-01',
        description: 'Granel',
        quantity: money('10.5'),
        unitPrice: money(1),
      },
    ]
    const c = calcularCobertura({
      orden,
      aprobadas: [{ itemCode: 'KG-01', description: 'Granel', quantity: money('0.1') }],
      enCurso: [{ itemCode: 'KG-01', description: 'Granel', quantity: money('0.2') }],
    })
    // 0.1 + 0.2 en coma flotante da 0.30000000000000004; aqui tiene que dar 0.3.
    expect(c.lineas[0].restante.toString()).toBe('10.2')
  })
})
