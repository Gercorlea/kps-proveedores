import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { Decimal, money, moneyOrZero } from '../money'
import {
  CfdiParseError,
  type CfdiConcepto,
  type CfdiEmisor,
  type CfdiImpuestoLinea,
  type CfdiImpuestos,
  type CfdiReceptor,
  type CfdiPago,
  type CfdiRelacionado,
  type CfdiTimbre,
  type ParsedCfdi,
  type TipoDeComprobante,
} from './types'

/**
 * Extractor de CFDI 4.0 (§12.1 del spec).
 *
 * §04 principio 5: "cero captura manual de datos fiscales". Todo lo que el
 * portal sabe de una factura sale de aqui.
 *
 * Nota sobre namespaces: el prefijo NO es fijo. La mayoria de los PAC emiten
 * `cfdi:Comprobante` y `tfd:TimbreFiscalDigital`, pero el prefijo lo elige el
 * emisor y hay CFDI validos sin prefijo o con uno propio. Por eso todo el
 * parser resuelve por NOMBRE LOCAL, nunca por el prefijo literal.
 */

// ---------------------------------------------------------------------------
// Utilidades de navegacion por nombre local
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>

/** Nombre local de una etiqueta: `cfdi:Conceptos` -> `Conceptos`. */
function localName(key: string): string {
  const colon = key.indexOf(':')
  return colon === -1 ? key : key.slice(colon + 1)
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Primer hijo cuyo nombre local coincida, ignorando el prefijo de namespace. */
function child(node: unknown, name: string): unknown {
  if (!isNode(node)) return undefined
  for (const key of Object.keys(node)) {
    if (localName(key) === name) return node[key]
  }
  return undefined
}

/**
 * fast-xml-parser colapsa un unico elemento repetido en un objeto en vez de un
 * arreglo. Una factura de un solo concepto llegaria como objeto y romperia
 * cualquier `.map()`. Aqui se normaliza siempre a arreglo.
 */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** Atributo como cadena limpia. Devuelve undefined si esta ausente o vacio. */
function attr(node: unknown, name: string): string | undefined {
  if (!isNode(node)) return undefined
  const raw = node[name]
  if (raw === undefined || raw === null) return undefined
  const text = String(raw).trim()
  return text === '' ? undefined : text
}

function requiredAttr(node: unknown, name: string, context: string): string {
  const value = attr(node, name)
  if (value === undefined) {
    throw new CfdiParseError(
      'CAMPO_OBLIGATORIO_AUSENTE',
      `El CFDI no trae el atributo obligatorio ${name} en ${context}.`,
      { attribute: name, context },
    )
  }
  return value
}

function decimalAttr(node: unknown, name: string, context: string): Decimal | undefined {
  const raw = attr(node, name)
  if (raw === undefined) return undefined
  try {
    return money(raw)
  } catch {
    throw new CfdiParseError(
      'IMPORTE_ILEGIBLE',
      `El importe ${name} de ${context} no es un numero valido: "${raw}".`,
      { attribute: name, context, raw },
    )
  }
}

function requiredDecimalAttr(node: unknown, name: string, context: string): Decimal {
  const value = decimalAttr(node, name, context)
  if (value === undefined) {
    throw new CfdiParseError(
      'CAMPO_OBLIGATORIO_AUSENTE',
      `El CFDI no trae el importe obligatorio ${name} en ${context}.`,
      { attribute: name, context },
    )
  }
  return value
}

/**
 * Las fechas del CFDI son ISO 8601 SIN zona horaria: `2026-03-14T12:30:00`.
 * `new Date(...)` las interpreta como hora local del servidor, lo que en un
 * contenedor en UTC-6 mueve una factura de las 00:30 al dia anterior — y con
 * ella el ejercicio contable. Se construye la fecha en UTC a mano.
 */
function parseCfdiDate(raw: string, context: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(raw.trim())
  if (!match) {
    throw new CfdiParseError('FECHA_ILEGIBLE', `La fecha de ${context} no es valida: "${raw}".`, {
      context,
      raw,
    })
  }
  const [, y, mo, d, h, mi, s] = match
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  )
  if (Number.isNaN(date.getTime())) {
    throw new CfdiParseError('FECHA_ILEGIBLE', `La fecha de ${context} no es valida: "${raw}".`, {
      context,
      raw,
    })
  }
  return date
}

function requiredDateAttr(node: unknown, name: string, context: string): Date {
  return parseCfdiDate(requiredAttr(node, name, context), `${context}/${name}`)
}

