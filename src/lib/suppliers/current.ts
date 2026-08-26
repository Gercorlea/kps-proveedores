import { getSession } from '../auth/server'
import { SupplierStatus, SupplierType } from '../domain/enums'
import { suppliers } from '../mongo'

/**
 * El proveedor de la sesion, leido en cada pantalla que lo necesita.
 *
 * El tipo NO viaja en el token a proposito: si KPS le cambia el tipo a un
 * proveedor, el cambio tiene que verse en la siguiente pantalla y no cuando
 * caduque la sesion ocho horas despues. Eso obliga a una lectura por render, y
 * por eso vive aqui y no repetida en cada pagina.
 *
 * Devuelve null y no lanza cuando la lectura falla —sin MONGODB_URI, base
 * caida—. Quien llama decide si eso es fatal: para la barra de navegacion no lo
 * es (se pinta sin la etiqueta), para la carga de una factura si.
 */

export interface ServicioContratado {
  id: string
  title: string
  description: string
  documentKey: string
}

export interface ProveedorActual {
  supplierCode: string
  tipo: SupplierType
  estatus: SupplierStatus
  nombre: string
  rfc: string
  /** Tal como viene de B1: la forma del domicilio no la fija el portal. */
  domicilio: Record<string, unknown>
  contacto: Record<string, unknown>
  condicionesPago: string | null
  moneda: string | null
  grupoB1: number | null
  constanciaFecha: Date | null
  bloqueado: boolean
  motivoBloqueo: string | null
  bloqueadoDesde: Date | null
  /** Solo los vigentes: un servicio dado de baja no puede facturarse. */
  servicios: ServicioContratado[]
  /** Los dados de baja. No se pueden facturar; se listan para que se vea por que. */
  serviciosBaja: ServicioContratado[]
  sincronizadoEn: Date | null
  altaEn: Date | null
  actualizadoEn: Date | null
}

export function esServicio(proveedor: ProveedorActual | null): boolean {
  return proveedor?.tipo === SupplierType.SERVICIO
}

export async function getProveedorActual(): Promise<ProveedorActual | null> {
  const session = await getSession()
  if (!session?.supplierCode) return null

  try {
    // Se traen todos los campos de la ficha: la pantalla "Mi informacion" los
    // muestra enteros y una proyeccion recortada obligaria a una segunda lectura
    // del mismo documento solo para ella. El unico campo que NO se guarda aqui
    // —el saldo— tampoco esta en la coleccion: se lee en vivo de B1.
    const doc = await (await suppliers()).findOne({ supplierCode: session.supplierCode })
    if (!doc) return null

    const servicios = (doc.services ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      documentKey: s.documentKey,
      active: s.active,
    }))
    const ficha = ({ id, title, description, documentKey }: (typeof servicios)[number]) => ({
      id,
      title,
      description,
      documentKey,
    })

    return {
      supplierCode: session.supplierCode,
      tipo: doc.type,
      estatus: doc.status,
      nombre: doc.legalName,
      rfc: doc.taxId,
      domicilio: doc.fiscalAddress ?? {},
      contacto: doc.contact ?? {},
      condicionesPago: doc.paymentTerms ?? null,
      moneda: doc.currency ?? null,
      grupoB1: doc.groupCode ?? null,
      constanciaFecha: doc.taxCertificateDate ?? null,
      bloqueado: doc.blocked,
      motivoBloqueo: doc.blockReason ?? null,
      bloqueadoDesde: doc.blockedAt ?? null,
      servicios: servicios.filter((s) => s.active).map(ficha),
      serviciosBaja: servicios.filter((s) => !s.active).map(ficha),
      sincronizadoEn: doc.syncedAt ?? null,
      altaEn: doc.createdAt ?? null,
      actualizadoEn: doc.updatedAt ?? null,
    }
  } catch (error) {
    console.warn('[proveedor] no se pudo leer el proveedor de la sesion:', error)
    return null
  }
}
