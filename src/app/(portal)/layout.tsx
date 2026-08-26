import Link from 'next/link'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, esInterno, verifySession, type SessionPayload } from '@/lib/auth/session'
import { SupplierType } from '@/lib/domain/enums'
import { listarAvisos, type ListaAvisos } from '@/lib/notifications'
import { puedeCapturarEntradas } from '@/lib/receipts/acceso'
import { getProveedorActual, type ProveedorActual } from '@/lib/suppliers/current'
import Notificaciones from './notificaciones'



interface Item {
  href: string
  label: string
  count?: number
}
interface Grupo {
  label: string
  items: Item[]
}

function navegacion(session: SessionPayload | null, proveedor: ProveedorActual | null): Grupo[] {
  if (!session) return []
  const roles = session.roles
  const tiene = (r: string) => (roles as readonly string[]).includes(r)

  const grupos: Grupo[] = []

  if (tiene('PROVEEDOR_MERCANCIA') || tiene('PROVEEDOR_SERVICIO')) {
    const operacion: Item[] = [{ href: '/', label: 'Inicio' }]

    // Quien decide si hay ordenes de compra es el TIPO del proveedor en la base,
    // no el rol del usuario. Los dos dicen lo mismo casi siempre, pero cuando KPS
    // le cambia el tipo a un proveedor el rol de sus usuarios no se reescribe
    // solo: mandar sobre el rol dejaria un menu que ofrece "Ordenes de compra" a
    // quien ya factura sin ellas. Ante la duda —lectura fallida, proveedor sin
    // ficha— se cae del lado de no ofrecer la seccion.
    if (proveedor?.tipo === SupplierType.MERCANCIA) {
      operacion.push({ href: '/ordenes', label: 'Ordenes de compra' })
      // SOLO PRUEBAS. Con `FEATURE_ENTRADAS_PROVEEDOR=true` el proveedor tambien
      // captura entradas, para poder recorrer el flujo entero con una sola
      // sesion. En produccion la bandera va apagada y esto no aparece: quien da
      // por recibida la mercancia es almacen, y un proveedor firmando su propia
      // entrega se acreditaria lo que todavia no ha entregado.
      if (session && puedeCapturarEntradas(session)) {
        operacion.push({ href: '/entradas', label: 'Entradas de mercancia' })
      }
    }
    operacion.push({ href: '/facturas', label: 'Facturas' })
    grupos.push({ label: 'Operacion', items: operacion })
    grupos.push({
      label: 'Documentos',
      items: [
        { href: '/complementos', label: 'Complementos de pago' },
        { href: '/notificaciones', label: 'Avisos' },
        { href: '/mi-informacion', label: 'Mi informacion' },
      ],
    })
  }

  if (esInterno(roles)) {
    const kps: Item[] = []
    if (tiene('KPS_COMPRAS') || tiene('ADMIN_SISTEMA')) {
      kps.push({ href: '/ordenes', label: 'Ordenes de compra' })
    }
    // Registrar que llego la mercancia. Va en el bloque interno y no en el del
    // proveedor porque quien da por recibida la mercancia es almacen: un
    // proveedor firmando su propia entrega se acreditaria lo que todavia no ha
    // entregado. El guard de verdad esta en la pagina y en
    // /api/v1/goods-receipts; esconder el enlace no es seguridad (§06).
    kps.push({ href: '/entradas', label: 'Entradas de mercancia' })
    // Peticiones, Proveedores y Usuarios viven en kps-dashboard, que es el que
    // tiene la conexion con SAP y la administracion. Aqui no quedan.
    if (kps.length > 0) grupos.push({ label: 'KPS', items: kps })
  }

  return grupos
}

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const secret = process.env.JWT_SECRET
  const session = secret ? await verifySession(token, secret) : null

  // Que clase de proveedor es quien entro. La lectura vive en un solo sitio
  // porque de ella dependen tanto esta barra como la pantalla de carga, y dos
  // lecturas separadas del mismo dato es exactamente como acaban
  // contradiciendose el menu y la pantalla a la que lleva.
  //
  // Devuelve null si falla —sin MONGODB_URI, base caida— y la barra se pinta sin
  // la etiqueta. Quedarse sin ella es un incordio; tumbar el portal es otra cosa.
  const proveedor = await getProveedorActual()

  const grupos = navegacion(session, proveedor)

  // Los avisos con los que se pinta la campana la primera vez. Aqui solo se
  // LEEN: materializar los nuevos es cosa del sondeo y de la pantalla de avisos,
  // porque este layout corre en cada navegacion y no vale la pena pagar la
  // escritura en todas. Consecuencia asumida: un aviso recien nacido tarda hasta
  // media vuelta del reloj en aparecer, o sale en cuanto se abre el panel.
  let avisos: ListaAvisos = { avisos: [], noLeidos: 0 }
  if (session?.supplierCode) {
    try {
      avisos = await listarAvisos({ supplierCode: session.supplierCode, userId: session.userId })
    } catch (error) {
      console.warn('[avisos] no se pudieron leer para la topbar:', error)
    }
  }

  return (
    <div className="ar-shell">
      <header className="ar-topbar">
        <Link href="/" className="ar-brand">
          <svg className="ar-brand__mark" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 1 13 12.5H1Z" fill="currentColor" />
          </svg>
          <span>Arcanum</span>
          <span className="ar-brand__sep">·</span>
          <span>Portal de Proveedores</span>
        </Link>

        {/* Arriba queda solo lo que identifica a la EMPRESA: de que tipo de
            proveedor es. Quien entro y el boton de salir bajan al pie de la
            barra lateral. */}
        <div className="ar-brand">
          {proveedor ? (
            <>
              <span
                className="ar-status"
                data-tone={proveedor.bloqueado ? 'danger' : 'ok'}
                title={
                  proveedor.tipo === 'SERVICIO'
                    ? 'Facturas sin orden de compra, con evidencia del servicio prestado.'
                    : 'Facturas contra una entrada de mercancia, a partir de tus ordenes de compra.'
                }
              >
                {proveedor.tipo === 'SERVICIO' ? 'Proveedor de servicios' : 'Proveedor comercial'}
              </span>
              <span className="ar-brand__sep">·</span>
              <span>{proveedor.nombre}</span>
              <span className="ar-brand__sep">·</span>
              <span className="ar-brand__context">{session?.supplierCode}</span>
            </>
          ) : (
            <span className="ar-brand__context">KPS</span>
          )}
          {session && <Notificaciones inicial={avisos} />}
        </div>
      </header>

      <div className="ar-body">
        <nav className="ar-sidebar pf-sidebar" aria-label="Navegacion principal">
          <div className="pf-nav">
            {grupos.map((grupo) => (
              <div className="ar-nav__group" key={grupo.label}>
                <span className="ar-nav__label">{grupo.label}</span>
                {grupo.items.map((item) => (
                  <a key={`${grupo.label}-${item.href}`} href={item.href} className="ar-nav__item">
                    <span>{item.label}</span>
                    {item.count !== undefined && <span className="ar-nav__count">{item.count}</span>}
                  </a>
                ))}
              </div>
            ))}
          </div>

          {session && (
            <div className="pf-user">
              <div className="pf-user__name" title={session.email}>
                {session.name}
              </div>
              <div className="pf-user__meta">{session.supplierCode ?? session.email}</div>
              <a href="/api/v1/auth/logout" className="ar-nav__item pf-salir">
                <span>Cerrar sesion</span>
              </a>
            </div>
          )}
        </nav>

        <main className="ar-main">{children}</main>
      </div>

      <style>{`
        /* Clases propias, no redefiniciones: .ar-sidebar no es columna flex y
           hace falta que lo sea para anclar el pie abajo del todo. */
        .pf-sidebar {
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .pf-nav { flex: 1 1 auto; overflow-y: auto; }
        .pf-user {
          flex: none;
          margin-top: auto;
          padding-top: var(--ar-s3);
          border-top: 1px solid var(--ar-line);
        }
        .pf-user__name {
          padding: 0 var(--ar-s6);
          font-size: 13px;
          font-weight: 600;
          color: var(--ar-ink);
          /* El correo de un proveedor puede ser largo; se corta en vez de
             ensanchar la barra. */
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pf-user__meta {
          padding: 0 var(--ar-s6) var(--ar-s2);
          font-family: var(--ar-mono);
          font-size: 11px;
          color: var(--ar-ink-3);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pf-salir { color: var(--ar-ink-3); }
        .pf-salir:hover { color: var(--ar-danger); }
      `}</style>
    </div>
  )
}
