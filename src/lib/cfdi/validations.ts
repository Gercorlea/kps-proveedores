import { round2 } from '../money'
import { getConfig } from '../config'
import { SupplierStatus } from '../domain/enums'
import { verificarCertificado } from './certificado'
import { revisarEstructura } from './estructura'
import type { ParsedCfdi } from './types'

/**
 * Reglas de validacion del CFDI (§12.2).
 *
 * Viven aqui y no en la ruta que las estreno porque ahora hay dos caminos que
 * tienen que juzgar el mismo XML con el mismo criterio: la vista previa que ve
 * el proveedor al soltar el archivo (`POST /cfdi/parse`) y el envio definitivo
 * (`POST /invoices`). Si cada uno llevara su copia, el portal podria pintar
 * "todo correcto" y luego rechazar el envio, o —peor— aceptar una factura que la
 * pantalla habia marcado en rojo.
 *
 * Que reglas se pueden correr depende de lo que se sepa en ese momento: sin
 * saber quien sube el archivo no hay RFC_EMISOR, y sin base de datos no hay
 * DUPLICADO_PORTAL. Por eso el contexto es opcional campo a campo y lo que no se
 * pudo comprobar sale por `pendientes()`, nunca como un "pasa" gratis.
 */

export interface Validacion {
  regla: string
  severidad: 'BLOQUEANTE' | 'ADVERTENCIA' | 'INFO'
  pasa: boolean
  detalle: string
}

/** Lo que hace falta saber del proveedor para juzgar su propia factura. */
export interface ProveedorEnValidacion {
  taxId: string
  legalName: string
  status: SupplierStatus
  blocked: boolean
  blockReason?: string | null
}

export interface ContextoValidacion {
  /** RFC de KPS. Ausente si falta KPS_RFC en el entorno. */
  rfcKps?: string
  /** Proveedor que sube el archivo. Ausente si no hay sesion de proveedor. */
  proveedor?: ProveedorEnValidacion | null
  /**
   * Si el UUID ya estaba cargado en el portal. `undefined` significa que no se
   * pudo consultar, y entonces la regla no se reporta: no es lo mismo "no esta
   * duplicado" que "no se miro".
   */
  uuidDuplicado?: boolean
  /** Si ya se corrieron SAT_VIGENTE y LISTA_69B. Solo lo lee `pendientes()`. */
  externasCorridas?: boolean
  /** Si ya se corrio el cotejo contra la entrada. Solo lo lee `pendientes()`. */
  cotejoCorrido?: boolean
}

/** Nombre legible de un impuesto del catalogo c_Impuesto. */
function nombreImpuesto(clave: string): string {
  if (clave === '001') return 'ISR'
  if (clave === '002') return 'IVA'
  if (clave === '003') return 'IEPS'
  return `impuesto ${clave}`
}

