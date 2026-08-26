import { getConfig } from '../config'
import { MatchOutcome } from '../domain/enums'
import { formatMoney, moneyOrZero } from '../money'
import type { ParsedCfdi } from '../cfdi/types'
import type { Validacion } from '../cfdi/validations'
import type { EntradaFacturable } from '../sap/entradas-facturables'
import type { B1PurchaseOrder } from '../sap/types'
import { matchInvoice } from './engine'
import type { MatchResult, PoLine, ReceiptLine } from './types'

/**
 * Enchufa el motor de cotejo (§06) a los documentos reales de Business One.
 *
 * POR QUE HACIA FALTA ESTE MODULO. `engine.ts` es una funcion pura que recibe la
 * orden, la entrada y el CFDI ya en forma de dominio; hasta ahora el unico que
 * se los daba era la pantalla de demostracion. El flujo de verdad —el proveedor
 * sube su XML contra una entrada— nunca lo llamaba, asi que el cotejo existia
 * escrito y no se corria nunca. Esta es la traduccion que faltaba.
 *
 * LO QUE EVITA. Sin cotejo, el portal acepta cualquier importe y quien decide es
 * B1 al registrar, copiando de la entrada: si el CFDI dice 29,000 y la entrada
 * vale 29, B1 registra 29 sin protestar, porque los importes los pone el
 * documento base y no la factura. La diferencia solo sale a la luz cuando
 * alguien cuadra la cuenta de dotacion, meses despues.
 */

/**
 * La misma moneda escrita de dos maneras.
 *
 * Business One llama `MXP` al peso mexicano; el SAT y el CFDI lo llaman `MXN`.
 * Son la misma moneda. Sin esta traduccion el cotejo rechazaria por "moneda
 * distinta" todas las facturas nacionales, que son casi todas.
 */
export function normalizarMoneda(codigo: string | null | undefined): string {
  const c = (codigo ?? '').trim().toUpperCase()
  if (c === 'MXP') return 'MXN'
  return c || 'MXN'
}

/** Renglones de la orden en la forma que pide el motor. */
function renglonesDeOrden(orden: B1PurchaseOrder): PoLine[] {
  return (orden.DocumentLines ?? []).map((l) => ({
    lineNum: l.LineNum,
    itemCode: l.ItemCode ?? undefined,
    description: l.ItemDescription ?? l.ItemCode ?? `Renglon ${l.LineNum}`,
    quantityOrdered: moneyOrZero(l.Quantity),
    remainingOpen: moneyOrZero(l.RemainingOpenQuantity ?? l.Quantity),
    unitPrice: moneyOrZero(l.UnitPrice ?? l.Price),
    lineTotal: moneyOrZero(l.LineTotal),
    taxAmount: moneyOrZero(l.TaxTotal),
  }))
}

/** Renglones de la entrada en la forma que pide el motor. */
function renglonesDeEntrada(entrada: EntradaFacturable): ReceiptLine[] {
  return entrada.renglones.map((r) => ({
    lineNum: r.lineNum,
    poLineNum: r.poLineNum,
    itemCode: r.itemCode ?? undefined,
    description: r.descripcion,
    quantityReceived: r.recibida,
    remainingOpen: r.abierta,
    price: r.precio,
    lineTotal: r.importe,
    taxAmount: r.impuesto,
  }))
}

export interface Cotejo {
  readonly resultado: MatchResult
  /** Las reglas COTEJO_* listas para guardar en `validationResults`. */
  readonly validaciones: Validacion[]
}

/**
 * Coteja el CFDI contra la entrada y la orden.
 *
 * LAS REGLAS SALEN COMO ADVERTENCIA, NO COMO BLOQUEANTE. Una diferencia de
 * cotejo no es un XML mal formado: es un desacuerdo sobre cuanto se debe, y §06
 * lo resuelve con una nota de credito, no cerrandole la puerta al proveedor. Lo
 * que si bloquea es ENVIAR la factura a KPS: eso lo decide `canProceed` en la
 * ruta de envio, y para entonces el proveedor ya tiene delante el renglon y el
 * importe exactos.
 */
