import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import {
  ETIQUETA_PROVEEDOR,
  InvoiceStatus,
  TONO_ESTATUS,
  type TonoEstatus,
} from '@/lib/domain/enums'
import { fromDecimal128, invoices, supplierScope, type InvoiceDoc } from '@/lib/mongo'
import type { LineaEntrada } from '@/lib/matching/recepciones'
import { getSapClient, SapError, type B1DocumentLine, type B1PurchaseOrder } from '@/lib/sap'
import { leerEntradasDeOrdenes } from '@/lib/sap/entradas'
import { describirPlazo, leerPlazos, type Plazo } from '@/lib/sap/plazos'
import { paginar, Paginador } from '../paginacion'
import { Buscador } from './buscador'

/**
 * P04 · Estado de cuenta del proveedor.
 *
 * DOS PESTAÑAS, TRES NIVELES. Rediseño pedido por el cliente sobre la maqueta
 * que mando (`Portal_Proveedores_Definitivo_Final_V2.html`). Antes eran cuatro
 * pestañas planas —Por entregar / Por facturar / Facturado / Pagado— y una
 * lista de entradas sueltas ordenada por fecha. El proveedor tenia que cruzar a
 * mano que entrada era de que orden, y salir a otra pantalla para ver de que
 * articulo hablaba cada una.
 *
 * Ahora la unidad de lectura es LA ORDEN, y se abre hacia dentro sin cambiar de
 * pagina:
 *
 *   Nivel 1 · ORDEN     — cuanto falta por entregar, cuanto por facturar y que
 *                         tanto de la orden va facturado.
 *   Nivel 2 · ARTICULO  — pedido / recibido / facturado / pendiente por renglon.
 *   Nivel 3 · ENTRADA   — cada entrega, su importe, su factura y el boton de
 *                         cargarla.
 *
 * Y dos pestañas, no cuatro:
 *
 *   Por facturar        — lo que el proveedor todavia tiene que cobrar. Incluye
 *                         lo que ya subio y KPS aun revisa, porque sigue siendo
 *                         dinero suyo que no ha cobrado. Los chips separan
 *                         "me toca a mi" de "le toca a KPS".
 *   Facturas aprobadas  — lo que KPS ya autorizo, pagado o por pagar.
 *
 * "Por entregar" desaparecio como pestaña pero no como dato: vive en la fila de
 * cada orden, que es donde significa algo.
 *
 * QUE SE MANTIENE DEL ACUERDO ANTERIOR. La conversacion sigue siendo de
 * IMPORTES: cada nivel abre con dinero y las piezas aparecen solo dentro del
 * articulo, que es donde se discute un faltante. Fuera de la vista, por acuerdo
 * explicito: el nombre del proveedor (salvo para internos) y los impuestos
 * desglosados. El numero de entrada sigue siendo EL punto de conexion entre KPS
 * y el proveedor.
 *
 * Lee de Business One en vivo. B1 es la fuente de verdad de las ordenes y aqui
 * no hay cache local: lo que se ve es lo que hay en SAP en este momento.
 *
 * AISLAMIENTO. El filtro por proveedor va en el `$filter` que se manda a B1, no
 * despues de leer. Traerse todas las ordenes de la empresa y descartar las
 * ajenas en memoria pondria los datos de todos los proveedores en el proceso, y
 * un descuido bastaria para enseñarlos.
 *
 * Nota de arquitectura: §04 principio 2 dice que ninguna llamada a SAP ocurre
 * dentro de un request HTTP. Esta pantalla lo incumple a proposito: es una
 * lectura, no una escritura, y encolarla obligaria al proveedor a esperar sin
 * saber a que. Lo que si tiene que ir a la cola es toda escritura hacia B1.
 */
export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ q?: string; p?: string; tab?: string; f?: string; sel?: string }>
}

/**
 * Tope de ordenes que se traen por visita.
 *
 * Se paginan en memoria porque el $filter de este Service Layer no tiene
 * `toupper` —responde "Property 'toupper' of 'Document' is invalid"— y su
 * `contains` distingue mayusculas, asi que buscar del lado de B1 obligaria a
 * escribir la razon social con las mayusculas exactas.
 */
const MAX_ORDENES = 1000

/**
 * `historico` existe porque una entrada se puede facturar DENTRO de Business One
 * sin pasar por el portal, y asi entro casi todo lo viejo: 286 de las 318
 * entradas de la instancia. No caben en "Por facturar" —no admiten factura— ni
 * en "Facturas aprobadas" —el portal no tiene ninguna que enseñar—, y dejarlas
 * fuera de las dos las volveria imposibles de encontrar por numero de entrada,
 * que es una de las tres cosas que busca el buscador.
 */
type Pestana = 'facturar' | 'aprobadas' | 'historico'

const PESTANAS: Array<{ id: Pestana; label: string }> = [
  { id: 'facturar', label: 'Por facturar' },
  { id: 'aprobadas', label: 'Facturas aprobadas' },
  { id: 'historico', label: 'Facturadas en Business One' },
]

/**
 * En que punto esta una entrega respecto de su factura.
 *
 * Es el eje de toda la pantalla: decide la pestaña, el chip, el sello y si hay
 * boton de cargar. Se deriva del estatus de la factura que manda, nunca se
 * guarda.
 */
type EstadoEntrada = 'por_subir' | 'en_revision' | 'aprobada' | 'pagada' | 'facturada_b1'

/** Chips de "Por facturar": separan lo que le toca al proveedor de lo que no. */
type ChipFacturar = 'todas' | 'por_subir' | 'en_revision'
/** Chips de "Facturas aprobadas". */
type ChipAprobadas = 'todas' | 'por_pagar' | 'pagadas'
type Chip = ChipFacturar | ChipAprobadas

const CHIPS: Record<Pestana, ReadonlyArray<{ id: Chip; label: string }>> = {
  facturar: [
    { id: 'todas', label: 'Todas' },
    { id: 'por_subir', label: 'Por cargar factura' },
    { id: 'en_revision', label: 'En revision' },
  ],
  aprobadas: [
    { id: 'todas', label: 'Todas' },
    { id: 'por_pagar', label: 'Por pagar' },
    { id: 'pagadas', label: 'Pagadas' },
  ],
  // Sin chips: no hay nada que afinar, todas estan en el mismo punto.
  historico: [{ id: 'todas', label: 'Todas' }],
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * Cantidades, no importes: hasta tres decimales y sin ceros de relleno.
 *
 * "600" y no "600.00", porque son sacos. Pero "4.141" si el articulo se mide en
 * toneladas y llego una fraccion; redondear ahi inventaria mercancia.
 */
function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 }).format(value)
}

function formatDate(raw: string | null | undefined): string {
  if (!raw) return '—'
  // El Service Layer devuelve 'YYYY-MM-DD'. Se formatea sin construir un Date
  // para no desplazar el dia por la zona horaria del servidor.
  const [y, m, d] = raw.slice(0, 10).split('-')
  const meses = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
  const mes = meses[Number(m) - 1] ?? m
  return `${d} ${mes} ${y}`
}

/** Fechas que vienen de Mongo como Date. Se formatean en UTC, como las de B1. */
function formatFecha(valor: Date | null | undefined): string {
  if (!valor) return '—'
  return formatDate(valor.toISOString())
}

