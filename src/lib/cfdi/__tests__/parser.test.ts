import { describe, it, expect } from 'vitest'
import { parseCfdi } from '../parser'
import { CfdiParseError } from '../types'

/**
 * Los CFDI de prueba son sinteticos: RFC de la lista de pruebas del SAT y
 * sellos recortados. Ningun dato real de KPS ni de sus proveedores.
 */

const TIMBRE = `<tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
    Version="1.1" UUID="a1b2c3d4-1111-2222-3333-444455556666"
    FechaTimbrado="2026-03-14T12:31:05" RfcProvCertifica="AAA010101AAA"
    SelloCFD="c2Vsb0NGRA==" NoCertificadoSAT="00001000000504465028" SelloSAT="c2Vsb1NBVA=="/>`

/** Factura de ingreso con dos conceptos e IVA 16%: 1000 + 500 = 1500, IVA 240, total 1740. */
const FACTURA_DOS_CONCEPTOS = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
    Version="4.0" Serie="A" Folio="123" Fecha="2026-03-14T12:30:00"
    FormaPago="03" MetodoPago="PUE" TipoDeComprobante="I" Moneda="MXN"
    SubTotal="1500.00" Total="1740.00" LugarExpedicion="64000"
    Exportacion="01" NoCertificado="00001000000504465028" Sello="c2VsbG8=" Certificado="Y2VydA==">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="PROVEEDOR DEMO SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="KPS950101AB1" Nombre="KPS SA DE CV" DomicilioFiscalReceptor="64000"
      RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="31161500" NoIdentificacion="TORN-001" Cantidad="100"
        ClaveUnidad="H87" Unidad="Pieza" Descripcion="Tornillo hexagonal 3/8"
        ValorUnitario="10.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="31161500" NoIdentificacion="TUER-002" Cantidad="50"
        ClaveUnidad="H87" Descripcion="Tuerca hexagonal 3/8"
        ValorUnitario="10.00" Importe="500.00" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="500.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="80.00"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="240.00">
    <cfdi:Traslados>
      <cfdi:Traslado Base="1500.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="240.00"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>${TIMBRE}</cfdi:Complemento>
</cfdi:Comprobante>`

/** Un solo concepto: el caso que fast-xml-parser NO entrega como arreglo. */
const FACTURA_UN_CONCEPTO = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
    Version="4.0" Fecha="2026-03-14T12:30:00" TipoDeComprobante="I" Moneda="MXN"
    SubTotal="100.00" Total="116.00" LugarExpedicion="64000" NoCertificado="00001000000504465028">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="PROVEEDOR DEMO" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="KPS950101AB1" Nombre="KPS SA DE CV" DomicilioFiscalReceptor="64000"
      RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="01010101" Cantidad="1" ClaveUnidad="E48"
        Descripcion="Servicio unico" ValorUnitario="100.00" Importe="100.00"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>${TIMBRE}</cfdi:Complemento>
</cfdi:Comprobante>`

/** Nota de credito (tipo E) que apunta a la factura que corrige. */
const NOTA_CREDITO = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
    Version="4.0" Fecha="2026-03-20T09:00:00" TipoDeComprobante="E" Moneda="MXN"
    SubTotal="100.00" Total="116.00" LugarExpedicion="64000" NoCertificado="00001000000504465028">
  <cfdi:CfdiRelacionados TipoRelacion="01">
    <cfdi:CfdiRelacionado UUID="a1b2c3d4-1111-2222-3333-444455556666"/>
  </cfdi:CfdiRelacionados>
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="PROVEEDOR DEMO" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="KPS950101AB1" Nombre="KPS SA DE CV" DomicilioFiscalReceptor="64000"
      RegimenFiscalReceptor="601" UsoCFDI="G02"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="31161500" Cantidad="10" ClaveUnidad="H87"
        Descripcion="Devolucion tornillo" ValorUnitario="10.00" Importe="100.00"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>${TIMBRE}</cfdi:Complemento>
