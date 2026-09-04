import { Decimal, round2, sum } from '../money'
import { RFC_PATTERN } from '../config'
import { TIPO_PAGO, type ParsedCfdi } from './types'

/**
 * Las reglas del Anexo 20 que hacen que un PAC rechace un comprobante.
 *
 * POR QUE EN CODIGO Y NO CONTRA EL XSD. Validar con el esquema exige los .xsd
 * del SAT en disco y una libreria nativa, y aun asi el XSD solo comprueba
 * FORMAS: que `Moneda` tenga tres letras, que `Total` sea un decimal. Lo que de
 * verdad tumba comprobantes son las reglas CRUZADAS —"si la moneda no es MXN,
 * TipoCambio es obligatorio"— y esas viven en la Guia de llenado, no en el
 * esquema. Aqui estan las cruzadas y, de paso, los catalogos.
 *
 * QUE NO ESTA AQUI. Nada que dependa de la red: el estado del comprobante lo
 * contesta el SAT (`sat.ts`) y el titular del sello lo prueba el certificado
 * (`certificado.ts`). Este modulo es una funcion pura y se prueba sin nada.
 *
 * SEVERIDADES. Bloquea lo que hace el comprobante inutilizable para KPS —una
 * moneda extranjera sin tipo de cambio no se puede registrar en Business One— y
 * avisa de lo que es raro pero registrable. Bloquear de mas devuelve al
 * proveedor una factura que su PAC ya dio por buena, y esa es una discusion que
 * el portal no puede ganar.
 */

export interface ProblemaEstructura {
  /** Nombre de regla, ya con el prefijo. Ej: `ESTRUCTURA_TIPO_CAMBIO`. */
  readonly regla: string
  readonly severidad: 'BLOQUEANTE' | 'ADVERTENCIA'
  readonly detalle: string
}

// --- Catalogos del SAT (Anexo 20, CFDI 4.0) --------------------------------

/** c_FormaPago. */
const FORMAS_PAGO = new Set([
  '01', '02', '03', '04', '05', '06', '08', '12', '13', '14', '15', '17',
  '23', '24', '25', '26', '27', '28', '29', '30', '31', '99',
])

/** c_MetodoPago. */
const METODOS_PAGO = new Set(['PUE', 'PPD'])

/** c_UsoCFDI, version 4.0. */
const USOS_CFDI = new Set([
  'G01', 'G02', 'G03',
  'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08',
  'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10',
  'S01', 'CP01', 'CN01',
])

/** c_RegimenFiscal. */
const REGIMENES = new Set([
  '601', '603', '605', '606', '607', '608', '610', '611', '612', '614', '615',
  '616', '620', '621', '622', '623', '624', '625', '626', '628', '629', '630',
])

/** c_Exportacion, obligatorio desde 4.0. */
const EXPORTACIONES = new Set(['01', '02', '03', '04'])

/** c_ObjetoImp. */
const OBJETOS_IMP = new Set(['01', '02', '03', '04', '05', '06', '07'])

/** c_Impuesto: 001 ISR, 002 IVA, 003 IEPS. */
const IMPUESTOS = new Set(['001', '002', '003'])

const TIPOS_FACTOR = new Set(['Tasa', 'Cuota', 'Exento'])

/** Tasas de IVA que existen en Mexico. La franja fronteriza usa el 8%. */
const TASAS_IVA = ['0', '0.08', '0.16']

const CP_PATTERN = /^\d{5}$/

/**
 * Margen de redondeo por renglon.
 *
 * El SAT tolera hasta un peso de diferencia entre `Cantidad * ValorUnitario` y
 * el `Importe` declarado, porque el emisor redondea cada renglon a dos
 * decimales. Exigir el centavo exacto rechazaria facturas perfectamente
 * validas: 1,603 piezas con seis decimales en el precio unitario nunca dan un
 * importe redondo.
 */
const MARGEN_RENGLON = new Decimal('1')

/** Margen para la suma de conceptos contra el subtotal declarado. */
const MARGEN_DOCUMENTO = new Decimal('1')