/**
 * Minusculas y sin acentos: quien busca "pena" espera encontrar "Peña", y quien
 * teclea rapido no pone el acento.
 */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/**
 * Compacta para comparar: quita todo lo que no sea letra o numero. La tabla
 * muestra "OC 1098" y "E 501", asi que eso es lo que la gente copia al buscador:
 * "OC 1098", "oc1098" y "1098" tienen que ser el mismo termino.
 */
function compacto(texto: string): string {
  return normalizar(texto).replace(/[^a-z0-9]/g, '')
}

type Resultado =
  | { ok: true; ordenes: readonly B1PurchaseOrder[]; truncado: boolean }
  | { ok: false; error: string }

async function cargar(cardCode: string | undefined): Promise<Resultado> {
  const sap = getSapClient()
  const ordenes: B1PurchaseOrder[] = []
  let truncado = false

  try {
    let skip = 0
    for (;;) {
      // Abiertas Y cerradas: el estado de cuenta tambien enseña lo ya pagado, y
      // esas ordenes casi siempre estan cerradas en B1.
      const page = await sap.listPurchaseOrders({ openOnly: false, cardCode, skip })
      ordenes.push(...page.items)
      // Una pagina vacia con `nextSkip` dejaria el cursor donde estaba: se corta
      // aqui para no quedarse dando vueltas contra B1.
      if (page.nextSkip === undefined || page.items.length === 0) break
      if (ordenes.length >= MAX_ORDENES) {
        truncado = true
        break
      }
      skip = page.nextSkip
    }
    return { ok: true, ordenes, truncado }
  } catch (error) {
    if (error instanceof SapError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : 'Error desconocido.' }
  }
}

/**
 * Los renglones de las ordenes que caben en la pagina, de una sola consulta.
 *
 * El nivel 2 del acordeon necesita lo PEDIDO por articulo, y eso vive en las
 * lineas de la orden, que el listado no trae. Pedirlas para el historico entero
 * seria carisimo; para las 15 que se ven, es un viaje.
 *
 * Si falla se devuelve el mapa vacio y el acordeon lo dice en su sitio: perder
 * los renglones no puede tumbar el estado de cuenta, que es lo que el proveedor
 * vino a ver.
 */
async function renglonesDeOrdenes(
  docEntries: readonly number[],
  cardCode: string | undefined,
): Promise<ReadonlyMap<number, readonly B1DocumentLine[]>> {
  const mapa = new Map<number, readonly B1DocumentLine[]>()
  if (docEntries.length === 0) return mapa
  const page = await getSapClient().listPurchaseOrdersWithLines({
    docEntries,
    ...(cardCode ? { cardCode } : {}),
    top: docEntries.length,
  })
  for (const oc of page.items) mapa.set(oc.DocEntry, oc.DocumentLines ?? [])
  return mapa
}

// ---------------------------------------------------------------------------
// Facturas del portal, indexadas por la entrada que facturan (regla M3: una
// factura por entrada; `baseEntry` es el DocEntry de la entrada).
// ---------------------------------------------------------------------------

/**
 * Como se le dice al proveedor cada estatus, con su tono.
 *
 * NO define nada: lee `ETIQUETA_PROVEEDOR` y `TONO_ESTATUS`, que son del
 * dominio y los comparte todo el portal. Antes esta pantalla tenia su propio
 * mapa y acabo diciendo "Registrada en KPS" donde /facturas decia "Registrada":
 * la misma factura con dos nombres segun donde se mirara.
 *
 * `status` llega como `string` desde Mongo, asi que si trae un valor que el
 * dominio no conoce se muestra tal cual en vez de un hueco.
 */
function estatusFactura(status: string): { label: string; tone: TonoEstatus } {
  const s = status as InvoiceStatus
  return { label: ETIQUETA_PROVEEDOR[s] ?? status, tone: TONO_ESTATUS[s] ?? null }
}

/** Facturas que dejan la entrada en "Pagada". */
const PAGADAS: readonly string[] = [InvoiceStatus.PAGADA, InvoiceStatus.CERRADA]

/**
 * Facturas que KPS ya autorizo: el dinero esta comprometido.
 *
 * `ERROR_SAP` entra aqui, y no en revision, por el mismo criterio que
 * `invoices/resumen`: el registro en B1 fallo del lado de KPS, la factura ya
 * estaba aprobada y al proveedor se le enseña "Registrando". Contarla como
 * pendiente lo mandaria a arreglar algo que no es suyo.
 */
const APROBADAS: readonly string[] = [
  InvoiceStatus.APROBADA_PAGO,
  InvoiceStatus.REGISTRADA_SAP,
  InvoiceStatus.CUENTAS_POR_PAGAR,
  InvoiceStatus.ERROR_SAP,
]

/**
 * Facturas en manos de KPS. El proveedor no tiene nada que hacer con ellas,
 * pero tampoco ha cobrado: por eso siguen en "Por facturar" y no en la otra
 * pestaña.
 *
 * OJO CON LAS DOS DE NOTA DE CREDITO, que se parecen y no son lo mismo:
 *   NC_EN_REVISION  — el proveedor ya mando la nota y KPS la esta viendo. Aqui.
 *   NC_SOLICITADA   — KPS se la esta PIDIENDO. Esa es del proveedor, y va con
 *                     las devueltas: `invoices/resumen` la pone en
 *                     REQUIEREN_ACCION junto a EN_CORRECCION, y ademas dispara
 *                     un aviso (`AVISO_POR_ESTATUS`). Meterla aqui la escondia
 *                     bajo "En revision" y la dejaba sin boton, que es tanto
 *                     como pedirle una nota de credito y no decirle donde.
 */
const EN_REVISION: readonly string[] = [
  InvoiceStatus.EN_VALIDACION,
  InvoiceStatus.EN_COTEJO,
  InvoiceStatus.NC_EN_REVISION,
  InvoiceStatus.EN_REVISION,
]

interface FacturaDeEntrada {
  folio: string
  status: string
  emitida: Date | null
  capturada: Date | null
  importe: number | null
}

async function facturasPorEntrada(ctx: {
  supplierCode?: string | null
  internal: boolean
}): Promise<Map<number, FacturaDeEntrada[]>> {
  const docs = await (await invoices())
    .find(supplierScope<InvoiceDoc>({ baseEntry: { $ne: null } }, ctx), {
      projection: { folio: 1, status: 1, total: 1, createdAt: 1, issueDate: 1, baseEntry: 1 },
    })
    .toArray()

  const mapa = new Map<number, FacturaDeEntrada[]>()
  for (const d of docs) {
    if (d.baseEntry === null || d.baseEntry === undefined) continue
    mapa.set(d.baseEntry, [
      ...(mapa.get(d.baseEntry) ?? []),
      {
        folio: d.folio,
        status: d.status,
        emitida: d.issueDate ?? null,
        capturada: d.createdAt ?? null,
        importe: d.total ? Number(fromDecimal128(d.total)?.toString() ?? 0) : null,
      },
    ])
  }
  return mapa
}

/**
 * La factura QUE MANDA de una entrada: la pagada, si no la aprobada, si no la
 * que KPS revisa, si no la mas reciente de las devueltas. Una entrada puede
 * acumular varias —se rechaza una y se vuelve a cargar— pero al proveedor se le
 * enseña en que quedo.
 */
