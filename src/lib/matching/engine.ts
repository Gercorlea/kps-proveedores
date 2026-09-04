import { MatchOutcome } from '../domain/enums'
import { Decimal, formatMoney, round2, round3, sum, withinTolerance } from '../money'
import type { CfdiConcepto } from '../cfdi/types'
import type {
  LineFigures,
  MatchDifference,
  MatchInput,
  MatchLine,
  MatchOptions,
  MatchResult,
  MatchedBy,
  ReceiptLine,
} from './types'

/**
 * Motor de cotejo three-way (§06).
 *
 * Funcion pura: recibe la OC, la entrada y el CFDI ya cargados, y devuelve el
 * veredicto con el detalle linea por linea. No decide el estatus de la factura
 * —eso lo hace la maquina de estados— ni escribe nada.
 *
 * Lo que B1 hara despues por su cuenta (§00 consecuencia 02: impedir facturar
 * mas de lo recibido) este motor lo ANTICIPA y lo EXPLICA. B1 lo impone con un
 * error opaco; aqui el proveedor ve la linea y el importe exacto.
 */

const ZERO = new Decimal(0)

const EMPTY_FIGURES: LineFigures = {
  quantity: ZERO,
  unitPrice: ZERO,
  amount: ZERO,
  tax: ZERO,
  total: ZERO,
}

/** Normaliza una descripcion para poder compararla: sin acentos, sin dobles espacios. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function figures(quantity: Decimal, amount: Decimal, tax: Decimal): LineFigures {
  return {
    quantity: round3(quantity),
    // El precio unitario se deriva; con cantidad cero no se divide.
    unitPrice: quantity.isZero() ? ZERO : amount.dividedBy(quantity).toDecimalPlaces(4),
    amount: round2(amount),
    tax: round2(tax),
    total: round2(amount.plus(tax)),
  }
}

function receiptFigures(line: ReceiptLine): LineFigures {
  return figures(line.quantityReceived, line.lineTotal, line.taxAmount)
}

function conceptoFigures(concepto: CfdiConcepto): LineFigures {
  // El importe del concepto va neto de descuento; el IVA es el trasladado
  // menos lo retenido de esa misma linea.
  const amount = concepto.importe.minus(concepto.descuento)
  const tax = concepto.totalTrasladados.minus(concepto.totalRetenidos)
  return figures(concepto.cantidad, amount, tax)
}

function totalOf(lines: readonly LineFigures[]): LineFigures {
  const quantity = sum(lines.map((l) => l.quantity))
  const amount = sum(lines.map((l) => l.amount))
  const tax = sum(lines.map((l) => l.tax))
  return figures(quantity, amount, tax)
}

/**
 * Empareja cada concepto del CFDI con una linea de la entrada.
 *
 * La factura del proveedor no trae el LineNum de B1, asi que se intenta por
 * codigo de articulo, luego por descripcion normalizada y, en ultimo lugar, por
 * posicion. Una linea que no empareja NO se descarta: se reporta.
 */
function pairLines(
  conceptos: readonly CfdiConcepto[],
  receiptLines: readonly ReceiptLine[],
): Array<{ concepto: CfdiConcepto; receipt: ReceiptLine | null; matchedBy: MatchedBy }> {
  const disponibles = new Set(receiptLines.map((l) => l.lineNum))
  const tomar = (line: ReceiptLine | undefined): ReceiptLine | null => {
    if (!line || !disponibles.has(line.lineNum)) return null
    disponibles.delete(line.lineNum)
    return line
  }

  return conceptos.map((concepto, index) => {
    // 1 · por codigo de articulo declarado en el CFDI
    if (concepto.noIdentificacion) {
      const objetivo = concepto.noIdentificacion.trim().toUpperCase()
      const porCodigo = tomar(
        receiptLines.find(
          (l) => disponibles.has(l.lineNum) && l.itemCode?.trim().toUpperCase() === objetivo,
        ),
      )
      if (porCodigo) return { concepto, receipt: porCodigo, matchedBy: 'itemCode' as const }
    }

    // 2 · por descripcion normalizada
    const objetivoDesc = normalize(concepto.descripcion)
    const porDescripcion = tomar(
      receiptLines.find(
        (l) => disponibles.has(l.lineNum) && normalize(l.description) === objetivoDesc,
      ),
    )
    if (porDescripcion)
      return { concepto, receipt: porDescripcion, matchedBy: 'descripcion' as const }

    // 3 · por posicion, solo si esa posicion sigue libre
    const porPosicion = tomar(receiptLines[index])
    if (porPosicion) return { concepto, receipt: porPosicion, matchedBy: 'posicion' as const }

    return { concepto, receipt: null, matchedBy: 'sin-correspondencia' as const }
  })
}

