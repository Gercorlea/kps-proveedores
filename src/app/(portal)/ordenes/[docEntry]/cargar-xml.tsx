'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Carga de facturas contra una orden de compra.
 *
 * Acepta VARIOS XML porque una orden rara vez se factura de una vez: el
 * proveedor entrega en partes y emite un CFDI por entrega. Cada XML es una
 * factura propia —tiene su UUID y su folio— y aqui solo se agrupan para poder
 * verlos juntos contra el total de la orden.
 *
 * El flujo tiene dos pasos separados a proposito:
 *
 *   Guardar  deja las facturas en BORRADOR, con su XML adjunto. Nadie las
 *            revisa todavia.
 *   Enviar   las pasa a revision. Es lo que hace que KPS las vea.
 *
 * Entre uno y otro el proveedor mira cuanto falta y decide si adjunta otro XML
 * o ya manda lo que tiene. Juntar los dos pasos le quitaria esa decision.
 *
 * ALCANCE de la comparacion. Solo se contrastan moneda e importe contra la
 * orden. El cotejo de §06 va linea a linea contra la ENTRADA de mercancia, que
 * es la unidad de facturacion, y aqui no hay entrada. Por eso la fila dice "la
 * orden queda cubierta por importe" y no "cotejada": la diferencia esta en el
 * texto de la fila, no en un aviso aparte.
 */

interface Validacion {
  regla: string
  severidad: 'BLOQUEANTE' | 'ADVERTENCIA' | 'INFO'
  pasa: boolean
  detalle: string
}

interface Concepto {
  linea: number
  descripcion: string
  noIdentificacion: string | null
  cantidad: string
  valorUnitario: string
  importe: string
}

interface Extraido {
  ok: boolean
  esNotaDeCredito: boolean
  comprobante: {
    serie: string | null
    folio: string | null
    fecha: string
    moneda: string
    subTotal: string
    trasladados: string
    retenidos: string
    total: string
  }
  emisor: { rfc: string; nombre: string }
  receptor: { rfc: string; nombre: string }
  timbre: { uuid: string; fechaTimbrado: string }
  conceptos: Concepto[]
  validaciones: Validacion[]
}

/** Estado de un XML dentro de la pantalla. */
interface Ficha {
  id: string
  nombre: string
  archivo: File
  datos?: Extraido
  /** Error al leer el XML. */
  error?: string
  /** Folio del portal una vez guardada. */
  folio?: string
  xmlFileKey?: string
  enviada?: boolean
  /** Error al guardar o al enviar. */
  errorAccion?: string
}

/**
 * Una entrada de mercancia de esta orden que todavia se puede facturar.
 *
 * Se declara aqui y no se importa de `lib/sap/entradas-facturables` porque este
 * es un componente de cliente: aquel modulo arrastra el cliente de B1, que no
 * puede viajar al navegador. La forma la fija el servidor al pasar el prop.
 */
export interface EntradaOpcion {
  docEntry: number
  docNum: number
  /** 'YYYY-MM-DD'. */
  fecha: string
  renglones: number
}

interface Props {
  docEntry: number
  /** Numero de la orden que ve la gente (poNumber). */
  docNum: string
  cardCode: string
  moneda: string
  totalOc: number
  cancelada: boolean
  cerrada: boolean
  /** Entradas abiertas de esta orden. Vacio si almacen no ha registrado ninguna. */
  entradas: EntradaOpcion[]
  /** La lectura se corto por el tope de paginas: la lista es un minimo. */
  entradasTruncadas: boolean
}

function num(texto: string | undefined): number {
  const n = Number(texto)
  return Number.isFinite(n) ? n : 0
}

