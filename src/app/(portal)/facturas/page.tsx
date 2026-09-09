import { AvisoToast } from '@/app/(portal)/toast'
import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { ETIQUETA_PROVEEDOR, TONO_ESTATUS } from '@/lib/domain/enums'
import { listarFacturasDelProveedor, type PeticionResumen } from '@/lib/invoices/review'
import { Buscador } from '../buscador'
import { FileCode, FileText, Paperclip } from '../iconos'
import { enlacePagina } from '../paginacion'
import { TablaAdaptable } from '../tabla-adaptable'

/**
 * P09 · Mis facturas.
 *
 * Lee de la base, no de la maqueta: aqui aparece lo que el proveedor envio de
 * verdad desde P06, con el estatus que KPS le haya puesto. Los estados los
 * traduce ETIQUETA_PROVEEDOR (§06): el proveedor no ve la jerga interna.
 *
 * REDISEÑO CRONOS. La pantalla era una tabla suelta bajo un rotulo que repetia
 * el titulo, sin manera de buscar y con un pie que parecia paginacion pero solo
 * contaba filas: con 40 facturas habia que recorrerlas a ojo y con 200 no habia
 * pantalla que alcanzara. Ahora es UN panel —cabecera, franja de filtros, tabla
 * de canto a canto y pie de paginacion de verdad—, el mismo patron que
 * /ordenes, con el buscador y la paginacion compartidos y no reescritos aqui.
 *
 * La fila cabe en UNA LINEA (§06). Lo que la desbordaba era la columna de
 * archivos, que escribia "sin XML · sin PDF · 2 evidencias"; ahora son tres
 * chips de 16px con el texto entero en el `title`, y el hueco se reserva aunque
 * el archivo falte para que los de todas las filas caigan en la misma x.
 */
export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ q?: string; p?: string; f?: string }>
}