export function validarCfdi(cfdi: ParsedCfdi, ctx: ContextoValidacion = {}): Validacion[] {
  const validaciones: Validacion[] = []

  // --- SUMA_IMPUESTOS (BLOQUEANTE) ---------------------------------------
  // subtotal - descuento + trasladados - retenidos = total
  const calculado = round2(
    cfdi.subTotal
      .minus(cfdi.descuento)
      .plus(cfdi.impuestos.totalTrasladados)
      .minus(cfdi.impuestos.totalRetenidos),
  )
  const cuadra = calculado.equals(round2(cfdi.total))
  validaciones.push({
    regla: 'SUMA_IMPUESTOS',
    severidad: 'BLOQUEANTE',
    pasa: cuadra,
    detalle: cuadra
      ? `Los importes cuadran: ${calculado.toFixed(2)} ${cfdi.moneda}.`
      : `El total declarado es ${cfdi.total.toFixed(2)} pero la suma de conceptos e impuestos da ${calculado.toFixed(2)}. Revisa el XML con quien lo timbro.`,
  })

  // --- RFC_RECEPTOR (BLOQUEANTE) -----------------------------------------
  if (ctx.rfcKps) {
    const coincide = cfdi.receptor.rfc === ctx.rfcKps
    validaciones.push({
      regla: 'RFC_RECEPTOR',
      severidad: 'BLOQUEANTE',
      pasa: coincide,
      detalle: coincide
        ? `La factura esta emitida a ${ctx.rfcKps}.`
        : `La factura esta emitida a ${cfdi.receptor.rfc} y deberia estarlo a ${ctx.rfcKps}.`,
    })
  } else {
    validaciones.push({
      regla: 'RFC_RECEPTOR',
      severidad: 'INFO',
      pasa: false,
      detalle:
        'No se pudo comprobar: falta KPS_RFC en el entorno. Sin el no se sabe a que RFC debe venir emitida la factura.',
    })
  }

  // --- TIMBRE_PRESENTE (BLOQUEANTE) --------------------------------------
  // Si llegamos aqui el parser ya lo garantizo; se reporta por completitud.
  validaciones.push({
    regla: 'TIMBRE_PRESENTE',
    severidad: 'BLOQUEANTE',
    pasa: true,
    detalle: `Timbrada el ${cfdi.timbre.fechaTimbrado.toISOString().slice(0, 10)} con el certificado ${cfdi.timbre.noCertificadoSAT}.`,
  })

  // --- RFC_EMISOR (BLOQUEANTE) -------------------------------------------
  // Impide que un proveedor cargue con su sesion la factura de otro.
  if (ctx.proveedor) {
    const suyo = cfdi.emisor.rfc === ctx.proveedor.taxId
    validaciones.push({
      regla: 'RFC_EMISOR',
      severidad: 'BLOQUEANTE',
      pasa: suyo,
      detalle: suyo
        ? `La emite ${ctx.proveedor.legalName} con RFC ${ctx.proveedor.taxId}.`
        : `El XML lo emite ${cfdi.emisor.rfc} y tu cuenta es la de ${ctx.proveedor.taxId}. Solo puedes cargar facturas emitidas por tu empresa.`,
    })

    // --- PROVEEDOR_ACTIVO (BLOQUEANTE) -----------------------------------
    const activo = ctx.proveedor.status === SupplierStatus.ACTIVO && !ctx.proveedor.blocked
    validaciones.push({
      regla: 'PROVEEDOR_ACTIVO',
      severidad: 'BLOQUEANTE',
      pasa: activo,
      detalle: activo
        ? 'Tu cuenta esta activa y sin bloqueos.'
        : ctx.proveedor.blocked
          ? `Tu cuenta esta retenida: ${ctx.proveedor.blockReason ?? 'tienes un recibo de pago pendiente'}.`
          : `Tu cuenta esta en estado ${ctx.proveedor.status} y no puede facturar. Habla con KPS.`,
    })
  }

  // --- CERTIFICADO_EMISOR (BLOQUEANTE) -----------------------------------
  // La unica regla que comprueba algo que el autor del XML no puede fabricar.
  // Todas las demas leen lo que el comprobante dice de si mismo.
  if (getConfig().cfdi.verificarCertificado) {
    const cert = verificarCertificado({
      certificadoBase64: cfdi.certificado,
      noCertificado: cfdi.noCertificado,
      rfcEmisor: cfdi.emisor.rfc,
      fechaTimbrado: cfdi.timbre.fechaTimbrado,
    })
    validaciones.push({
      regla: 'CERTIFICADO_EMISOR',
      severidad: 'BLOQUEANTE',
      pasa: cert.ok,
      detalle: cert.ok
        ? `Sellada con el certificado ${cert.numeroSerie} de ${cert.titular ?? cert.rfc}, vigente del ${cert.vigenteDesde.toISOString().slice(0, 10)} al ${cert.vigenteHasta.toISOString().slice(0, 10)}.`
        : cert.detalle,
    })
  } else {
    validaciones.push({
      regla: 'CERTIFICADO_EMISOR',
      severidad: 'INFO',
      pasa: false,
      detalle:
        'No se comprobo: CFDI_VERIFICAR_CERTIFICADO esta apagada. Con ella apagada, un XML inventado pasa todas las validaciones del portal.',
    })
  }

  // --- ESTRUCTURA_* (Anexo 20) -------------------------------------------
  // Cada problema sale como su propia regla para que el proveedor vea el campo
  // exacto en vez de un "el XML no cumple el estandar".
  if (getConfig().cfdi.verificarEstructura) {
    for (const p of revisarEstructura(cfdi)) {
      validaciones.push({
        regla: p.regla,
        severidad: p.severidad,
        pasa: false,
        detalle: p.detalle,
      })
    }
  }

  // --- RETENCIONES (ADVERTENCIA) -----------------------------------------
  // Si la factura trae retenciones, el importe que KPS le paga al proveedor NO
  // es el total del CFDI: es el total menos lo retenido. Business One solo lo
  // registra bien si conoce el `WTCode` de cada retencion, y esos codigos son de
  // la instalacion de KPS.
  //
  // AVISO Y NO BLOQUEO. El proveedor no puede arreglar una configuracion de KPS,
  // y devolverle su factura por eso seria echarle encima un problema ajeno. El
  // bloqueo de verdad esta donde importa: el dashboard no registra en B1 una
  // factura con retenciones sin codigos, porque hacerlo le pagaria de mas.
  if (!cfdi.impuestos.totalRetenidos.isZero()) {
    const codigos = getConfig().cfdi.retencionesWtCodes
    const sinMapear = [...new Set(cfdi.impuestos.retenciones.map((r) => r.impuesto))].filter(
      (impuesto) => !codigos.has(impuesto),
    )
    const completo = sinMapear.length === 0
    validaciones.push({
      regla: 'RETENCIONES',
      severidad: 'ADVERTENCIA',
      pasa: completo,
      detalle: completo
        ? `La factura retiene ${cfdi.impuestos.totalRetenidos.toFixed(2)} ${cfdi.moneda}. KPS te pagara ${round2(cfdi.total).toFixed(2)} y entregara la retencion al SAT.`
        : `La factura retiene ${cfdi.impuestos.totalRetenidos.toFixed(2)} ${cfdi.moneda} de ${sinMapear.map(nombreImpuesto).join(' y ')}, y KPS todavia no tiene configurados los codigos de retencion de Business One. Cuentas por pagar tendra que registrarla a mano.`,
    })
  }

  // --- DUPLICADO_PORTAL (BLOQUEANTE) -------------------------------------
  if (ctx.uuidDuplicado !== undefined) {
    validaciones.push({
      regla: 'DUPLICADO_PORTAL',
      severidad: 'BLOQUEANTE',
      pasa: !ctx.uuidDuplicado,
      detalle: ctx.uuidDuplicado
        ? `El UUID ${cfdi.timbre.uuid} ya se cargo antes en el portal. Una factura solo se sube una vez.`
        : 'Este UUID no se habia cargado antes en el portal.',
    })
  }

  return validaciones
}