export function cotejarConEntrada(input: {
  readonly orden: B1PurchaseOrder
  readonly entrada: EntradaFacturable
  readonly cfdi: ParsedCfdi
}): Cotejo {
  const { orden, entrada, cfdi } = input
  const cfg = getConfig().matching

  // La moneda de referencia es la de la ENTRADA y no la de la orden: es de la
  // entrada de donde B1 copia la factura, y es su moneda la que acabara en el
  // documento registrado.
  const moneda = normalizarMoneda(entrada.moneda ?? orden.DocCurrency)

  const resultado = matchInvoice(
    {
      poNumber: String(orden.DocNum),
      poCurrency: moneda,
      poLines: renglonesDeOrden(orden),
      receiptNumber: String(entrada.docNum),
      receiptLines: renglonesDeEntrada(entrada),
      // El motor compara `invoice.moneda` contra `poCurrency`, asi que el CFDI
      // entra con su moneda normalizada por el mismo criterio.
      invoice: { ...cfdi, moneda: normalizarMoneda(cfdi.moneda) },
    },
    {
      tolerance: {
        absolute: cfg.toleranceAbsolute,
        percentage: cfg.tolerancePercentage,
      },
      underInvoicePolicy: cfg.underInvoicePolicy,
    },
  )

  const validaciones: Validacion[] = []

  if (resultado.outcome === MatchOutcome.MONEDA_DISTINTA) {
    validaciones.push({
      regla: 'COTEJO_MONEDA',
      severidad: 'BLOQUEANTE',
      pasa: false,
      detalle: resultado.summary,
    })
    // Sin moneda comun no hay nada mas que comparar: el motor ni lo intento.
    return { resultado, validaciones }
  }

  // --- COTEJO_CANTIDAD ----------------------------------------------------
  const problemasCantidad = resultado.differences.filter(
    (d) => d.field === 'CANTIDAD' || d.field === 'LINEA_SIN_CORRESPONDENCIA',
  )
  validaciones.push({
    regla: 'COTEJO_CANTIDAD',
    severidad: 'ADVERTENCIA',
    pasa: problemasCantidad.length === 0,
    detalle:
      problemasCantidad.length === 0
        ? `Las cantidades de tu factura coinciden con la entrada ${resultado.receiptNumber}.`
        : problemasCantidad.map((d) => d.message).join(' '),
  })

  // --- COTEJO_IMPORTE -----------------------------------------------------
  const problemasImporte = resultado.differences.filter(
    (d) => d.field === 'TOTAL' || d.field === 'PRECIO_UNITARIO' || d.field === 'IMPORTE',
  )
  const importeCuadra = resultado.totalDifference.isZero() && problemasImporte.length === 0
  validaciones.push({
    regla: 'COTEJO_IMPORTE',
    severidad: 'ADVERTENCIA',
    pasa: importeCuadra,
    detalle: importeCuadra
      ? `El importe de tu factura coincide con la entrada ${resultado.receiptNumber}: ${formatMoney(resultado.totals.invoice.total, resultado.currency)}.`
      : `${resultado.summary} Lo recibido en la entrada ${resultado.receiptNumber} vale ${formatMoney(resultado.totals.receipt.total, resultado.currency)} y tu factura cobra ${formatMoney(resultado.totals.invoice.total, resultado.currency)}.`,
  })

  return { resultado, validaciones }
}

/**
 * El resultado del cotejo en la forma que se guarda en `invoices.matchResult`.
 *
 * Se guardan CIFRAS COMO CADENA, no como numero de coma flotante: un importe que
 * pasa por `number` deja de ser exacto, y esta es la constancia de por que se
 * aprobo o se rechazo una factura. La matriz completa por linea no se guarda —es
 * grande y se puede recalcular—; lo que se guarda es lo que hay que poder leer
 * meses despues sin volver a llamar a B1.
 */
export function paraGuardar(resultado: MatchResult): Record<string, unknown> {
  return {
    outcome: resultado.outcome,
    currency: resultado.currency,
    poNumber: resultado.poNumber,
    receiptNumber: resultado.receiptNumber,
    receiptTotal: resultado.totals.receipt.total.toFixed(2),
    invoiceTotal: resultado.totals.invoice.total.toFixed(2),
    totalDifference: resultado.totalDifference.toFixed(2),
    creditNoteAmount: resultado.creditNoteAmount?.toFixed(2) ?? null,
    pendingAmount: resultado.pendingAmount?.toFixed(2) ?? null,
    requiresCreditNote: resultado.requiresCreditNote,
    canProceed: resultado.canProceed,
    summary: resultado.summary,
    differences: resultado.differences.map((d) => ({
      lineNumber: d.lineNumber,
      field: d.field,
      expected: d.expected?.toFixed(2) ?? null,
      received: d.received?.toFixed(2) ?? null,
      difference: d.difference?.toFixed(2) ?? null,
      message: d.message,
    })),
    ranAt: new Date(),
  }
}
