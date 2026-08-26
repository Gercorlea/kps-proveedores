import { describe, it, expect } from 'vitest'
import { parseCfdi } from '../parser'
import { revisarEstructura } from '../estructura'

/**
 * Reglas del Anexo 20 (§12.2).
 *
 * CADA PRUEBA ES UN ATAQUE. No se comprueba que un CFDI bueno pase —eso lo hace
 * solo la primera— sino que uno manipulado NO pase. Una regla que nunca dispara
 * es peor que no tenerla: da la impresion de que algo se revisa.
 *
 * Los CFDI son sinteticos, con el RFC de la lista de pruebas del SAT.
 */

const TIMBRE = `<tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
    Version="1.1" UUID="a1b2c3d4-1111-2222-3333-444455556666"
    FechaTimbrado="2026-03-14T12:31:05" RfcProvCertifica="AAA010101AAA"
    SelloCFD="c2Vsb0NGRA==" NoCertificadoSAT="00001000000504465028" SelloSAT="c2Vsb1NBVA=="/>`

/** 100 x 10.00 = 1,000.00 + IVA 16% (160.00) = 1,160.00. */
const BUENA = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
    Version="4.0" Serie="A" Folio="123" Fecha="2026-03-14T12:30:00"
    FormaPago="03" MetodoPago="PUE" TipoDeComprobante="I" Moneda="MXN"
    SubTotal="1000.00" Total="1160.00" LugarExpedicion="64000"
    Exportacion="01" NoCertificado="00001000000504465028" Sello="c2VsbG8=" Certificado="Y2VydA==">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="PROVEEDOR DEMO SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="KPS950101AB1" Nombre="KPS SA DE CV" DomicilioFiscalReceptor="64000"
      RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="31161500" NoIdentificacion="TORN-001" Cantidad="100"
        ClaveUnidad="H87" Unidad="Pieza" Descripcion="Tornillo hexagonal 3/8"
        ValorUnitario="10.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados>
        <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa"
            TasaOCuota="0.160000" Importe="160.00"/>
      </cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados>
    <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa"
        TasaOCuota="0.160000" Importe="160.00"/>
  </cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>${TIMBRE}</cfdi:Complemento>
