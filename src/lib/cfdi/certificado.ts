import { X509Certificate } from 'node:crypto'
import { RFC_PATTERN } from '../config'

/**
 * El certificado de sello digital (CSD) del emisor, comprobado de verdad.
 *
 * POR QUE ESTO ES LA VALIDACION MAS IMPORTANTE DEL PORTAL. Todas las demas
 * reglas leen lo que el XML DICE de si mismo: el RFC del emisor, el total, la
 * fecha. Un XML inventado dice lo que su autor quiera y las pasa todas. Esta es
 * la unica que comprueba algo que el autor del XML no puede fabricar: un
 * certificado emitido por el SAT, con su numero de serie, a nombre de ese RFC y
 * vigente el dia del timbrado.
 *
 * QUE COMPRUEBA Y QUE NO. Comprueba el certificado; NO comprueba el sello. El
 * sello exige la cadena original, que se arma con el XSLT del SAT, y sin ella
 * verificar la firma es imposible. La consulta al SAT (`sat.ts`) cubre ese hueco
 * por otra via: el SAT solo conoce los UUID que el mismo timbro.
 *
 * EL NUMERO DE SERIE. `NoCertificado` son 20 digitos, pero en el X.509 el numero
 * de serie no se guarda como numero: se guarda como los BYTES ASCII de esos 20
 * digitos. El serial `3030...` en hexadecimal se lee "0000...". Comparar el hex
 * contra los 20 digitos directamente falla siempre; hay que decodificarlo antes.
 */

export type MotivoCertificado =
  | 'NO_ES_CERTIFICADO'
  | 'SERIE_NO_COINCIDE'
  | 'RFC_NO_COINCIDE'
  | 'NO_VIGENTE'

export interface CertificadoValido {
  readonly ok: true
  /** Los 20 digitos, ya decodificados del numero de serie del X.509. */
  readonly numeroSerie: string
  readonly rfc: string
  readonly titular: string | null
  readonly vigenteDesde: Date
  readonly vigenteHasta: Date
}

export interface CertificadoInvalido {
  readonly ok: false
  readonly motivo: MotivoCertificado
  /** Redactado para que lo lea el proveedor. */
  readonly detalle: string
}

export type ResultadoCertificado = CertificadoValido | CertificadoInvalido

/**
 * Convierte el numero de serie hexadecimal del X.509 a los digitos que declara
 * `NoCertificado`. Devuelve null si el hex no decodifica a digitos ASCII, que es
 * lo que pasa con un certificado que no es de la PKI del SAT.
 */
function serieDesdeHex(hex: string): string | null {
  const limpio = hex.replace(/[^0-9a-fA-F]/g, '')
  if (limpio.length === 0 || limpio.length % 2 !== 0) return null

  let texto = ''
  for (let i = 0; i < limpio.length; i += 2) {
    const codigo = Number.parseInt(limpio.slice(i, i + 2), 16)
    // Solo digitos ASCII: el numero de certificado del SAT son 20 cifras.
    if (codigo < 0x30 || codigo > 0x39) return null
    texto += String.fromCharCode(codigo)
  }
  return texto
}

/**
 * El RFC del titular. En los certificados del SAT vive en el atributo
 * `x500UniqueIdentifier` (OID 2.5.4.45), que OpenSSL imprime de formas distintas
 * segun la version, y a veces tambien en `serialNumber`.
 *
 * Se busca el patron de RFC en TODO el sujeto en vez de leer un atributo
 * concreto: el sitio exacto cambia entre versiones de OpenSSL y entre los
 * certificados de persona fisica y moral, y equivocarse de atributo haria
 * rechazar certificados legitimos.
 */
function rfcDelSujeto(subject: string): string | null {
  // El sujeto llega como lineas `clave=valor`. Se parten los valores por
  // separadores comunes para no confundir un RFC con un trozo de la razon
  // social que casualmente empiece igual.
  const piezas = subject.split(/[\n,/=]+/).map((p) => p.trim().toUpperCase())
  for (const pieza of piezas) {
    if (RFC_PATTERN.test(pieza)) return pieza
  }
  return null
}

/** El nombre del titular (`CN`), si el sujeto lo trae. */
function titularDelSujeto(subject: string): string | null {
  const linea = subject.split('\n').find((l) => l.trimStart().toUpperCase().startsWith('CN='))
  return linea ? linea.trim().slice(3).trim() || null : null
}