function fechaHora(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}/${mm} ${hh}:${mi}`
}

/**
 * Solo el dia: una fecha de vencimiento no tiene hora.
 *
 * Se lee en UTC —`getUTCDate`, no `getDate`— porque Business One la manda sin
 * hora ni zona (`2026-08-24T00:00:00Z`), y en una zona al oeste de Greenwich el
 * `getDate` local devuelve el dia ANTERIOR. Vencimientos corridos un dia hacia
 * atras es justo lo que no se le puede ensenar a quien espera un pago.
 */
function fechaCorta(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = MESES[d.getUTCMonth()]
  return `${dd} ${mm}`
}

const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

/** Estados en los que la factura ya no se mueve. */
const CERRADAS: readonly string[] = ['CERRADA', 'RECHAZADA', 'DUPLICADA']

/**
 * Tope de facturas que trae la consulta. Es el `.limit(200)` de `listar()`, no
 * un numero elegido aqui: se repite para poder avisar cuando se toca.
 */
const MAX_FACTURAS = 200

const CHIPS = [
  { id: 'todas', label: 'Todas' },
  { id: 'curso', label: 'En curso' },
  { id: 'cerradas', label: 'Cerradas' },
] as const
type Chip = (typeof CHIPS)[number]['id']

function enChip(f: PeticionResumen, chip: Chip): boolean {
  if (chip === 'curso') return !CERRADAS.includes(f.status)
  if (chip === 'cerradas') return CERRADAS.includes(f.status)
  return true
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
 * Busca sobre TODO lo que se ve en la fila —folio, serie, UUID, proveedor,
 * tipo, estatus e importe—, no sobre una sola columna (§07). Quien ve
 * "Rechazada" en la pantalla y la escribe en la caja espera que filtre, aunque
 * "rechazada" no sea un campo de la base sino la traduccion de un estado.
 *
 * El UUID entero entra en el pajar aunque la tabla solo enseñe sus primeros
 * ocho: es lo que trae pegado el acuse del SAT, y se busca copiandolo completo.
 */
function coincide(f: PeticionResumen, termino: string, interno: boolean): boolean {
  if (termino === '') return true
  const pajar = normalizar(
    [
      f.folio,
      f.serie ?? '',
      f.uuid ?? '',
      f.total,
      f.tipo === 'SERVICIO' ? 'servicio' : 'mercancia',
      ETIQUETA_PROVEEDOR[f.status],
      // El proveedor solo se busca donde se ve. En la pantalla de un proveedor
      // la columna no existe —son todas suyas— y dejarla en el pajar daria
      // aciertos que no se pueden explicar mirando la tabla.
      interno ? `${f.supplierCode} ${f.proveedor}` : '',
    ].join(' '),
  )
  // Cada palabra por separado y todas tienen que estar: asi "rechazada 2026"
  // encuentra lo mismo escrito en cualquier orden.
  return normalizar(termino)
    .split(/\s+/)
    .filter((t) => t !== '')
    .every((t) => pajar.includes(t))
}

/**
 * Chip de archivo. El icono ES el dato (§11): dice si el XML esta o falta en el
 * ancho de un cuadrito. Cuando el archivo existe es un enlace de descarga;
 * cuando no, el mismo hueco en gris, que es lo que mantiene alineada la
 * columna. El texto entero vive en el `title` y en el `aria-label`, porque un
 * enlace de solo icono no tiene nombre que leer.
 */
function ChipArchivo({
  href,
  rotulo,
  children,
}: {
  href: string | null
  rotulo: string
  children: React.ReactNode
}) {
  if (!href) {
    // `role="img"` con su etiqueta y no `aria-hidden`: que falte el XML es un
    // dato, no un adorno, y esconderselo a un lector de pantalla le deja la
    // fila incompleta. El glifo de dentro ya va oculto por su cuenta.
    return (
      <span
        className="cr-chip-ico"
        data-tone="vacio"
        role="img"
        title={`Falta el ${rotulo}`}
        aria-label={`Falta el ${rotulo}`}
      >
        {children}
      </span>
    )
  }
  return (
    <a className="cr-chip-ico" href={href} title={`Descargar el ${rotulo}`} aria-label={`Descargar el ${rotulo}`}>
      {children}
    </a>
  )
}

export default async function Page({ searchParams }: Props) {
  const { q, p, f: filtro } = await searchParams
  const termino = q?.trim() ?? ''
  const chip: Chip = CHIPS.find((c) => c.id === filtro)?.id ?? 'todas'

  const session = await getSession()
  if (!session) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver tus facturas.</p>
      </div>
    )
  }

  const interno = esInterno(session.roles)

  let facturas: PeticionResumen[] = []
  let error: string | null = null
  try {
    facturas = await listarFacturasDelProveedor({
      supplierCode: session.supplierCode,
      internal: interno,
    })
  } catch (e) {
    error = e instanceof Error ? e.message : 'Error desconocido.'
  }

  const enProceso = facturas.filter((x) => !CERRADAS.includes(x.status)).length

  // El buscador manda sobre el chip: primero se acota a la vista y luego se
  // busca dentro. Asi el conteo de "no hay resultados aqui pero si en todas"
  // sale de comparar los dos numeros.
  const delChip = facturas.filter((x) => enChip(x, chip))
  const visibles = delChip.filter((x) => coincide(x, termino, interno))
  const enTodas = facturas.filter((x) => coincide(x, termino, interno)).length


  const enlace = (c: Chip, t: string, numero: number) =>
    enlacePagina(
      '/facturas',
      { f: c === 'todas' ? undefined : c, q: t === '' ? undefined : t },
      numero,
    )

  return (
    <>
      {/* Encabezado de PAGINA: suelto, sin recuadro (§05). A la izquierda el
          titulo y el pulso del listado; a la derecha la accion. Se fue de aqui
          el rotulo "Proveedor · CODIGO": la barra superior ya lleva el nombre y
          el codigo de quien entro, y repetirlo gastaba el sitio del boton. */}
      <div className="cr-page-head cr-page-head--facturas">
        <div>
          <h1>Facturas</h1>
          <p className="cr-small cr-flush cr-ink-3">
            Facturas enviadas al portal y seguimiento de su estado
          </p>
        </div>
        <Link className="cr-btn cr-btn--primary" href="/facturas/nueva">
          Cargar factura
        </Link>
      </div>

      {error && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">No se pudo leer la base del portal</span>
          <AvisoToast mensaje={error} />
        </div>
      )}

      {facturas.length === MAX_FACTURAS && (
        <div className="cr-info" data-tone="warn">
          <span className="cr-info__label">Listado recortado</span>
          <p>
            Se muestran las {MAX_FACTURAS} facturas más recientes. La búsqueda se limita a estos documentos.
          </p>
        </div>
      )}

      {/* UN SOLO PANEL para todo el listado: cabecera, filtros, tabla y pie. La
          tabla no va dentro de otro recuadro ni con aire alrededor —el panel ya
          es la caja (§05)—. */}
      <section className="cr-panel cr-facturas" aria-label="Listado de facturas">
        <div className="cr-panel__head">
          <div>
            <div className="cr-panel__title">
              {interno ? 'Facturas de proveedores' : 'Tus facturas'}
            </div>
            {/* El conteo del subtitulo es el de LO QUE SE VE, no el del total:
                al escribir en el buscador es lo unico que confirma que el
                filtro hizo algo (§07). */}
            <p className="cr-small cr-flush cr-ink-3">
              {visibles.length === facturas.length
                ? `${facturas.length} facturas · ${enProceso} en curso`
                : `${visibles.length} de ${facturas.length}`}
            </p>
          </div>

          <div className="cr-panel__controles">

            <Buscador
              base="/facturas"
              termino={termino}
              filtros={{ f: chip === 'todas' ? undefined : chip }}
              placeholder="Folio, UUID, estatus o importe"
              etiqueta="Buscar por folio, UUID, proveedor, estatus o importe"
            />
            <div className="cr-segment" role="group" aria-label="Filtrar por estado">
              {CHIPS.map((c) => (
                <Link
                  key={c.id}
                  href={enlace(c.id, termino, 1)}
                  className="cr-segment__item"
                  {...(chip === c.id ? { 'aria-current': 'page' as const } : {})}
                >
                  {c.label}
                </Link>
              ))}
            </div>

          </div>
        </div>

        {visibles.length === 0 ? (
          /* Tres vacios distintos, porque son tres cosas distintas: no has
             cargado nada, el filtro no deja nada, o la busqueda no encontro
             nada. Decir "no hay facturas" cuando lo que pasa es que el chip
             esconde las que hay manda a buscar un fallo donde no lo hay (§10). */
          <div className="cr-empty cr-empty--compacto">
            {facturas.length === 0 ? (
              <>
                <div className="cr-empty__title">Todavia no has cargado facturas.</div>
                <p>
                  Sube el XML, el PDF y la evidencia en{' '}
                  <Link href="/facturas/nueva">Cargar una factura</Link> y KPS la recibira para
                  revision.
                </p>
              </>
            ) : termino !== '' ? (
              <>
                <div className="cr-empty__title">Sin resultados para &quot;{termino}&quot;.</div>
                <p>
                  {enTodas > 0 ? (
                    <>
                      Hay {enTodas} en <Link href={enlace('todas', termino, 1)}>todas tus facturas</Link>.
                    </>
                  ) : (
                    'Se busca por folio, UUID, estatus e importe.'
                  )}
                </p>
              </>
            ) : (
              <>
                <div className="cr-empty__title">
                  Ninguna factura {chip === 'curso' ? 'en curso' : 'cerrada'}.
                </div>
                <p>
                  <Link href={enlace('todas', '', 1)}>Ver todas</Link> las {facturas.length} que
                  tienes.
                </p>
              </>
            )}
          </div>
        ) : (
          <TablaAdaptable
            base="/facturas"
            unidad="facturas"
            pagina={p}
            filtros={{ f: chip === 'todas' ? undefined : chip, q: termino || undefined }}
            className="cr-table cr-table--stack cr-facturas__tabla"
            cabecera={
              <thead>
                <tr>
                  <th>Estatus</th>
                  <th>Folio</th>
                  <th>Tipo</th>
                  {interno && <th>Proveedor</th>}
                  <th>UUID</th>
                  <th>Archivos</th>
                  <th>Vencimiento</th>
                  <th>Enviada</th>
                  <th className="cr-num">Total con IVA</th>
                </tr>
              </thead>
              } filas={visibles.map((f) => (
                  <tr key={f.folio}>
                    <td data-label="Estatus" title={ETIQUETA_PROVEEDOR[f.status]}>
                      <span className="cr-badge" data-tone={TONO_ESTATUS[f.status] ?? undefined}>
                        {ETIQUETA_PROVEEDOR[f.status]}
                      </span>
                    </td>
                    <td className="cr-code" data-label="Folio" title={f.folio}>
                      {f.folio}
                    </td>
                    <td data-label="Tipo">{f.tipo === 'SERVICIO' ? 'Servicio' : 'Mercancia'}</td>
                    {interno && (
                      <td data-label="Proveedor" title={`${f.supplierCode} ? ${f.proveedor}`}>
                        <span className="cr-mono">{f.supplierCode}</span>
                        {f.proveedor !== f.supplierCode ? ` · ${f.proveedor}` : ''}
                      </td>
                    )}
                    <td className="cr-code" data-label="UUID">
                      {f.uuid ? (
                        <span title={f.uuid}>{f.uuid.slice(0, 8).toUpperCase()}</span>
                      ) : (
                        <span className="cr-muted">—</span>
                      )}
                    </td>
                    {/* Los tres archivos en tres huecos fijos. Se enlaza lo que
                        existe y se dice lo que falta: un guion suelto no
                        distingue "sin PDF" de "no se sabe". */}
                    <td data-label="Archivos">
                      <span className="cr-chips">
                        <ChipArchivo
                          href={f.xmlFileKey ? `/api/v1/documents/${f.xmlFileKey}` : null}
                          rotulo="XML"
                        >
                          <FileCode />
                        </ChipArchivo>
                        <ChipArchivo
                          href={f.pdfFileKey ? `/api/v1/documents/${f.pdfFileKey}` : null}
                          rotulo="PDF"
                        >
                          <FileText />
                        </ChipArchivo>
                        <span
                          className="cr-chip-ico"
                          data-tone={f.evidencias > 0 ? undefined : 'vacio'}
                          role="img"
                          aria-label={
                            f.evidencias === 0
                              ? 'Sin evidencias'
                              : `${f.evidencias} evidencia${f.evidencias === 1 ? '' : 's'}`
                          }
                          title={
                            f.evidencias === 0
                              ? 'Sin evidencias'
                              : `${f.evidencias} evidencia${f.evidencias === 1 ? '' : 's'}`
                          }
                        >
                          <Paperclip />
                        </span>
                        {/* El chip de al lado ya anuncia "2 evidencias": este
                            numero es la version a la vista y se oculta al
                            lector para no decirlo dos veces. La ranura se
                            reserva vaya numero o no, para que la columna no se
                            mueva de fila en fila. */}
                        <span className="cr-chips__num" aria-hidden="true">
                          {f.evidencias > 0 ? f.evidencias : ''}
                        </span>
                      </span>
                    </td>
                    {/* Cuando toca cobrar. La calcula Business One con los dias
                        de credito pactados, y solo existe una vez registrada
                        alli: antes no hay fecha que dar, y estimar una seria
                        prometer algo que nadie ha calculado. */}
                    <td data-label="Vencimiento">
                      {f.vence ? (
                        fechaCorta(f.vence)
                      ) : (
                        <span
                          className="cr-muted"
                          title="Se calcula cuando KPS registra la factura en Business One"
                        >
                          —
                        </span>
                      )}
                    </td>
                    <td data-label="Enviada">{fechaHora(f.enviada)}</td>
                    <td className="cr-num" data-label="Total con IVA">
                      {f.total}
                    </td>
                  </tr>
                ))} />
        )}


      </section>
    </>
  )
}
