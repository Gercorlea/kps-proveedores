import { Decimal, ZERO_TOLERANCE, money } from '../money'
import { parseCfdi } from '../cfdi/parser'
import { matchInvoice } from '../matching/engine'
import type { MatchResult, PoLine, ReceiptLine } from '../matching/types'

/**
 * Datos de demostracion del portal.
 *
 * Existe para que las pantallas se puedan ver y recorrer antes de que existan
 * los endpoints de §13. Se sustituye por lecturas del servidor sin tocar los
 * componentes: la forma de los datos ya es la del modelo de Prisma.
 *
 * Lo que NO es maqueta: el CFDI de abajo es un XML real que pasa por el parser
 * de verdad, y el cotejo de P08 lo calcula el motor de verdad. Los importes que
 * ves en esa pantalla los computa `matchInvoice`, no estan escritos a mano.
 */

export const PROVEEDOR = {
  supplierCode: 'P-10442',
  legalName: 'Textiles del Norte SA',
  taxId: 'TDN950412H45',
  type: 'MERCANCIA' as const,
  status: 'ACTIVO' as const,
  blocked: false,
  paymentTerms: '30 dias',
  email: 'facturacion@textilesdelnorte.example',
  phone: '81 8000 1122',
  currency: 'MXN',
  address: 'Av. Industrial 4120, Apodaca, Nuevo Leon, 66600',
}

export interface DemoReceipt {
  documentNumber: string
  sapDocEntry: number
  postingDate: string
  pieces: number
  amount: string
  status: 'FACTURADA' | 'POR_FACTURAR' | 'EN_ESPERA'
  invoiceFolio?: string
}

export interface DemoPurchaseOrder {
  poNumber: string
  sapDocEntry: number
  documentDate: string
  currency: string
  totalAmount: string
  invoicedAmount: string
  status: 'ABIERTA' | 'PARCIALMENTE_FACTURADA' | 'FACTURADA_COMPLETA' | 'CERRADA_PAGADA'
  receipts: DemoReceipt[]
}

export const ORDENES: DemoPurchaseOrder[] = [
  {
    poNumber: '4471',
    sapDocEntry: 22471,
    documentDate: '02 AGO 2026',
    currency: 'MXN',
    totalAmount: '412,900.00',
    invoicedAmount: '270,040.00',
    status: 'PARCIALMENTE_FACTURADA',
    receipts: [
      {
        documentNumber: '5512',
        sapDocEntry: 20512,
        postingDate: '04 AGO',
        pieces: 1200,
        amount: '142,860.00',
        status: 'FACTURADA',
        invoiceFolio: 'FAC-2026-118',
      },
      {
        documentNumber: '5518',
        sapDocEntry: 20518,
        postingDate: '09 AGO',
        pieces: 840,
        amount: '127,180.00',
        status: 'FACTURADA',
        invoiceFolio: 'FAC-2026-117',
      },
      {
        documentNumber: '5524',
        sapDocEntry: 20524,
        postingDate: '14 AGO',
        pieces: 620,
        amount: '98,854.04',
        status: 'POR_FACTURAR',
      },
      {
        documentNumber: '5531',
        sapDocEntry: 20531,
        postingDate: '16 AGO',
        pieces: 410,
        amount: '54,440.00',
        status: 'POR_FACTURAR',
      },
    ],
  },
  {
    poNumber: '4482',
    sapDocEntry: 22482,
    documentDate: '11 AGO 2026',
    currency: 'MXN',
    totalAmount: '188,300.00',
    invoicedAmount: '0.00',
    status: 'ABIERTA',
    receipts: [],
  },
  {
    poNumber: '4455',
    sapDocEntry: 22455,
    documentDate: '21 JUL 2026',
    currency: 'MXN',
    totalAmount: '96,512.00',
    invoicedAmount: '96,512.00',
    status: 'FACTURADA_COMPLETA',
    receipts: [
      {
        documentNumber: '5488',
        sapDocEntry: 20488,
        postingDate: '24 JUL',
        pieces: 700,
        amount: '96,512.00',
        status: 'FACTURADA',
        invoiceFolio: 'FAC-2026-108',
      },
    ],
  },
  {
    poNumber: '4490',
    sapDocEntry: 22490,
    documentDate: '15 AGO 2026',
    currency: 'MXN',
    totalAmount: '74,120.00',
    invoicedAmount: '0.00',
    status: 'ABIERTA',
    receipts: [],
  },
]