/** Las que impiden que la factura avance. */
export function bloqueantes(validaciones: readonly Validacion[]): Validacion[] {
  return validaciones.filter((v) => v.severidad === 'BLOQUEANTE' && !v.pasa)
}

/**
 * Reglas de §12.2 que este contexto NO pudo correr. Se enseñan al proveedor para
 * que "paso lo que se pudo revisar" no se confunda con "la factura es valida".
 */
export function pendientes(ctx: ContextoValidacion = {}): string[] {
  const lista: string[] = []
  if (ctx.uuidDuplicado === undefined) {
    lista.push('DUPLICADO_PORTAL · necesita la base de datos del portal')
  }
  if (!ctx.proveedor) {
    lista.push(
      'RFC_EMISOR · necesita saber que proveedor esta subiendo la factura',
      'PROVEEDOR_ACTIVO · necesita la cuenta del proveedor',
    )
  }
  // SAT_VIGENTE y LISTA_69B salen de la red, asi que no las puede correr una
  // funcion pura. Viven en `validaciones-externas.ts` y se anaden aparte; si
  // quien llama no las corrio, aqui es donde se dice.
  if (!ctx.externasCorridas) {
    lista.push(
      'SAT_VIGENTE · necesita el servicio de consulta del SAT',
      'LISTA_69B · necesita la lista de EFOS que publica el SAT',
    )
  }
  if (!ctx.cotejoCorrido) {
    lista.push('COTEJO_CANTIDAD y COTEJO_IMPORTE · necesitan la entrada de mercancia')
  }
  lista.push('DUPLICADO_SAP · necesita consultar Business One por el UUID')
  return lista
}
