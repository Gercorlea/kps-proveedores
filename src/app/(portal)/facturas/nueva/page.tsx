import { getSession } from '@/lib/auth/server'
import { SupplierType } from '@/lib/domain/enums'
import { getProveedorActual } from '@/lib/suppliers/current'
import CargaFactura from './carga-factura'

/**
 * P06 · Nueva factura — mitad de servidor.
 *
 * La pantalla es interactiva y tiene que ser cliente, pero de que clase de
 * proveedor se trata solo se sabe leyendo la base, y de eso dependen el texto de
 * la evidencia y si la factura cuelga de una orden. Resolverlo con un fetch
 * desde el navegador haria parpadear la pantalla entre los dos flujos.
 */
export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  if (!session) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Sin sesion</span>
        <p>Vuelve a entrar para cargar una factura.</p>
      </div>
    )
  }

  const proveedor = await getProveedorActual()

  // Sin proveedor no se puede facturar, y hay que distinguir las dos causas: no
  // es lo mismo una cuenta interna de KPS —que nunca va a cargar facturas— que
  // un proveedor cuya lectura fallo, donde reintentar si tiene sentido.
  if (!proveedor) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">No se pudo abrir la carga de facturas</span>
        <p>
          {session.supplierCode
            ? `Tu cuenta apunta al proveedor ${session.supplierCode}, pero el portal no pudo leer sus datos. Vuelve a intentarlo; si sigue igual, avisa a KPS.`
            : 'Tu cuenta no esta vinculada a ningun proveedor, asi que no puede cargar facturas.'}
        </p>
      </div>
    )
  }

  if (proveedor.bloqueado) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Tu cuenta esta retenida</span>
        <p>
          {proveedor.motivoBloqueo ??
            'KPS retuvo tu cuenta y mientras siga asi no se admiten facturas nuevas.'}
        </p>
        <p className="cr-small">
          La retencion detiene el proceso, no lo cancela: en cuanto se resuelva vas a poder cargar
          con normalidad.
        </p>
      </div>
    )
  }

  return (
    <CargaFactura
      tipo={proveedor.tipo === SupplierType.SERVICIO ? 'SERVICIO' : 'MERCANCIA'}
      supplierCode={proveedor.supplierCode}
    />
  )
}