export type EstatusFactura =
  | 'BORRADOR'
  | 'EN_VALIDACION'
  | 'EN_COTEJO'
  | 'NC_SOLICITADA'
  | 'EN_REVISION'
  | 'APROBADA_PAGO'
  | 'CUENTAS_POR_PAGAR'
  | 'PAGADA'
  | 'CERRADA'
  | 'RECHAZADA'

/** Lectura para el proveedor (ARC-DS-2026-PP-001 §06, tabla de estatus). */
export const ETIQUETA_PROVEEDOR: Record<EstatusFactura, string> = {
  BORRADOR: 'Borrador',
  EN_VALIDACION: 'Validando',
  EN_COTEJO: 'Cotejando',
  NC_SOLICITADA: 'Requiere nota de credito',
  EN_REVISION: 'En revision',
  APROBADA_PAGO: 'Aprobada para pago',
  CUENTAS_POR_PAGAR: 'En cuentas por pagar',
  PAGADA: 'Pagada',
  CERRADA: 'Cerrada',
  RECHAZADA: 'Rechazada',
}

export type Tono = 'ok' | 'warn' | 'danger' | 'ai' | undefined

export const TONO_ESTATUS: Record<EstatusFactura, Tono> = {
  BORRADOR: undefined,
  EN_VALIDACION: 'ai',
  EN_COTEJO: 'ai',
  NC_SOLICITADA: 'danger',
  EN_REVISION: undefined,
  APROBADA_PAGO: 'ok',
  CUENTAS_POR_PAGAR: undefined,
  PAGADA: 'warn',
  CERRADA: 'ok',
  RECHAZADA: 'danger',
}

export interface DemoInvoice {
  id: string
  folio: string
  tipo: 'Mercancia' | 'Servicio'
  poNumber?: string
  receiptNumber?: string
  total: string
  currency: string
  estatus: EstatusFactura
  fecha: string
  uuid: string
  /** Solo cuando el cotejo detecto diferencia: se calcula, no se escribe. */
  tieneCotejo?: boolean
}

export const FACTURAS: DemoInvoice[] = [
  {
    id: 'fac-118',
    folio: 'FAC-2026-118',
    tipo: 'Mercancia',
    poNumber: '4471',
    receiptNumber: '5512',
    total: '142,860.00',
    currency: 'MXN',
    estatus: 'PAGADA',
    fecha: '14 AGO',
    uuid: 'C3D4E5F6-1111-2222-3333-444455556666',
  },
  {
    id: 'fac-117',
    folio: 'FAC-2026-117',
    tipo: 'Servicio',
    total: '38,000.00',
    currency: 'MXN',
    estatus: 'EN_REVISION',
    fecha: '13 AGO',
    uuid: 'B2C3D4E5-1111-2222-3333-444455556666',
  },
  {
    id: 'fac-115',
    folio: 'FAC-2026-115',
    tipo: 'Mercancia',
    poNumber: '4471',
    receiptNumber: '5524',
    total: '102,471.62',
    currency: 'MXN',
    estatus: 'NC_SOLICITADA',
    fecha: '12 AGO',
    uuid: 'A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D',
    tieneCotejo: true,
  },
  {
    id: 'fac-112',
    folio: 'FAC-2026-112',
    tipo: 'Mercancia',
    poNumber: '4455',
    receiptNumber: '5488',
    total: '96,512.00',
    currency: 'MXN',
    estatus: 'PAGADA',
    fecha: '09 AGO',
    uuid: 'D4E5F6A7-1111-2222-3333-444455556666',
  },
  {
    id: 'fac-108',
    folio: 'FAC-2026-108',
    tipo: 'Servicio',
    total: '17,400.00',
    currency: 'MXN',
    estatus: 'CERRADA',
    fecha: '05 AGO',
    uuid: 'E5F6A7B8-1111-2222-3333-444455556666',
  },
]

export const findInvoice = (id: string): DemoInvoice | undefined =>
  FACTURAS.find((f) => f.id === id || f.folio === id)

export const findOrder = (poNumber: string): DemoPurchaseOrder | undefined =>
  ORDENES.find((o) => o.poNumber === poNumber)

