import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { ETIQUETA_PROVEEDOR, SupplierType, TONO_ESTATUS } from '@/lib/domain/enums'
import { resumenDelProveedor, type ResumenProveedor } from '@/lib/invoices/resumen'
import { listarFacturasDelProveedor, type PeticionResumen } from '@/lib/invoices/review'
import { getProveedorActual } from '@/lib/suppliers/current'

/**
 * P03 · Inicio del proveedor — ARC-DS-2026-PP-001 §05.
 *
 * La portada cambia segun la clase de proveedor, y no por adorno: uno de
 * servicios no tiene ordenes de compra ni entradas de mercancia, asi que un KPI
 * de "ordenes abiertas" en su pantalla es un numero que nunca se va a mover y la
 * promesa de una seccion que su menu no tiene.
 *
 * Reglas del sistema que esta pantalla respeta al pie de la letra:
 *   - El estatus vive en el dot (.ar-status). Ninguna fila se rellena de color.
 *   - Los montos van en mono, tabular y alineados a la derecha (.ar-num).
 *   - Cero emojis, cero iconos rellenos.
 *   - El bloque "Requiere tu accion" SOLO se dibuja si hay algo que hacer.
 */
export const dynamic = 'force-dynamic'

type Tono = 'ok' | 'warn' | 'danger' | 'ai' | undefined

interface Kpi {
  label: string
  value: string
  delta?: string
  tono?: Tono
}

/** Cuatro KPI, iguales para las dos clases de proveedor. */
function kpis(resumen: ResumenProveedor): Kpi[] {
  return [
    { label: 'Facturas enviadas', value: String(resumen.total) },
    { label: 'En revision', value: String(resumen.enCurso) },
    {
      label: 'Requieren correccion',
      value: String(resumen.requierenAccion),
      tono: resumen.requierenAccion > 0 ? 'danger' : undefined,
      delta: resumen.requierenAccion > 0 ? 'TE TOCA A TI' : undefined,
    },
    {
      label: 'Complementos',
      value: String(resumen.recibosPendientes),
      tono: resumen.recibosPendientes > 0 ? 'warn' : undefined,
      delta: resumen.recibosPendientes > 0 ? 'PLAZO DEL SAT' : undefined,
    },
  ]
}

const MES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

function fechaCorta(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')} ${MES[d.getMonth()]}`
}

export default async function Page() {
  const session = await getSession()
  if (!session) {
    return (
      <div className="ar-info" data-tone="danger">
        <span className="ar-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver tu portada.</p>
      </div>
    )
  }

  const proveedor = await getProveedorActual()
  const esServicio = proveedor?.tipo === SupplierType.SERVICIO
  const ctx = { supplierCode: session.supplierCode, internal: esInterno(session.roles) }

  let resumen: ResumenProveedor | null = null
  let movimientos: PeticionResumen[] = []
  let error: string | null = null
  try {
    ;[resumen, movimientos] = await Promise.all([
      resumenDelProveedor(ctx),
      listarFacturasDelProveedor(ctx),
    ])
  } catch (e) {
    error = e instanceof Error ? e.message : 'Error desconocido.'
  }

  const recientes = movimientos.slice(0, 5)
  const pendientes = resumen ? resumen.requierenAccion + resumen.recibosPendientes : 0

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>Inicio</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {pendientes === 0
              ? 'No tienes nada pendiente'
              : pendientes === 1
                ? 'Un asunto requiere tu atencion'
                : `${pendientes} asuntos requieren tu atencion`}
          </p>
        </div>
        <div className="ar-page-head__meta">
          <span className="ar-meta">
            {proveedor ? `${proveedor.nombre} · ${proveedor.supplierCode}` : 'KPS'}
          </span>
          <br />
          <span className="ar-meta">
            {esServicio ? 'Proveedor de servicios' : 'Proveedor comercial'}
          </span>
        </div>
      </div>

      {error && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">No se pudo leer la base del portal</span>
          <p>{error}</p>
        </div>
      )}

      {resumen && (
        <section className="ar-section">
          <div className="ar-kpi-grid">
            {kpis(resumen).map((kpi) => (
              <div className="ar-kpi" key={kpi.label}>
                <span className="ar-kpi__label">{kpi.label}</span>
                <div className="ar-kpi__value">{kpi.value}</div>
                {kpi.delta && (
                  <div className="ar-kpi__delta" data-tone={kpi.tono}>
                    {kpi.tono ? `● ${kpi.delta}` : kpi.delta}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Bloques de razon: que paso, por que, y que hacer ahora (§01). */}
      {resumen && resumen.requierenAccion > 0 && (
        <section className="ar-section">
          <span className="ar-eyebrow">Requiere tu accion</span>
          <div className="ar-info" data-tone="danger">
            <span className="ar-info__label">
              {resumen.requierenAccion === 1
                ? 'Una factura te fue devuelta'
                : `${resumen.requierenAccion} facturas te fueron devueltas`}
            </span>
            <p>El motivo de cada una esta en tu lista de facturas.</p>
            <div className="ar-btn-row" style={{ marginTop: 'var(--ar-s3)' }}>
              <a href="/facturas" className="ar-btn" style={{ borderBottom: 0 }}>
                Ver el motivo
              </a>
            </div>
          </div>
        </section>
      )}

      {resumen && resumen.recibosPendientes > 0 && (
        <section className="ar-section">
          <span className="ar-eyebrow">Requiere tu accion</span>
          <div className="ar-info" data-tone="warn">
            <span className="ar-info__label">
              {resumen.recibosPendientes === 1
                ? 'Debes un complemento de pago'
                : `Debes ${resumen.recibosPendientes} complementos de pago`}
            </span>
            <p>El SAT multa cada uno fuera de plazo.</p>
            <div className="ar-btn-row" style={{ marginTop: 'var(--ar-s3)' }}>
              <a href="/complementos" className="ar-btn" style={{ borderBottom: 0 }}>
                Subirlos
              </a>
            </div>
          </div>
        </section>
      )}

      <section className="ar-section">
        <span className="ar-eyebrow">Movimientos recientes</span>
        {recientes.length === 0 ? (
          <div className="ar-empty">
            <div className="ar-empty__title">Todavia no has cargado facturas.</div>
            <p>
              Cuando envies la primera, aqui vas a ver en que punto del proceso esta.{' '}
              <a href="/facturas/nueva">Cargar una factura</a>.
            </p>
          </div>
        ) : (
          <>
            <table className="ar-table ar-table--stack">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Tipo</th>
                  <th className="ar-num">Total</th>
                  <th>Estatus</th>
                  <th className="ar-num">Enviada</th>
                </tr>
              </thead>
              <tbody>
                {recientes.map((m) => (
                  <tr key={m.folio}>
                    <td className="ar-code" data-label="Folio">
                      {m.folio}
                    </td>
                    <td data-label="Tipo">{m.tipo === 'SERVICIO' ? 'Servicio' : 'Mercancia'}</td>
                    <td className="ar-num" data-label="Total">
                      {m.total}
                    </td>
                    <td data-label="Estatus">
                      <span className="ar-status" data-tone={TONO_ESTATUS[m.status] ?? undefined}>
                        {ETIQUETA_PROVEEDOR[m.status]}
                      </span>
                    </td>
                    <td className="ar-num" data-label="Enviada">
                      {fechaCorta(m.enviada)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ar-pager">
              <span>
                {recientes.length} de {movimientos.length} documentos
              </span>
              <a href="/facturas">Ver todas</a>
            </div>
          </>
        )}
      </section>
    </>
  )
}