export function revisarEstructura(cfdi: ParsedCfdi): ProblemaEstructura[] {
  const problemas: ProblemaEstructura[] = []
  const bloqueo = (regla: string, detalle: string) => {
    problemas.push({ regla, severidad: 'BLOQUEANTE', detalle })
  }
  const aviso = (regla: string, detalle: string) => {
    problemas.push({ regla, severidad: 'ADVERTENCIA', detalle })
  }

  // --- Identificadores y patrones ----------------------------------------
  // El UUID no se comprueba aqui: lo hace `parseCfdi`, que revienta con
  // UUID_INVALIDO antes de construir el ParsedCfdi. Repetirlo seria codigo
  // muerto, y ademas peor colocado: estas reglas se apagan con
  // CFDI_VERIFICAR_ESTRUCTURA y la identidad del documento no puede depender de
  // una bandera.
  if (!RFC_PATTERN.test(cfdi.emisor.rfc.toUpperCase())) {
    bloqueo('ESTRUCTURA_RFC_EMISOR', `"${cfdi.emisor.rfc}" no tiene formato de RFC.`)
  }
  if (!RFC_PATTERN.test(cfdi.receptor.rfc.toUpperCase())) {
    bloqueo('ESTRUCTURA_RFC_RECEPTOR', `"${cfdi.receptor.rfc}" no tiene formato de RFC.`)
  }

  if (!CP_PATTERN.test(cfdi.lugarExpedicion)) {
    bloqueo(
      'ESTRUCTURA_LUGAR_EXPEDICION',
      `LugarExpedicion debe ser el codigo postal de cinco digitos del emisor, y trae "${cfdi.lugarExpedicion}".`,
    )
  }
  if (!CP_PATTERN.test(cfdi.receptor.domicilioFiscal)) {
    bloqueo(
      'ESTRUCTURA_DOMICILIO_RECEPTOR',
      `DomicilioFiscalReceptor debe ser el codigo postal de cinco digitos de KPS, y trae "${cfdi.receptor.domicilioFiscal}". Desde CFDI 4.0 el SAT comprueba que coincida con el que tiene registrado: si no cuadra, el PAC no timbra.`,
    )
  }

  // --- Catalogos ----------------------------------------------------------
  if (!REGIMENES.has(cfdi.emisor.regimenFiscal)) {
    aviso(
      'ESTRUCTURA_REGIMEN_EMISOR',
      `El regimen fiscal del emisor "${cfdi.emisor.regimenFiscal}" no esta en el catalogo c_RegimenFiscal.`,
    )
  }
  if (!REGIMENES.has(cfdi.receptor.regimenFiscal)) {
    aviso(
      'ESTRUCTURA_REGIMEN_RECEPTOR',
      `El regimen fiscal del receptor "${cfdi.receptor.regimenFiscal}" no esta en el catalogo c_RegimenFiscal.`,
    )
  }
  if (!USOS_CFDI.has(cfdi.receptor.usoCFDI)) {
    aviso(
      'ESTRUCTURA_USO_CFDI',
      `El uso "${cfdi.receptor.usoCFDI}" no esta en el catalogo c_UsoCFDI de la version 4.0.`,
    )
  }
  if (cfdi.formaPago && !FORMAS_PAGO.has(cfdi.formaPago)) {
    aviso(
      'ESTRUCTURA_FORMA_PAGO',
      `La forma de pago "${cfdi.formaPago}" no esta en el catalogo c_FormaPago.`,
    )
  }
  if (cfdi.metodoPago && !METODOS_PAGO.has(cfdi.metodoPago)) {
    bloqueo(
      'ESTRUCTURA_METODO_PAGO',
      `El metodo de pago solo puede ser PUE o PPD, y trae "${cfdi.metodoPago}".`,
    )
  }

  // `Exportacion` es obligatorio desde 4.0: su ausencia delata un XML armado a
  // mano o copiado de un CFDI 3.3.
  if (!cfdi.exportacion) {
    bloqueo(
      'ESTRUCTURA_EXPORTACION',
      'Falta el atributo Exportacion, que es obligatorio en CFDI 4.0. Para una venta nacional vale "01".',
    )
  } else if (!EXPORTACIONES.has(cfdi.exportacion)) {
    aviso(
      'ESTRUCTURA_EXPORTACION',
      `El valor de Exportacion "${cfdi.exportacion}" no esta en el catalogo c_Exportacion.`,
    )
  }

  // --- Moneda y tipo de cambio -------------------------------------------
  if (!/^[A-Z]{3}$/.test(cfdi.moneda)) {
    bloqueo(
      'ESTRUCTURA_MONEDA',
      `La moneda "${cfdi.moneda}" no es un codigo ISO-4217 de tres letras.`,
    )
  } else if (cfdi.moneda === 'MXN') {
    // Con pesos el tipo de cambio sobra; si viene, tiene que valer 1.
    if (cfdi.tipoCambio && !cfdi.tipoCambio.equals(1)) {
      bloqueo(
        'ESTRUCTURA_TIPO_CAMBIO',
        `La factura esta en pesos pero declara un tipo de cambio de ${cfdi.tipoCambio.toString()}. En MXN solo se admite 1, o no ponerlo.`,
      )
    }
  } else if (cfdi.moneda !== 'XXX') {
    // Sin tipo de cambio no hay forma de registrar la factura en pesos, y
    // Business One la rechazaria o —peor— la tomaria a la paridad del dia.
    if (!cfdi.tipoCambio || cfdi.tipoCambio.lessThanOrEqualTo(0)) {
      bloqueo(
        'ESTRUCTURA_TIPO_CAMBIO',
        `La factura esta en ${cfdi.moneda} y no trae TipoCambio. Sin el no se puede convertir a pesos ni registrar en Business One.`,
      )
    }
  }

  // --- Reglas propias del comprobante de pago (tipo P) --------------------
  if (cfdi.tipoDeComprobante === TIPO_PAGO) {
    if (cfdi.moneda !== 'XXX') {
      bloqueo(
        'ESTRUCTURA_PAGO_MONEDA',
        `Un complemento de pago lleva Moneda="XXX" y este trae "${cfdi.moneda}". El importe real va en el nodo Pago, no en el comprobante.`,
      )
    }
    if (!cfdi.total.isZero() || !cfdi.subTotal.isZero()) {
      bloqueo(
        'ESTRUCTURA_PAGO_IMPORTES',
        'Un complemento de pago va con SubTotal y Total en cero: no cobra nada, solo informa de un cobro que ya ocurrio.',
      )
    }
    if (cfdi.pagos.length === 0) {
      bloqueo(
        'ESTRUCTURA_PAGO_SIN_NODO',
        'El comprobante dice ser de tipo P pero no trae ningun nodo Pago del complemento de pagos.',
      )
    }
    // Los importes de un tipo P no se cotejan contra conceptos: el resto de las
    // comprobaciones de abajo no aplica.
    return problemas
  }

  // --- Metodo y forma de pago en una factura ------------------------------
  if (!cfdi.metodoPago) {
    bloqueo(
      'ESTRUCTURA_METODO_PAGO',
      'Falta MetodoPago. Es obligatorio en una factura, y es lo que decide si habra complemento de pago: PUE se cobro al emitirla, PPD se cobra despues.',
    )
  }
  if (!cfdi.formaPago) {
    bloqueo('ESTRUCTURA_FORMA_PAGO', 'Falta FormaPago. Es obligatorio en una factura de ingreso.')
  }

  if (cfdi.total.lessThanOrEqualTo(0)) {
    bloqueo(
      'ESTRUCTURA_TOTAL',
      `El total de la factura es ${cfdi.total.toFixed(2)}. Una factura de ingreso cobra algo.`,
    )
  }

  if (cfdi.descuento.greaterThan(cfdi.subTotal)) {
    bloqueo(
      'ESTRUCTURA_DESCUENTO',
      `El descuento (${cfdi.descuento.toFixed(2)}) es mayor que el subtotal (${cfdi.subTotal.toFixed(2)}).`,
    )
  }

  // --- Conceptos ----------------------------------------------------------
  for (const c of cfdi.conceptos) {
    const donde = `Linea ${c.lineNumber} ("${c.descripcion}")`

    if (c.cantidad.lessThanOrEqualTo(0)) {
      bloqueo(
        'ESTRUCTURA_CONCEPTO_CANTIDAD',
        `${donde}: la cantidad es ${c.cantidad.toString()}. Un concepto factura una cantidad positiva.`,
      )
    }

    // Cantidad x ValorUnitario tiene que dar el Importe. Es la comprobacion que
    // atrapa el renglon manipulado: el que cambia el importe y se olvida de
    // cuadrar el precio unitario.
    const esperado = round2(c.cantidad.times(c.valorUnitario))
    if (esperado.minus(round2(c.importe)).abs().greaterThan(MARGEN_RENGLON)) {
      bloqueo(
        'ESTRUCTURA_CONCEPTO_IMPORTE',
        `${donde}: ${c.cantidad.toString()} x ${c.valorUnitario.toFixed(2)} da ${esperado.toFixed(2)}, pero el renglon declara ${c.importe.toFixed(2)}.`,
      )
    }

    if (c.objetoImp && !OBJETOS_IMP.has(c.objetoImp)) {
      aviso(
        'ESTRUCTURA_CONCEPTO_OBJETO_IMP',
        `${donde}: ObjetoImp "${c.objetoImp}" no esta en el catalogo c_ObjetoImp.`,
      )
    }

    // `02` significa "si es objeto de impuesto": el SAT exige entonces el nodo
    // de impuestos. Al reves, un `01` con impuestos tambien es contradictorio.
    const tieneImpuestos = c.traslados.length > 0 || c.retenciones.length > 0
    if (c.objetoImp === '02' && !tieneImpuestos) {
      bloqueo(
        'ESTRUCTURA_CONCEPTO_OBJETO_IMP',
        `${donde}: dice ser objeto de impuesto (ObjetoImp 02) pero no trae ningun impuesto desglosado.`,
      )
    }
    if (c.objetoImp === '01' && tieneImpuestos) {
      bloqueo(
        'ESTRUCTURA_CONCEPTO_OBJETO_IMP',
        `${donde}: dice NO ser objeto de impuesto (ObjetoImp 01) pero desglosa impuestos.`,
      )
    }

    for (const t of [...c.traslados, ...c.retenciones]) {
      if (!IMPUESTOS.has(t.impuesto)) {
        aviso(
          'ESTRUCTURA_CONCEPTO_IMPUESTO',
          `${donde}: el impuesto "${t.impuesto}" no esta en el catalogo c_Impuesto (001 ISR, 002 IVA, 003 IEPS).`,
        )
      }
      if (!TIPOS_FACTOR.has(t.tipoFactor)) {
        aviso(
          'ESTRUCTURA_CONCEPTO_IMPUESTO',
          `${donde}: TipoFactor "${t.tipoFactor}" no es Tasa, Cuota ni Exento.`,
        )
      }
    }

    // El IVA trasladado solo puede ir a las tasas que existen en Mexico. Un 15%
    // o un 18% delatan un XML armado a mano, no una factura de un PAC.
    for (const t of c.traslados) {
      const tasa = t.tasaOCuota
      if (t.impuesto !== '002' || t.tipoFactor !== 'Tasa' || !tasa) continue
      if (!TASAS_IVA.some((v) => tasa.equals(v))) {
        bloqueo(
          'ESTRUCTURA_TASA_IVA',
          `${donde}: el IVA va al ${tasa.times(100).toFixed(2)}%. En Mexico el IVA trasladado solo puede ser 0%, 8% (franja fronteriza) o 16%.`,
        )
      }
    }
  }

  // Suma de conceptos contra el subtotal declarado. El total ya lo comprueba la
  // regla SUMA_IMPUESTOS; esto atrapa el caso distinto de un concepto anadido o
  // borrado despues de timbrar.
  const sumaConceptos = round2(sum(cfdi.conceptos.map((c) => c.importe)))
  if (sumaConceptos.minus(round2(cfdi.subTotal)).abs().greaterThan(MARGEN_DOCUMENTO)) {
    bloqueo(
      'ESTRUCTURA_SUBTOTAL',
      `Los conceptos suman ${sumaConceptos.toFixed(2)} y el comprobante declara un subtotal de ${cfdi.subTotal.toFixed(2)}.`,
    )
  }

  return problemas
}
