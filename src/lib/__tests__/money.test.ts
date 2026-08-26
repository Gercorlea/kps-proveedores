import { describe, it, expect } from 'vitest'
import {
  Decimal,
  money,
  moneyOrZero,
  MoneyParseError,
  round2,
  round3,
  difference,
  absDifference,
  toleranceBand,
  withinTolerance,
  toDb,
  sum,
  ZERO_TOLERANCE,
  type Tolerance,
} from '../money'

const tol = (absolute: string, percentage: string): Tolerance => ({
  absolute: new Decimal(absolute),
  percentage: new Decimal(percentage),
})

describe('money()', () => {
  it('acepta las tres representaciones que llegan de los bordes del sistema', () => {
    // string del XML del CFDI, number del Service Layer, Decimal de Prisma.
    expect(money('1234.56').toFixed(2)).toBe('1234.56')
    expect(money(1234.56).toFixed(2)).toBe('1234.56')
    expect(money(new Decimal('1234.56')).toFixed(2)).toBe('1234.56')
    expect(money({ toString: () => '1234.56' }).toFixed(2)).toBe('1234.56')
  })

  it('lanza en vez de devolver NaN: un importe ilegible es un error de datos, no un cero', () => {
    expect(() => money('no-es-un-numero')).toThrow(MoneyParseError)
    expect(() => money('')).toThrow(MoneyParseError)
    expect(() => money(null)).toThrow(MoneyParseError)
    expect(() => money(undefined)).toThrow(MoneyParseError)
    expect(() => money(Number.NaN)).toThrow(MoneyParseError)
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(MoneyParseError)
  })

  it('moneyOrZero trata el ausente como cero, para los atributos opcionales del CFDI', () => {
    expect(moneyOrZero(undefined).toFixed(2)).toBe('0.00')
    expect(moneyOrZero('').toFixed(2)).toBe('0.00')
    expect(moneyOrZero('15.50').toFixed(2)).toBe('15.50')
    // Pero un valor presente e ilegible sigue siendo un error.
    expect(() => moneyOrZero('abc')).toThrow(MoneyParseError)
  })
})

describe('aritmetica sin punto flotante', () => {
  it('no arrastra el error binario que dispararia notas de credito falsas', () => {
    // 0.1 + 0.2 en float da 0.30000000000000004; contra un total de 0.30 eso
    // es una "diferencia" de la que el proveedor no tiene ninguna culpa.
    const total = money('0.1').plus(money('0.2'))
    expect(total.toFixed(2)).toBe('0.30')
    expect(total.equals(money('0.3'))).toBe(true)
  })

  it('suma listas largas sin deriva', () => {
    const centavos = Array.from({ length: 1000 }, () => money('0.01'))
    expect(sum(centavos).toFixed(2)).toBe('10.00')
    expect(sum([]).toFixed(2)).toBe('0.00')
  })
})

describe('redondeo HALF_UP (redondeo aritmetico del SAT)', () => {
  it('redondea el 5 hacia arriba, no al par', () => {
    // Con ROUND_HALF_EVEN (el default de muchas librerias) 1234.565 daria 1234.56.
    expect(round2(new Decimal('1234.565')).toFixed(2)).toBe('1234.57')
    expect(round2(new Decimal('1234.575')).toFixed(2)).toBe('1234.58')
    expect(round2(new Decimal('0.005')).toFixed(2)).toBe('0.01')
  })

  it('redondea cantidades a tres decimales', () => {
    expect(round3(new Decimal('12.3455')).toFixed(3)).toBe('12.346')
    expect(round3(new Decimal('12.3454')).toFixed(3)).toBe('12.345')
  })

  it('toDb serializa con los decimales exactos que espera NUMERIC', () => {
    expect(toDb(new Decimal('1234.565'))).toBe('1234.57')
    expect(toDb(new Decimal('7'))).toBe('7.00')
    expect(toDb(new Decimal('12.3455'), 3)).toBe('12.346')
  })
})

describe('diferencias', () => {
  it('difference conserva el signo: positivo cuando se factura de mas', () => {
    expect(difference(money('120.00'), money('100.00')).toFixed(2)).toBe('20.00')
    expect(difference(money('80.00'), money('100.00')).toFixed(2)).toBe('-20.00')
  })

  it('absDifference ignora la direccion', () => {
    expect(absDifference(money('80.00'), money('100.00')).toFixed(2)).toBe('20.00')
  })
})

describe('tolerancia del cotejo (regla M11, pendiente 20.5)', () => {
  it('por defecto es exacta al centavo', () => {
    expect(withinTolerance(money('100.00'), money('100.00'), ZERO_TOLERANCE)).toBe(true)
    expect(withinTolerance(money('100.01'), money('100.00'), ZERO_TOLERANCE)).toBe(false)
  })

  it('la banda es el MAYOR entre la absoluta y la porcentual, nunca la suma', () => {
    // Sobre 1000: absoluta 5.00 vs. porcentual 1% = 10.00 -> gana 10.00.
    expect(toleranceBand(money('1000.00'), tol('5.00', '0.01')).toFixed(2)).toBe('10.00')
    // Sobre 100: absoluta 5.00 vs. porcentual 1% = 1.00 -> gana 5.00.
    expect(toleranceBand(money('100.00'), tol('5.00', '0.01')).toFixed(2)).toBe('5.00')
    // Si se sumaran, la banda sobre 1000 seria 15.00 y aflojaria el control
    // sin que nadie lo hubiera decidido.
  })

  it('acepta dentro de la banda y rechaza justo fuera, en ambas direcciones', () => {
    const t = tol('0.50', '0')
    expect(withinTolerance(money('100.50'), money('100.00'), t)).toBe(true)
    expect(withinTolerance(money('99.50'), money('100.00'), t)).toBe(true)
    expect(withinTolerance(money('100.51'), money('100.00'), t)).toBe(false)
    expect(withinTolerance(money('99.49'), money('100.00'), t)).toBe(false)
  })

  it('la banda porcentual escala con el importe esperado', () => {
    const t = tol('0', '0.005') // 0.5%
    expect(withinTolerance(money('10050.00'), money('10000.00'), t)).toBe(true)
    expect(withinTolerance(money('10050.01'), money('10000.00'), t)).toBe(false)
  })

  it('usa el valor absoluto del esperado, para no invertir la banda en negativos', () => {
    // Una nota de credito puede llegar con importe negativo segun como se modele.
    expect(toleranceBand(money('-1000.00'), tol('0', '0.01')).toFixed(2)).toBe('10.00')
  })
})