</cfdi:Comprobante>`

/** Sin prefijo de namespace y con retenciones: el parser resuelve por nombre local. */
const FACTURA_SIN_PREFIJO_CON_RETENCION = `<?xml version="1.0" encoding="UTF-8"?>
<Comprobante xmlns="http://www.sat.gob.mx/cfd/4"
    Version="4.0" Fecha="2026-03-14T12:30:00" TipoDeComprobante="I" Moneda="MXN"
    SubTotal="1000.00" Total="1053.33" LugarExpedicion="64000" NoCertificado="00001000000504465028">
  <Emisor Rfc="aaa010101aaa" Nombre="HONORARIOS DEMO" RegimenFiscal="612"/>
  <Receptor Rfc="KPS950101AB1" Nombre="KPS SA DE CV" DomicilioFiscalReceptor="64000"
      RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <Conceptos>
    <Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="E48"
        Descripcion="Honorarios profesionales" ValorUnitario="1000.00" Importe="1000.00"/>
  </Conceptos>
  <Impuestos TotalImpuestosTrasladados="160.00" TotalImpuestosRetenidos="106.67">
    <Retenciones>
      <Retencion Base="1000.00" Impuesto="001" Importe="100.00"/>
      <Retencion Base="1000.00" Impuesto="002" Importe="6.67"/>
    </Retenciones>
    <Traslados>
      <Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
    </Traslados>
  </Impuestos>
  <Complemento>${TIMBRE}</Complemento>