/** El RFC se normaliza a mayusculas y sin espacios antes de cualquier comparacion. */
function normalizeRfc(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

// ---------------------------------------------------------------------------
// Impuestos
// ---------------------------------------------------------------------------

function parseImpuestoLinea(node: unknown, context: string): CfdiImpuestoLinea {
  return {
    base: decimalAttr(node, 'Base', context) ?? new Decimal(0),
    impuesto: requiredAttr(node, 'Impuesto', context),
    tipoFactor: attr(node, 'TipoFactor') ?? 'Tasa',
    tasaOCuota: decimalAttr(node, 'TasaOCuota', context),
    // Un traslado con TipoFactor "Exento" no lleva Importe: vale cero.
    importe: decimalAttr(node, 'Importe', context) ?? new Decimal(0),
  }
}

/**
 * Lee un bloque de impuestos (`Traslados`/`Retenciones`) que puede colgar del
 * comprobante o de un concepto. La estructura es
 * `Impuestos > Traslados > Traslado[]`, con los mismos nombres en ambos niveles.
 */
function parseImpuestosBloque(
  impuestosNode: unknown,
  context: string,
): { traslados: CfdiImpuestoLinea[]; retenciones: CfdiImpuestoLinea[] } {
  const traslados = asArray(child(child(impuestosNode, 'Traslados'), 'Traslado')).map((t) =>
    parseImpuestoLinea(t, `${context}/Traslado`),
  )
  const retenciones = asArray(child(child(impuestosNode, 'Retenciones'), 'Retencion')).map((r) =>
    parseImpuestoLinea(r, `${context}/Retencion`),
  )
  return { traslados, retenciones }
}

function sumImportes(lineas: readonly CfdiImpuestoLinea[]): Decimal {
  return lineas.reduce<Decimal>((acc, l) => acc.plus(l.importe), new Decimal(0))
}

// ---------------------------------------------------------------------------
// Secciones del comprobante
// ---------------------------------------------------------------------------

function parseEmisor(comprobante: unknown): CfdiEmisor {
  const node = child(comprobante, 'Emisor')
  if (node === undefined) {
    throw new CfdiParseError('CAMPO_OBLIGATORIO_AUSENTE', 'El CFDI no trae nodo Emisor.')
  }
  return {
    rfc: normalizeRfc(requiredAttr(node, 'Rfc', 'Emisor')),
    nombre: requiredAttr(node, 'Nombre', 'Emisor'),
    regimenFiscal: requiredAttr(node, 'RegimenFiscal', 'Emisor'),
  }
}

function parseReceptor(comprobante: unknown): CfdiReceptor {
  const node = child(comprobante, 'Receptor')
  if (node === undefined) {
    throw new CfdiParseError('CAMPO_OBLIGATORIO_AUSENTE', 'El CFDI no trae nodo Receptor.')
  }
  return {
    rfc: normalizeRfc(requiredAttr(node, 'Rfc', 'Receptor')),
    nombre: requiredAttr(node, 'Nombre', 'Receptor'),
    // DomicilioFiscalReceptor y RegimenFiscalReceptor son obligatorios en 4.0
    // y no existian en 3.3: son la forma mas rapida de detectar un 3.3 disfrazado.
    domicilioFiscal: requiredAttr(node, 'DomicilioFiscalReceptor', 'Receptor'),
    regimenFiscal: requiredAttr(node, 'RegimenFiscalReceptor', 'Receptor'),
    usoCFDI: requiredAttr(node, 'UsoCFDI', 'Receptor'),
  }
}

function parseConceptos(comprobante: unknown): CfdiConcepto[] {
  const nodes = asArray(child(child(comprobante, 'Conceptos'), 'Concepto'))
  if (nodes.length === 0) {
    throw new CfdiParseError('SIN_CONCEPTOS', 'El CFDI no trae ningun concepto.')
  }

  return nodes.map((node, index) => {
    const context = `Concepto[${index + 1}]`
    const { traslados, retenciones } = parseImpuestosBloque(child(node, 'Impuestos'), context)

    return {
      lineNumber: index + 1,
      claveProdServ: requiredAttr(node, 'ClaveProdServ', context),
      claveUnidad: requiredAttr(node, 'ClaveUnidad', context),
      unidad: attr(node, 'Unidad'),
      noIdentificacion: attr(node, 'NoIdentificacion'),
      descripcion: requiredAttr(node, 'Descripcion', context),
      cantidad: requiredDecimalAttr(node, 'Cantidad', context),
      valorUnitario: requiredDecimalAttr(node, 'ValorUnitario', context),
      importe: requiredDecimalAttr(node, 'Importe', context),
      descuento: decimalAttr(node, 'Descuento', context) ?? new Decimal(0),
      objetoImp: attr(node, 'ObjetoImp'),
      traslados,
      retenciones,
      totalTrasladados: sumImportes(traslados),
      totalRetenidos: sumImportes(retenciones),
    }
  })
}

function parseImpuestos(comprobante: unknown): CfdiImpuestos {
  const node = child(comprobante, 'Impuestos')
  const { traslados, retenciones } = parseImpuestosBloque(node, 'Impuestos')

  // Se prefieren los totales declarados por el emisor; si faltan, se suman las
  // lineas. La regla SUMA_IMPUESTOS de §12.2 valida despues que cuadren con el
  // total: aqui solo se extrae, no se juzga.
  const declaradoTrasladados = decimalAttr(node, 'TotalImpuestosTrasladados', 'Impuestos')
  const declaradoRetenidos = decimalAttr(node, 'TotalImpuestosRetenidos', 'Impuestos')

  return {
    totalTrasladados: declaradoTrasladados ?? sumImportes(traslados),
    totalRetenidos: declaradoRetenidos ?? sumImportes(retenciones),
    traslados,
    retenciones,
  }
}

function parseTimbre(comprobante: unknown): CfdiTimbre {
  // El timbre vive en `Complemento > TimbreFiscalDigital`. Complemento puede
  // traer varios hijos (nomina, pagos, comercio exterior) y repetirse.
  for (const complemento of asArray(child(comprobante, 'Complemento'))) {
    const timbre = child(complemento, 'TimbreFiscalDigital')
    if (timbre !== undefined) {
      return {
        uuid: requiredAttr(timbre, 'UUID', 'TimbreFiscalDigital').toUpperCase(),
        fechaTimbrado: requiredDateAttr(timbre, 'FechaTimbrado', 'TimbreFiscalDigital'),
        noCertificadoSAT: requiredAttr(timbre, 'NoCertificadoSAT', 'TimbreFiscalDigital'),
        selloSAT: requiredAttr(timbre, 'SelloSAT', 'TimbreFiscalDigital'),
        selloCFD: requiredAttr(timbre, 'SelloCFD', 'TimbreFiscalDigital'),
        rfcProvCertifica: attr(timbre, 'RfcProvCertifica'),
        version: attr(timbre, 'Version') ?? '1.1',
      }
    }
  }

  throw new CfdiParseError(
    'SIN_TIMBRE',
    'El CFDI no esta timbrado: falta el complemento TimbreFiscalDigital.',
  )
}

/**
 * Los pagos de un complemento (REP): `Complemento > Pagos > Pago`.
 *
 * Se lee con los mismos helpers que ignoran el prefijo de espacio de nombres,
 * asi que sirve igual para `pago20:` que para cualquier otro alias que use el
 * PAC que timbro el comprobante.
 */
function parsePagos(comprobante: unknown): CfdiPago[] {
  const pagos: CfdiPago[] = []

  for (const complemento of asArray(child(comprobante, 'Complemento'))) {
    for (const bloque of asArray(child(complemento, 'Pagos'))) {
      for (const [i, pago] of asArray(child(bloque, 'Pago')).entries()) {
        const context = `Pago[${i + 1}]`
        if (attr(pago, 'FechaPago') === undefined) continue

        const documentos = asArray(child(pago, 'DoctoRelacionado')).flatMap((d) => {
          const uuid = attr(d, 'IdDocumento')?.toUpperCase()
          if (uuid === undefined) return []
          return [
            {
              uuid,
              numParcialidad: attr(d, 'NumParcialidad'),
              impSaldoAnt: decimalAttr(d, 'ImpSaldoAnt', context),
              impPagado: decimalAttr(d, 'ImpPagado', context),
              impSaldoInsoluto: decimalAttr(d, 'ImpSaldoInsoluto', context),
            },
          ]
        })

        pagos.push({
          fechaPago: requiredDateAttr(pago, 'FechaPago', context),
          formaDePago: attr(pago, 'FormaDePagoP'),
          monedaP: attr(pago, 'MonedaP') ?? 'MXN',
          monto: decimalAttr(pago, 'Monto', context) ?? new Decimal(0),
          documentos,
        })
      }
    }
  }

  return pagos
}

/** Los relacionados son como una nota de credito apunta a la factura que corrige. */
function parseRelacionados(comprobante: unknown): CfdiRelacionado[] {
  return asArray(child(comprobante, 'CfdiRelacionados')).flatMap((bloque) => {
    const tipoRelacion = attr(bloque, 'TipoRelacion')
    if (tipoRelacion === undefined) return []
    const uuids = asArray(child(bloque, 'CfdiRelacionado'))
      .map((r) => attr(r, 'UUID')?.toUpperCase())
      .filter((u): u is string => u !== undefined)
    return uuids.length > 0 ? [{ tipoRelacion, uuids }] : []
  })
}

// ---------------------------------------------------------------------------
// Entrada publica
// ---------------------------------------------------------------------------

const TIPOS_ACEPTADOS = new Set<TipoDeComprobante>(['I', 'E', 'P'])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false, // los importes se convierten con money(), no con el parser
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: false, // se resuelve por nombre local, conservando el XML tal cual
})

