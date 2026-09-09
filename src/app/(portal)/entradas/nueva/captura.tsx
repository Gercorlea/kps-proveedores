'use client'

import { mostrarToast } from '@/app/(portal)/toast'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

/**
 * Captura de cantidades de una entrada de mercancia.
 *
 * La orden y sus renglones llegan ya leidos de Business One desde el servidor:
 * este componente no consulta SAP ni decide de quien es la orden, solo recoge
 * cuanto llego de cada renglon.
 *
 * El limite por renglon es lo que queda ABIERTO en B1, no lo pedido. Un renglon
 * de 500 piezas del que ya llegaron 300 solo admite 200 mas, y ofrecer 500
 * llevaria a un rechazo de B1 despues de haberlo tecleado todo.
 */

export interface RenglonOc {
  lineNum: number
  itemCode: string | null
  descripcion: string
  /** Cantidad pedida en la orden. */
  pedido: number
  /** Cantidad que sigue abierta. Es el tope de lo que se puede recibir. */
  pendiente: number
  unidad: string | null
  /**
   * El articulo se maneja por lote: Business One no lo admite sin decir QUE
   * lote entro. Lo decide el maestro de articulos de B1, no esta pantalla.
   */
  pideLote: boolean
}

/**
 * Un lote tecleado en el formulario.
 *
 * Un renglon puede llevar varios —un camion trae dos lotes del mismo producto—
 * y sus cantidades tienen que sumar exactamente lo recibido. El servidor lo
 * comprueba tambien; aqui se avisa antes para no mandar algo que va a rebotar.
 */
export interface LoteCapturado {
  id: string
  numero: string
  cantidad: string
  /** 'AAAA-MM-DD'. Los articulos de KPS suelen llevarla. */
  caducidad: string
}

interface Props {
  poDocEntry: number
  docNum: number
  cardCode: string
  cardName: string | null
  renglones: readonly RenglonOc[]
  /** Hoy en 'YYYY-MM-DD', calculado en el servidor. */
  hoy: string
}

const numero = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