</Comprobante>`

const SIN_TIMBRE = FACTURA_UN_CONCEPTO.replace(
  /<cfdi:Complemento>[\s\S]*<\/cfdi:Complemento>/,
  '',
)

// ---------------------------------------------------------------------------

describe('parseCfdi — extraccion feliz', () => {
  it('extrae los datos del comprobante sin capturar nada a mano', () => {
    const cfdi = parseCfdi(FACTURA_DOS_CONCEPTOS)

    expect(cfdi.version).toBe('4.0')
    expect(cfdi.tipoDeComprobante).toBe('I')
    expect(cfdi.serie).toBe('A')
    expect(cfdi.folio).toBe('123')
    expect(cfdi.moneda).toBe('MXN')
    expect(cfdi.formaPago).toBe('03')
    expect(cfdi.metodoPago).toBe('PUE')
    expect(cfdi.lugarExpedicion).toBe('64000')
    expect(cfdi.subTotal.toFixed(2)).toBe('1500.00')
    expect(cfdi.total.toFixed(2)).toBe('1740.00')
    expect(cfdi.descuento.toFixed(2)).toBe('0.00')
  })

  it('no desplaza el dia al interpretar la fecha sin zona horaria', () => {
    // El CFDI dice 2026-03-14T12:30:00 sin offset. Si se interpretara como hora
    // local del servidor, en un contenedor en UTC-6 el instante se correria.
    const cfdi = parseCfdi(FACTURA_DOS_CONCEPTOS)
    expect(cfdi.fecha.toISOString()).toBe('2026-03-14T12:30:00.000Z')
    expect(cfdi.timbre.fechaTimbrado.toISOString()).toBe('2026-03-14T12:31:05.000Z')
  })

  it('extrae emisor y receptor, normalizando el RFC a mayusculas', () => {
    const cfdi = parseCfdi(FACTURA_SIN_PREFIJO_CON_RETENCION)
    expect(cfdi.emisor.rfc).toBe('AAA010101AAA') // venia en minusculas
    expect(cfdi.emisor.regimenFiscal).toBe('612')
    expect(cfdi.receptor.rfc).toBe('KPS950101AB1')
    expect(cfdi.receptor.domicilioFiscal).toBe('64000')
    expect(cfdi.receptor.usoCFDI).toBe('G03')
  })

  it('extrae los conceptos con sus impuestos por linea', () => {
    const cfdi = parseCfdi(FACTURA_DOS_CONCEPTOS)
    expect(cfdi.conceptos).toHaveLength(2)

    const [primero, segundo] = cfdi.conceptos
    expect(primero.lineNumber).toBe(1)
    expect(primero.noIdentificacion).toBe('TORN-001')
    expect(primero.claveProdServ).toBe('31161500')
    expect(primero.claveUnidad).toBe('H87')
    expect(primero.cantidad.toFixed(0)).toBe('100')
    expect(primero.valorUnitario.toFixed(2)).toBe('10.00')
    expect(primero.importe.toFixed(2)).toBe('1000.00')
    expect(primero.totalTrasladados.toFixed(2)).toBe('160.00')

    expect(segundo.lineNumber).toBe(2)
    expect(segundo.noIdentificacion).toBe('TUER-002')
    expect(segundo.totalTrasladados.toFixed(2)).toBe('80.00')
  })

  it('deja en undefined los atributos opcionales ausentes, no en cadena vacia', () => {
    // El motor de cotejo distingue "no lo declaro" de "lo declaro vacio": sin
    // NoIdentificacion tiene que emparejar la linea por descripcion, no contra ''.
    const [unico] = parseCfdi(FACTURA_UN_CONCEPTO).conceptos
    expect(unico.noIdentificacion).toBeUndefined()
    expect(unico.unidad).toBeUndefined()
    expect(unico.objetoImp).toBeUndefined()
  })

  it('normaliza a arreglo el concepto unico que fast-xml-parser entrega como objeto', () => {
    const cfdi = parseCfdi(FACTURA_UN_CONCEPTO)
    expect(Array.isArray(cfdi.conceptos)).toBe(true)
    expect(cfdi.conceptos).toHaveLength(1)
    expect(cfdi.conceptos[0].descripcion).toBe('Servicio unico')
  })

  it('suma trasladados y retenidos, y prefiere los totales declarados por el emisor', () => {
    const cfdi = parseCfdi(FACTURA_SIN_PREFIJO_CON_RETENCION)
    expect(cfdi.impuestos.totalTrasladados.toFixed(2)).toBe('160.00')
    expect(cfdi.impuestos.totalRetenidos.toFixed(2)).toBe('106.67')
    expect(cfdi.impuestos.retenciones).toHaveLength(2)
  })

  it('resuelve por nombre local: funciona sin prefijo de namespace', () => {
    const cfdi = parseCfdi(FACTURA_SIN_PREFIJO_CON_RETENCION)
    expect(cfdi.emisor.nombre).toBe('HONORARIOS DEMO')
    expect(cfdi.timbre.uuid).toBe('A1B2C3D4-1111-2222-3333-444455556666')
  })

  it('extrae el timbre con el UUID normalizado a mayusculas', () => {
    const cfdi = parseCfdi(FACTURA_DOS_CONCEPTOS)
    expect(cfdi.timbre.uuid).toBe('A1B2C3D4-1111-2222-3333-444455556666')
    expect(cfdi.timbre.noCertificadoSAT).toBe('00001000000504465028')
    expect(cfdi.timbre.selloSAT).toBe('c2Vsb1NBVA==')
  })

  it('acepta una nota de credito y conserva el UUID de la factura que corrige', () => {
    const cfdi = parseCfdi(NOTA_CREDITO)
    expect(cfdi.tipoDeComprobante).toBe('E')
    expect(cfdi.cfdiRelacionados).toHaveLength(1)
    expect(cfdi.cfdiRelacionados[0].tipoRelacion).toBe('01')
    expect(cfdi.cfdiRelacionados[0].uuids).toEqual(['A1B2C3D4-1111-2222-3333-444455556666'])
  })

  it('acepta el XML como Buffer, que es como llega del object store', () => {
    const cfdi = parseCfdi(Buffer.from(FACTURA_UN_CONCEPTO, 'utf8'))
    expect(cfdi.total.toFixed(2)).toBe('116.00')
  })
})

describe('parseCfdi — rechazos inmediatos de §12.1', () => {
  const casos: Array<[string, string, string]> = [
    ['XML mal formado', '<cfdi:Comprobante Version="4.0"', 'XML_MAL_FORMADO'],
    ['archivo vacio', '   ', 'XML_MAL_FORMADO'],
    ['no es un CFDI', '<?xml version="1.0"?><factura><total>100</total></factura>', 'NO_ES_CFDI'],
  ]

  for (const [nombre, xml, code] of casos) {
    it(`rechaza ${nombre} con ${code}`, () => {
      try {
        parseCfdi(xml)
        expect.unreachable('debio lanzar CfdiParseError')
      } catch (error) {
        expect(error).toBeInstanceOf(CfdiParseError)
        expect((error as CfdiParseError).code).toBe(code)
      }
    })
  }

  const rechazo = (xml: string, code: string) => {
    try {
      parseCfdi(xml)
      expect.unreachable('debio lanzar CfdiParseError')
    } catch (error) {
      expect(error).toBeInstanceOf(CfdiParseError)
      expect((error as CfdiParseError).code).toBe(code)
    }
  }

  it('rechaza CFDI 3.3 con VERSION_NO_SOPORTADA', () => {
    rechazo(FACTURA_UN_CONCEPTO.replace('Version="4.0"', 'Version="3.3"'), 'VERSION_NO_SOPORTADA')
  })

  it('rechaza un XML sin timbrar con SIN_TIMBRE', () => {
    rechazo(SIN_TIMBRE, 'SIN_TIMBRE')
  })

  /**
   * El folio fiscal lleva el indice unico de `invoices.uuid` y es la llave con
   * la que un complemento de pago encuentra su factura. Un UUID con basura
   * entraria a las dos cosas, asi que se rechaza al leer y no como regla de
   * estructura, que es opcional.
   */
  it('rechaza un folio fiscal que no tiene forma de UUID', () => {
    rechazo(
      // La P no es hexadecimal: el timbre no lo pudo emitir un PAC.
      FACTURA_UN_CONCEPTO.replace(
        'UUID="a1b2c3d4-1111-2222-3333-444455556666"',
        'UUID="1013P006-A311-4B00-9C13-000000000311"',
      ),
      'UUID_INVALIDO',
    )
  })

  it('rechaza un folio fiscal al que le faltan digitos', () => {
    rechazo(
      FACTURA_UN_CONCEPTO.replace(
        'UUID="a1b2c3d4-1111-2222-3333-444455556666"',
        'UUID="a1b2c3d4-1111-2222-3333-4444555566"',
      ),
      'UUID_INVALIDO',
    )
  })

  it('rechaza tipos de comprobante que no son factura ni nota de credito', () => {
    rechazo(
      FACTURA_UN_CONCEPTO.replace('TipoDeComprobante="I"', 'TipoDeComprobante="T"'),
      'TIPO_COMPROBANTE_INVALIDO',
    )
  })

  it('rechaza un comprobante sin conceptos', () => {
    rechazo(
      FACTURA_UN_CONCEPTO.replace(
        /<cfdi:Conceptos>[\s\S]*?<\/cfdi:Conceptos>/,
        '<cfdi:Conceptos></cfdi:Conceptos>',
      ),
      'SIN_CONCEPTOS',
    )
  })

  it('rechaza un campo obligatorio ausente, diciendo cual', () => {
    try {
      parseCfdi(FACTURA_UN_CONCEPTO.replace(' Total="116.00"', ''))
      expect.unreachable('debio lanzar')
    } catch (error) {
      expect(error).toBeInstanceOf(CfdiParseError)
      const e = error as CfdiParseError
      expect(e.code).toBe('CAMPO_OBLIGATORIO_AUSENTE')
      expect(e.message).toContain('Total')
    }
  })

  it('rechaza un importe ilegible en vez de tomarlo como cero', () => {
    rechazo(
      FACTURA_UN_CONCEPTO.replace('Total="116.00"', 'Total="ciento dieciseis"'),
      'IMPORTE_ILEGIBLE',
    )
  })

  it('rechaza una fecha ilegible', () => {
    rechazo(
      FACTURA_UN_CONCEPTO.replace('Fecha="2026-03-14T12:30:00"', 'Fecha="14/03/2026"'),
      'FECHA_ILEGIBLE',
    )
  })

  it('detecta un 3.3 disfrazado de 4.0 por los campos que 3.3 no tenia', () => {
    // RegimenFiscalReceptor y DomicilioFiscalReceptor son obligatorios solo en 4.0.
    rechazo(
      FACTURA_UN_CONCEPTO.replace(' RegimenFiscalReceptor="601"', ''),
      'CAMPO_OBLIGATORIO_AUSENTE',
    )
  })
})