function money(value: number): string {
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * B1 escribe la moneda nacional como `MXP` y el CFDI como `MXN`. Son la misma
 * moneda: `MXP` es el codigo heredado de la localizacion. Tratarlas como
 * distintas marcaria como diferencia practicamente toda factura mexicana.
 */
function mismaMoneda(a: string, b: string): boolean {
  const n = (m: string) => (m.toUpperCase() === 'MXP' ? 'MXN' : m.toUpperCase())
  return n(a) === n(b)
}

function bloqueantesDe(f: Ficha): Validacion[] {
  return f.datos?.validaciones.filter((v) => !v.pasa && v.severidad === 'BLOQUEANTE') ?? []
}

/** Una ficha se puede guardar si se leyo, es factura y no tiene reglas en rojo. */
function utilizable(f: Ficha): boolean {
  if (!f.datos || f.error) return false
  return !f.datos.esNotaDeCredito && bloqueantesDe(f).length === 0
}

export default function CargarXml({
  docEntry,
  docNum,
  cardCode,
  moneda,
  totalOc,
  cancelada,
  cerrada,
  entradas,
  entradasTruncadas,
}: Props) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)

  /**
   * Contra que entrada de mercancia se factura.
   *
   * Preseleccionada cuando hay una sola: es el caso normal —una entrega, una
   * factura— y obligar a elegir de una lista de uno solo es trabajo sin
   * decision. Con varias se deja vacio a proposito: adivinar cual es acertaria
   * la mitad de las veces y el error no se ve hasta contabilidad.
   */
  const [entradaElegida, setEntradaElegida] = useState<string>(
    entradas.length === 1 ? String(entradas[0].docEntry) : '',
  )
  const [fichas, setFichas] = useState<Ficha[]>([])
  const [leyendo, setLeyendo] = useState(false)
  const [trabajando, setTrabajando] = useState(false)
  const [arrastrando, setArrastrando] = useState(false)

  /**
   * Sin entrada de mercancia no se puede facturar, y por eso bloquea igual que
   * una orden cerrada.
   *
   * En B1 la factura se copia de la entrada (`BaseType: 20`): una factura sin
   * ella no se puede registrar NUNCA. Dejar subir el XML solo aplazaria el
   * rechazo hasta la aprobacion —dias despues, con el proveedor esperando un
   * pago— en vez de decirlo ahora, cuando todavia se puede resolver registrando
   * la entrada.
   */
  const sinEntradas = entradas.length === 0
  const bloqueado = cancelada || cerrada || sinEntradas

  async function agregar(lista: FileList) {
    setLeyendo(true)
    // La lista se construye aparte y se publica al final. Ir haciendo `setFichas`
    // por archivo impide comprobar los duplicados del propio lote: el estado no
    // se ha actualizado todavia cuando llega el siguiente.
    const nuevas: Ficha[] = []
    // UUID es la identidad real de un CFDI. Comparar por nombre de archivo no
    // sirve: el mismo comprobante renombrado seguiria colandose, y dos archivos
    // distintos pueden llamarse igual.
    const vistos = new Set(fichas.map((f) => f.datos?.timbre.uuid).filter(Boolean) as string[])

    // En serie y no con Promise.all: son subidas contra el mismo servidor y en
    // paralelo solo se estorban.
    for (const archivo of Array.from(lista)) {
      const id = `${archivo.name}-${archivo.size}-${Math.random().toString(36).slice(2, 8)}`
      const ficha: Ficha = { id, nombre: archivo.name, archivo }
      try {
        const body = new FormData()
        body.append('xml', archivo)
        const res = await fetch('/api/v1/cfdi/parse', { method: 'POST', body })
        const json = await res.json()
        if (!res.ok) {
          // La ruta responde problem+json: el motivo util esta en `detail`.
          ficha.error = json.detail ?? json.title ?? 'No se pudo leer el XML.'
        } else {
          const datos = json as Extraido
          const uuid = datos.timbre.uuid
          if (vistos.has(uuid)) {
            // Se anade marcada en vez de descartarla en silencio: al elegir
            // cinco archivos hay que ver CUAL sobra, no que aparezcan cuatro.
            ficha.datos = datos
            ficha.error = `Este XML ya esta en la lista (UUID ${uuid.slice(0, 8).toUpperCase()}). No se cuenta dos veces.`
          } else {
            vistos.add(uuid)
            ficha.datos = datos
          }
        }
      } catch {
        ficha.error = 'No se pudo contactar al servidor.'
      }
      nuevas.push(ficha)
    }

    setFichas((f) => [...f, ...nuevas])
    setLeyendo(false)
    // Se limpia el input para poder volver a elegir el mismo archivo: sin esto
    // el navegador no dispara `change` con el mismo nombre.
    if (input.current) input.current.value = ''
  }

  function quitar(id: string) {
    setFichas((f) => f.filter((x) => x.id !== id))
  }

  function marcar(id: string, cambios: Partial<Ficha>) {
    setFichas((prev) => prev.map((x) => (x.id === id ? { ...x, ...cambios } : x)))
  }

  async function guardarTodas() {
    setTrabajando(true)
    for (const f of fichas) {
      if (f.folio || !utilizable(f)) continue
      try {
        const body = new FormData()
        // Se manda el archivo, no lo extraido: el servidor vuelve a parsearlo y
        // a validarlo. Fiarse de la vista previa dejaria colar por `fetch` una
        // factura que no cuadra.
        body.append('xml', f.archivo)
        // Contra que entrada va. El servidor la vuelve a comprobar contra B1:
        // este campo dice cual eligio el usuario, no da por buena la eleccion.
        if (entradaElegida) body.append('entradaDocEntry', entradaElegida)
        const res = await fetch(`/api/v1/purchase-orders/${docEntry}/invoice`, {
          method: 'POST',
          body,
        })
        const json = await res.json()
        marcar(
          f.id,
          res.ok
            ? { folio: json.folio, xmlFileKey: json.xmlFileKey, errorAccion: undefined }
            : { errorAccion: json.detail ?? json.title ?? 'No se pudo guardar.' },
        )
      } catch {
        marcar(f.id, { errorAccion: 'No se pudo contactar al servidor.' })
      }
    }
    setTrabajando(false)
    router.refresh()
  }

  async function enviarTodas() {
    setTrabajando(true)
    for (const f of fichas) {
      if (!f.folio || f.enviada) continue
      try {
        const res = await fetch(`/api/v1/invoices/${f.folio}/enviar`, { method: 'POST' })
        const json = await res.json()
        marcar(
          f.id,
          res.ok
            ? { enviada: true, errorAccion: undefined }
            : { errorAccion: json.detail ?? json.title ?? 'No se pudo enviar.' },
        )
      } catch {
        marcar(f.id, { errorAccion: 'No se pudo contactar al servidor.' })
      }
    }
    setTrabajando(false)
    router.refresh()
  }

  const validas = fichas.filter(utilizable)
  const porGuardar = validas.filter((f) => !f.folio)
  const porEnviar = fichas.filter((f) => f.folio && !f.enviada)
  const enviadas = fichas.filter((f) => f.enviada)

  // Suma de lo que aportan TODOS los XML cargados, para compararla con la orden
  // de una vez. Comparar uno a uno no dice si entre todos ya se cubrio.
  const totalCargado = validas.reduce((acc, f) => acc + num(f.datos?.comprobante.total), 0)
  const diferencia = totalCargado - totalOc
  const monedaDistinta = validas.some(
    (f) => f.datos && !mismaMoneda(f.datos.comprobante.moneda, moneda),
  )

  return (
    <section className="ar-section">
      <span className="ar-eyebrow">Facturas del proveedor</span>

      {bloqueado ? (
        <div className="ar-info" data-tone={cancelada || cerrada ? 'warn' : 'danger'}>
          <span className="ar-info__label">
            {cancelada
              ? 'Orden cancelada'
              : cerrada
                ? 'Orden no abierta'
                : 'Todavia no se puede facturar'}
          </span>
          <p>
            {cancelada
              ? `La OC ${docNum} esta cancelada en Business One. No se puede facturar contra ella.`
              : cerrada
                ? `La OC ${docNum} ya no esta abierta en Business One, asi que no admite mas facturas.`
                : `La OC ${docNum} no tiene ninguna entrada de mercancia abierta en Business One, y la factura se copia de la entrada, no de la orden. Hasta que no se registre lo que llego, no hay contra que facturar.`}
          </p>
          {sinEntradas && !cancelada && !cerrada ? (
            <p className="ar-small ar-muted">
              {entradasTruncadas
                ? 'La lectura de entregas se corto antes de terminar, asi que puede haber alguna que no se alcanzo a leer. Recarga la pagina para volver a intentarlo.'
                : 'Si la mercancia ya llego, hay que registrar la entrada antes de cargar la factura.'}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="ar-field">
          {/* Contra que entrada de mercancia se factura.
              Va ANTES del XML y no despues porque es la decision que condiciona
              todo lo demas: sin entrada no hay factura posible, y descubrirlo al
              final —con el XML ya cargado— convierte un aviso en un rehacer.
              El caso "no hay ninguna entrada" no llega hasta aqui: bloquea la
              seccion entera mas arriba. */}
          <div style={{ marginBottom: '1rem' }}>
              <label className="ar-field__label" htmlFor="entrada">
                Entrada de mercancia que se factura
              </label>
              <select
                id="entrada"
                className="ar-input"
                value={entradaElegida}
                onChange={(e) => setEntradaElegida(e.target.value)}
                disabled={trabajando}
              >
                <option value="">Elige la entrada…</option>
                {entradas.map((e) => (
                  <option key={e.docEntry} value={e.docEntry}>
                    Entrada {e.docNum} · {e.fecha} · {e.renglones}{' '}
                    {e.renglones === 1 ? 'renglon' : 'renglones'} por facturar
                  </option>
                ))}
              </select>
              <p className="ar-small ar-muted">
                Es lo que permite registrar la factura en Business One: alli la factura se copia
                de la entrada, no de la orden. Cada entrada se factura una sola vez.
                {entradasTruncadas
                  ? ' La lista puede estar incompleta: hay mas entregas de las que se alcanzaron a leer.'
                  : ''}
              </p>
          </div>

          <label className="ar-field__label" htmlFor="xml">
            XML del CFDI
          </label>

          {/* Zona de arrastre. Es un `label` y no un `div` con onClick para que
              funcione con teclado y con lector de pantalla sin reimplementar
              nada: el propio navegador abre el selector al activarla. */}
          <label
            className="ar-drop cf-drop"
            data-active={arrastrando ? 'true' : undefined}
            htmlFor="xml"
            onDragOver={(e) => {
              e.preventDefault()
              setArrastrando(true)
            }}
            onDragLeave={() => setArrastrando(false)}
            onDrop={(e) => {
              e.preventDefault()
              setArrastrando(false)
              if (e.dataTransfer.files.length > 0) void agregar(e.dataTransfer.files)
            }}
          >
            <span className="cf-drop__titulo">
              {arrastrando ? 'Suelta los XML aqui' : 'Arrastra los XML o pulsa para elegirlos'}
            </span>
            <span className="ar-small">
              Puedes soltar varios a la vez. Solo el XML: los datos fiscales se extraen de el y no
              se captura nada a mano.
            </span>
          </label>

          <input
            id="xml"
            ref={input}
            className="cf-oculto"
            type="file"
            multiple
            accept=".xml,text/xml,application/xml"
            onChange={(e) => {
              const l = e.target.files
              if (l && l.length > 0) void agregar(l)
            }}
          />
        </div>
      )}

      {leyendo && (
        <div className="ar-info">
          <p style={{ margin: 0 }}>Leyendo los XML...</p>
        </div>
      )}

      {fichas.length > 0 && (
        <>
          {fichas.map((f) => {
            const bloq = bloqueantesDe(f)
            const problema = f.error ?? f.errorAccion ?? bloq[0]?.detalle
            return (
              <div key={f.id} className="ar-file cf-file" data-mal={problema ? 'si' : undefined}>
                <span className="cf-file__icono" aria-hidden="true">
                  XML
                </span>

                <span className="cf-file__cuerpo">
                  <span className="ar-file__name">{f.nombre}</span>
                  <span className="ar-file__size">
                    {(f.archivo.size / 1024).toFixed(1)} KB
                    {f.datos
                      ? ` · ${money(num(f.datos.comprobante.total))} ${f.datos.comprobante.moneda} · ${f.datos.conceptos.length} concepto${f.datos.conceptos.length === 1 ? '' : 's'}`
                      : ''}
                  </span>
                  {f.datos && (
                    <span className="ar-file__size">
                      UUID {f.datos.timbre.uuid.slice(0, 8).toUpperCase()} · {f.datos.emisor.nombre}
                    </span>
                  )}
                  {problema && <span className="ar-field__error">{problema}</span>}
                </span>

                <span className="cf-file__acciones">
                  {f.enviada ? (
                    <span className="ar-status" data-tone="ok">
                      Enviada · {f.folio}
                    </span>
                  ) : f.folio ? (
                    <span className="ar-status" data-tone="warn">
                      Borrador · {f.folio}
                    </span>
                  ) : !utilizable(f) ? (
                    <span className="ar-status" data-tone="danger">
                      {f.datos && f.error ? 'Duplicado' : 'No se puede usar'}
                    </span>
                  ) : (
                    <span className="ar-status">Sin guardar</span>
                  )}

                  {f.xmlFileKey && (
                    <a className="ar-code" href={`/api/v1/documents/${f.xmlFileKey}`}>
                      Ver
                    </a>
                  )}
                  {!f.folio && (
                    <button
                      type="button"
                      className="ar-btn"
                      data-variant="ghost"
                      onClick={() => quitar(f.id)}
                      disabled={trabajando}
                      aria-label={`Quitar ${f.nombre}`}
                    >
                      Quitar
                    </button>
                  )}
                </span>
              </div>
            )
          })}

          <span className="ar-eyebrow" style={{ marginTop: 'var(--ar-s5)' }}>
            Contraste con la OC {docNum}
          </span>
          <table className="ar-table ar-matrix">
            <tbody>
              <tr>
                <td>Total de la orden</td>
                <td className="ar-code">
                  {money(totalOc)} {moneda}
                </td>
              </tr>
              <tr>
                <td>
                  Suma de {validas.length} factura{validas.length === 1 ? '' : 's'}
                </td>
                <td className="ar-code">{money(totalCargado)}</td>
              </tr>
              <tr data-diff={Math.abs(diferencia) >= 0.01 ? 'true' : undefined}>
                <td>Diferencia</td>
                <td className="ar-code">
                  {diferencia > 0 ? '+' : ''}
                  {money(diferencia)}
                  {Math.abs(diferencia) < 0.01
                    ? ' — la orden queda cubierta por importe'
                    : diferencia > 0
                      ? ' — se factura de mas'
                      : ' — todavia falta por facturar'}
                </td>
              </tr>
              {monedaDistinta && (
                <tr data-diff="true">
                  <td>Moneda</td>
                  <td className="ar-code">
                    Algun CFDI no viene en la moneda de la orden ({moneda})
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="ar-btn-row">
            <button
              type="button"
              className="ar-btn"
              onClick={() => void guardarTodas()}
              disabled={trabajando || porGuardar.length === 0 || !entradaElegida}
              title={
                porGuardar.length > 0
                  ? undefined
                  : 'No hay facturas nuevas que guardar: o ya estan guardadas, o tienen algo que corregir.'
              }
            >
              {trabajando
                ? 'Trabajando...'
                : porGuardar.length > 1
                  ? `Guardar ${porGuardar.length} facturas`
                  : 'Guardar factura'}
            </button>

            <button
              type="button"
              className="ar-btn"
              data-variant="secondary"
              onClick={() => void enviarTodas()}
              disabled={trabajando || porEnviar.length === 0}
              title={
                porEnviar.length > 0
                  ? undefined
                  : 'Primero guarda las facturas; solo se envia lo que ya esta en borrador.'
              }
            >
              Enviar a revision
            </button>

            <span className="ar-small ar-muted">
              {enviadas.length > 0
                ? `${enviadas.length} enviada${enviadas.length === 1 ? '' : 's'} a KPS.`
                : porEnviar.length > 0
                  ? `${porEnviar.length} en borrador, sin enviar.`
                  : `Se guardaran como borrador de ${cardCode}.`}
            </span>
          </div>

          {enviadas.length > 0 && (
            <div className="ar-info" data-tone="ok">
              <span className="ar-info__label">En manos de KPS</span>
              <p>
                {enviadas.map((f) => f.folio).join(', ')} — KPS las revisara y te dira si las aprueba
                o si hay algo que corregir. Puedes seguirlas en <a href="/facturas">Facturas</a>.
              </p>
            </div>
          )}
        </>
      )}
      <style>{`
        /* El input real se oculta pero sigue en el arbol de accesibilidad: con
           display:none el label dejaria de activarlo con teclado. */
        .cf-oculto {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          white-space: nowrap;
          border: 0;
        }
        .cf-drop {
          display: flex;
          flex-direction: column;
          gap: var(--ar-s2);
          cursor: pointer;
        }
        .cf-drop:hover { border-color: var(--ar-ink-3); }
        .cf-drop__titulo { font-size: 13.5px; font-weight: 600; color: var(--ar-ink); }
        .cf-file { align-items: flex-start; }
        .cf-file[data-mal='si'] { border-color: var(--ar-danger); }
        .cf-file__icono {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border-radius: var(--ar-r-control);
          background: var(--ar-surface-2);
          font-family: var(--ar-mono);
          font-size: 9.5px;
          letter-spacing: 0.06em;
          color: var(--ar-ink-3);
        }
        .cf-file__cuerpo {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
          flex: 1 1 auto;
        }
        .cf-file__acciones {
          flex: none;
          display: flex;
          align-items: center;
          gap: var(--ar-s2);
        }
      `}</style>
    </section>
  )
}