export function matchInvoice(input: MatchInput, options: MatchOptions): MatchResult {
  const { invoice, receiptLines, poLines, poCurrency, poNumber, receiptNumber } = input
  const { tolerance, underInvoicePolicy } = options

  const base = { currency: poCurrency, poNumber, receiptNumber }

  // --- Moneda: rechazo directo, sin analizar nada mas (§06) ---
  if (invoice.moneda.toUpperCase() !== poCurrency.toUpperCase()) {
    const message = `Tu factura esta en ${invoice.moneda} y la orden ${poNumber} esta en ${poCurrency}. Vuelve a emitirla en ${poCurrency}.`
    return {
      ...base,
      outcome: MatchOutcome.MONEDA_DISTINTA,
      totals: { po: EMPTY_FIGURES, receipt: EMPTY_FIGURES, invoice: EMPTY_FIGURES },
      lines: [],
      differences: [
        { lineNumber: null, field: 'MONEDA', expected: null, received: null, difference: null, message },
      ],
      totalDifference: ZERO,
      creditNoteAmount: null,
      pendingAmount: null,
      requiresCreditNote: false,
      canProceed: false,
      summary: message,
    }
  }

  // --- Sin datos para cotejar ---
  if (receiptLines.length === 0 || invoice.conceptos.length === 0) {
    const message =
      receiptLines.length === 0
        ? `La entrada ${receiptNumber} no tiene lineas registradas en Business One. KPS debe revisarla antes de que puedas facturar.`
        : 'Tu factura no trae conceptos, asi que no hay nada que cotejar.'
    return {
      ...base,
      outcome: MatchOutcome.SIN_DATOS,
      totals: { po: EMPTY_FIGURES, receipt: EMPTY_FIGURES, invoice: EMPTY_FIGURES },
      lines: [],
      differences: [
        { lineNumber: null, field: 'TOTAL', expected: null, received: null, difference: null, message },
      ],
      totalDifference: ZERO,
      creditNoteAmount: null,
      pendingAmount: null,
      requiresCreditNote: false,
      canProceed: false,
      summary: message,
    }
  }

  const poByLineNum = new Map(poLines.map((l) => [l.lineNum, l]))
  const pares = pairLines(invoice.conceptos, receiptLines)
  const differences: MatchDifference[] = []

  const lines: MatchLine[] = pares.map(({ concepto, receipt, matchedBy }) => {
    const invoiceFigures = conceptoFigures(concepto)

    if (!receipt) {
      differences.push({
        lineNumber: concepto.lineNumber,
        field: 'LINEA_SIN_CORRESPONDENCIA',
        expected: null,
        received: invoiceFigures.total,
        difference: invoiceFigures.total,
        message: `La linea ${concepto.lineNumber} de tu factura, "${concepto.descripcion}" por ${formatMoney(invoiceFigures.total, poCurrency)}, no corresponde a nada de la entrada ${receiptNumber}.`,
      })
      return {
        invoiceLineNumber: concepto.lineNumber,
        poLineNum: null,
        receiptLineNum: null,
        description: concepto.descripcion,
        matchedBy,
        po: null,
        receipt: null,
        invoice: invoiceFigures,
        hasDifference: true,
      }
    }

    const receiptFig = receiptFigures(receipt)
    const poLine = poByLineNum.get(receipt.poLineNum)
    const poFig = poLine ? figures(poLine.quantityOrdered, poLine.lineTotal, poLine.taxAmount) : null

    let hasDifference = false

    // Cantidad (regla M7)
    if (!withinTolerance(invoiceFigures.quantity, receiptFig.quantity, tolerance)) {
      hasDifference = true
      differences.push({
        lineNumber: concepto.lineNumber,
        field: 'CANTIDAD',
        expected: receiptFig.quantity,
        received: invoiceFigures.quantity,
        difference: invoiceFigures.quantity.minus(receiptFig.quantity),
        message: `Linea ${concepto.lineNumber}: facturaste ${invoiceFigures.quantity.toFixed(3)} y se recibieron ${receiptFig.quantity.toFixed(3)}.`,
      })
    }

    // Precio unitario — se reporta aparte porque es la causa mas frecuente
    if (
      !invoiceFigures.quantity.isZero() &&
      !withinTolerance(invoiceFigures.unitPrice, receiptFig.unitPrice, tolerance)
    ) {
      hasDifference = true
      differences.push({
        lineNumber: concepto.lineNumber,
        field: 'PRECIO_UNITARIO',
        expected: receiptFig.unitPrice,
        received: invoiceFigures.unitPrice,
        difference: invoiceFigures.unitPrice.minus(receiptFig.unitPrice),
        message: `Linea ${concepto.lineNumber}: el precio unitario facturado es ${invoiceFigures.unitPrice.toFixed(2)} y el de la orden es ${receiptFig.unitPrice.toFixed(2)}.`,
      })
    }

    // Importe total CON IVA (regla M7)
    if (!withinTolerance(invoiceFigures.total, receiptFig.total, tolerance)) {
      hasDifference = true
      differences.push({
        lineNumber: concepto.lineNumber,
        field: 'TOTAL',
        expected: receiptFig.total,
        received: invoiceFigures.total,
        difference: invoiceFigures.total.minus(receiptFig.total),
        message: `Linea ${concepto.lineNumber}: facturaste ${formatMoney(invoiceFigures.total, poCurrency)} con IVA y lo recibido vale ${formatMoney(receiptFig.total, poCurrency)}.`,
      })
    }

    return {
      invoiceLineNumber: concepto.lineNumber,
      poLineNum: receipt.poLineNum,
      receiptLineNum: receipt.lineNum,
      description: concepto.descripcion,
      matchedBy,
      po: poFig,
      receipt: receiptFig,
      invoice: invoiceFigures,
      hasDifference,
    }
  })

  // Lineas de la entrada que la factura no cubrio: no son un error, pero
  // explican por que el total no cuadra, asi que se muestran en la matriz.
  const cubiertas = new Set(
    lines.map((l) => l.receiptLineNum).filter((n): n is number => n !== null),
  )
  for (const receipt of receiptLines) {
    if (cubiertas.has(receipt.lineNum)) continue
    const receiptFig = receiptFigures(receipt)
    const poLine = poByLineNum.get(receipt.poLineNum)
    lines.push({
      invoiceLineNumber: null,
      poLineNum: receipt.poLineNum,
      receiptLineNum: receipt.lineNum,
      description: receipt.description,
      matchedBy: 'sin-correspondencia',
      po: poLine ? figures(poLine.quantityOrdered, poLine.lineTotal, poLine.taxAmount) : null,
      receipt: receiptFig,
      invoice: null,
      hasDifference: true,
    })
    differences.push({
      lineNumber: null,
      field: 'LINEA_SIN_CORRESPONDENCIA',
      expected: receiptFig.total,
      received: null,
      difference: receiptFig.total.negated(),
      message: `La entrada ${receiptNumber} incluye "${receipt.description}" por ${formatMoney(receiptFig.total, poCurrency)} y tu factura no lo cubre.`,
    })
  }

  // --- Totales del documento ---
  const receiptTotals = totalOf(receiptLines.map(receiptFigures))
  const poTotals = totalOf(poLines.map((l) => figures(l.quantityOrdered, l.lineTotal, l.taxAmount)))
  // El total del documento se toma del CFDI, no de la suma de conceptos: es el
  // importe que el proveedor va a cobrar y el que B1 recibira.
  const invoiceTotals: LineFigures = {
    ...totalOf(invoice.conceptos.map(conceptoFigures)),
    total: round2(invoice.total),
  }

  const totalDifference = round2(invoiceTotals.total.minus(receiptTotals.total))
  const coincideTotal = withinTolerance(invoiceTotals.total, receiptTotals.total, tolerance)

  // Las cantidades cuadran cuando ninguna linea emparejada difiere en cantidad
  // y no sobra ni falta ninguna linea.
  const cantidadesCuadran = !differences.some(
    (d) => d.field === 'CANTIDAD' || d.field === 'LINEA_SIN_CORRESPONDENCIA',
  )

  let outcome: MatchOutcome
  if (coincideTotal && differences.length === 0) {
    outcome = MatchOutcome.COINCIDE
  } else if (cantidadesCuadran) {
    // Cantidad correcta, importe distinto por precio (§06, tabla de resultados).
    outcome = MatchOutcome.DIFERENCIA_PRECIO
  } else if (totalDifference.greaterThan(0)) {
    outcome = MatchOutcome.FACTURA_MAYOR
  } else if (totalDifference.lessThan(0)) {
    outcome = MatchOutcome.FACTURA_MENOR
  } else {
    // El total cuadra pero hay diferencias de linea que se compensan entre si.
    outcome = MatchOutcome.DIFERENCIA_PRECIO
  }

  // Solo se pide nota de credito cuando hay algo que acreditar: la factura
  // excede lo recibido. Una factura por debajo no se corrige con una NC.
  const excede = totalDifference.greaterThan(0)
  const creditNoteAmount = excede ? totalDifference : null
  const requiresCreditNote = outcome !== MatchOutcome.COINCIDE && excede

  const quedaSaldo = totalDifference.lessThan(0) && underInvoicePolicy === 'saldo'
  const pendingAmount = quedaSaldo ? totalDifference.negated() : null

  const canProceed = outcome === MatchOutcome.COINCIDE || (quedaSaldo && cantidadesCuadran)

  return {
    ...base,
    outcome,
    totals: { po: poTotals, receipt: receiptTotals, invoice: invoiceTotals },
    lines,
    differences,
    totalDifference,
    creditNoteAmount,
    pendingAmount,
    requiresCreditNote,
    canProceed,
    summary: buildSummary({
      outcome,
      totalDifference,
      currency: poCurrency,
      requiresCreditNote,
      pendingAmount,
      diferenciasDeLinea: differences.length,
    }),
  }
}