</cfdi:Comprobante>`

/** Aplica una manipulacion al XML bueno y devuelve las reglas que saltaron. */
function reglasTras(sustituir: (xml: string) => string): string[] {
  const xml = sustituir(BUENA)
  expect(xml, 'la manipulacion no cambio nada').not.toBe(BUENA)
  return revisarEstructura(parseCfdi(Buffer.from(xml))).map((p) => p.regla)
}

describe('revisarEstructura — un CFDI correcto', () => {
  it('no encuentra nada que objetar', () => {
    expect(revisarEstructura(parseCfdi(Buffer.from(BUENA)))).toEqual([])
  })
})

describe('revisarEstructura — importes manipulados', () => {
  it('caza un renglon cuyo importe no es cantidad x precio', () => {
    // El fraude tipico: se cambia el importe y se olvida cuadrar el unitario.
    expect(
      reglasTras((x) => x.replace('Importe="1000.00" ObjetoImp', 'Importe="9000.00" ObjetoImp')),
    ).toContain('ESTRUCTURA_CONCEPTO_IMPORTE')
  })

  it('caza la suma de conceptos que no da el subtotal', () => {
    expect(reglasTras((x) => x.replace('SubTotal="1000.00"', 'SubTotal="9000.00"'))).toContain(
      'ESTRUCTURA_SUBTOTAL',
    )
  })

  it('rechaza un descuento mayor que el subtotal', () => {
    expect(
      reglasTras((x) => x.replace('SubTotal="1000.00"', 'SubTotal="1000.00" Descuento="5000.00"')),
    ).toContain('ESTRUCTURA_DESCUENTO')
  })

  it('tolera el redondeo del emisor de hasta un peso', () => {
    // 100 x 10.00 declarado como 1000.40: es redondeo, no manipulacion. Exigir
    // el centavo exacto rechazaria facturas que el PAC ya dio por buenas.
    expect(
      reglasTras((x) => x.replace('Importe="1000.00" ObjetoImp', 'Importe="1000.40" ObjetoImp')),
    ).not.toContain('ESTRUCTURA_CONCEPTO_IMPORTE')
  })
})

describe('revisarEstructura — impuestos', () => {
  it('rechaza una tasa de IVA que no existe en Mexico', () => {
    expect(reglasTras((x) => x.replace('TasaOCuota="0.160000"', 'TasaOCuota="0.180000"'))).toContain(
      'ESTRUCTURA_TASA_IVA',
    )
  })

  it('acepta el 8% de la franja fronteriza', () => {
    expect(
      reglasTras((x) => x.replaceAll('TasaOCuota="0.160000"', 'TasaOCuota="0.080000"')),
    ).not.toContain('ESTRUCTURA_TASA_IVA')
  })

  it('rechaza un concepto que dice no ser objeto de impuesto pero desglosa impuestos', () => {
    expect(reglasTras((x) => x.replace('ObjetoImp="02"', 'ObjetoImp="01"'))).toContain(
      'ESTRUCTURA_CONCEPTO_OBJETO_IMP',
    )
  })
})

describe('revisarEstructura — reglas cruzadas de CFDI 4.0', () => {
  it('exige TipoCambio cuando la moneda no es el peso', () => {
    // Sin el, la factura no se puede convertir a pesos ni registrar en B1.
    expect(reglasTras((x) => x.replace('Moneda="MXN"', 'Moneda="USD"'))).toContain(
      'ESTRUCTURA_TIPO_CAMBIO',
    )
  })

  it('rechaza un TipoCambio distinto de 1 en una factura en pesos', () => {
    expect(
      reglasTras((x) => x.replace('Moneda="MXN"', 'Moneda="MXN" TipoCambio="18.00"')),
    ).toContain('ESTRUCTURA_TIPO_CAMBIO')
  })

  it('detecta la falta de Exportacion, que delata un CFDI 3.3 disfrazado', () => {
    expect(reglasTras((x) => x.replace(' Exportacion="01"', ''))).toContain('ESTRUCTURA_EXPORTACION')
  })

  it('exige MetodoPago, que es lo que decide si habra complemento de pago', () => {
    expect(reglasTras((x) => x.replace(' MetodoPago="PUE"', ''))).toContain(
      'ESTRUCTURA_METODO_PAGO',
    )
  })

  it('rechaza un codigo postal del receptor que no tiene cinco digitos', () => {
    expect(
      reglasTras((x) =>
        x.replace('DomicilioFiscalReceptor="64000"', 'DomicilioFiscalReceptor="6400"'),
      ),
    ).toContain('ESTRUCTURA_DOMICILIO_RECEPTOR')
  })

  it('rechaza un folio fiscal que no tiene forma de UUID', () => {
    expect(
      reglasTras((x) =>
        x.replace(
          'UUID="a1b2c3d4-1111-2222-3333-444455556666"',
          'UUID="1013P006-A311-4B00-9C13-000000000311"',
        ),
      ),
    ).toContain('ESTRUCTURA_UUID')
  })

  it('avisa de un UsoCFDI que no esta en el catalogo', () => {
    expect(reglasTras((x) => x.replace('UsoCFDI="G03"', 'UsoCFDI="ZZ9"'))).toContain(
      'ESTRUCTURA_USO_CFDI',
    )
  })
})

describe('revisarEstructura — complemento de pago', () => {
  const PAGO = BUENA.replace('TipoDeComprobante="I"', 'TipoDeComprobante="P"')
  const reglas = () => revisarEstructura(parseCfdi(Buffer.from(PAGO))).map((p) => p.regla)

  it('exige moneda XXX e importes en cero', () => {
    expect(reglas()).toContain('ESTRUCTURA_PAGO_MONEDA')
    expect(reglas()).toContain('ESTRUCTURA_PAGO_IMPORTES')
  })

  it('exige el nodo Pago del complemento', () => {
    expect(reglas()).toContain('ESTRUCTURA_PAGO_SIN_NODO')
  })
})
