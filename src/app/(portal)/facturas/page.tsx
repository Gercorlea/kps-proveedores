import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { ETIQUETA_PROVEEDOR, TONO_ESTATUS } from '@/lib/domain/enums'
import { listarFacturasDelProveedor, type PeticionResumen } from '@/lib/invoices/review'

/**
 * P09 · Mis facturas.
 *
 * Lee de la base, no de la maqueta: aqui aparece lo que el proveedor envio de
 * verdad desde P06, con el estatus que KPS le haya puesto. Los estados los
 * traduce ETIQUETA_PROVEEDOR (§06): el proveedor no ve la jerga interna.
 */
export const dynamic = 'force-dynamic'

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

export default async function Page() {
  const session = await getSession()
  if (!session) {
    return (
      <div className="ar-info" data-tone="danger">
        <span className="ar-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver tus facturas.</p>
      </div>
    )
  }

  let facturas: PeticionResumen[] = []
  let error: string | null = null
  try {
    facturas = await listarFacturasDelProveedor({
      supplierCode: session.supplierCode,
      internal: esInterno(session.roles),
    })
  } catch (e) {
    error = e instanceof Error ? e.message : 'Error desconocido.'
  }

  const enProceso = facturas.filter((f) => !CERRADAS.includes(f.status)).length

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>Facturas</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {facturas.length} documentos · {enProceso} en curso
          </p>
        </div>
        <div className="ar-page-head__meta">
          <span className="ar-meta">
            {session.supplierCode ? `Proveedor · ${session.supplierCode}` : 'KPS'}
          </span>
          <br />
          <a className="ar-meta" href="/facturas/nueva">
            Cargar una factura
          </a>
        </div>
      </div>

      {error && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">No se pudo leer la base del portal</span>
          <p>{error}</p>
        </div>
      )}

      <section className="ar-section">
        <span className="ar-eyebrow">Tus facturas</span>

        {facturas.length === 0 ? (
          <div className="ar-empty">
            <div className="ar-empty__title">Todavia no has cargado facturas.</div>
            <p>
              Sube el XML, el PDF y la evidencia en <a href="/facturas/nueva">Cargar una factura</a>{' '}
              y KPS la recibira para revision.
            </p>
          </div>
        ) : (
          <table className="ar-table ar-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Tipo</th>
                <th>UUID</th>
                <th className="ar-num">Total con IVA</th>
                <th>Estatus</th>
                <th>Archivos</th>
                <th className="ar-num">Te pagan</th>
                <th className="ar-num">Enviada</th>
              </tr>
            </thead>
            <tbody>
              {facturas.map((f) => (
                <tr key={f.folio}>
                  <td className="ar-code" data-label="Folio">
                    {f.folio}
                  </td>
                  <td data-label="Tipo">{f.tipo === 'SERVICIO' ? 'Servicio' : 'Mercancia'}</td>
                  <td className="ar-code" data-label="UUID">
                    {f.uuid ? f.uuid.slice(0, 8).toUpperCase() : '—'}
                  </td>
                  <td className="ar-num" data-label="Total con IVA">
                    {f.total}
                  </td>
                  <td data-label="Estatus">
                    <span className="ar-status" data-tone={TONO_ESTATUS[f.status] ?? undefined}>
                      {ETIQUETA_PROVEEDOR[f.status]}
                    </span>
                  </td>
                  <td data-label="Archivos">
                    {/* Se enlaza lo que existe y se dice lo que falta. Un guion
                        suelto no distingue "sin PDF" de "no se sabe". */}
                    {f.xmlFileKey ? (
                      <a className="ar-code" href={`/api/v1/documents/${f.xmlFileKey}`}>
                        XML
                      </a>
                    ) : (
                      <span className="ar-muted">sin XML</span>
                    )}
                    {' · '}
                    {f.pdfFileKey ? (
                      <a className="ar-code" href={`/api/v1/documents/${f.pdfFileKey}`}>
                        PDF
                      </a>
                    ) : (
                      <span className="ar-muted">sin PDF</span>
                    )}
                    {f.evidencias > 0 && ` · ${f.evidencias} evidencia${f.evidencias === 1 ? '' : 's'}`}
                  </td>
                  {/* Cuando toca cobrar. La calcula Business One con los dias de
                      credito pactados, y solo existe una vez registrada alli:
                      antes no hay fecha que dar, y estimar una seria prometer
                      algo que nadie ha calculado. */}
                  <td className="ar-num" data-label="Te pagan">
                    {f.vence ? (
                      fechaCorta(f.vence)
                    ) : (
                      <span className="ar-muted" title="Se calcula cuando KPS registra la factura en Business One">
                        —
                      </span>
                    )}
                  </td>
                  <td className="ar-num" data-label="Enviada">
                    {fechaHora(f.enviada)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="ar-pager">
          <span>{facturas.length} documentos</span>
          <span>{enProceso} en curso</span>
        </div>
      </section>
    </>
  )
}
