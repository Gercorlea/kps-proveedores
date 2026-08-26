import type { Decimal } from '../money'
import { getConfig } from '../config'

/**
 * Consulta del estado de un CFDI ante el SAT (§12.2 regla SAT_VIGENTE).
 *
 * QUE APORTA QUE NO APORTE NADA MAS. El certificado (`certificado.ts`) prueba
 * que el sello lo puso quien dice; esto prueba que el comprobante EXISTE para el
 * SAT y sigue vigente. Son dos hechos distintos: un CFDI legitimo que el emisor
 * cancelo la semana pasada pasa la prueba del certificado y falla esta. Y KPS no
 * puede deducir una factura cancelada.
 *
 * EL SERVICIO ES PUBLICO Y GRATUITO. Es el mismo que hay detras del QR de
 * cualquier factura. No hace falta e.firma, ni contrato, ni PAC.
 *
 * ES SOAP, Y ES LENTO. El SAT tarda segundos y se cae con regularidad. De ahi
 * dos decisiones:
 *
 *   1. Una caida NO se convierte en un rechazo. Devuelve `INDETERMINADO` y la
 *      regla se reporta como no comprobada. Rechazar la factura de un proveedor
 *      porque el SAT tuvo un mal minuto seria castigarle por algo suyo.
 *   2. Se cachea en memoria del proceso. Al cargar la factura se pregunta en
 *      fresco; las relecturas de la misma pantalla se sirven de cache.
 *
 * LA CACHE ES DEL PROCESO, no de Mongo. Con varias instancias cada una
 * preguntara por su cuenta la primera vez, y un reinicio la vacia. Es aceptable
 * —el volumen de facturas de KPS no satura nada— y evita una coleccion mas.
 */

export type EstadoSat = 'VIGENTE' | 'CANCELADO' | 'NO_ENCONTRADO' | 'INDETERMINADO'

export interface RespuestaSat {
  readonly estado: EstadoSat
  /** `CodigoEstatus` tal cual lo devuelve el SAT. */
  readonly codigo: string | null
  /** `EsCancelable`: "Cancelable sin aceptacion", "No cancelable", ... */
  readonly esCancelable: string | null
  readonly estatusCancelacion: string | null
  /**
   * `ValidacionEFOS`. `200` significa que el emisor NO esta en la lista del
   * 69-B. Cualquier otra cosa es un aviso: el SAT lo tiene senalado.
   */
  readonly validacionEfos: string | null
  /** Por que quedo INDETERMINADO. Null si la consulta funciono. */
  readonly motivo: string | null
  /** Servida de cache y no consultada en fresco. */
  readonly deCache: boolean
}

interface EntradaCache {
  readonly respuesta: RespuestaSat
  readonly expira: number
}

const cache = new Map<string, EntradaCache>()

/** Solo para pruebas: vacia la cache del proceso. */
export function limpiarCacheSat(): void {
  cache.clear()
}

function indeterminado(motivo: string): RespuestaSat {
  return {
    estado: 'INDETERMINADO',
    codigo: null,
    esCancelable: null,
    estatusCancelacion: null,
    validacionEfos: null,
    motivo,
    deCache: false,
  }
}

/**
 * El total tal como lo espera la expresion impresa.
 *
 * El SAT compara la cifra contra la del comprobante, asi que tiene que ir con
 * los mismos decimales con los que se timbro. Un CFDI se escribe casi siempre a
 * dos decimales; los de mas de dos —importes con fracciones de centavo— se
 * mandan con su precision completa en vez de redondearse, porque redondear aqui
 * es exactamente lo que hace que el SAT conteste "no coincide".
 */
function formatearTotal(total: Decimal): string {
  return total.toFixed(Math.max(2, total.decimalPlaces()))
}

/**
 * La expresion impresa: la misma cadena que va dentro del QR de la factura.
 *
 * `fe` son los ULTIMOS OCHO caracteres del sello del emisor. Es obligatorio
 * desde CFDI 4.0 y es lo que impide consultar el estado de una factura ajena
 * conociendo solo su UUID.
 */
export function expresionImpresa(input: {
  readonly uuid: string
  readonly rfcEmisor: string
  readonly rfcReceptor: string
  readonly total: Decimal
  readonly sello: string
}): string {
  const params = [
    `id=${input.uuid.toUpperCase()}`,
    `re=${input.rfcEmisor.trim().toUpperCase()}`,
    `rr=${input.rfcReceptor.trim().toUpperCase()}`,
    `tt=${formatearTotal(input.total)}`,
    `fe=${input.sello.slice(-8)}`,
  ]
  return `?${params.join('&')}`
}

