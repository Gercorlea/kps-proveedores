import { Suspense } from 'react'
import ModalOrden from './modal-orden'
import DetalleOrden from './[docEntry]/detalle-orden'
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
import { TablaAdaptable } from '../tabla-adaptable'
import { Buscador } from '../buscador'

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
  searchParams: Promise<{ q?: string; p?: string; tab?: string; f?: string; sel?: string; dq?: string; dp?: string; ordenCompleta?: string }>
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
    { id: 'en_revision', label: 'En revisión' },
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
  const { q, p, tab, f, sel, dq, dp, ordenCompleta } = await searchParams
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

  const filtros = {
    tab: pestana === 'facturar' ? undefined : pestana,
    f: chip === 'todas' ? undefined : chip,
    q: termino || undefined,
  }
  const numeroPagina = Math.max(1, Number.parseInt(p ?? '1', 10) || 1)
  // La selección pertenece al resultado filtrado. Paginar o filtrar la lista la cierra.
  const elegida = pestana !== 'aprobadas'
    ? entradasVisibles.find(({ entrega }) => String(entrega.docEntry) === sel) ?? null
    : null
  let renglones: ReadonlyMap<number, readonly B1DocumentLine[]> = new Map()
  let renglonesError = false
  if (elegida) {
    try { renglones = await renglonesDeOrdenes([elegida.fila.oc.DocEntry], cardCode) }
    catch { renglonesError = true }
  }
  const total = pestana === 'aprobadas' ? aprobadasVisibles.length : entradasVisibles.length

  return (
    <>
      <div className="cr-page-head cr-page-head--listado">
        <div>
          <h1>Órdenes de compra</h1>
          <p className="cr-small cr-flush cr-ink-3">Entradas de mercancía, facturas y seguimiento de tus órdenes</p>
          {resultado.ok && (
            <div className="cr-vistas-pagina">
              <div className="cr-segment" role="group" aria-label="Vista">
                {PESTANAS.map((t) => (
                  <Link key={t.id} href={enlace(t.id, 'todas', termino, 1)} className="cr-segment__item"
                    aria-current={pestana === t.id ? 'page' : undefined}>{t.label}</Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {!resultado.ok ? (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">No se pudieron consultar las órdenes</span>
          <p>{interno ? resultado.error : 'Vuelve a intentarlo en unos momentos.'}</p>
        </div>
      ) : (
        <div className="cr-ordenes" data-detalle={elegida ? 'true' : undefined}>
          <section className="cr-panel cr-listado" aria-label="Estado de cuenta">
            <div className="cr-panel__head">
              <div>
                <h2 className="cr-panel__title">Estado de cuenta</h2>
                <p className="cr-small cr-flush cr-ink-3">{total} {pestana === 'aprobadas' ? 'facturas' : 'entradas'}</p>
              </div>
              <div className="cr-panel__controles">
                <Buscador base="/ordenes" termino={termino} filtros={{ tab: filtros.tab, f: filtros.f }}
                  placeholder="Orden, entrada o folio" etiqueta="Buscar órdenes, entradas o facturas" />
                {CHIPS[pestana].length > 1 && (
                <div className="cr-segment" role="group" aria-label="Filtrar por estado">
                  {CHIPS[pestana].map((c) => (
                    <Link key={c.id} href={enlace(pestana, c.id, termino, 1)} className="cr-segment__item"
                      aria-current={chip === c.id ? 'page' : undefined}>{c.label}</Link>
                  ))}
                </div>
                )}
              </div>
            </div>
            {resultado.truncado && <p className="cr-listado__aviso">Listado limitado a {MAX_ORDENES} órdenes. La búsqueda se realiza sobre los documentos consultados.</p>}
            {entradasError && <p className="cr-listado__aviso">No se pudieron consultar las entradas. La información de facturación no está disponible.</p>}
            {entradasTruncadas && <p className="cr-listado__aviso">La consulta de entregas está incompleta. Los importes mostrados son mínimos confirmados.</p>}
            {total === 0 ? (
              <div className="cr-empty cr-empty--compacto">
                <div className="cr-empty__title">{entradasError ? 'No se pudo cargar el listado.' : termino ? `Sin resultados para "${termino}".` : 'No hay documentos en esta vista.'}</div>
                <p>{termino ? 'Prueba con otro número de orden, entrada o folio.' : 'Los documentos aparecerán aquí cuando tengan el estado correspondiente.'}</p>
              </div>
            ) : pestana === 'aprobadas' ? (
              <TablaAdaptable base="/ordenes" unidad="facturas" pagina={p} filtros={filtros}
                className="cr-table cr-table--stack cr-listado__tabla cr-ordenes__tabla"
                cabecera={<thead><tr>
                  <th>Factura</th><th>Entrada</th><th>Orden</th>
                  {interno && <th>Proveedor</th>}<th>Capturada</th><th>Plazo</th><th className="cr-num">Importe</th><th>Estatus</th>
                </tr></thead>}
                filas={aprobadasVisibles.map((fila) => {
                  const estatus = estatusFactura(fila.factura.status)
                  return <tr key={`${fila.oc.DocEntry}-${fila.entrega.docEntry}`}>
                    <td data-label="Factura" className="cr-code" title={`Emitida: ${formatFecha(fila.factura.emitida)}`}>{fila.factura.folio}</td>
                    <td data-label="Entrada" className="cr-code" title={`Recibida: ${formatDate(fila.entrega.fecha)}`}>{fila.entrega.docNum}</td>
                    <td data-label="Orden" className="cr-code"><Link href={`/ordenes/${fila.oc.DocEntry}`}>OC {fila.oc.DocNum}</Link></td>
                    {interno && <td data-label="Proveedor" title={`${fila.oc.CardName ?? ''} ${fila.oc.CardCode}`}>{fila.oc.CardName ?? fila.oc.CardCode}</td>}
                    <td data-label="Capturada" className="cr-code">{formatFecha(fila.factura.capturada)}</td>
                    <td data-label="Plazo">{describirPlazo(plazos, fila.oc.PaymentGroupCode)}</td>
                    <td data-label="Importe" className="cr-num">{formatMoney(fila.factura.importe ?? fila.entrega.importe)} {fila.oc.DocCurrency ?? ''}</td>
                    <td data-label="Estatus" title={estatus.label}><span className="cr-badge" data-tone={estatus.tone ?? undefined}>{estatus.label}</span></td>
                  </tr>
                })} />
            ) : (
              <TablaAdaptable base="/ordenes" unidad="entradas" pagina={p} filtros={filtros}
                className="cr-table cr-table--stack cr-listado__tabla cr-ordenes__tabla"
                cabecera={<>
                  <colgroup><col className="cr-ordenes__id" /><col className="cr-ordenes__fecha" /><col className="cr-ordenes__id" />
                    <col /><col className="cr-ordenes__importe" /><col className="cr-ordenes__estado" /><col className="cr-ordenes__accion" /></colgroup>
                  <thead><tr><th>Entrada</th><th>Recibida</th><th>Orden</th><th>Proveedor</th>
                    <th className="cr-num">Importe</th><th>Estado</th><th className="cr-num">Acción</th></tr></thead>
                </>}
                filas={entradasVisibles.map(({ fila, entrega }) => {
                  const sello = selloDe(entrega.factura, entrega.estado)
                  const abierta = elegida?.entrega.docEntry === entrega.docEntry && elegida.fila.oc.DocEntry === fila.oc.DocEntry
                  const destino = enlace(pestana, chip, termino, numeroPagina, abierta ? null : entrega.docEntry)
                  return <tr key={`${fila.oc.DocEntry}-${entrega.docEntry}`} data-seleccionada={abierta ? 'true' : undefined}>
                    <td data-label="Entrada" className="cr-code"><Link href={destino} scroll={false} aria-current={abierta ? 'true' : undefined}>{entrega.docNum}</Link></td>
                    <td data-label="Recibida" className="cr-code">{formatDate(entrega.fecha)}</td>
                    <td data-label="Orden" className="cr-code" title={`${fila.entregas.length} entradas en esta orden`}><Link href={`/ordenes/${fila.oc.DocEntry}`}>OC {fila.oc.DocNum}</Link></td>
                    <td data-label="Proveedor" title={`${fila.oc.CardName ?? ''} ${fila.oc.CardCode}`}>
                      <span className="cr-listado__proveedor"><span className="cr-listado__nombre">{fila.oc.CardName ?? fila.oc.CardCode}</span>
                        {interno && <span className="cr-listado__codigo">{fila.oc.CardCode}</span>}</span>
                    </td>
                    <td data-label="Importe" className="cr-num">{formatMoney(entrega.importe)} {fila.oc.DocCurrency ?? ''}</td>
                    <td data-label="Estado" title={sello.texto}><span className="cr-badge" data-tone={sello.tone}>{sello.texto}</span></td>
                    <td data-label="Acción" className="cr-num"><Link href={destino} scroll={false} className="cr-btn cr-btn--secondary cr-btn--sm">{abierta ? 'Cerrar' : 'Ver detalle'}</Link></td>
                  </tr>
                })} />
            )}
          </section>
          {elegida && <FichaOrden fila={elegida.fila} renglones={renglones.get(elegida.fila.oc.DocEntry)}
            renglonesError={renglonesError} plazos={plazos} cerrar={enlace(pestana, chip, termino, numeroPagina)}
            filtros={{ ...filtros, p, sel }} termino={dq?.trim() ?? ''} pagina={dp} />}
        </div>
      )}
      {ordenCompleta && <ModalOrden><Suspense fallback={<p role="status">Cargando informacion de la orden...</p>}><DetalleOrden params={Promise.resolve({ docEntry: ordenCompleta })} consulta /></Suspense></ModalOrden>}
    </>
  )
}

function FichaOrden({ fila, renglones, renglonesError, plazos, cerrar, filtros, termino, pagina }: {
  fila: FilaOC
  renglones: readonly B1DocumentLine[] | undefined
  renglonesError: boolean
  plazos: ReadonlyMap<number, Plazo>
  cerrar: string
  filtros: Record<string, string | undefined>
  termino: string
  pagina?: string
}) {
  const { articulos } = articulosDeOrden(fila, renglones)
  const moneda = fila.oc.DocCurrency ?? ''
  const hayQueFacturar = fila.entregas.some((e) => e.estado === 'por_subir')
  // Una fila por factura conserva el historial completo de cada entrada.
  const documentos = fila.entregas.flatMap((entrega) =>
    (entrega.facturas.length ? entrega.facturas : [null]).map((factura) => ({ entrega, factura })),
  ).filter(({ entrega, factura }) => !termino || compacto([
    entrega.docNum, factura?.folio ?? '', selloDe(factura, entrega.estado).texto,
    formatMoney(factura?.importe ?? entrega.importe), formatDate(entrega.fecha),
  ].join(' ')).includes(compacto(termino)))
  return (
    <aside className="cr-panel cr-listado cr-ordenes__detalle" aria-label={`Detalle de OC ${fila.oc.DocNum}`}>
      <div className="cr-panel__head">
        <div><h2 className="cr-panel__title">OC {fila.oc.DocNum}</h2>
          <p className="cr-small cr-flush cr-ink-3">{fila.oc.CardName ?? fila.oc.CardCode}</p></div>
        <Link href={cerrar} scroll={false} className="cr-btn cr-btn--ghost cr-btn--sm">Cerrar</Link>
      </div>
      <div className="cr-ordenes__resumen">
        <div><span className="cr-label">Por facturar</span><span className="cr-mono">{formatMoney(fila.porSubir + fila.enRevision)} {moneda}</span></div>
        <div><span className="cr-label">Por entregar</span><span className="cr-mono">{formatMoney(fila.porEntregar)} {moneda}</span></div>
        <div><span className="cr-label">Avance</span><span className="cr-mono">{fila.pctFacturado}%</span></div>
      </div>
      <dl className="cr-ordenes__datos">
        <div><dt>Emitida</dt><dd>{formatDate(fila.oc.DocDate)}</dd></div>
        <div><dt>Total</dt><dd>{formatMoney(fila.oc.DocTotal)} {moneda}</dd></div>
        <div><dt>Plazo de pago</dt><dd>{describirPlazo(plazos, fila.oc.PaymentGroupCode)}</dd></div>
      </dl>
      <p className="cr-listado__aviso">{fila.entregas.length} entradas · {fila.entregas.filter((e) => e.estado !== 'por_subir').length} facturadas
        {articulos.length > 0 && ` · ${articulos.length} productos · ${formatQty(articulos.reduce((t, a) => t + a.pendiente, 0))} sin recibir`}</p>
      {renglonesError && <p className="cr-listado__aviso">No se pudo consultar el detalle de los artículos.</p>}
      <div className="cr-panel__head">
        <h3 className="cr-panel__title">Entradas y facturas</h3>
        <div className="cr-panel__controles"><Buscador base="/ordenes" parametro="dq" termino={termino} filtros={filtros}
          placeholder="Entrada o factura" etiqueta="Buscar en el detalle de la orden" /></div>
      </div>
      {documentos.length === 0 ? <div className="cr-empty cr-empty--compacto"><p>{termino ? 'Sin resultados en el detalle.' : 'Esta orden todavía no tiene entradas.'}</p></div> :
        <TablaAdaptable key={`${fila.oc.DocEntry}-${termino}`} expandible base="/ordenes" unidad="documentos" clavePagina="dp" pagina={pagina} reservaInferior={57} filtros={{ ...filtros, dq: termino || undefined }}
          className="cr-table cr-table--stack cr-listado__tabla cr-ordenes__documentos"
          cabecera={<thead><tr><th>Entrada</th><th>Factura</th><th>Estado</th><th className="cr-num">Importe</th></tr></thead>}
          filas={documentos.map(({ entrega, factura }) => {
            const sello = factura ? estatusFactura(factura.status) : { label: entrega.estado === 'facturada_b1' ? 'En B1' : 'Sin factura', tone: entrega.estado === 'facturada_b1' ? null : 'warn' }
            return <tr key={`${entrega.docEntry}-${factura?.folio ?? 'sin-factura'}`}>
              <td data-label="Entrada" className="cr-code" title={formatDate(entrega.fecha)}>{entrega.docNum}</td>
              <td data-label="Factura" className="cr-code" title={factura?.folio}>{factura?.folio ?? '—'}</td>
              <td data-label="Estado" title={sello.label}><span className="cr-badge" data-tone={sello.tone ?? undefined}>{sello.label}</span></td>
              <td data-label="Importe" className="cr-num">{formatMoney(factura?.importe ?? entrega.importe)}</td>
            </tr>
          })} />}
      <div className="cr-ordenes__pie">
        <Link scroll={false} href={hayQueFacturar ? `/ordenes/${fila.oc.DocEntry}` : `/ordenes?${new URLSearchParams(Object.entries({ ...filtros, dq: termino, dp: pagina, ordenCompleta: String(fila.oc.DocEntry) }).filter((entry): entry is [string, string] => entry[1] !== undefined))}`} className={`cr-btn cr-btn--sm ${hayQueFacturar ? 'cr-btn--primary' : 'cr-btn--secondary'}`}>
          {hayQueFacturar ? 'Cargar factura' : 'Ver la orden completa'}
        </Link>
      </div>
    </aside>
  )
}
