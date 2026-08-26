import type { MatchOutcome } from '../domain/enums'
import type { Decimal, Tolerance } from '../money'
import type { ParsedCfdi } from '../cfdi/types'

/**
 * Cotejo three-way — ARC-SPEC-2026-PP-003 §06.
 *
 * Compara tres fuentes por linea: la orden de compra, la entrada de mercancia y
 * el CFDI del proveedor. La regla M7 es explicita en que se comparan CANTIDAD e
 * IMPORTE TOTAL CON IVA.
 *
 * Todo lo de aqui son datos planos: el motor es una funcion pura. No abre la
 * base de datos ni llama a SAP, porque tiene que poder probarse entero sin
 * ninguna de las dos cosas.
 */

/** Linea de la orden de compra (PurchaseOrderItem). */
export interface PoLine {
  readonly lineNum: number
  readonly itemCode?: string
  readonly description: string
  readonly quantityOrdered: Decimal
  readonly remainingOpen: Decimal
  readonly unitPrice: Decimal
  readonly lineTotal: Decimal
  readonly taxAmount: Decimal
}

/** Linea de la entrada de mercancia (GoodsReceiptItem). */
export interface ReceiptLine {
  readonly lineNum: number
  /** BaseLine hacia la OC: enlaza esta linea con la de la orden. */
  readonly poLineNum: number
  readonly itemCode?: string
  readonly description: string
  readonly quantityReceived: Decimal
  /** Cuanto falta por facturar de esta linea. */
  readonly remainingOpen: Decimal
  readonly price: Decimal
  readonly lineTotal: Decimal
  readonly taxAmount: Decimal
}

export interface MatchInput {
  readonly poNumber: string
  /** Moneda de la OC. Si el CFDI trae otra, se rechaza sin analizar mas. */
  readonly poCurrency: string
  readonly poLines: readonly PoLine[]
  readonly receiptNumber: string
  readonly receiptLines: readonly ReceiptLine[]
  readonly invoice: ParsedCfdi
}

export interface MatchOptions {
  /** Tolerancia del cotejo (regla M11, pendiente 20.5). */
  readonly tolerance: Tolerance
  /**
   * Que hacer si la factura es MENOR que lo recibido (pendiente 20.6).
   * `saldo`   = se acepta y la entrada conserva saldo por facturar.
   * `rechazo` = se marca como diferencia y no avanza.
   */
  readonly underInvoicePolicy: 'saldo' | 'rechazo'
}

/** Cifras de una linea en cualquiera de las tres fuentes. */
export interface LineFigures {
  readonly quantity: Decimal
  readonly unitPrice: Decimal
  /** Importe sin IVA. */
  readonly amount: Decimal
  readonly tax: Decimal
  /** Importe CON IVA — la cifra que manda en el cotejo (M7). */
  readonly total: Decimal
}

/** Como se emparejo una linea de la factura con la de la entrada. */
export type MatchedBy = 'itemCode' | 'descripcion' | 'posicion' | 'sin-correspondencia'

export type DiffField =
  | 'MONEDA'
  | 'CANTIDAD'
  | 'PRECIO_UNITARIO'
  | 'IMPORTE'
  | 'TOTAL'
  | 'LINEA_SIN_CORRESPONDENCIA'

/**
 * Una diferencia concreta. El spec §06 es tajante: "No se le dice al proveedor
 * 'no coincide' sin decirle exactamente en que linea y por cuanto".
 */
export interface MatchDifference {
  /** Numero de linea de la factura. Null cuando la diferencia es del documento. */
  readonly lineNumber: number | null
  readonly field: DiffField
  readonly expected: Decimal | null
  readonly received: Decimal | null
  /** Con signo: positivo cuando la factura excede. */
  readonly difference: Decimal | null
  /** Redactado para que lo lea el proveedor. */
  readonly message: string
}

/** Una fila de la matriz de tres columnas que pinta P08. */
export interface MatchLine {
  readonly invoiceLineNumber: number | null
  readonly poLineNum: number | null
  readonly receiptLineNum: number | null
  readonly description: string
  readonly matchedBy: MatchedBy
  readonly po: LineFigures | null
  readonly receipt: LineFigures | null
  readonly invoice: LineFigures | null
  readonly hasDifference: boolean
}

export interface MatchTotals {
  readonly po: LineFigures
  readonly receipt: LineFigures
  readonly invoice: LineFigures
}

export interface MatchResult {
  readonly outcome: MatchOutcome
  readonly currency: string
  readonly poNumber: string
  readonly receiptNumber: string
  readonly totals: MatchTotals
  readonly lines: readonly MatchLine[]
  readonly differences: readonly MatchDifference[]
  /** Diferencia del documento con IVA, con signo. Positiva = se facturo de mas. */
  readonly totalDifference: Decimal
  /** Importe de la nota de credito requerida, con IVA. Null si no aplica. */
  readonly creditNoteAmount: Decimal | null
  /** Saldo que queda por facturar cuando se acepta una factura menor. */
  readonly pendingAmount: Decimal | null
  readonly requiresCreditNote: boolean
  /** True si la factura puede seguir a revision sin accion del proveedor. */
  readonly canProceed: boolean
  /** Una frase que resume el resultado, para la cabecera de P08. */
  readonly summary: string
}