function facturaQueManda(lista: readonly FacturaDeEntrada[] | undefined): FacturaDeEntrada | null {
  if (!lista || lista.length === 0) return null
  return (
    lista.find((f) => PAGADAS.includes(f.status)) ??
    lista.find((f) => APROBADAS.includes(f.status)) ??
    lista.find((f) => EN_REVISION.includes(f.status)) ??
    [...lista].sort((a, b) => (b.capturada?.getTime() ?? 0) - (a.capturada?.getTime() ?? 0))[0]
  )
}

/**
 * En que punto esta la entrega.
 *
 * Sin factura, o con una devuelta o rechazada, el dinero vuelve a estar
 * pendiente de facturar y le toca al proveedor: `por_subir`.
 *
 * SALVO QUE B1 YA LA HAYA FACTURADO. La factura se puede registrar dentro de
 * Business One sin pasar por el portal —es como entro todo el historico—, y
 * entonces el portal no tiene ningun documento que enseñar aunque la entrada
 * este cerrada. Llamar a eso `por_subir` ponia 286 de las 318 entradas de la
 * instancia en la pestaña "Por facturar" ofreciendo cargar una factura que B1
 * rechaza: la entrada cerrada ya no admite otra.
 *
 * No se dice "aprobada" ni "pagada" porque el portal no sabe nada de esa
 * factura; se dice lo unico que consta.
 */
function estadoDe(factura: FacturaDeEntrada | null, abiertaEnB1: boolean): EstadoEntrada {
  if (!factura) return abiertaEnB1 ? 'por_subir' : 'facturada_b1'
  if (PAGADAS.includes(factura.status)) return 'pagada'
  if (APROBADAS.includes(factura.status)) return 'aprobada'
  if (EN_REVISION.includes(factura.status)) return 'en_revision'
  // Con una factura del portal devuelta o rechazada el dinero vuelve a estar
  // pendiente, y eso manda sobre lo que diga B1.
  return 'por_subir'
}

/**
 * Sello de la entrega, con su tono. El color va en el dot, nunca en la fila.
 *
 * LEE EL MAPA DEL DOMINIO Y NO DECIDE NADA POR SU CUENTA. Antes reescribia el
 * texto por estado —"En revision", "Aprobada", "Pagada"— e imponia `danger` a
 * todo lo que no encajaba, con dos consecuencias:
 *
 *   · Cuatro estatus distintos salian los cuatro como "En revision", y dos como
 *     "Aprobada": el proveedor no podia saber en cual de ellos estaba.
 *   · Un BORRADOR suyo sin enviar se pintaba en rojo, igual que una RECHAZADA,
 *     aunque el mapa lo tenia clasificado como aviso.
 *
 * Con el mapa como unica fuente, cambiar una etiqueta o un tono ahi se refleja
 * en toda la pantalla.
 */
function selloDe(
  factura: FacturaDeEntrada | null,
  estado: EstadoEntrada,
): { texto: string; tone?: string } {
  // Sin tono: no es un pendiente del proveedor ni un problema, es un hecho.
  if (!factura && estado === 'facturada_b1') return { texto: 'Facturada en Business One' }
  if (!factura) return { texto: 'Sin factura', tone: 'warn' }
  const estatus = estatusFactura(factura.status)
  return { texto: `${estatus.label} · ${factura.folio}`, tone: estatus.tone ?? undefined }
}

// ---------------------------------------------------------------------------
// Modelo de la pantalla
// ---------------------------------------------------------------------------

/** Una entrega de mercancia contra una orden, ya resuelta contra su factura. */
interface Entrega {
  docEntry: number
  docNum: number
  fecha: string
  /** Importe CON IVA de lo que esta entrada le entrego a esta orden. */
  importe: number
  /**
   * La factura que fija el estado de la entrada. Ver `facturaQueManda`.
   *
   * NO es "la factura de la entrada": una entrada puede llevar VARIAS —una
   * parcial, una nota de credito, un reemplazo tras una devolucion—. Esta es
   * solo la que manda para pintar el estado; la lista completa va en
   * `facturas`, y es la que hay que enseñar cuando se abre el detalle.
   */
  factura: FacturaDeEntrada | null
  /** Todas las facturas cargadas contra esta entrada, la mas reciente primero. */
  facturas: readonly FacturaDeEntrada[]
  estado: EstadoEntrada
  /** Cantidad por renglon de la orden: `BaseLine` -> piezas. */
  cantidadPorLinea: ReadonlyMap<number, number>
}

/** Una orden con todo lo que colgo de ella. Es la fila del nivel 1. */
interface FilaOC {
  oc: B1PurchaseOrder
  entregas: Entrega[]
  /** Importe con IVA de todo lo recibido. */
  entregado: number
  /** Lo que la orden todavia espera, en dinero. Cero si B1 la cerro. */
  porEntregar: number
  /** Entregado sin factura, o con una devuelta. Le toca al proveedor. */
  porSubir: number
  /** Entregado y facturado, con KPS revisando. */
  enRevision: number
  /** Entregado, facturado y autorizado por KPS. */
  aprobado: number
  /**
   * Porcentaje de la orden ya facturado.
   *
   * Cuenta tambien lo facturado DENTRO de Business One. Con solo lo aprobado en
   * el portal, una orden cuyas entradas se facturaron en B1 salia al 0% junto a
   * la frase "todas facturadas" en la misma ficha.
   */
  pctFacturado: number
  /** Llego una parte y el resto sigue esperando. */
  parcial: boolean
}

/** Una factura ya autorizada. Es la fila de la segunda pestaña. */
interface FilaAprobada {
  oc: B1PurchaseOrder
  entrega: Entrega
  factura: FacturaDeEntrada
  pagada: boolean
}

