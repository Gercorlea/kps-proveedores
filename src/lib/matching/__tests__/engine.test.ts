import { describe, expect, it } from 'vitest'
import { parseCfdi } from '../../cfdi/parser'
import { MatchOutcome } from '../../domain/enums'
import { money, ZERO_TOLERANCE } from '../../money'
import { matchInvoice } from '../engine'
import type { PoLine, ReceiptLine } from '../types'

/**
 * El caso viene de la prueba de carga real contra la entrada 322 de Small Lab:
 * la factura cobra 10,000 piezas a 54.31 mas IVA y la entrada trae 10,000 a
 * 63.00 sin IVA. Los dos documentos suman 630,000.00 USD exactos, asi que la
 * diferencia del documento es CERO y lo unico que no cuadra son los renglones.
 *
 * Ahi el resumen decia "Hay una diferencia de USD 0.00 entre tu factura y la
 * entrada": un mensaje que se contradice solo y manda a buscar un descuadre de
 * importe que no existe.
 */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
    Version="4.0" Serie="A" Folio="9001" Fecha="2026-09-04T10:00:00"
    FormaPago="03" MetodoPago="PUE" TipoDeComprobante="I"
    Moneda="USD" TipoCambio="1"
    SubTotal="543103.45" Total="630000.00" LugarExpedicion="64000"
    Exportacion="01" NoCertificado="00001000000504465028" Sello="c2VsbG8=" Certificado="Y2VydA==">
  <cfdi:Emisor Rfc="XAXX010101000" Nombre="Small Lab" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="KPS950101AB1" Nombre="KPS SA DE CV" DomicilioFiscalReceptor="64000"
      RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="42131600" NoIdentificacion="PTAL0004" Cantidad="10000"
        ClaveUnidad="H87" Unidad="Pieza" Descripcion="Alux Serum PDRN 30ML"
        ValorUnitario="54.310345" Importe="543103.45" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados>
        <cfdi:Traslado Base="543103.45" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="86896.55"/>
      </cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="86896.55"><cfdi:Traslados>
    <cfdi:Traslado Base="543103.45" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="86896.55"/>
  </cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
        Version="1.1" UUID="9a1b2c3d-9001-4444-8888-aaaabbbbcccc"
        FechaTimbrado="2026-09-04T10:01:00" RfcProvCertifica="AAA010101AAA"
        SelloCFD="c2Vsb0NGRA==" NoCertificadoSAT="00001000000504465028" SelloSAT="c2Vsb1NBVA=="/>
  </cfdi:Complemento>
</cfdi:Comprobante>`

const poLine: PoLine = {
  lineNum: 0,
  itemCode: 'PTAL0004',
  description: 'Alux Serum PDRN 30ML',
  quantityOrdered: money(10000),
  remainingOpen: money(0),
  unitPrice: money('63'),
  lineTotal: money('630000'),
  taxAmount: money(0),
}

const receiptLine: ReceiptLine = {
  lineNum: 0,
  poLineNum: 0,
  itemCode: 'PTAL0004',
  description: 'Alux Serum PDRN 30ML',
  quantityReceived: money(10000),
  remainingOpen: money(0),
  price: money('63'),
  lineTotal: money('630000'),
  taxAmount: money(0),
}

describe('matchInvoice — resumen', () => {
  const resultado = matchInvoice(
    {
      poNumber: '1037',
      poCurrency: 'USD',
      poLines: [poLine],
      receiptNumber: '322',
      receiptLines: [receiptLine],
      invoice: parseCfdi(Buffer.from(XML)),
    },
    { tolerance: ZERO_TOLERANCE, underInvoicePolicy: 'saldo' },
  )

  it('no cuadra aunque los totales sean identicos', () => {
    expect(resultado.totalDifference.toString()).toBe('0')
    expect(resultado.outcome).toBe(MatchOutcome.DIFERENCIA_PRECIO)
    expect(resultado.canProceed).toBe(false)
  })

  it('no cita una diferencia de importe que no existe', () => {
    expect(resultado.summary).not.toContain('0.00')
    expect(resultado.summary).not.toMatch(/diferencia de USD/)
  })

  it('dice que lo que no cuadra son los renglones', () => {
    expect(resultado.summary).toContain('renglon')
    expect(resultado.differences.length).toBeGreaterThan(0)
  })
})
