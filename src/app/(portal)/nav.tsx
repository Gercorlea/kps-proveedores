'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { IconoDeRuta } from './iconos'

export interface NavItem {
  href: string
  label: string
  count?: number
}

export interface NavGrupo {
  label: string
  items: NavItem[]
}

/**
 * El menu lateral.
 *
 * ES CLIENTE POR UNA SOLA RAZON: marcar el renglon activo. `usePathname` no
 * existe en el servidor, y hasta ahora el menu se pintaba con <a> planos sin
 * `aria-current`, asi que la regla `.cr-nav__item[aria-current="page"]` del
 * sistema no llegaba a aplicarse nunca y ningun renglon se resaltaba. Los datos
 * —quien ve que— se siguen decidiendo en el servidor y llegan ya resueltos por
 * `grupos`: aqui no hay ninguna decision de permisos.
 *
 * Los enlaces pasan a `next/link` de paso, que es lo que evita recargar el
 * documento entero al cambiar de pantalla.
 */
export default function NavPortal({ grupos }: { grupos: NavGrupo[] }) {
  const pathname = usePathname()

  // Todas las bases del menu, para desempatar mas abajo.
  const bases = grupos.flatMap((g) => g.items.map((i) => i.href))

  /**
   * Un renglon esta activo si la ruta ES su base o cuelga de ella.
   *
   * DOS SALVEDADES, las dos por el mismo motivo: "/" es prefijo de todo.
   *
   *   1. La raiz solo empata EXACTA. Con la regla de prefijo, "Inicio" se
   *      quedaba marcado en /pagos y /recibos —pantallas que existen pero no
   *      estan en el menu—, senalando un renglon que no lleva ahi.
   *   2. Entre dos bases que empatan gana la mas larga, que es lo que hace que
   *      en /ordenes/123 se marque "Ordenes de compra" y no otra cosa.
   */
  const activo = (href: string) => {
    if (href === '/') return pathname === '/'
    const conBarra = href.endsWith('/') ? href : href + '/'
    if (pathname !== href && !pathname.startsWith(conBarra)) return false
    return !bases.some((otra) => {
      if (otra.length <= href.length) return false
      const otraConBarra = otra.endsWith('/') ? otra : otra + '/'
      return pathname === otra || pathname.startsWith(otraConBarra)
    })
  }

  return (
    <div className="pf-nav">
      {grupos.map((grupo) => (
        <div className="cr-nav__group" key={grupo.label}>
          <span className="cr-nav__label">{grupo.label}</span>
          {grupo.items.map((item) => {
            const esActivo = activo(item.href)
            return (
              <Link
                key={`${grupo.label}-${item.href}`}
                href={item.href}
                className="cr-nav__item"
                {...(esActivo ? { 'aria-current': 'page' as const } : {})}
              >
                <IconoDeRuta href={item.href} className="cr-nav__icon" />
                <span className="cr-nav__text">{item.label}</span>
                {item.count !== undefined && <span className="cr-nav__count">{item.count}</span>}
              </Link>
            )
          })}
        </div>
      ))}
    </div>
  )
}