function construir(args: {
  ordenes: readonly B1PurchaseOrder[]
  porOrden: ReadonlyMap<number, readonly LineaEntrada[]>
  facturas: Map<number, FacturaDeEntrada[]>
}): { porFacturar: FilaOC[]; aprobadas: FilaAprobada[]; historicas: FilaOC[] } {
  const porFacturar: FilaOC[] = []
  const aprobadas: FilaAprobada[] = []
  const historicas: FilaOC[] = []

  for (const oc of args.ordenes) {
    const lineas = args.porOrden.get(oc.DocEntry) ?? []

    // Una entrada puede surtir la orden en varios renglones: se agrupa por
    // entrada y se suma su importe con IVA, que es como se factura y se compara.
    // La cantidad se guarda por renglon, que es lo que el nivel 2 reparte.
    const porEntrada = new Map<
      number,
      {
        docNum: number
        fecha: string
        importe: number
        cantidadPorLinea: Map<number, number>
        /** Piezas de esta entrada que B1 todavia no ha facturado. */
        porFacturar: number
      }
    >()
    for (const l of lineas) {
      const previo = porEntrada.get(l.docEntry)
      const conIva = (l.importe?.toNumber() ?? 0) + (l.impuesto?.toNumber() ?? 0)
      const cantidades = previo?.cantidadPorLinea ?? new Map<number, number>()
      cantidades.set(l.lineaOrden, (cantidades.get(l.lineaOrden) ?? 0) + l.cantidad.toNumber())
      porEntrada.set(l.docEntry, {
        docNum: l.docNum,
        fecha: l.fecha,
        importe: (previo?.importe ?? 0) + conIva,
        cantidadPorLinea: cantidades,
        // Se suma por renglon: una entrada de cinco articulos con uno solo sin
        // facturar sigue teniendo algo que cobrar.
        porFacturar: (previo?.porFacturar ?? 0) + (l.porFacturar?.toNumber() ?? l.cantidad.toNumber()),
      })
    }

    const entregas: Entrega[] = []
    let entregado = 0
    let porSubir = 0
    let enRevision = 0
    let aprobado = 0
    // Aparte de `aprobado`: no es dinero que el portal tenga que cobrar, pero si
    // cuenta como orden facturada para el avance.
    let facturadoEnB1 = 0

    for (const [docEntry, e] of porEntrada) {
      const facturasDeEntrada = args.facturas.get(docEntry) ?? []
      const factura = facturaQueManda(facturasDeEntrada)
      const estado = estadoDe(factura, e.porFacturar > 0.001)
      const entrega: Entrega = {
        docEntry,
        docNum: e.docNum,
        fecha: e.fecha,
        importe: e.importe,
        factura,
        facturas: facturasDeEntrada,
        estado,
        cantidadPorLinea: e.cantidadPorLinea,
      }
      entregas.push(entrega)
      entregado += e.importe
      if (estado === 'por_subir') porSubir += e.importe
      else if (estado === 'en_revision') enRevision += e.importe
      // Una entrada facturada dentro de B1 no aporta a ningun total del portal:
      // no hay factura que cobrar aqui, y contarla como aprobada inventaria un
      // documento que el portal nunca vio. Va a su propia pestaña.
      else if (estado === 'facturada_b1') facturadoEnB1 += e.importe
      else {
        aprobado += factura?.importe ?? e.importe
        aprobadas.push({ oc, entrega, factura: factura!, pagada: estado === 'pagada' })
      }
    }

    // Las pendientes primero: es lo que el proveedor vino a hacer. Dentro de
    // cada grupo, lo mas viejo arriba, que es lo que lleva mas tiempo sin cobrar.
    // `facturada_b1` al final: no hay nada que hacer con ella.
    const orden: Record<EstadoEntrada, number> = {
      por_subir: 0,
      en_revision: 1,
      aprobada: 2,
      pagada: 3,
      facturada_b1: 4,
    }
    entregas.sort((a, b) => orden[a.estado] - orden[b.estado] || (a.fecha < b.fecha ? -1 : 1))

    // "Por entregar" solo tiene sentido en ordenes que B1 mantiene abiertas: una
    // cerrada ya no espera mercancia, llegara lo que llegara.
    const abierta = oc.DocumentStatus === 'bost_Open' && oc.Cancelled !== 'tYES'
    const porEntregar = abierta ? Math.max(0, oc.DocTotal - entregado) : 0

    const fila: FilaOC = {
      oc,
      entregas,
      entregado,
      porEntregar: porEntregar > 0.01 ? porEntregar : 0,
      porSubir,
      enRevision,
      aprobado,
      pctFacturado:
        oc.DocTotal > 0
          ? Math.min(100, Math.round(((aprobado + facturadoEnB1) / oc.DocTotal) * 100))
          : 0,
      parcial: entregado > 0.01 && porEntregar > 0.01,
    }

    // Entra a la pestaña si queda algo por cobrar o algo por entregar. Una orden
    // enteramente cobrada ya no tiene nada que hacer aqui: vive en la otra.
    if (fila.porSubir > 0.01 || fila.enRevision > 0.01 || fila.porEntregar > 0) porFacturar.push(fila)

    // Una orden puede estar en las dos: una entrada ya facturada en B1 y otra
    // esperando factura del portal. Cada pestaña enseña las entradas que le
    // tocan, no la orden entera.
    if (fila.entregas.some((e) => e.estado === 'facturada_b1')) historicas.push(fila)
  }

  /*
   * PRIMERO LAS QUE TIENEN ENTRADAS. Todo el flujo del portal cuelga de la
   * entrada de mercancia: sin una, no hay nada que facturar. Una orden sin
   * entradas esta en esta pestana solo porque falta que llegue mercancia, asi
   * que ponerla arriba —como hacia el orden por vencimiento— llenaba la primera
   * pagina de filas sobre las que el proveedor no puede hacer nada.
   *
   * Dentro de cada grupo manda el vencimiento: lo que antes vence, arriba.
   */
  porFacturar.sort((a, b) => {
    const conA = a.entregas.length > 0 ? 0 : 1
    const conB = b.entregas.length > 0 ? 0 : 1
    if (conA !== conB) return conA - conB
    return (a.oc.DocDueDate ?? '9999') < (b.oc.DocDueDate ?? '9999') ? -1 : 1
  })
  // Lo mas reciente arriba: es lo que se anda moviendo.
  aprobadas.sort((a, b) => (a.entrega.fecha < b.entrega.fecha ? 1 : -1))

  return { porFacturar, aprobadas, historicas }
}

// ---------------------------------------------------------------------------
// Nivel 2 · el articulo
// ---------------------------------------------------------------------------

interface Articulo {
  lineNum: number
  itemCode: string | null
  descripcion: string
  unidad: string | null
  precio: number
  /** `Quantity` del renglon: lo que se pidio. */
  pedido: number
  /** Suma de las entradas contra este renglon. La cantidad fisica. */
  recibido: number
  /** De lo recibido, lo que ya lleva factura viva. */
  facturado: number
  /** Recibido y todavia sin factura. Es lo que se puede cobrar hoy. */
  pendiente: number
  /** Las entregas que tocaron este renglon, con su cantidad en el. */
  entregas: Array<{ entrega: Entrega; cantidad: number }>
}

/**
 * Reparte las entregas de una orden entre sus renglones.
 *
 * El cruce va por NUMERO DE RENGLON (`BaseLine`), no por codigo de articulo:
 * una misma orden puede pedir el mismo articulo en dos renglones y cruzar por
 * articulo repartiria mal lo recibido. Es la regla 1 de `matching/recepciones`.
 *
 * Una entrega que no case con ningun renglon NO se descarta en silencio: sale
 * en `huerfanas`, y la pantalla la enseña aparte. Tragarsela haria que una
 * orden con mercancia registrada contra un renglon inexistente pareciera
 * correcta.
 */
function articulosDeOrden(
  fila: FilaOC,
  renglones: readonly B1DocumentLine[] | undefined,
): { articulos: Articulo[]; huerfanas: Entrega[] } {
  if (!renglones || renglones.length === 0) {
    return { articulos: [], huerfanas: fila.entregas }
  }

  const conocidos = new Set(renglones.map((r) => r.LineNum))
  const articulos = renglones.map<Articulo>((r) => {
    const entregas: Array<{ entrega: Entrega; cantidad: number }> = []
    let recibido = 0
    let facturado = 0
    for (const e of fila.entregas) {
      const cantidad = e.cantidadPorLinea.get(r.LineNum)
      if (cantidad === undefined || cantidad === 0) continue
      entregas.push({ entrega: e, cantidad })
      recibido += cantidad
      // La factura es de la ENTRADA entera (regla M3), asi que si la entrada
      // tiene factura viva, todo lo que trajo de este renglon esta facturado.
      if (e.estado !== 'por_subir') facturado += cantidad
    }
    return {
      lineNum: r.LineNum,
      itemCode: r.ItemCode ?? null,
      descripcion: r.ItemDescription?.trim() || r.ItemCode || `Renglon ${r.LineNum}`,
      unidad: r.MeasureUnit ?? r.UoMCode ?? null,
      precio: r.Price ?? r.UnitPrice ?? 0,
      pedido: r.Quantity,
      recibido,
      facturado,
      pendiente: Math.max(0, recibido - facturado),
      entregas,
    }
  })

  const huerfanas = fila.entregas.filter((e) =>
    [...e.cantidadPorLinea.keys()].some((linea) => !conocidos.has(linea)),
  )
  return { articulos, huerfanas }
}

