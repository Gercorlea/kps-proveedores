import type { Decimal } from '../money'

/**
 * Representacion de dominio de un CFDI 4.0 ya extraido del XML.
 *
 * §12.1: todo esto sale del XML sin intervencion humana. §04 principio 5:
 * "cero captura manual de datos fiscales".
 *
 * Aqui muere la nulabilidad: si un campo obligatorio del CFDI falta, el parser
 * lanza `CfdiParseError` en vez de devolver un objeto a medias. Los `?` que
 * quedan son los que el propio estandar del SAT declara opcionales.
 */

export type TipoDeComprobante = 'I' | 'E' | 'T' | 'N' | 'P'

export interface CfdiEmisor {
  readonly rfc: string
  readonly nombre: string
  readonly regimenFiscal: string
}

export interface CfdiReceptor {
  readonly rfc: string
  readonly nombre: string
  readonly domicilioFiscal: string
  readonly regimenFiscal: string
  readonly usoCFDI: string
}

export interface CfdiImpuestoLinea {
  readonly base: Decimal
  readonly impuesto: string
  readonly tipoFactor: string
  readonly tasaOCuota?: Decimal
  readonly importe: Decimal
}

export interface CfdiConcepto {
  /** 1-indexado, en el orden en que aparece en el XML. */
  readonly lineNumber: number
  readonly claveProdServ: string
  readonly claveUnidad: string
  readonly unidad?: string
  /** `NoIdentificacion`: el codigo del articulo segun el proveedor. */
  readonly noIdentificacion?: string
  readonly descripcion: string
  readonly cantidad: Decimal
  readonly valorUnitario: Decimal
  readonly importe: Decimal
  readonly descuento: Decimal
  readonly objetoImp?: string
  readonly traslados: readonly CfdiImpuestoLinea[]
  readonly retenciones: readonly CfdiImpuestoLinea[]
  /** Suma de `traslados`. Precalculado porque el cotejo lo pide por linea. */
  readonly totalTrasladados: Decimal
  /** Suma de `retenciones`. */
  readonly totalRetenidos: Decimal
}

export interface CfdiImpuestos {
  readonly totalTrasladados: Decimal
  readonly totalRetenidos: Decimal
  readonly traslados: readonly CfdiImpuestoLinea[]
  readonly retenciones: readonly CfdiImpuestoLinea[]
}

export interface CfdiTimbre {
  readonly uuid: string
  readonly fechaTimbrado: Date
  readonly noCertificadoSAT: string
  readonly selloSAT: string
  readonly selloCFD: string
  readonly rfcProvCertifica?: string
  readonly version: string
}

/**
 * Una factura saldada por un complemento de pago (nodo `pago20:DoctoRelacionado`).
 *
 * `impPagado` es lo que este pago abona a ESA factura, no el total del pago: un
 * mismo REP puede saldar varias facturas de golpe, y confundir las dos cifras es
 * como se dan por cubiertas facturas que solo recibieron un abono parcial.
 */
export interface CfdiDoctoRelacionado {
  readonly uuid: string
  readonly numParcialidad?: string
  readonly impSaldoAnt?: Decimal
  readonly impPagado?: Decimal
  readonly impSaldoInsoluto?: Decimal
}

/** Un pago del complemento (nodo `pago20:Pago`). */
export interface CfdiPago {
  readonly fechaPago: Date
  readonly formaDePago?: string
  readonly monedaP: string
  readonly monto: Decimal
  readonly documentos: readonly CfdiDoctoRelacionado[]
}

export interface CfdiRelacionado {
  readonly tipoRelacion: string
  readonly uuids: readonly string[]
}

export interface ParsedCfdi {
  readonly version: string
  readonly tipoDeComprobante: TipoDeComprobante
  readonly serie?: string
  readonly folio?: string
  readonly fecha: Date
  readonly subTotal: Decimal
  readonly descuento: Decimal
  readonly total: Decimal
  readonly moneda: string
  readonly tipoCambio?: Decimal
  readonly formaPago?: string
  readonly metodoPago?: string
  readonly condicionesDePago?: string
  readonly lugarExpedicion: string
  readonly exportacion?: string
  readonly noCertificado: string
  /** El certificado de sello digital del emisor, X.509 en base64 DER. */
  readonly certificado: string
  /** El sello del emisor, base64. Se guarda para poder auditarlo. */
  readonly sello: string
  readonly emisor: CfdiEmisor
  readonly receptor: CfdiReceptor
  readonly conceptos: readonly CfdiConcepto[]
  readonly impuestos: CfdiImpuestos
  readonly timbre: CfdiTimbre
  /** Documentos relacionados: los usa una nota de credito para apuntar a su factura. */
  readonly cfdiRelacionados: readonly CfdiRelacionado[]
  /** Pagos del complemento. Vacio en todo lo que no sea un comprobante tipo P. */
  readonly pagos: readonly CfdiPago[]
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/**
 * Motivos de rechazo inmediato en la extraccion (§12.1).
 * Se mapean uno a uno a reglas de §12.2 para que el proveedor vea siempre un
 * mensaje concreto en vez de "el XML es invalido".
 */
export type CfdiParseErrorCode =
  | 'XML_MAL_FORMADO'
  | 'NO_ES_CFDI'
  | 'VERSION_NO_SOPORTADA'
  | 'SIN_TIMBRE'
  | 'UUID_INVALIDO'
  | 'TIPO_COMPROBANTE_INVALIDO'
  | 'CAMPO_OBLIGATORIO_AUSENTE'
  | 'IMPORTE_ILEGIBLE'
  | 'FECHA_ILEGIBLE'
  | 'SIN_CONCEPTOS'

export class CfdiParseError extends Error {
  constructor(
    readonly code: CfdiParseErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'CfdiParseError'
  }
}

/** Comprobante de ingreso: una factura. */
export const TIPO_FACTURA: TipoDeComprobante = 'I'
/** Comprobante de egreso: una nota de credito. */
export const TIPO_NOTA_CREDITO: TipoDeComprobante = 'E'
/** Comprobante de pago: un complemento (REP). */
export const TIPO_PAGO: TipoDeComprobante = 'P'

/**
 * Metodo de pago del CFDI, que es lo que decide si habra complemento.
 *
 * PUE se cobra al emitir y no lleva REP. PPD se cobra despues y SI lo lleva,
 * con fecha limite legal. Tratarlos igual significa o exigir un documento que
 * la ley no pide, o dejar de exigir uno que si.
 */
export const METODO_PUE = 'PUE'
export const METODO_PPD = 'PPD'