/**
 * Comprueba el certificado del emisor contra lo que el CFDI declara.
 *
 * `fechaTimbrado` y no la fecha de hoy: lo que importa es que el certificado
 * estuviera vigente CUANDO se timbro. Un CSD que caduco el mes pasado no
 * invalida las facturas que sello mientras estaba vigente; usar la fecha de hoy
 * rechazaria facturas legitimas del historico.
 */
export function verificarCertificado(input: {
  /** El atributo `Certificado` del comprobante: el X.509 en base64, sin PEM. */
  readonly certificadoBase64: string
  /** El atributo `NoCertificado`: 20 digitos. */
  readonly noCertificado: string
  /** El RFC que el XML dice que emite. */
  readonly rfcEmisor: string
  readonly fechaTimbrado: Date
}): ResultadoCertificado {
  const base64 = input.certificadoBase64.replace(/\s+/g, '')
  if (!base64) {
    return {
      ok: false,
      motivo: 'NO_ES_CERTIFICADO',
      detalle: 'El comprobante no trae el certificado del emisor en el atributo Certificado.',
    }
  }

  let cert: X509Certificate
  try {
    // El atributo viene en base64 DER. Se decodifica y se pasa el DER crudo, que
    // es una de las dos formas que acepta el constructor.
    //
    // NO SE ENVUELVE EN PEM. Armar el PEM a mano obliga a trocear el base64 en
    // lineas de 64, y cuando la longitud es multiplo exacto de 64 el troceado
    // deja una linea en blanco antes de END que hace fallar el parseo de un
    // certificado perfectamente valido. Con el DER no hay nada que formatear.
    cert = new X509Certificate(Buffer.from(base64, 'base64'))
  } catch {
    return {
      ok: false,
      motivo: 'NO_ES_CERTIFICADO',
      detalle:
        'El contenido del atributo Certificado no es un certificado X.509. Un CFDI timbrado siempre lo trae; este archivo no viene de un PAC.',
    }
  }

  // --- Numero de serie ----------------------------------------------------
  const serie = serieDesdeHex(cert.serialNumber)
  const declarado = input.noCertificado.trim()
  if (serie === null) {
    return {
      ok: false,
      motivo: 'SERIE_NO_COINCIDE',
      detalle: `El numero de serie del certificado (${cert.serialNumber}) no tiene el formato que usa el SAT. Ese certificado no lo emitio el SAT.`,
    }
  }
  if (serie !== declarado) {
    return {
      ok: false,
      motivo: 'SERIE_NO_COINCIDE',
      detalle: `El comprobante declara el certificado ${declarado} pero el que adjunta es el ${serie}. Son dos certificados distintos.`,
    }
  }

  // --- Titular ------------------------------------------------------------
  const rfcCert = rfcDelSujeto(cert.subject)
  const rfcXml = input.rfcEmisor.trim().toUpperCase()
  if (rfcCert === null) {
    return {
      ok: false,
      motivo: 'RFC_NO_COINCIDE',
      detalle:
        'El certificado no trae ningun RFC en el titular. Un certificado de sello digital del SAT siempre lo trae.',
    }
  }
  if (rfcCert !== rfcXml) {
    return {
      ok: false,
      motivo: 'RFC_NO_COINCIDE',
      detalle: `El certificado es de ${rfcCert} y el comprobante dice emitirlo ${rfcXml}. Nadie puede sellar una factura con el certificado de otro.`,
    }
  }

  // --- Vigencia el dia del timbrado ---------------------------------------
  const desde = new Date(cert.validFrom)
  const hasta = new Date(cert.validTo)

  if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
    return {
      ok: false,
      motivo: 'NO_VIGENTE',
      detalle: 'No se pudieron leer las fechas de vigencia del certificado.',
    }
  }

  const cuando = input.fechaTimbrado
  if (cuando < desde || cuando > hasta) {
    const dia = (d: Date) => d.toISOString().slice(0, 10)
    return {
      ok: false,
      motivo: 'NO_VIGENTE',
      detalle: `El certificado ${serie} estuvo vigente del ${dia(desde)} al ${dia(hasta)}, y el comprobante se timbro el ${dia(cuando)}. Un CSD no puede sellar fuera de su vigencia.`,
    }
  }

  return {
    ok: true,
    numeroSerie: serie,
    rfc: rfcCert,
    titular: titularDelSujeto(cert.subject),
    vigenteDesde: desde,
    vigenteHasta: hasta,
  }
}