export default function Captura({ poDocEntry, docNum, cardCode, cardName, renglones, hoy }: Props) {
  const router = useRouter()
  const [cantidades, setCantidades] = useState<Record<number, string>>({})
  /**
   * Lotes por renglon. Se guardan por `lineNum` y no por posicion en la tabla:
   * el orden de las lineas en B1 no es estable, y una lista por indice acabaria
   * asignando el lote de un articulo a otro.
   */
  const [lotes, setLotes] = useState<Record<number, LoteCapturado[]>>({})
  const [fecha, setFecha] = useState(hoy)
  const [comentario, setComentario] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [hecho, setHecho] = useState<{ docNum: number; lineas: number } | null>(null)

  /**
   * Se valida aqui para avisar antes de mandar, pero el servidor comprueba lo
   * mismo por su cuenta: esto es comodidad, no control.
   */
  const problemas = useMemo(() => {
    const lista: string[] = []
    for (const r of renglones) {
      const crudo = cantidades[r.lineNum]
      if (!crudo) continue
      const valor = Number(crudo)
      if (!Number.isFinite(valor) || valor < 0) {
        lista.push(`"${r.descripcion}": ${crudo} no es una cantidad válida.`)
      } else if (valor > r.pendiente) {
        lista.push(
          `"${r.descripcion}": capturaste ${numero.format(valor)} y solo quedan ${numero.format(r.pendiente)} pendientes.`,
        )
      }

      // Lotes. Se comprueba aqui ademas de en el servidor para que el boton no
      // deje mandar algo que va a rebotar: el rechazo de B1 por lotes llega en
      // ingles y sin decir de que renglon.
      if (!r.pideLote || valor <= 0) continue

      const mios = (lotes[r.lineNum] ?? []).filter((l) => l.numero.trim() !== '')
      if (mios.length === 0) {
        lista.push(`"${r.descripcion}": se maneja por lote y no dijiste cuál llegó.`)
        continue
      }

      const suma = mios.reduce((acc, l) => acc + (Number(l.cantidad) || 0), 0)
      if (Math.abs(suma - valor) >= 0.0005) {
        lista.push(
          `"${r.descripcion}": los lotes suman ${numero.format(suma)} y recibiste ${numero.format(valor)}. Tienen que coincidir.`,
        )
      }

      // Un numero repetido es un error de captura: el mismo lote tecleado dos
      // veces en vez de sumar sus piezas en un solo renglon.
      const numeros = mios.map((l) => l.numero.trim().toUpperCase())
      if (new Set(numeros).size !== numeros.length) {
        lista.push(`"${r.descripcion}": repetiste un número de lote.`)
      }
    }
    return lista
  }, [cantidades, renglones, lotes])

  const conCantidad = renglones.filter((r) => Number(cantidades[r.lineNum] ?? '0') > 0)
  const puedeEnviar = conCantidad.length > 0 && problemas.length === 0 && !enviando

  function llenarTodo() {
    const lleno: Record<number, string> = {}
    for (const r of renglones) {
      if (r.pendiente > 0) lleno[r.lineNum] = String(r.pendiente)
    }
    setCantidades(lleno)
  }

  /**
   * Añade un lote al renglon, con la cantidad que falta ya puesta.
   *
   * Se preselecciona el faltante porque el caso normal es UN lote por renglon:
   * asi el usuario teclea el numero y ya cuadra. Con varios, edita la cantidad y
   * el siguiente vuelve a traer lo que reste.
   */
  function agregarLote(lineNum: number, faltante: number) {
    setLotes((prev) => {
      const mios = prev[lineNum] ?? []
      const nuevo: LoteCapturado = {
        // El id es del renglon del formulario, no del lote: React necesita una
        // clave estable, y el numero de lote todavia esta vacio.
        id: `${lineNum}-${mios.length}-${Math.random().toString(36).slice(2, 8)}`,
        numero: '',
        cantidad: faltante > 0 ? String(Number(faltante.toFixed(3))) : '',
        caducidad: '',
      }
      return { ...prev, [lineNum]: [...mios, nuevo] }
    })
  }

  function cambiarLote(lineNum: number, id: string, cambio: Partial<LoteCapturado>) {
    setLotes((prev) => ({
      ...prev,
      [lineNum]: (prev[lineNum] ?? []).map((l) => (l.id === id ? { ...l, ...cambio } : l)),
    }))
  }

  function quitarLote(lineNum: number, id: string) {
    setLotes((prev) => ({
      ...prev,
      [lineNum]: (prev[lineNum] ?? []).filter((l) => l.id !== id),
    }))
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault()
    setEnviando(true)
    try {
      const res = await fetch('/api/v1/goods-receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poDocEntry,
          fecha,
          ...(comentario.trim() ? { comentario: comentario.trim() } : {}),
          lineas: conCantidad.map((r) => ({
            lineNum: r.lineNum,
            cantidad: Number(cantidades[r.lineNum]),
            // Solo se mandan si el articulo los pide: un articulo sin lote no
            // admite `BatchNumbers` y B1 rechaza el documento entero si los ve.
            ...(r.pideLote
              ? {
                  lotes: (lotes[r.lineNum] ?? [])
                    .filter((l) => l.numero.trim() !== '' && Number(l.cantidad) > 0)
                    .map((l) => ({
                      numero: l.numero.trim(),
                      cantidad: Number(l.cantidad),
                      ...(l.caducidad ? { caducidad: l.caducidad } : {}),
                    })),
                }
              : {}),
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        mostrarToast('No se pudo completar la acción', 'error', data.detail ?? 'No se pudo registrar la entrada.')
        setEnviando(false)
        return
      }
      mostrarToast('Entrada registrada', 'success', `Documento ${data.docNum}`)
      setHecho({ docNum: data.docNum, lineas: data.lineas?.length ?? conCantidad.length })
      // Las pantallas de ordenes leen B1 en vivo: al refrescar, lo recibido ya
      // sale actualizado sin tocar nada mas.
      router.refresh()
    } catch {
      mostrarToast('No se pudo completar la acción', 'error', 'No se pudo contactar al servidor.')
      setEnviando(false)
    }
  }

  if (hecho) {
    return (
      <div className="cr-info" data-tone="ok">
        <span className="cr-info__label">Entrada {hecho.docNum} registrada</span>
        <p>
          Se registraron {hecho.lineas} {hecho.lineas === 1 ? 'renglón' : 'renglones'} contra la OC{' '}
          {docNum}. Business One ya descontó lo recibido, así que la orden puede facturarse.
        </p>
        <div className="cr-btn-row">
          <a href={`/ordenes/${poDocEntry}`} className="cr-btn">
            Ver la orden
          </a>
          <a
            href="/entradas"
            className="cr-btn"
            data-variant="secondary"
           
          >
            Registrar otra
          </a>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={enviar}>
      <section className="cr-section">
        <span className="cr-label">Datos de la entrada</span>
        <div className="cr-field-grid">
          <div className="cr-field">
            <label className="cr-field__label" htmlFor="fecha">
              Fecha de entrada
            </label>
            <input
              id="fecha"
              className="cr-input"
              data-machine="true"
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              required
            />
            <div className="cr-field__help">El día que la mercancía entró al almacén.</div>
          </div>
          <div className="cr-field">
            <label className="cr-field__label" htmlFor="comentario">
              Comentario
            </label>
            <input
              id="comentario"
              className="cr-input"
              type="text"
              maxLength={254}
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
              placeholder="Opcional"
            />
            <div className="cr-field__help">Se guarda en el documento de Business One.</div>
          </div>
        </div>
      </section>

      <section className="cr-section">
        <span className="cr-label">Qué llegó</span>

        <div className="cr-btn-row cr-mb-4">
          <button type="button" className="cr-btn" data-variant="secondary" onClick={llenarTodo}>
            Llegó todo lo pendiente
          </button>
          <button
            type="button"
            className="cr-btn"
            data-variant="ghost"
            onClick={() => setCantidades({})}
          >
            Limpiar
          </button>
        </div>

        <table className="cr-table cr-table--stack">
          <thead>
            <tr>
              <th>#</th>
              <th>Artículo</th>
              <th>Descripción</th>
              <th className="cr-num">Pedido</th>
              <th className="cr-num">Pendiente</th>
              <th className="cr-num">Llegó</th>
            </tr>
          </thead>
          <tbody>
            {renglones.map((r) => {
              const valor = cantidades[r.lineNum] ?? ''
              const excede = valor !== '' && Number(valor) > r.pendiente
              return (
                <tr key={r.lineNum}>
                  <td className="cr-code" data-label="#">
                    {r.lineNum}
                  </td>
                  <td className="cr-code" data-label="Artículo">
                    {r.itemCode ?? '—'}
                  </td>
                  <td data-label="Descripción">{r.descripcion}</td>
                  <td className="cr-num" data-label="Pedido">
                    {numero.format(r.pedido)}
                    {r.unidad ? ` ${r.unidad}` : ''}
                  </td>
                  <td className="cr-num" data-label="Pendiente">
                    {r.pendiente > 0 ? (
                      numero.format(r.pendiente)
                    ) : (
                      <span className="cr-muted">—</span>
                    )}
                  </td>
                  <td className="cr-num" data-label="Llegó">
                    <input
                      className="cr-input cr-input--num"
                      data-machine="true"
                      type="number"
                      min={0}
                      max={r.pendiente}
                      step="0.001"
                      inputMode="decimal"
                      value={valor}
                      disabled={r.pendiente <= 0}
                      aria-invalid={excede || undefined}
                      aria-label={`Cantidad recibida de ${r.descripcion}`}
                      onChange={(e) =>
                        setCantidades((prev) => ({ ...prev, [r.lineNum]: e.target.value }))
                      }
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* Lotes.
            Van FUERA de la tabla y no como otra columna: un renglon puede
            llevar varios lotes, y una celda que crece rompe la alineacion de
            toda la fila. Solo aparecen los renglones que piden lote Y en los que
            se tecleo cantidad: pedir el lote de algo que no llego es ruido. */}
        {renglones
          .filter((r) => r.pideLote && Number(cantidades[r.lineNum] ?? '0') > 0)
          .map((r) => {
            const mios = lotes[r.lineNum] ?? []
            const recibido = Number(cantidades[r.lineNum] ?? '0')
            const suma = mios.reduce((acc, l) => acc + (Number(l.cantidad) || 0), 0)
            const cuadra = Math.abs(suma - recibido) < 0.0005

            return (
              <div key={`lotes-${r.lineNum}`} className="cr-field cr-mt-5">
                <label className="cr-field__label">
                  Lotes de {r.itemCode ?? `renglón ${r.lineNum}`}
                </label>
                <p className="cr-small cr-muted cr-mt-0">
                  {r.descripcion}. Business One no admite recibir este artículo sin decir qué lote
                  entró. Si llegaron varios, añade un renglón por cada uno: las cantidades tienen
                  que sumar {numero.format(recibido)}.
                </p>

                {mios.map((l, i) => (
                  <div
                    key={l.id}
                    className="cr-row cr-mb-2"
                  >
                    <input
                      className="cr-input"
                      style={{ flex: '2 1 160px' }}
                      placeholder="Número de lote"
                      value={l.numero}
                      aria-label={`Número del lote ${i + 1} de ${r.descripcion}`}
                      onChange={(e) => cambiarLote(r.lineNum, l.id, { numero: e.target.value })}
                    />
                    <input
                      className="cr-input cr-right"
                      data-machine="true"
                      type="number"
                      min={0}
                      step="0.001"
                      inputMode="decimal"
                      // Proporcion de esta fila concreta, no del sistema: los
                      // tres campos del lote reparten el ancho entre ellos.
                      style={{ flex: '1 1 100px' }}
                      placeholder="Cantidad"
                      value={l.cantidad}
                      aria-label={`Cantidad del lote ${i + 1} de ${r.descripcion}`}
                      onChange={(e) => cambiarLote(r.lineNum, l.id, { cantidad: e.target.value })}
                    />
                    <input
                      className="cr-input"
                      data-machine="true"
                      type="date"
                      style={{ flex: '1 1 150px' }}
                      value={l.caducidad}
                      aria-label={`Caducidad del lote ${i + 1} de ${r.descripcion}`}
                      onChange={(e) => cambiarLote(r.lineNum, l.id, { caducidad: e.target.value })}
                    />
                    <button
                      type="button"
                      className="cr-btn"
                      data-variant="secondary"
                      onClick={() => quitarLote(r.lineNum, l.id)}
                      aria-label={`Quitar el lote ${i + 1} de ${r.descripcion}`}
                    >
                      Quitar
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  className="cr-btn"
                  data-variant="secondary"
                  onClick={() => agregarLote(r.lineNum, recibido - suma)}
                >
                  Añadir lote
                </button>

                {mios.length > 0 && (
                  <p className="cr-small" data-tone={cuadra ? undefined : 'danger'}>
                    {cuadra
                      ? `Los lotes suman ${numero.format(suma)}, que es lo recibido.`
                      : `Los lotes suman ${numero.format(suma)} y recibiste ${numero.format(recibido)}. Faltan ${numero.format(recibido - suma)}.`}
                  </p>
                )}
              </div>
            )
          })}
      </section>

      {problemas.length > 0 && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">Revisa las cantidades</span>
          {problemas.map((p) => (
            <p key={p} className="cr-small">
              {p}
            </p>
          ))}
        </div>
      )}



      <div className="cr-btn-row">
        <button type="submit" className="cr-btn" disabled={!puedeEnviar}>
          {enviando ? 'Registrando...' : 'Registrar entrada'}
        </button>
        <a
          href={`/ordenes/${poDocEntry}`}
          className="cr-btn"
          data-variant="secondary"
         
        >
          Cancelar
        </a>
        <span className="cr-small cr-muted">
          {conCantidad.length === 0
            ? 'Captura al menos un renglón.'
            : `${conCantidad.length} ${conCantidad.length === 1 ? 'renglón' : 'renglones'} · ${cardCode}${cardName ? ` · ${cardName}` : ''}`}
        </span>
      </div>
    </form>
  )
}