// ---------------------------------------------------------------------------
// Cotejo real de la factura FAC-2026-115 contra la entrada 5524
// ---------------------------------------------------------------------------

/**
 * CFDI 4.0 sintetico. El proveedor factura 620 metros a 142.48 cuando la orden
 * pacto 137.45: la diferencia de precio es la que P08 tiene que explicar.
 *
 * 620 x 142.48 = 88,337.60  ·  IVA 16% = 14,134.02  ·  total 102,471.62
 */
const CFDI_DEMO = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
    Version="4.0" Serie="A" Folio="115" Fecha="2026-08-12T09:41:00"
    FormaPago="03" MetodoPago="PUE" TipoDeComprobante="I" Moneda="MXN"
    SubTotal="88337.60" Total="102471.62" LugarExpedicion="66600"
    Exportacion="01" NoCertificado="00001000000504465028">
  <cfdi:Emisor Rfc="TDN950412H45" Nombre="TEXTILES DEL NORTE SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="KPS950101AB1" Nombre="KPS SA DE CV" DomicilioFiscalReceptor="64000"
      RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="11162000" NoIdentificacion="TELA-POP-240" Cantidad="620"
        ClaveUnidad="MTR" Unidad="Metro" Descripcion="Tela popelina 240 hilos"
        ValorUnitario="142.48" Importe="88337.60" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="88337.60" Impuesto="002" TipoFactor="Tasa"
              TasaOCuota="0.160000" Importe="14134.02"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="14134.02">
    <cfdi:Traslados>
      <cfdi:Traslado Base="88337.60" Impuesto="002" TipoFactor="Tasa"
          TasaOCuota="0.160000" Importe="14134.02"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
        Version="1.1" UUID="a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
        FechaTimbrado="2026-08-12T09:41:22" RfcProvCertifica="AAA010101AAA"
        SelloCFD="c2Vsb0NGRA==" NoCertificadoSAT="00001000000504465028" SelloSAT="c2Vsb1NBVA=="/>
  </cfdi:Complemento>
</cfdi:Comprobante>`

/** Linea de la OC 4471: 1,200 m pactados a 137.45. */
const PO_LINES: PoLine[] = [
  {
    lineNum: 0,
    itemCode: 'TELA-POP-240',
    description: 'Tela popelina 240 hilos',
    quantityOrdered: money('1200'),
    remainingOpen: money('580'),
    unitPrice: money('137.45'),
    lineTotal: money('164940.00'),
    taxAmount: money('26390.40'),
  },
]

/** Entrada 5524: se recibieron 620 m al precio de la orden. */
const RECEIPT_LINES: ReceiptLine[] = [
  {
    lineNum: 0,
    poLineNum: 0,
    itemCode: 'TELA-POP-240',
    description: 'Tela popelina 240 hilos',
    quantityReceived: money('620'),
    remainingOpen: new Decimal(0),
    price: money('137.45'),
    lineTotal: money('85219.00'),
    taxAmount: money('13635.04'),
  },
]

/**
 * Ejecuta el cotejo de verdad. Parser real, motor real, tolerancia cero.
 * Si alguien cambia una cifra del CFDI de arriba, esta pantalla lo refleja.
 */
export function cotejoDemo(): MatchResult {
  return matchInvoice(
    {
      poNumber: '4471',
      poCurrency: 'MXN',
      poLines: PO_LINES,
      receiptNumber: '5524',
      receiptLines: RECEIPT_LINES,
      invoice: parseCfdi(CFDI_DEMO),
    },
    { tolerance: ZERO_TOLERANCE, underInvoicePolicy: 'saldo' },
  )
}

/** Datos fiscales extraidos del XML, para la card de sistema de P10. */
export function datosExtraidosDemo() {
  const cfdi = parseCfdi(CFDI_DEMO)
  return {
    uuid: cfdi.timbre.uuid,
    rfcEmisor: cfdi.emisor.rfc,
    fecha: cfdi.fecha.toISOString().slice(0, 10).split('-').reverse().join('/'),
    subtotal: cfdi.subTotal.toFixed(2),
    iva: cfdi.impuestos.totalTrasladados.toFixed(2),
    total: cfdi.total.toFixed(2),
    moneda: cfdi.moneda,
  }
}
