/**
 * Iconos del menu lateral.
 *
 * Son los trazos de lucide (ISC) dibujados a mano en vez de instalar
 * `lucide-react`: el portal tiene 16 dependencias y ninguna es de interfaz —el
 * resto de los iconos, como la campana de avisos, ya se escriben asi—. Traer un
 * paquete entero para siete glifos no se paga.
 *
 * Se copian los trazos y no unos propios para que el menu se vea IDENTICO al de
 * Industria Real, que si usa lucide: mismo viewBox de 24, mismo grosor de 2 y
 * mismas terminaciones redondeadas.
 *
 * Los iconos del menu NO son decorativos —distinguen un renglon de otro de un
 * vistazo—, pero tampoco aportan nada al lector de pantalla, que ya lee la
 * etiqueta al lado. Por eso van con `aria-hidden`.
 */

type Props = { className?: string }

function Svg({ children, className }: Props & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function LayoutDashboard(p: Props) {
  return (
    <Svg {...p}>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </Svg>
  )
}

function ShoppingCart(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </Svg>
  )
}

function Truck(p: Props) {
  return (
    <Svg {...p}>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Svg>
  )
}

function FileCheck(p: Props) {
  return (
    <Svg {...p}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="m9 15 2 2 4-4" />
    </Svg>
  )
}

function Coins(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
      <path d="M7 6h1v4" />
      <path d="m16.71 13.88.7.71-2.82 2.82" />
    </Svg>
  )
}

function Bell(p: Props) {
  return (
    <Svg {...p}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Svg>
  )
}

function Building2(p: Props) {
  return (
    <Svg {...p}>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
      <path d="M10 18h4" />
    </Svg>
  )
}

function LogOut(p: Props) {
  return (
    <Svg {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </Svg>
  )
}

/**
 * Icono por ruta.
 *
 * Se indexa por `href` y no por etiqueta: la etiqueta es texto de pantalla y
 * puede reescribirse; la ruta es la identidad del renglon.
 */
const POR_RUTA: Record<string, (p: Props) => React.ReactElement> = {
  '/': LayoutDashboard,
  '/ordenes': ShoppingCart,
  '/entradas': Truck,
  '/facturas': FileCheck,
  '/complementos': Coins,
  '/notificaciones': Bell,
  '/mi-informacion': Building2,
}

export function IconoDeRuta({ href, className }: { href: string; className?: string }) {
  const Icono = POR_RUTA[href]
  // Una ruta nueva sin icono no rompe el menu: se queda sin glifo y el renglon
  // se sigue leyendo. Peor seria un hueco de alto distinto o un icono de relleno
  // que no significa nada.
  if (!Icono) return null
  return <Icono className={className} />
}

/**
 * Lupa y aspa del buscador de listados.
 *
 * No van en `POR_RUTA` porque no identifican una ruta: son las dos acciones de
 * la caja de busqueda. Se exportan sueltas y llevan su propia etiqueta en el
 * boton que las envuelve, que es quien la anuncia.
 */
function Lupa(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  )
}

function Aspa(p: Props) {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  )
}

export { LogOut, Lupa, Aspa }