function enlace(
  pestana: Pestana,
  chip: Chip,
  termino: string,
  pagina: number,
  sel?: number | null,
): string {
  const params = new URLSearchParams()
  if (pestana !== 'facturar') params.set('tab', pestana)
  if (chip !== 'todas') params.set('f', chip)
  if (termino) params.set('q', termino)
  if (pagina > 1) params.set('p', String(pagina))
  if (sel != null) params.set('sel', String(sel))
  const qs = params.toString()
  return qs ? `/ordenes?${qs}` : '/ordenes'
}

export default async function Page({ searchParams }: Props) {
  const { q, p, tab, f, sel } = await searchParams
  const termino = q?.trim() ?? ''
  const pestana: Pestana = PESTANAS.find((t) => t.id === tab)?.id ?? 'facturar'
  const chip: Chip = CHIPS[pestana].find((c) => c.id === f)?.id ?? 'todas'

  const session = await getSession()
  if (!session) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver tu estado de cuenta.</p>
      </div>
    )
  }

  const interno = esInterno(session.roles)

  // Un usuario sin proveedor y sin ser interno no tiene ordenes que ver. Se
  // corta antes de llamar a B1: sin `cardCode` la consulta traeria las de todos.
  if (!interno && !session.supplierCode) {
    return (
      <>
        <div className="cr-page-head">
          <h1>Ordenes de compra</h1>
        </div>
        <div className="cr-info" data-tone="warn">
          <span className="cr-info__label">Tu cuenta no esta vinculada a un proveedor</span>
          <p>Avisa a KPS para que la vincule; hasta entonces no hay ordenes que mostrar.</p>
        </div>
      </>
    )
  }

  const cardCode = interno ? undefined : session.supplierCode!
  const ctx = { supplierCode: session.supplierCode, internal: interno }

  const [resultado, facturas, plazos] = await Promise.all([
    cargar(cardCode),
    // Si la base falla se sigue con el mapa vacio: el estado de cuenta pierde la
    // columna de factura pero no el resto.
    facturasPorEntrada(ctx).catch(() => new Map<number, FacturaDeEntrada[]>()),
    leerPlazos(),
  ])

  const todas = resultado.ok ? resultado.ordenes : []

  // TODAS las entradas del proveedor, de una sola lectura filtrada por cardCode
  // y fecha en B1. Es lo que permite armar el estado de cuenta sin abrir orden
  // por orden — exactamente lo que el cliente pidio quitar de encima.
  let entradasError: string | null = null
  let entradasTruncadas = false
  let porOrden: ReadonlyMap<number, readonly LineaEntrada[]> = new Map()
  if (todas.length > 0) {
    try {
      const leidas = await leerEntradasDeOrdenes({
        ordenes: todas.map((oc) => ({ DocEntry: oc.DocEntry, DocDate: oc.DocDate })),
        ...(cardCode ? { cardCode } : {}),
      })
      porOrden = leidas.porOrden
      entradasTruncadas = leidas.truncado
    } catch (error) {
      entradasError = error instanceof Error ? error.message : 'Error desconocido.'
    }
  }

  const { porFacturar, aprobadas, historicas } = construir({ ordenes: todas, porOrden, facturas })

  // Busqueda: numero de orden, de entrada o folio de factura. El articulo no
  // entra a proposito: sus renglones solo se leen de B1 para la pagina visible,
  // asi que buscar por el encontraria unas ordenes si y otras no segun donde
  // hubiera caido el corte.
  const buscado = compacto(termino)
  const coincideOC = (fila: FilaOC) =>
    [
      String(fila.oc.DocNum),
      `OC ${fila.oc.DocNum}`,
      fila.oc.CardCode,
      fila.oc.CardName ?? '',
      ...fila.entregas.flatMap((e) => [String(e.docNum), e.factura?.folio ?? '']),
    ].some((c) => compacto(c).includes(buscado))
  const coincideAprobada = (fila: FilaAprobada) =>
    [
      String(fila.oc.DocNum),
      `OC ${fila.oc.DocNum}`,
      String(fila.entrega.docNum),
      fila.factura.folio,
      fila.oc.CardCode,
      fila.oc.CardName ?? '',
    ].some((c) => compacto(c).includes(buscado))

  /*
   * LA LISTA ES DE ENTRADAS, NO DE ORDENES.
   *
   * El trabajo del proveedor no es "revisar ordenes", es "facturar las entradas
   * que me faltan". Con la lista por orden habia que abrir ficha tras ficha
   * para descubrir cuales tenian algo pendiente —y una orden puede tener
   * muchas entradas—. Aqui cada renglon es una entrada: se ve de golpe todo lo
   * que hay que facturar, y la orden queda como contexto de la fila.
   *
   * La orden sigue viajando con cada entrada porque la ficha de la derecha la
   * necesita: importes, plazo y el resto de sus entradas.
   */
  const historico = pestana === 'historico'
  const entradasVisibles = (historico ? historicas : porFacturar)
    .filter((fila) => !termino || coincideOC(fila))
    .flatMap((fila) => fila.entregas.map((entrega) => ({ fila, entrega })))
    .filter(({ entrega }) => {
      // El historico enseña SOLO lo ya facturado en B1: una orden puede traer
      // ademas una entrada pendiente, y esa vive en la otra pestaña.
      if (historico) return entrega.estado === 'facturada_b1'
      // Y "Por facturar" nunca las enseña, ni con el chip "Todas".
      if (entrega.estado === 'facturada_b1') return false
      if (chip === 'todas') return true
      const estado: EstadoEntrada = chip === 'en_revision' ? 'en_revision' : 'por_subir'
      return entrega.estado === estado
    })
    // Lo mas viejo arriba: es lo que lleva mas tiempo sin cobrarse.
    .sort((a, b) => (a.entrega.fecha < b.entrega.fecha ? -1 : 1))

  const aprobadasVisibles = aprobadas
    .filter((fila) => !termino || coincideAprobada(fila))
    .filter((fila) => chip === 'todas' || (chip === 'pagadas' ? fila.pagada : !fila.pagada))

  // Cuando la busqueda no da nada AQUI, se mira si da en el otro sitio antes de
  // decir nada. Mandar a alguien a "prueba en la otra pestaña" cuando ahi
  // tampoco esta es hacerle perder el viaje; y si la orden estaba delante y la
  // escondio el chip, lo que hay que decir es eso, no que cambie de pestaña.
  const coincidencias = (p: Pestana) =>
    p === 'aprobadas'
      ? aprobadas.filter(coincideAprobada).length
      : (p === 'historico' ? historicas : porFacturar).filter(coincideOC).length
  // Con tres pestañas ya no hay "la otra": se apunta a la primera distinta que
  // de verdad tenga resultados, que es la unica que vale la pena ofrecer.
  const otra: Pestana =
    PESTANAS.map((t) => t.id).find((id) => id !== pestana && coincidencias(id) > 0) ??
    (pestana === 'facturar' ? 'aprobadas' : 'facturar')
  const enLaOtra = termino ? coincidencias(otra) : 0
  const enElResto = termino && chip !== 'todas' ? coincidencias(pestana) : 0

  // Las dos pestanas se paginan igual, pero cada una con sus filas. `POR_PAGINA`
  // marca ademas el tope de ordenes cuyos renglones se le piden a B1 de golpe:
  // solo se leen los de la pagina visible.
  const pagEntradas = paginar(entradasVisibles, p)
  const pagAprobadas = paginar(aprobadasVisibles, p)
  const pag = pestana === 'aprobadas' ? pagAprobadas : pagEntradas
  const entradasPagina = pagEntradas.filas
  const aprobadasPagina = pagAprobadas.filas
  const enPantalla = pag.filas.length

  // LA ORDEN ABIERTA EN LA FICHA.
  //
  // Se busca dentro de la pagina visible y no en todo el listado: un `sel` que
  // apunta a una orden filtrada fuera —cambiar de chip con la ficha abierta—
  // debe cerrarse sola, no resucitar una fila que ya no esta en la lista.
  // `sel` identifica una ENTRADA, no una orden: es la unidad de la lista. La
  // ficha enseña la orden a la que pertenece, que es el contexto que hace falta
  // para decidir sobre ella.
  const elegida =
    pestana !== 'aprobadas' && sel != null
      ? (entradasPagina.find(({ entrega }) => String(entrega.docEntry) === sel) ?? null)
      : null
  const seleccionada = elegida?.fila ?? null

  // Los renglones, SOLO de la orden abierta.
  //
  // La lista ya no los necesita —su ultima columna cuenta entradas, que vienen
  // de otro sitio—, y la ficha enseña una orden cada vez. Sigue siendo UNA
  // llamada a B1, pero con los renglones de una orden en vez de los de cinco.
  let renglones: ReadonlyMap<number, readonly B1DocumentLine[]> = new Map()
  let renglonesError = false
  if (seleccionada) {
    try {
      renglones = await renglonesDeOrdenes([seleccionada.oc.DocEntry], cardCode)
    } catch {
      renglonesError = true
    }
  }

  return (
    <>
      <div className="cr-page-head">
        <div>
          <h1>Ordenes de compra</h1>
          {!resultado.ok && <p className="cr-lead cr-flush">No se pudo leer tu estado de cuenta</p>}
        </div>
      </div>

      {!resultado.ok && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">No se pudieron leer las ordenes</span>
          {interno && <p className="cr-small cr-flush">{resultado.error}</p>}
        </div>
      )}

      {resultado.ok && (
        <>
          <section className="cr-section cr-filtros">
            {/* NIVEL 1 · LA VISTA. Pestañas con subrayado, no un segmentado.
                Manda sobre los chips de abajo, y dos cajas del mismo tamaño una
                junto a otra no dejaban ver cual anida en cual: el chip activo,
                en tinta solida, pesaba mas que la pestaña activa, que solo se
                marcaba con fondo blanco. Son <a> porque la pestaña vive en la
                URL —se comparte y se recarga—, y por eso el activo se marca con
                `aria-current` y no con `aria-selected`, que es de un tablist de
                verdad. */}
            <div className="cr-tabs" role="group" aria-label="Vista">
              {PESTANAS.map((t) => (
                <Link
                  key={t.id}
                  href={enlace(t.id, 'todas', termino, 1)}
                  className="cr-tabs__item"
                  {...(pestana === t.id ? { 'aria-current': 'page' as const } : {})}
                >
                  {t.label}
                </Link>
              ))}
            </div>

            {/* NIVEL 2 · afina dentro de la pestaña: chips a la izquierda,
                buscador contra el borde derecho. */}
            <div className="cr-filtros__fila">
              {/* Los chips son enlaces, no botones: el filtro vive en la URL y
                  asi se puede compartir o recargar. */}
              <div className="cr-btn-row cr-filtros__chips">
                {CHIPS[pestana].map((c) => (
                  <Link
                    key={c.id}
                    href={enlace(pestana, c.id, termino, 1)}
                    className="cr-pill"
                    {...(chip === c.id ? { 'aria-current': 'page' as const } : {})}
                  >
                    {c.label}
                  </Link>
                ))}
              </div>

              {/* Filtra al escribir. Es un Client Component minimo —lo unico
                  de la pantalla que lo es— porque el resto sigue siendo
                  servidor: empuja `?q=` y esta pagina se vuelve a pintar. */}
              <Buscador
                termino={termino}
                tab={pestana !== 'facturar' ? pestana : undefined}
                chip={chip !== 'todas' ? chip : undefined}
              />
            </div>
          </section>

          {resultado.truncado && (
            <div className="cr-info" data-tone="warn">
              <span className="cr-info__label">Listado recortado</span>
              <p>
                Se cargaron las {MAX_ORDENES} mas recientes. Para una anterior, busca su numero.
              </p>
            </div>
          )}

          {entradasError && (
            <div className="cr-info" data-tone="warn">
              <span className="cr-info__label">No se pudieron leer las entradas de mercancia</span>
              <p className="cr-flush">Falta lo entregado y lo facturable.</p>
              {interno && <p className="cr-small cr-flush">{entradasError}</p>}
            </div>
          )}

          {entradasTruncadas && (
            <div className="cr-info" data-tone="warn">
              <span className="cr-info__label">Entregas recortadas</span>
              <p>Hay mas entregas de las que se leyeron. Lo que ves es un minimo.</p>
            </div>
          )}

          {renglonesError && (
            <div className="cr-info" data-tone="warn">
              <span className="cr-info__label">No se pudo leer el detalle por articulo</span>
              <p>Faltan los articulos. Las ordenes y sus entregas estan completas.</p>
            </div>
          )}

          <section className="cr-section">
            {enPantalla === 0 ? (
              <div className="cr-empty">
                {termino !== '' ? (
                  <>
                    <div className="cr-empty__title">
                      Sin resultados para &quot;{termino}&quot;.
                    </div>
                    {/* Se dice DONDE esta, con el enlace hecho. El chip primero:
                        si la orden esta en esta misma pestaña y la tapa el
                        filtro, mandar a la otra seria mandar mal. */}
                    <p>
                      {enElResto > 0 ? (
                        <>
                          Hay {enElResto} en{' '}
                          <Link href={enlace(pestana, 'todas', termino, 1)}>
                            todas las de esta pestaña
                          </Link>
                          .
                        </>
                      ) : enLaOtra > 0 ? (
                        <>
                          Hay {enLaOtra} en{' '}
                          <Link href={enlace(otra, 'todas', termino, 1)}>
                            {PESTANAS.find((t) => t.id === otra)?.label}
                          </Link>
                          .
                        </>
                      ) : (
                        <>
                          Se busca por numero de orden, de entrada o folio de factura.{' '}
                          <Link href={enlace(pestana, chip, '', 1)}>Quitar la busqueda</Link>.
                        </>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="cr-empty__title">
                      {pestana === 'historico'
                        ? 'Ninguna entrada facturada en Business One.'
                        : pestana === 'facturar'
                          ? chip === 'por_subir'
                            ? 'Nada pendiente de facturar.'
                            : chip === 'en_revision'
                              ? 'Nada en revision.'
                              : 'Ninguna orden con saldo.'
                          : chip === 'pagadas'
                            ? 'Ningun pago registrado.'
                            : 'Ninguna factura aprobada.'}
                    </div>
                    <p>
                      {pestana === 'historico'
                        ? 'Aparecen aqui las entradas cuya factura se registro directamente en Business One, sin pasar por el portal.'
                        : pestana === 'facturar'
                          ? 'Aparecen aqui cuando KPS registra una entrada de tu mercancia.'
                          : 'Aparecen aqui cuando KPS autoriza una factura.'}
                    </p>
                  </>
                )}
              </div>
            ) : pestana !== 'aprobadas' ? (
              /* MAESTRO-DETALLE. La lista resume; la ficha de la derecha
                 detalla. Antes cada orden era un acordeon de tres niveles: al
                 abrir la tercera, la cuarta se iba fuera de la pantalla, y para
                 comparar dos habia que plegar una. La ficha no mueve la lista.

                 La seleccion viaja en `?sel=`, no en estado del cliente: asi la
                 pantalla sigue siendo Server Component —puede pedirle a B1 los
                 renglones de la orden abierta— y el enlace se comparte. */
              <div className="cr-md" data-abierta={seleccionada ? 'true' : undefined}>
                <div className="cr-panel">
                  <div className="cr-md__fila cr-md__cabecera">
                    <span># Entrada</span>
                    <span>Recibida</span>
                    <span>Orden</span>
                    <span className="cr-right">Importe</span>
                    <span>Estado</span>
                  </div>

                  {entradasPagina.map(({ fila, entrega }) => {
                    const sello = selloDe(entrega.factura, entrega.estado)
                    const abierta = elegida?.entrega.docEntry === entrega.docEntry
                    const moneda = fila.oc.DocCurrency ?? ''
                    /* El recuento de la ORDEN, no de la fila. Con un renglon
                       por entrada se pierde de vista a que conjunto pertenece:
                       esto dice si esta es la ultima que falta o una de doce.
                       Sale de `fila.entregas`, que trae TODAS las de la orden
                       aunque el chip haya recortado la lista. */
                    const totalEntradas = fila.entregas.length
                    const facturadas = fila.entregas.filter((e) => e.estado !== 'por_subir').length
                    return (
                        <Link
                          key={entrega.docEntry}
                          className="cr-md__fila"
                          scroll={false}
                          href={enlace(
                            pestana,
                            chip,
                            termino,
                            pag.numero,
                            // Volver a pulsar la fila abierta la cierra: es el
                            // gesto que espera cualquiera que quiera recuperar
                            // el ancho completo de la lista.
                            abierta ? null : entrega.docEntry,
                          )}
                          {...(abierta ? { 'aria-current': 'page' as const } : {})}
                        >
                          <span className="cr-md__celda">
                            <span className="cr-code cr-md__titulo">{entrega.docNum}</span>
                          </span>
                          <span className="cr-md__celda">{formatDate(entrega.fecha)}</span>
                          <span className="cr-md__celda">
                            <span className="cr-code">OC {fila.oc.DocNum}</span>
                            <span className="cr-md__sub">
                              {interno
                                ? `${fila.oc.CardCode}${fila.oc.CardName ? ` · ${fila.oc.CardName}` : ''}`
                                : (fila.oc.CardName ?? fila.oc.CardCode)}
                            </span>
                            <span className="cr-md__sub">
                              {totalEntradas === 1 ? '1 entrada' : `${totalEntradas} entradas`} ·{' '}
                              {facturadas === 0
                                ? 'ninguna facturada'
                                : facturadas === totalEntradas
                                  ? 'todas facturadas'
                                  : `${facturadas} facturada${facturadas === 1 ? '' : 's'}`}
                            </span>
                          </span>
                          <span className="cr-md__celda" data-align="right">
                            <strong className="cr-mono">{formatMoney(entrega.importe)}</strong>
                            <span className="cr-md__sub">{moneda}</span>
                          </span>
                          <span className="cr-md__celda">
                            <span className="cr-status" data-tone={sello.tone}>
                              {sello.texto}
                            </span>
                          </span>
                        </Link>
                    )
                  })}
                </div>

                <div className="cr-md__detalle">
                  {seleccionada ? (
                    <FichaOrden
                      fila={seleccionada}
                      renglones={renglones.get(seleccionada.oc.DocEntry)}
                      renglonesError={renglonesError}
                      plazos={plazos}
                      cerrar={enlace(pestana, chip, termino, pag.numero, null)}
                    />
                  ) : (
                    /* La columna existe aunque no haya nada elegido: si
                       apareciera y desapareciera, la lista cambiaria de ancho a
                       cada clic. */
                    <div className="cr-panel">
                      <div className="cr-md__vacio">
                        <p className="cr-small cr-flush">
                          {historico
                            ? 'Elige una entrada para ver su orden. Su factura se registro en Business One, no aqui.'
                            : 'Elige una entrada para ver su orden y cargarle la factura.'}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="cr-table-scroll">
                <table className="cr-table cr-table--stack">
                  <thead>
                    <tr>
                      <th>Estatus</th>
                      <th>Factura</th>
                      {/* El numero de entrada es EL punto de conexion entre KPS
                          y el proveedor: por eso va tan adelante. */}
                      <th>Entrada</th>
                      <th>Orden</th>
                      {interno && <th>Proveedor</th>}
                      <th className="cr-date">Capturada</th>
                      <th>Plazo de pago</th>
                      <th className="cr-num">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aprobadasPagina.map((fila) => {
                      const estatus = estatusFactura(fila.factura.status)
                      return (
                        <tr key={`${fila.oc.DocEntry}-${fila.entrega.docEntry}`}>
                          <td data-label="Estatus">
                            <span className="cr-status" data-tone={estatus.tone ?? undefined}>
                              {estatus.label}
                            </span>
                          </td>
                          <td className="cr-code" data-label="Factura">
                            {fila.factura.folio}
                            <div className="cr-small cr-muted">
                              {formatFecha(fila.factura.emitida)}
                            </div>
                          </td>
                          <td data-label="Entrada">
                            <span className="cr-code">{fila.entrega.docNum}</span>
                            <div className="cr-small cr-muted">
                              {formatDate(fila.entrega.fecha)}
                            </div>
                          </td>
                          <td className="cr-code" data-label="Orden">
                            <Link href={`/ordenes/${fila.oc.DocEntry}`}>OC {fila.oc.DocNum}</Link>
                          </td>
                          {interno && (
                            <td data-label="Proveedor">
                              <span className="cr-mono">{fila.oc.CardCode}</span>
                              {fila.oc.CardName ? ` · ${fila.oc.CardName}` : ''}
                            </td>
                          )}
                          <td className="cr-date" data-label="Capturada">
                            {formatFecha(fila.factura.capturada)}
                          </td>
                          <td data-label="Plazo de pago">
                            {describirPlazo(plazos, fila.oc.PaymentGroupCode)}
                          </td>
                          <td className="cr-num" data-label="Importe">
                            {formatMoney(fila.factura.importe ?? fila.entrega.importe)}{' '}
                            {fila.oc.DocCurrency ?? ''}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <Paginador
              pagina={pag}
              unidad={pestana === 'aprobadas' ? 'facturas' : 'ordenes'}
              href={(n) => enlace(pestana, chip, termino, n)}
            />
          </section>
        </>
      )}
    </>
  )
}

/**
 * Nivel 3 · las entradas de mercancia de un articulo.
 *
 * Cada renglon es una entrega concreta, con su importe y su factura. El boton
 * nombra la entrada porque es lo que el proveedor tiene que casar con su
 * remision: "cargar factura" a secas no dice de cual.
 */
/**
 * La ficha de la orden abierta.
 *
 * En 440px no cabe la tabla de ocho columnas que tenia el acordeon, asi que el
 * detalle del articulo se lee en VERTICAL: descripcion arriba y las seis cifras
 * en pares dato/valor. Es la misma informacion, ordenada para una columna
 * estrecha en vez de para una fila ancha.
 */
function FichaOrden({
  fila,
  renglones,
  renglonesError,
  plazos,
  cerrar,
}: {
  fila: FilaOC
  renglones: readonly B1DocumentLine[] | undefined
  renglonesError: boolean
  plazos: ReadonlyMap<number, Plazo>
  cerrar: string
}) {
  const { articulos } = articulosDeOrden(fila, renglones)
  const moneda = fila.oc.DocCurrency ?? ''
  const cobrable = fila.porSubir + fila.enRevision
  // Si hay alguna entrada sin factura, ESA es la accion de la ficha. Antes el
  // unico boton era "Ver la orden completa" —una navegacion, no una accion—, y
  // para facturar habia que pulsarlo, buscar la entrada y cargar ahi: tres
  // pasos para lo unico que el proveedor vino a hacer.
  const hayQueFacturar = fila.entregas.some((e) => e.estado === 'por_subir')

  return (
    <div className="cr-panel cr-md__panel">
      <div className="cr-panel__head">
        <div className="cr-md__celda">
          <p className="cr-label cr-flush">Orden de compra</p>
          <h2 className="cr-mono cr-md__titulo">OC {fila.oc.DocNum}</h2>
          <p className="cr-md__sub cr-flush">
            {fila.oc.CardName ?? fila.oc.CardCode}
          </p>
        </div>
        {/* Cierra la ficha sin tener que volver a buscar la fila abierta. */}
        <Link href={cerrar} className="cr-btn cr-btn--sm" data-variant="ghost" scroll={false}>
          Cerrar
        </Link>
      </div>

      <div className="cr-md__cifras">
        <div className="cr-md__cifra">
          <p className="cr-label cr-flush">Por facturar</p>
          <span className="cr-mono">{formatMoney(cobrable)}</span>
        </div>
        <div className="cr-md__cifra">
          <p className="cr-label cr-flush">Por entregar</p>
          <span className="cr-mono">
            {fila.porEntregar > 0 ? formatMoney(fila.porEntregar) : '—'}
          </span>
        </div>
        <div className="cr-md__cifra">
          <p className="cr-label cr-flush">Avance</p>
          <span className="cr-mono">{fila.pctFacturado}%</span>
        </div>
      </div>

      {/* ORDEN -> ENTRADAS -> FACTURAS.
          Antes el cuerpo iba orden -> ARTICULOS -> entradas, y cada articulo
          traia seis cifras: con cinco articulos la ficha eran tres pantallas de
          scroll. Pero la jerarquia del negocio no es esa —una orden tiene
          entradas, y cada entrada puede llevar varias facturas—, asi que el
          nivel de en medio es la ENTRADA, que ademas es lo unico sobre lo que
          el proveedor puede actuar. Los articulos pasan a ser una linea de
          resumen; el desglose completo esta en /ordenes/[docEntry]. */}
      <div className="cr-md__cuerpo">
        <div className="cr-md__bloque">
          <dl className="cr-md__datos cr-mt-0">
            <div className="cr-md__dato">
              <dt>Emitida</dt>
              <dd>{formatDate(fila.oc.DocDate)}</dd>
            </div>
            <div className="cr-md__dato">
              <dt>Total</dt>
              <dd>
                {formatMoney(fila.oc.DocTotal)} {moneda}
              </dd>
            </div>
            <div className="cr-md__dato">
              <dt>Plazo</dt>
              {/* El plazo DE ESTA ORDEN, no el del proveedor: puede pactarse
                  distinto para una compra concreta. Y los dias corren desde que
                  se sube la factura al portal, no desde la entrega fisica. */}
              <dd>{describirPlazo(plazos, fila.oc.PaymentGroupCode)}</dd>
            </div>
          </dl>

          <p className="cr-small cr-muted cr-mt-3 cr-flush">
            {fila.entregas.length === 1 ? '1 entrada' : `${fila.entregas.length} entradas`} ·{' '}
            {fila.entregas.filter((e) => e.estado !== 'por_subir').length} facturada
            {fila.entregas.filter((e) => e.estado !== 'por_subir').length === 1 ? '' : 's'}
            {articulos.length > 0 &&
              ` · ${articulos.length === 1 ? '1 producto' : `${articulos.length} productos`}, ${formatQty(
                articulos.reduce((t, a) => t + a.pendiente, 0),
              )} sin recibir`}
          </p>
        </div>

        {renglonesError && (
          <div className="cr-md__bloque">
            <p className="cr-small cr-muted cr-flush">
              No se pudo leer el detalle por articulo. Las cifras de arriba siguen siendo
              correctas.
            </p>
          </div>
        )}

        {fila.entregas.length === 0 ? (
          <div className="cr-md__bloque">
            <p className="cr-small cr-muted cr-flush">
              Esta orden todavia no tiene entradas de mercancia registradas.
            </p>
          </div>
        ) : (
          fila.entregas.map((entrega) => {
            const sello = selloDe(entrega.factura, entrega.estado)
            return (
              <div className="cr-md__bloque" key={entrega.docEntry}>
                <div className="cr-md__entrada">
                  <span className="cr-md__celda">
                    <span className="cr-code cr-md__titulo">Entrada {entrega.docNum}</span>
                    <span className="cr-md__sub">{formatDate(entrega.fecha)}</span>
                  </span>
                  <span className="cr-md__celda" data-align="right">
                    <span className="cr-mono">
                      {formatMoney(entrega.importe)} {moneda}
                    </span>
                    <span className="cr-md__sub">
                      <span className="cr-status" data-tone={sello.tone}>
                        {sello.texto}
                      </span>
                    </span>
                  </span>
                </div>


                {/* Las facturas de ESTA entrada. Una entrada puede llevar
                    varias —una parcial, una nota de credito, un reemplazo tras
                    una devolucion—; enseñar solo la que manda escondia las
                    demas. Con una sola no se lista: el sello de arriba ya la
                    dice, y repetirla seria ruido. */}
                {entrega.facturas.length > 1 && (
                  <div className="cr-mt-2">
                    <p className="cr-label cr-flush">Facturas</p>
                    {entrega.facturas.map((f) => (
                      <div className="cr-md__factura" key={f.folio}>
                        <span className="cr-code">{f.folio}</span>
                        <span className="cr-md__sub">
                          {estatusFactura(f.status).label}
                          {f.importe !== null && ` · ${formatMoney(f.importe)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="cr-md__pie">
        <Link
          href={`/ordenes/${fila.oc.DocEntry}`}
          className="cr-btn cr-btn--block"
          data-variant={hayQueFacturar ? undefined : 'secondary'}
        >
          {hayQueFacturar ? 'Cargar factura' : 'Ver la orden completa'}
        </Link>
      </div>
    </div>
  )
}
