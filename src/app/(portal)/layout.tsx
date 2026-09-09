import Image from 'next/image'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, esInterno, verifySession, type SessionPayload } from '@/lib/auth/session'
import { SupplierType } from '@/lib/domain/enums'
import { listarAvisos, type ListaAvisos } from '@/lib/notifications'
import { puedeCapturarEntradas } from '@/lib/receipts/acceso'
import { getProveedorActual, type ProveedorActual } from '@/lib/suppliers/current'
import { LogOut } from './iconos'
import NavPortal from './nav'
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

/**
 * El menu lateral.
 *
 * UN SOLO MENU, NO DOS. Antes el portal se partia en un bloque de proveedor y
 * otro de KPS, y el personal interno acababa viendo dos enlaces sueltos —ordenes
 * y entradas— sin manera de llegar a las demas pantallas desde la barra. Pero
 * esas pantallas SI saben atender a un interno: /facturas y /complementos leen
 * en modo agregado —todos los proveedores, no uno— y /notificaciones y
 * /mi-informacion explican por su cuenta que son de un proveedor concreto. El
 * menu era lo unico que no se habia enterado.
 *
 * Ahora la lista es una sola y cada renglon se gana su sitio por separado.
 */
function navegacion(session: SessionPayload | null, proveedor: ProveedorActual | null): Grupo[] {
  if (!session) return []
  const roles = session.roles
  const tiene = (r: string) => (roles as readonly string[]).includes(r)
  const interno = esInterno(roles)
  const esProveedor = tiene('PROVEEDOR_MERCANCIA') || tiene('PROVEEDOR_SERVICIO')

  // Ni proveedor ni personal de KPS: no hay portal que ofrecerle.
  if (!interno && !esProveedor) return []

  const operacion: Item[] = [{ href: '/', label: 'Inicio' }]

  // QUIEN DECIDE SI HAY ORDENES DE COMPRA.
  //
  // Para un proveedor, el TIPO que tiene en la base, no el rol de su usuario.
  // Los dos dicen lo mismo casi siempre, pero cuando KPS le cambia el tipo a un
  // proveedor el rol de sus usuarios no se reescribe solo: mandar sobre el rol
  // dejaria un menu que ofrece "Ordenes de compra" a quien ya factura sin ellas.
  // Ante la duda —lectura fallida, proveedor sin ficha— se cae del lado de no
  // ofrecer la seccion.
  //
  // Para personal de KPS manda el rol, porque no tiene ficha de proveedor que
  // mirar: la pantalla le enseña las ordenes de todos.
  //
  // Las dos vias van en OR y no en un ternario sobre `interno`: quien lleve los
  // dos sombreros —un usuario de KPS que ademas factura— entra por cualquiera de
  // ellas. Ramificar sobre el rol interno le quitaria la seccion que le toca
  // como proveedor.
  const veOrdenes =
    (interno && (tiene('KPS_COMPRAS') || tiene('ADMIN_SISTEMA'))) ||
    proveedor?.tipo === SupplierType.MERCANCIA
  if (veOrdenes) operacion.push({ href: '/ordenes', label: 'Órdenes de compra' })

  // Quien da por recibida la mercancia es almacen: un proveedor firmando su
  // propia entrega se acreditaria lo que todavia no ha entregado. Por eso el
  // interno la ve siempre, y el proveedor solo con `FEATURE_ENTRADAS_PROVEEDOR`,
  // que existe para recorrer el flujo entero con una sola sesion en pruebas y va
  // apagada en produccion. El guard de verdad esta en la pagina y en
  // /api/v1/goods-receipts; esconder el enlace no es seguridad (§06).
  const veEntradas =
    interno || (proveedor?.tipo === SupplierType.MERCANCIA && puedeCapturarEntradas(session))
  if (veEntradas) operacion.push({ href: '/entradas', label: 'Entradas de mercancia' })

  operacion.push({ href: '/facturas', label: 'Facturas' })

  // Mi informacion es de UN proveedor concreto. Se le sigue ofreciendo al
  // interno a proposito —tiene que poder recorrer el portal entero para
  // revisarlo— y la pantalla explica que hace falta una cuenta vinculada. Un
  // enlace que dice por que no aplica es mejor que un hueco en el menu que
  // obliga a adivinar la URL.
  //
  // AVISOS NO ESTA EN EL MENU a proposito. La campana de la barra ya es su
  // entrada: lista los avisos, marca uno al abrirlo, marca todos de golpe y
  // lleva a /notificaciones con "Ver todas". Un renglon en el menu duplicaba
  // esa puerta y ademas competia con el contador rojo, que es el que de verdad
  // avisa. La ruta sigue viva; lo que se quita es la segunda entrada.
  //
  // Peticiones, Proveedores y Usuarios viven en kps-dashboard, que es el que
  // tiene la conexion con SAP y la administracion. Aqui no quedan.
  return [
    { label: 'Operación', items: operacion },
    {
      label: 'Documentos',
      items: [
        { href: '/complementos', label: 'Complementos de pago' },
        { href: '/mi-informacion', label: 'Mi perfil' },
      ],
    },
  ]
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
    <div className="cr-shell">

      <header className="cr-topbar">
        {/* La marca ocupa una columna del ancho del sidebar: su borde derecho y
            el del sidebar son la misma linea vertical. Ver §04 de cronos.css.

            SOLO EL LOGOTIPO. Antes llevaba al lado el rotulo "PORTAL DE
            PROVEEDORES", que obligaba a dejar la marca en 92px para que el
            rotulo cupiera en dos lineas. El nombre del producto ya lo dice cada
            pantalla en su titulo, asi que la columna entera es del logotipo. */}
        <Link href="/" className="cr-brand">
          <Image
            className="cr-brand__logo"
            src="/group-kps.png"
            alt="Group KPS"
            width={431}
            height={150}
            priority
          />
        </Link>

        {/* Arriba queda solo lo que identifica a la EMPRESA a la que se factura.
            Quien entro y el boton de salir bajan al pie de la barra lateral.
            El punto lleva el estado —verde en operacion, rojo bloqueada—: es
            color de estatus en un dot, que es donde la spec lo permite. */}
        <div className="cr-topbar__context">
          {proveedor ? (
            <>
              <span
                className="cr-topbar__empresa"
                title={
                  (proveedor.tipo === 'SERVICIO'
                    ? 'Proveedor de servicios · Facturas sin orden de compra, con evidencia del servicio prestado.'
                    : 'Proveedor comercial · Facturas contra una entrada de mercancia, a partir de tus ordenes de compra.') +
                  (proveedor.bloqueado ? ' · Cuenta bloqueada.' : '')
                }
              >
                <span className={proveedor.bloqueado ? 'cr-dot cr-dot--danger' : 'cr-dot cr-dot--ok'} />
                {proveedor.nombre}
              </span>
              <span className="cr-brand__context cr-mono">{session?.supplierCode}</span>
            </>
          ) : (
            <span className="cr-topbar__empresa">
              <span className="cr-topbar__etiqueta">Portal de proveedores</span>
              <span className="cr-topbar__organizacion">KPS</span>
            </span>
          )}
        </div>

        <div className="cr-topbar__right">{session && <Notificaciones inicial={avisos} />}</div>
      </header>

      <div className="cr-body">
        <nav className="cr-sidebar pf-sidebar" aria-label="Navegacion principal">
          <NavPortal grupos={grupos} />

          {session && (
            <div className="pf-user">
              <Link href="/mi-informacion" className="pf-user__cuenta" aria-label="Ver mi perfil">
              <div className="pf-user__name" title={session.email}>
                {session.name}
              </div>
              <div className="pf-user__meta" title={session.supplierCode ?? session.email}>{session.supplierCode ?? session.email}</div>
              </Link>
              {/* Sigue siendo <a> y no <Link>: es un endpoint de la API que
                  borra la cookie y redirige, no una ruta del portal. */}
              <a href="/api/v1/auth/logout" className="cr-nav__item pf-salir">
                <LogOut className="cr-nav__icon" />
                <span className="cr-nav__text">Cerrar sesión</span>
              </a>
            </div>
          )}
        </nav>

        <main className="cr-main">{children}</main>
      </div>

      <style>{`
        /* Clases propias, no redefiniciones: .cr-sidebar no es columna flex y
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
          padding-top: var(--cr-s3);
          border-top: 1px solid var(--cr-line);
        }
        .pf-user__name {
          /* Mismo sangrado que el texto de un .cr-nav__item: el padding del
             renglon (s3) sobre el padding de la barra. Con s6 el pie quedaba
             12px mas adentro que la lista de arriba. */
          padding: 0 var(--cr-s3);
          font-size: 13px;
          font-weight: 600;
          color: var(--cr-ink);
          /* El correo de un proveedor puede ser largo; se corta en vez de
             ensanchar la barra. */
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pf-user__meta {
          padding: 0 var(--cr-s3) var(--cr-s2);
          font-family: var(--cr-mono);
          font-size: 11px;
          color: var(--cr-ink-3);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pf-salir { color: var(--cr-ink-3); }
        .pf-salir:hover { color: var(--cr-danger); background: var(--cr-danger-tint); }

        /* En movil la barra deja de ser columna: es una sola tira que se
           desliza. En columna, el pie de usuario se comia 100px del alto de
           CADA pantalla antes de llegar al contenido. */
        @media (max-width: 900px) {
          .pf-sidebar { flex-direction: row; align-items: center; gap: var(--cr-s2); }
          .pf-nav {
            /* "min-width: 0" es lo que hace que la tira se deslice en vez de
               ensanchar la pagina: un item flex arranca en "nunca mas angosto
               que mi contenido", asi que con siete enlaces dentro empujaba el
               documento a 658px de ancho y sacaba barra horizontal en el body,
               con la topbar yendose fuera de cuadro al hacer scroll. */
            flex: 1 1 auto; min-width: 0; display: flex; gap: var(--cr-s2);
            overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
          }
          .pf-nav::-webkit-scrollbar { display: none; }
          .pf-user {
            display: flex; align-items: center; flex: none;
            margin: 0; padding: 0 0 0 var(--cr-s2);
            border-top: 0; border-left: 1px solid var(--cr-line);
          }
          /* Quien entro ya se lee en "Mi informacion"; aqui solo tiene que
             quedar la salida. */
          .pf-user__name, .pf-user__meta { display: none; }
          .pf-salir { white-space: nowrap; }
        }
      `}</style>
    </div>
  )
}
