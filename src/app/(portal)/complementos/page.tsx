import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { complementosPendientes, type ComplementoPendiente } from '@/lib/invoices/complementos'
import Subir from './subir'

/**
 * Complementos de pago pendientes.
 *
 * Aqui solo caen facturas PPD ya pagadas. Las PUE no aparecen nunca: se cobraron
 * al emitirse y no llevan complemento, asi que pedirselo al proveedor —y peor,
 * retenerle pagos por no darlo— seria exigir un documento que no existe.
 */
export const dynamic = 'force-dynamic'

const MES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

function fecha(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MES[d.getUTCMonth()]}`
}

/** El plazo, dicho como lo entiende quien lo tiene que cumplir. */
function plazo(c: ComplementoPendiente): { texto: string; tono: 'danger' | 'warn' | undefined } {
  if (c.diasRestantes === null) return { texto: '—', tono: undefined }
  if (c.diasRestantes < 0) return { texto: `Vencio el ${fecha(c.limite)}`, tono: 'danger' }
  if (c.diasRestantes === 0) return { texto: 'Vence hoy', tono: 'danger' }
  if (c.diasRestantes <= 5)
    return { texto: `${c.diasRestantes} dias · ${fecha(c.limite)}`, tono: 'warn' }
  return { texto: fecha(c.limite), tono: undefined }
}

export default async function Page() {
  const session = await getSession()
  if (!session) {
    return (
      <div className="ar-info" data-tone="danger">
        <span className="ar-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver tus complementos.</p>
      </div>
    )
  }

  let pendientes: ComplementoPendiente[] = []
  let error: string | null = null
  try {
    pendientes = await complementosPendientes({
      supplierCode: session.supplierCode,
      internal: esInterno(session.roles),
    })
  } catch (e) {
    error = e instanceof Error ? e.message : 'Error desconocido.'
  }

  const vencidos = pendientes.filter((c) => (c.diasRestantes ?? 1) < 0).length

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>Complementos de pago</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {pendientes.length === 0
              ? 'No debes ninguno'
              : `${pendientes.length} pendiente${pendientes.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      {error && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">No se pudo leer la base del portal</span>
          <p>{error}</p>
        </div>
      )}

      {vencidos > 0 && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">
            {vencidos === 1 ? 'Un complemento vencido' : `${vencidos} complementos vencidos`}
          </span>
          <p>El SAT multa cada comprobante fuera de plazo. Emitelo y subelo cuanto antes.</p>
        </div>
      )}

      <section className="ar-section">
        {pendientes.length === 0 ? (
          <div className="ar-empty">
            <div className="ar-empty__title">Estas al dia.</div>
            <p>Aqui apareceran tus facturas PPD en cuanto KPS marque el pago.</p>
          </div>
        ) : (
          <table className="ar-table ar-table--stack">
            <thead>
              <tr>
                <th>Factura</th>
                <th className="ar-num">Total</th>
                <th className="ar-num">Pagada</th>
                <th>Fecha limite</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pendientes.map((c) => {
                const p = plazo(c)
                return (
                  <tr key={c.folio}>
                    <td className="ar-code" data-label="Factura">
                      {c.folio}
                    </td>
                    <td className="ar-num" data-label="Total">
                      {c.total}
                    </td>
                    <td className="ar-num" data-label="Pagada">
                      {fecha(c.pagadaEl)}
                    </td>
                    <td data-label="Fecha limite">
                      <span className="ar-status" data-tone={p.tono}>
                        {p.texto}
                      </span>
                    </td>
                    <td>
                      <Subir folio={c.folio} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="ar-section">
        <div className="ar-info">
          <span className="ar-info__label">El plazo lo fija el SAT</span>
          <p>
            El complemento vence el dia 5 del mes siguiente al pago. Solo lo llevan las facturas PPD:
            las PUE se cobran al emitirse y nunca aparecen aqui.
          </p>
        </div>
      </section>
    </>
  )
}