function buildSummary(args: {
  outcome: MatchOutcome
  totalDifference: Decimal
  currency: string
  requiresCreditNote: boolean
  pendingAmount: Decimal | null
  /** Cuantas diferencias por renglon encontro el cotejo. */
  diferenciasDeLinea: number
}): string {
  const {
    outcome,
    totalDifference,
    currency,
    requiresCreditNote,
    pendingAmount,
    diferenciasDeLinea,
  } = args

  if (outcome === MatchOutcome.COINCIDE) {
    return 'Tu factura coincide con la entrada de mercancia.'
  }
  if (requiresCreditNote) {
    return `Tu factura excede el importe recibido por ${formatMoney(totalDifference.abs(), currency)} con IVA.`
  }
  if (pendingAmount) {
    return `Tu factura queda por debajo de lo recibido en ${formatMoney(pendingAmount, currency)}. La entrada conserva ese saldo por facturar.`
  }
  // LOS RENGLONES PUEDEN NO CUADRAR CON EL TOTAL CUADRADO. Un precio unitario
  // mas bajo con una cantidad mas alta da el mismo importe, y entonces la
  // diferencia del documento es cero. Citarla —"hay una diferencia de USD
  // 0.00"— dejaba un mensaje que se contradecia solo y mandaba al proveedor a
  // buscar un descuadre de importe que no existe: lo que no cuadra son los
  // renglones.
  if (totalDifference.isZero()) {
    return diferenciasDeLinea === 1
      ? 'El total de tu factura coincide con el de la entrada, pero un renglon no: la diferencia se compensa dentro del documento.'
      : `El total de tu factura coincide con el de la entrada, pero ${diferenciasDeLinea} renglones no: las diferencias se compensan entre si dentro del documento.`
  }
  return `Hay una diferencia de ${formatMoney(totalDifference.abs(), currency)} entre tu factura y la entrada.`
}