/**
 * Convierte el XML de un CFDI 4.0 en su representacion de dominio.
 *
 * Lanza `CfdiParseError` con el codigo correspondiente ante cualquiera de los
 * rechazos inmediatos de §12.1. Nunca devuelve un objeto a medias.
 */
export function parseCfdi(xml: string | Buffer): ParsedCfdi {
  const text = typeof xml === 'string' ? xml : xml.toString('utf8')

  if (text.trim() === '') {
    throw new CfdiParseError('XML_MAL_FORMADO', 'El archivo XML esta vacio.')
  }

  const validation = XMLValidator.validate(text)
  if (validation !== true) {
    throw new CfdiParseError('XML_MAL_FORMADO', 'El archivo no es un XML bien formado.', {
      detail: validation.err,
    })
  }

  let document: unknown
  try {
    document = parser.parse(text)
  } catch (cause) {
    throw new CfdiParseError('XML_MAL_FORMADO', 'No se pudo leer el archivo XML.', {
      cause: String(cause),
    })
  }

  const comprobante = child(document, 'Comprobante')
  if (comprobante === undefined) {
    throw new CfdiParseError(
      'NO_ES_CFDI',
      'El archivo no es un CFDI: no contiene un nodo Comprobante.',
    )
  }

  const version = attr(comprobante, 'Version')
  if (version !== '4.0') {
    throw new CfdiParseError(
      'VERSION_NO_SOPORTADA',
      `El portal solo acepta CFDI version 4.0; este comprobante declara "${version ?? 'sin version'}".`,
      { version },
    )
  }

  const tipoRaw = requiredAttr(comprobante, 'TipoDeComprobante', 'Comprobante')
  if (!TIPOS_ACEPTADOS.has(tipoRaw as TipoDeComprobante)) {
    throw new CfdiParseError(
      'TIPO_COMPROBANTE_INVALIDO',
      `Tipo de comprobante "${tipoRaw}" no admitido: se espera I para factura o E para nota de credito.`,
      { tipoDeComprobante: tipoRaw },
    )
  }
  const tipoDeComprobante = tipoRaw as TipoDeComprobante

  // El timbre se lee antes que los conceptos: un XML sin timbrar se rechaza por
  // SIN_TIMBRE, que es el motivo util para el proveedor, y no por un campo suelto.
  const timbre = parseTimbre(comprobante)

  return {
    version,
    tipoDeComprobante,
    serie: attr(comprobante, 'Serie'),
    folio: attr(comprobante, 'Folio'),
    fecha: requiredDateAttr(comprobante, 'Fecha', 'Comprobante'),
    subTotal: requiredDecimalAttr(comprobante, 'SubTotal', 'Comprobante'),
    descuento: moneyOrZero(attr(comprobante, 'Descuento')),
    total: requiredDecimalAttr(comprobante, 'Total', 'Comprobante'),
    moneda: requiredAttr(comprobante, 'Moneda', 'Comprobante'),
    tipoCambio: decimalAttr(comprobante, 'TipoCambio', 'Comprobante'),
    formaPago: attr(comprobante, 'FormaPago'),
    metodoPago: attr(comprobante, 'MetodoPago'),
    condicionesDePago: attr(comprobante, 'CondicionesDePago'),
    lugarExpedicion: requiredAttr(comprobante, 'LugarExpedicion', 'Comprobante'),
    exportacion: attr(comprobante, 'Exportacion'),
    noCertificado: requiredAttr(comprobante, 'NoCertificado', 'Comprobante'),
    // El X.509 del emisor en base64 y su sello. Los necesita `certificado.ts`
    // para comprobar que el comprobante lo sello quien dice haberlo sellado.
    //
    // EL ESTANDAR LOS EXIGE Y AQUI NO SE EXIGEN. Es deliberado: el parser
    // extrae, no juzga. Un CFDI sin certificado no es un CFDI, pero decirlo
    // como un error de extraccion lo convierte en un 422 con una sola linea,
    // mientras que dejarlo pasar vacio hace que la regla CERTIFICADO_EMISOR lo
    // explique junto al resto de las validaciones, que es donde el proveedor
    // esta mirando.
    certificado: attr(comprobante, 'Certificado') ?? '',
    sello: attr(comprobante, 'Sello') ?? '',
    emisor: parseEmisor(comprobante),
    receptor: parseReceptor(comprobante),
    conceptos: parseConceptos(comprobante),
    impuestos: parseImpuestos(comprobante),
    timbre,
    cfdiRelacionados: parseRelacionados(comprobante),
    pagos: parsePagos(comprobante),
  }
}
