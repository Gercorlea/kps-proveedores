import { METODO_PPD } from '../cfdi/types'
import { InvoiceStatus } from '../domain/enums'
import { invoices, supplierScope, type InvoiceDoc } from '../mongo'

/**
 * Conteos del Inicio del proveedor (P03).
 *
 * Se resuelve con una agregacion y no contando sobre la lista de facturas
 * porque la lista viene con `limit 200`: a partir de ahi los KPI mentirian, y un
 * numero equivocado en la portada es peor que no ponerlo.
 *
 * Los grupos NO son los estatus crudos. El proveedor no necesita saber si su
 * factura esta en APROBADA_PAGO o en REGISTRADA_SAP —las dos significan "ya
 * paso, espera el dinero"—; necesita saber en cual de ellas tiene que hacer
 * algo. De ahi que el corte sea por accion y no por estado.
 */

/** Esperando a KPS. El proveedor no hace nada. */
const EN_CURSO: readonly InvoiceStatus[] = [
  InvoiceStatus.EN_VALIDACION,
  InvoiceStatus.EN_COTEJO,
  InvoiceStatus.EN_REVISION,
  InvoiceStatus.NC_EN_REVISION,
]

/** Aprobadas: el trabajo ya esta hecho y lo que falta es el pago. */
const POR_COBRAR: readonly InvoiceStatus[] = [
  InvoiceStatus.APROBADA_PAGO,
  InvoiceStatus.REGISTRADA_SAP,
  InvoiceStatus.CUENTAS_POR_PAGAR,
  // ERROR_SAP es un fallo de KPS, no del proveedor: para el cuenta como
  // aprobada y en camino. §06 se lo muestra como "Registrando".
  InvoiceStatus.ERROR_SAP,
]

/** La pelota esta en el tejado del proveedor. */
const REQUIEREN_ACCION: readonly InvoiceStatus[] = [
  InvoiceStatus.EN_CORRECCION,
  InvoiceStatus.NC_SOLICITADA,
]

export interface ResumenProveedor {
  /** Enviadas y esperando decision de KPS. */
  enCurso: number
  /** Aprobadas, pendientes de que entre el dinero. */
  porCobrar: number
  /** Devueltas o con nota de credito solicitada: tiene que hacer algo. */
  requierenAccion: number
  /**
   * Pagadas que deben complemento de pago: PPD y sin REP cargado. Las PUE no
   * cuentan —no llevan complemento— y meterlas aqui haria que el portal le
   * reclamara al proveedor un documento que la ley no le pide.
   */
  recibosPendientes: number
  /** Rechazadas y duplicadas: cerradas en contra, sin accion posible. */
  rechazadas: number
  total: number
}

const VACIO: ResumenProveedor = {
  enCurso: 0,
  porCobrar: 0,
  requierenAccion: 0,
  recibosPendientes: 0,
  rechazadas: 0,
  total: 0,
}

function sumar(conteo: Map<string, number>, estados: readonly InvoiceStatus[]): number {
  return estados.reduce((total, estado) => total + (conteo.get(estado) ?? 0), 0)
}

/**
 * El filtro pasa por `supplierScope` como exige §02: es la unica barrera de
 * aislamiento que hay, porque MongoDB no tiene row-level security.
 */
export async function resumenDelProveedor(ctx: {
  supplierCode?: string | null
  internal: boolean
}): Promise<ResumenProveedor> {
  const coleccion = await invoices()
  const [grupos, complementos] = await Promise.all([
    coleccion
      .aggregate<{ _id: InvoiceStatus; n: number }>([
        { $match: supplierScope<InvoiceDoc>({}, ctx) },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ])
      .toArray(),
    coleccion.countDocuments(
      supplierScope<InvoiceDoc>(
        {
          status: InvoiceStatus.PAGADA,
          paymentMethod: METODO_PPD,
          paymentReceipt: { $in: [null] },
        },
        ctx,
      ),
    ),
  ])

  if (grupos.length === 0) return VACIO

  const conteo = new Map(grupos.map((g) => [String(g._id), g.n]))

  return {
    enCurso: sumar(conteo, EN_CURSO),
    porCobrar: sumar(conteo, POR_COBRAR),
    requierenAccion: sumar(conteo, REQUIEREN_ACCION),
    recibosPendientes: complementos,
    rechazadas: sumar(conteo, [InvoiceStatus.RECHAZADA, InvoiceStatus.DUPLICADA]),
    total: grupos.reduce((t, g) => t + g.n, 0),
  }
}
