import { Decimal } from 'decimal.js'

/**
 * Aritmetica de importes del portal.
 *
 * Regla dura: ningun importe fiscal toca `number` en punto flotante. El CFDI se
 * compara contra SAP centavo a centavo (regla M7: "importe total CON IVA"), y un
 * 0.1 + 0.2 = 0.30000000000000004 se traduce en una nota de credito pedida por
 * error. Todo importe vive como Decimal desde que sale del XML hasta que entra
 * a Postgres como NUMERIC.
 *
 * El redondeo es HALF_UP, que es el redondeo aritmetico que aplica el SAT.
 */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP })

export { Decimal }

/** Decimales de un importe monetario (subtotal, IVA, total). */
export const MONEY_DP = 2
/** Decimales de una cantidad (cantidad ordenada, recibida, facturada). */
export const QTY_DP = 3

export class MoneyParseError extends Error {
  constructor(readonly raw: unknown) {
    super(`No se pudo interpretar el importe: ${JSON.stringify(raw)}`)
    this.name = 'MoneyParseError'
  }
}

/**
 * Convierte a Decimal cualquier representacion que llegue del XML (string), del
 * Service Layer (number) o de Prisma (Decimal propio, expuesto como objeto con
 * toString). Lanza en vez de devolver NaN: un importe ilegible es un error de
 * datos, no un cero.
 */
export function money(value: Decimal.Value | { toString(): string } | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') {
    throw new MoneyParseError(value)
  }
  const candidate =
    typeof value === 'object' && !(value instanceof Decimal)
      ? value.toString()
      : (value as Decimal.Value)

  let parsed: Decimal
  try {
    parsed = new Decimal(candidate)
  } catch {
    throw new MoneyParseError(value)
  }
  if (!parsed.isFinite()) throw new MoneyParseError(value)
  return parsed
}

/** Igual que `money`, pero un valor ausente vale cero. Para campos opcionales del CFDI. */
export function moneyOrZero(
  value: Decimal.Value | { toString(): string } | null | undefined,
): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0)
  return money(value)
}

export function round(value: Decimal, dp: number): Decimal {
  return value.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP)
}

export const round2 = (value: Decimal): Decimal => round(value, MONEY_DP)
export const round3 = (value: Decimal): Decimal => round(value, QTY_DP)

/** Diferencia con signo: positivo cuando `a` excede a `b`. */
export function difference(a: Decimal, b: Decimal): Decimal {
  return a.minus(b)
}

export function absDifference(a: Decimal, b: Decimal): Decimal {
  return a.minus(b).abs()
}

export interface Tolerance {
  /** Tolerancia absoluta, en la moneda del documento. */
  readonly absolute: Decimal
  /** Tolerancia relativa sobre el valor esperado, como fraccion (0.01 = 1%). */
  readonly percentage: Decimal
}

export const ZERO_TOLERANCE: Tolerance = {
  absolute: new Decimal(0),
  percentage: new Decimal(0),
}

/**
 * Margen efectivo para un valor esperado dado: el mayor entre la tolerancia
 * absoluta y la porcentual. Se toma el mayor y no la suma para que subir una
 * de las dos nunca afloje la otra sin que nadie lo note.
 */
export function toleranceBand(expected: Decimal, tolerance: Tolerance): Decimal {
  const relative = expected.abs().times(tolerance.percentage)
  return Decimal.max(tolerance.absolute.abs(), relative)
}

/** `actual` cae dentro de la tolerancia respecto de `expected`. */
export function withinTolerance(actual: Decimal, expected: Decimal, tolerance: Tolerance): boolean {
  return absDifference(actual, expected).lte(toleranceBand(expected, tolerance))
}

/** Serializa para Postgres NUMERIC. Prisma acepta string y evita el ida y vuelta por float. */
export function toDb(value: Decimal, dp: number = MONEY_DP): string {
  return round(value, dp).toFixed(dp)
}

/** Formato de presentacion en es-MX, para UI y correos. */
export function formatMoney(value: Decimal, currency = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    minimumFractionDigits: MONEY_DP,
    maximumFractionDigits: MONEY_DP,
  }).format(value.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP).toNumber())
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(v), new Decimal(0))
}