/** Valor de una etiqueta de la respuesta, ignorando el prefijo de namespace. */
function leerEtiqueta(xml: string, nombre: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${nombre}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${nombre}>`,
    'i',
  )
  const m = re.exec(xml)
  if (!m) return null
  const valor = m[1].trim()
  return valor.length > 0 ? valor : null
}

/**
 * Traduce lo que contesta el SAT.
 *
 * `CodigoEstatus` empieza por `S` cuando encontro el comprobante y por `N`
 * cuando no. Los dos codigos `N` que importan:
 *
 *   601 — la expresion impresa esta mal armada. Es un problema NUESTRO, no una
 *         prueba de que la factura sea falsa: se devuelve INDETERMINADO.
 *   602 — el SAT no conoce ese comprobante. Eso SI es concluyente.
 */
function interpretar(xml: string): RespuestaSat {
  const codigo = leerEtiqueta(xml, 'CodigoEstatus')
  const estadoCrudo = leerEtiqueta(xml, 'Estado')
  const base = {
    codigo,
    esCancelable: leerEtiqueta(xml, 'EsCancelable'),
    estatusCancelacion: leerEtiqueta(xml, 'EstatusCancelacion'),
    validacionEfos: leerEtiqueta(xml, 'ValidacionEFOS'),
    deCache: false,
  }

  if (codigo && /^\s*N/i.test(codigo)) {
    if (codigo.includes('602')) {
      return { ...base, estado: 'NO_ENCONTRADO', motivo: null }
    }
    return {
      ...base,
      estado: 'INDETERMINADO',
      motivo: `El SAT no pudo procesar la consulta: ${codigo}`,
    }
  }

  const estado = (estadoCrudo ?? '').toLowerCase()
  if (estado.startsWith('vigente')) return { ...base, estado: 'VIGENTE', motivo: null }
  if (estado.startsWith('cancelado')) return { ...base, estado: 'CANCELADO', motivo: null }
  if (estado.includes('no encontrado')) return { ...base, estado: 'NO_ENCONTRADO', motivo: null }

  return {
    ...base,
    estado: 'INDETERMINADO',
    motivo: estadoCrudo
      ? `El SAT devolvio un estado que no se reconoce: "${estadoCrudo}".`
      : 'El SAT contesto sin decir el estado del comprobante.',
  }
}

/**
 * Pregunta al SAT por un comprobante.
 *
 * NUNCA LANZA. Un fallo de red, un timeout o un HTML de error del SAT salen como
 * `INDETERMINADO` con el motivo dentro. Quien llama decide que hacer con eso, y
 * en este portal la decision es no bloquear: ver `validaciones-externas.ts`.
 */
export async function consultarSat(input: {
  readonly uuid: string
  readonly rfcEmisor: string
  readonly rfcReceptor: string
  readonly total: Decimal
  readonly sello: string
}): Promise<RespuestaSat> {
  const cfg = getConfig().sat

  if (!cfg.enabled) {
    return indeterminado('La consulta al SAT esta apagada (SAT_VALIDATION_ENABLED=false).')
  }

  const clave = input.uuid.toUpperCase()
  const guardada = cache.get(clave)
  if (guardada && guardada.expira > Date.now()) {
    return { ...guardada.respuesta, deCache: true }
  }

  // El CDATA es obligatorio: la expresion lleva `&`, que sin escapar rompe el
  // sobre SOAP y el SAT contesta con un error de parseo.
  const sobre =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
    '<soapenv:Header/><soapenv:Body><tem:Consulta>' +
    `<tem:expresionImpresa><![CDATA[${expresionImpresa(input)}]]></tem:expresionImpresa>` +
    '</tem:Consulta></soapenv:Body></soapenv:Envelope>'

  let respuesta: RespuestaSat
  try {
    const r = await fetch(cfg.consultaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'http://tempuri.org/IConsultaCFDIService/Consulta',
      },
      body: sobre,
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    })

    respuesta = r.ok
      ? interpretar(await r.text())
      : indeterminado(`El servicio del SAT contesto HTTP ${r.status}.`)
  } catch (error) {
    const esTimeout = error instanceof Error && error.name === 'TimeoutError'
    respuesta = indeterminado(
      esTimeout
        ? `El SAT no contesto en ${cfg.requestTimeoutMs / 1000} segundos.`
        : `No se pudo consultar al SAT: ${error instanceof Error ? error.message : 'error desconocido'}.`,
    )
  }

  // Un INDETERMINADO no se cachea: es un fallo pasajero y guardarlo haria que el
  // siguiente intento —que quiza si funcionaria— ni se lanzara.
  if (respuesta.estado !== 'INDETERMINADO') {
    cache.set(clave, { respuesta, expira: Date.now() + cfg.cacheTtlHours * 60 * 60 * 1000 })
  }

  return respuesta
}
