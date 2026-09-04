'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * P06 · Nueva factura.
 *
 * Reglas del spec que impone:
 *   M5 / S4 — XML y PDF son ambos obligatorios.
 *   M6 / S3 — la evidencia es obligatoria, y va con titulo y descripcion.
 *   §04.5   — cero captura manual de datos fiscales: el UUID, el RFC y los
 *             importes salen del XML y son de solo lectura.
 *   §01 DS  — ningun boton deshabilitado sin explicacion adyacente.
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
    formaPago: string | null
    metodoPago: string | null
    usoCFDI: string
  }
  emisor: { rfc: string; nombre: string }
  receptor: { rfc: string; nombre: string }
  timbre: { uuid: string; fechaTimbrado: string; noCertificadoSAT: string }
  conceptos: Concepto[]
  validaciones: Validacion[]
  pendientes: string[]
}

function kb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fechaCorta(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

/**
 * Tres pasos, iguales para todos. El de mercancia lleva ademas el cotejo contra
 * la entrada de almacen, que hoy no esta conectado y por eso no se anuncia: un
 * paso en gris que nunca se enciende promete una comprobacion que no ocurre.
 */
const PASOS = [
  ['01', 'Factura'],
  ['02', 'Evidencia'],
  ['03', 'Envio'],
] as const

export default function CargaFactura({
  tipo,
  supplierCode,
}: {
  tipo: 'SERVICIO' | 'MERCANCIA'
  supplierCode: string | null
}) {
  const esServicio = tipo === 'SERVICIO'

  const [xml, setXml] = useState<File | null>(null)
  const [pdf, setPdf] = useState<File | null>(null)
  const [evidencia, setEvidencia] = useState<File | null>(null)
  const [titulo, setTitulo] = useState('')
  const [descripcion, setDescripcion] = useState('')

  const [extraido, setExtraido] = useState<Extraido | null>(null)
  const [errorXml, setErrorXml] = useState<string | null>(null)
  const [procesando, setProcesando] = useState(false)

  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState<{ folio: string } | null>(null)
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null)
  const [rechazos, setRechazos] = useState<Validacion[]>([])

  const xmlRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  const evidRef = useRef<HTMLInputElement>(null)

  const procesarXml = useCallback(async (file: File) => {
    setProcesando(true)
    setErrorXml(null)
    setExtraido(null)
    try {
      const body = new FormData()
      body.append('xml', file)
      const res = await fetch('/api/v1/cfdi/parse', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setErrorXml(data.detail ?? 'No se pudo leer el XML.')
        setXml(null)
        return
      }
      setExtraido(data as Extraido)
      setXml(file)
    } catch {
      setErrorXml('No se pudo contactar al servidor para procesar el XML.')
      setXml(null)
    } finally {
      setProcesando(false)
    }
  }, [])

  /**
   * Envio definitivo. Todo va junto en un multipart, y es el servidor quien
   * vuelve a parsear y a validar el XML: lo que se ve arriba es la lectura del
   * navegador y no puede ser la que decide.
   */
  const enviar = useCallback(async () => {
    if (!xml || !pdf || !evidencia) return
    setEnviando(true)
    setErrorEnvio(null)
    setRechazos([])
    try {
      const body = new FormData()
      body.append('xml', xml)
      body.append('pdf', pdf)
      body.append('evidencia', evidencia)
      body.append('titulo', titulo)
      body.append('descripcion', descripcion)

      const res = await fetch('/api/v1/invoices', { method: 'POST', body })
      const data = (await res.json()) as {
        folio?: string
        detail?: string
        validaciones?: Validacion[]
      }
      if (!res.ok) {
        setErrorEnvio(data.detail ?? 'No se pudo enviar la factura.')
        setRechazos(data.validaciones ?? [])
        return
      }
      setEnviado({ folio: data.folio! })
    } catch {
      setErrorEnvio('No se pudo contactar al servidor para enviar la factura.')
    } finally {
      setEnviando(false)
    }
  }, [xml, pdf, evidencia, titulo, descripcion])

  const faltantes: string[] = []
  if (!xml) faltantes.push('el XML')
  if (!pdf) faltantes.push('el PDF')
  if (!evidencia) faltantes.push('la evidencia')
  if (!titulo.trim()) faltantes.push('el titulo')
  if (!descripcion.trim()) faltantes.push('la descripcion')

  const bloqueantes =
    extraido?.validaciones.filter((v) => v.severidad === 'BLOQUEANTE' && !v.pasa) ?? []
  const puedeEnviar = faltantes.length === 0 && bloqueantes.length === 0

  const evidenciaLista = Boolean(evidencia) && titulo.trim() !== '' && descripcion.trim() !== ''
  const paso = !xml ? 1 : !evidenciaLista ? 2 : 3

  return (
    <>
      <div className="cr-page-head">
        <div>
          <h1>Nueva factura</h1>
          <p className="cr-lead cr-flush">
            Sube el XML, el PDF y la evidencia
          </p>
        </div>
        <div className="cr-page-head__meta">
          <span className="cr-meta">
            {supplierCode ? `Proveedor · ${supplierCode}` : 'Sin proveedor'}
          </span>
          <br />
          <span className="cr-meta">
            {esServicio ? 'Factura sin orden de compra' : 'Factura contra entrada'}
          </span>
        </div>
      </div>

      <div className="cr-steps">
        {PASOS.map(([num, label], i) => {
          const n = i + 1
          const estado = n < paso ? 'done' : n === paso ? 'current' : 'pending'
          return (
            <span className="cr-step" data-state={estado} key={num}>
              <span className="cr-step__num">{num}</span>
              {label}
            </span>
          )
        })}
      </div>

      <section className="cr-section">
        <span className="cr-label">Paso 01 · Tu factura</span>

        <div className="cr-drop" data-invalid={errorXml ? 'true' : undefined}>
          <p className="cr-drop__title">Sube el XML y el PDF</p>
          <p className="cr-small cr-drop__hint">
            Los dos archivos son obligatorios
          </p>
          <div className="cr-btn-row cr-btn-row--center">
            <button
              type="button"
              className="cr-btn"
              data-variant="secondary"
              onClick={() => xmlRef.current?.click()}
              disabled={procesando}
            >
              {procesando ? 'Leyendo XML...' : 'Seleccionar XML'}
            </button>
            <button
              type="button"
              className="cr-btn"
              data-variant="secondary"
              onClick={() => pdfRef.current?.click()}
            >
              Seleccionar PDF
            </button>
          </div>
          <input
            ref={xmlRef}
            type="file"
            accept=".xml,text/xml,application/xml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void procesarXml(f)
            }}
          />
          <input
            ref={pdfRef}
            type="file"
            accept=".pdf,application/pdf"
            hidden
            onChange={(e) => setPdf(e.target.files?.[0] ?? null)}
          />
        </div>

        {errorXml && (
          <div className="cr-info cr-mt-3" data-tone="danger">
            <span className="cr-info__label">El XML no se pudo procesar</span>
            <p>{errorXml}</p>
          </div>
        )}

        <div className="cr-mt-3">
          {xml && (
            <div className="cr-file">
              <span className="cr-file__name">{xml.name}</span>
              <span className="cr-file__size">{kb(xml.size)}</span>
              <button
                type="button"
                className="cr-btn"
                data-variant="ghost"
                onClick={() => {
                  setXml(null)
                  setExtraido(null)
                  if (xmlRef.current) xmlRef.current.value = ''
                }}
              >
                Quitar
              </button>
            </div>
          )}
          {pdf && (
            <div className="cr-file">
              <span className="cr-file__name">{pdf.name}</span>
              <span className="cr-file__size">{kb(pdf.size)}</span>
              <button
                type="button"
                className="cr-btn"
                data-variant="ghost"
                onClick={() => {
                  setPdf(null)
                  if (pdfRef.current) pdfRef.current.value = ''
                }}
              >
                Quitar
              </button>
            </div>
          )}
        </div>
      </section>

      {extraido && (
        <section className="cr-section">
          <span className="cr-label">Datos extraidos del XML</span>

          <div className="cr-card" data-ai="true">
            <div className="cr-card__head">
              <div>
                <h3>
                  {extraido.esNotaDeCredito ? 'Nota de credito' : 'Factura'}{' '}
                  {extraido.comprobante.serie ?? ''}
                  {extraido.comprobante.folio ? `-${extraido.comprobante.folio}` : ''}
                </h3>
                <span className="cr-small">{extraido.emisor.nombre}</span>
              </div>
              <span className="cr-badge cr-push" data-tone="ai">
                Auto
              </span>
            </div>

            <table className="cr-table cr-matrix">
              <tbody>
                <tr>
                  <td>UUID</td>
                  <td className="cr-code">{extraido.timbre.uuid}</td>
                </tr>
                <tr>
                  <td>RFC emisor</td>
                  <td className="cr-code">{extraido.emisor.rfc}</td>
                </tr>
                <tr>
                  <td>RFC receptor</td>
                  <td className="cr-code">{extraido.receptor.rfc}</td>
                </tr>
                <tr>
                  <td>Fecha</td>
                  <td className="cr-code">{fechaCorta(extraido.comprobante.fecha)}</td>
                </tr>
                <tr>
                  <td>Subtotal</td>
                  <td className="cr-code">{extraido.comprobante.subTotal}</td>
                </tr>
                <tr>
                  <td>IVA trasladado</td>
                  <td className="cr-code">{extraido.comprobante.trasladados}</td>
                </tr>
                {extraido.comprobante.retenidos !== '0.00' && (
                  <tr>
                    <td>Retenciones</td>
                    <td className="cr-code">{extraido.comprobante.retenidos}</td>
                  </tr>
                )}
                <tr>
                  <td>Total</td>
                  <td className="cr-code">
                    {extraido.comprobante.total} {extraido.comprobante.moneda}
                  </td>
                </tr>
              </tbody>
            </table>

            <p className="cr-small cr-mt-3 cr-flush">
              Estos datos vienen de tu XML. Si algo no coincide con tu factura, el archivo es
              incorrecto.
            </p>
          </div>

          <div className="cr-mt-4">
            <span className="cr-label">Conceptos</span>
            <table className="cr-table cr-table--stack">
              <thead>
                <tr>
                  <th>Descripcion</th>
                  <th>Codigo</th>
                  <th className="cr-num">Cantidad</th>
                  <th className="cr-num">Valor unitario</th>
                  <th className="cr-num">Importe</th>
                </tr>
              </thead>
              <tbody>
                {extraido.conceptos.map((c) => (
                  <tr key={c.linea}>
                    <td data-label="Descripcion">{c.descripcion}</td>
                    <td className="cr-code" data-label="Codigo">
                      {c.noIdentificacion ?? '—'}
                    </td>
                    <td className="cr-num" data-label="Cantidad">
                      {c.cantidad}
                    </td>
                    <td className="cr-num" data-label="Valor unitario">
                      {c.valorUnitario}
                    </td>
                    <td className="cr-num" data-label="Importe">
                      {c.importe}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </section>
      )}

      <section className="cr-section">
        <span className="cr-label">Paso 02 · Evidencia</span>
        <p className="cr-small">
          {esServicio
            ? 'Reporte firmado, acta de conformidad o entregable. Es lo que revisa KPS.'
            : 'La remision firmada por almacen.'}
        </p>

        <div className="cr-field-grid">
          <div className="cr-field">
            <label className="cr-field__label" htmlFor="titulo">
              Titulo de la evidencia
            </label>
            <input
              id="titulo"
              className="cr-input"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder={esServicio ? 'Acta de conformidad agosto' : 'Remision firmada 5524'}
              maxLength={120}
            />
          </div>

          <div className="cr-field">
            <label className="cr-field__label" htmlFor="archivo">
              Archivo de evidencia
            </label>
            <button
              type="button"
              className="cr-btn cr-btn--block"
              data-variant="secondary"
              onClick={() => evidRef.current?.click()}
            >
              {evidencia ? 'Cambiar evidencia' : 'Seleccionar evidencia'}
            </button>
            <input
              ref={evidRef}
              id="archivo"
              type="file"
              hidden
              onChange={(e) => setEvidencia(e.target.files?.[0] ?? null)}
            />
            <div className="cr-field__help">No es tu factura: es el documento que prueba el trabajo.</div>
          </div>
        </div>

        <div className="cr-field">
          <label className="cr-field__label" htmlFor="descripcion">
            Descripcion
          </label>
          <textarea
            id="descripcion"
            className="cr-textarea"
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            placeholder={
              esServicio
                ? 'Mantenimiento preventivo de las lineas 3 y 4 ejecutado del 1 al 15 de agosto. Acta firmada por el jefe de planta al cierre.'
                : 'Remision firmada por almacen el 14 de agosto, 620 metros de tela popelina recibidos en la planta de Apodaca.'
            }
            maxLength={600}
          />
          <div className="cr-field__help">{descripcion.length}/600</div>
        </div>

        {evidencia && (
          <div className="cr-file">
            <span className="cr-file__name">{evidencia.name}</span>
            <span className="cr-file__size">{kb(evidencia.size)}</span>
            <button
              type="button"
              className="cr-btn"
              data-variant="ghost"
              onClick={() => {
                setEvidencia(null)
                if (evidRef.current) evidRef.current.value = ''
              }}
            >
              Quitar
            </button>
          </div>
        )}
      </section>

      <section className="cr-section">
        <span className="cr-label">Paso 03 · Envio</span>

        {errorEnvio && (
          <div className="cr-info" data-tone="danger">
            <span className="cr-info__label">No se envio la factura</span>
            <p>{errorEnvio}</p>
            {rechazos.map((v) => (
              <p key={v.regla} className="cr-small">
                {v.regla.replace(/_/g, ' ')} · {v.detalle}
              </p>
            ))}
          </div>
        )}

        {enviado && (
          <div className="cr-info" data-tone="ok">
            <span className="cr-info__label">Factura enviada a revision</span>
            <p>
              Folio <span className="cr-mono">{enviado.folio}</span>. KPS te avisara si necesita una
              correccion.
            </p>
          </div>
        )}

        <div className="cr-btn-row">
          <button
            type="button"
            className="cr-btn"
            disabled={!puedeEnviar || enviando || enviado !== null}
            onClick={() => void enviar()}
          >
            {enviando ? 'Enviando...' : enviado ? 'Ya enviada' : 'Enviar a revision'}
          </button>
          <a className="cr-btn" data-variant="ghost" href="/facturas">
            {enviado ? 'Ver mis facturas' : 'Cancelar'}
          </a>
        </div>

        {!enviado && bloqueantes.length > 0 ? (
          <p className="cr-small cr-mt-2" data-tone="danger">
            {bloqueantes[0].detalle}
          </p>
        ) : !enviado && faltantes.length > 0 ? (
          <p className="cr-small cr-mt-2">
            Falta {faltantes.join(', ')}.
          </p>
        ) : null}
      </section>
    </>
  )
}
