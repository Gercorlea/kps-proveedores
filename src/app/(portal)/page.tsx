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
 *   - El estatus vive en el dot (.cr-status). Ninguna fila se rellena de color.
 *   - Los montos van en mono, tabular y alineados a la derecha (.cr-num).
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

/**
 * Cuatro KPI, iguales para las dos clases de proveedor.
 *
 * Los deltas —"Te toca a ti", "Plazo del SAT"— son un empujon dirigido a quien
 * tiene que actuar, y solo el proveedor lo es. A un interno los mismos numeros
 * le llegan como agregado de TODOS los proveedores: decirle que le toca a el
 * seria falso, y el plazo del SAT no corre contra KPS. Se queda el dato, se va
 * el imperativo.
 */
function kpis(resumen: ResumenProveedor, interno: boolean): Kpi[] {
  return [
    { label: 'Facturas enviadas', value: String(resumen.total) },
    { label: 'En revision', value: String(resumen.enCurso) },
    {
      label: 'Requieren correccion',
      value: String(resumen.requierenAccion),
      tono: resumen.requierenAccion > 0 ? 'danger' : undefined,
      delta: !interno && resumen.requierenAccion > 0 ? 'Te toca a ti' : undefined,
    },
    {
      label: 'Complementos',
      value: String(resumen.recibosPendientes),
      tono: resumen.recibosPendientes > 0 ? 'warn' : undefined,
      delta: !interno && resumen.recibosPendientes > 0 ? 'Plazo del SAT' : undefined,
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
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver tu portada.</p>
      </div>
    )
  }

  const proveedor = await getProveedorActual()
  const esServicio = proveedor?.tipo === SupplierType.SERVICIO
  // Personal de KPS. La portada esta escrita en segunda persona para un
  // proveedor —"debes", "te fue devuelta", "no has cargado"— y a un interno esos
  // mismos numeros le llegan como agregado de todos los proveedores. Se le
  // enseña el dato; los imperativos se guardan para quien puede obedecerlos.
  const interno = esInterno(session.roles)
  const ctx = { supplierCode: session.supplierCode, internal: interno }

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
      <div className="cr-page-head">
        <div>
          <h1>Inicio</h1>
          <p className="cr-lead cr-flush">
            {interno
              ? 'Resumen de la operacion, con todos los proveedores juntos'
              : pendientes === 0
                ? 'No tienes nada pendiente'
                : pendientes === 1
                  ? 'Un asunto requiere tu atencion'
                  : `${pendientes} asuntos requieren tu atencion`}
          </p>
        </div>
        <div className="cr-page-head__meta">
          <span className="cr-meta">
            {proveedor ? `${proveedor.nombre} · ${proveedor.supplierCode}` : 'KPS'}
          </span>
          <br />
          <span className="cr-meta">
            {proveedor
              ? esServicio
                ? 'Proveedor de servicios'
                : 'Proveedor comercial'
              : 'Personal de KPS'}
          </span>
        </div>
      </div>

      {error && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">No se pudo leer la base del portal</span>
          <p>{error}</p>
        </div>
      )}

      {resumen && (
        <section className="cr-section">
          <div className="cr-kpi-grid">
            {kpis(resumen, interno).map((kpi) => (
              <div className="cr-kpi" key={kpi.label}>
                <span className="cr-kpi__label">{kpi.label}</span>
                <div className="cr-kpi__value">{kpi.value}</div>
                {kpi.delta && (
                  <div className="cr-kpi__delta" data-tone={kpi.tono}>
                    {kpi.delta}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/*
        Bloques de razon: que paso, por que, y que hacer ahora (§01).

        Los dos van bajo UNA sola etiqueta "Requiere tu accion". Antes cada uno
        traia la suya y, con las dos cosas pendientes, el mismo encabezado salia
        repetido a media pantalla de distancia: leido de corrido parecian dos
        secciones distintas en vez de la lista de lo que le falta por hacer.

        La seccion entera no se dibuja si no hay nada pendiente, y no se le
        dibuja nunca a un interno: los numeros que la disparan son el agregado de
        todos los proveedores, y a el no le toca ninguno.
      */}
      {!interno && resumen && (resumen.requierenAccion > 0 || resumen.recibosPendientes > 0) && (
        <section className="cr-section">
          <span className="cr-label">Requiere tu accion</span>
          <div className="cr-stack">
            {resumen.requierenAccion > 0 && (
              <div className="cr-info" data-tone="danger">
                <span className="cr-info__label">
                  {resumen.requierenAccion === 1
                    ? 'Una factura te fue devuelta'
                    : `${resumen.requierenAccion} facturas te fueron devueltas`}
                </span>
                <p>El motivo de cada una esta en tu lista de facturas.</p>
                <div className="cr-btn-row cr-mt-3">
                  <a href="/facturas" className="cr-btn">
                    Ver el motivo
                  </a>
                </div>
              </div>
            )}

            {resumen.recibosPendientes > 0 && (
              <div className="cr-info" data-tone="warn">
                <span className="cr-info__label">
                  {resumen.recibosPendientes === 1
                    ? 'Debes un complemento de pago'
                    : `Debes ${resumen.recibosPendientes} complementos de pago`}
                </span>
                <p>El SAT multa cada uno fuera de plazo.</p>
                <div className="cr-btn-row cr-mt-3">
                  <a href="/complementos" className="cr-btn">
                    Subirlos
                  </a>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="cr-section">
        <span className="cr-label">Movimientos recientes</span>
        {recientes.length === 0 ? (
          <div className="cr-empty">
            <div className="cr-empty__title">
              {interno ? 'Todavia no hay facturas en el portal.' : 'Todavia no has cargado facturas.'}
            </div>
            <p>
              {interno ? (
                'En cuanto un proveedor envie la primera, aqui vas a ver en que punto esta.'
              ) : (
                <>
                  Cuando envies la primera, aqui vas a ver en que punto del proceso esta.{' '}
                  <a href="/facturas/nueva">Cargar una factura</a>.
                </>
              )}
            </p>
          </div>
        ) : (
          <>
            <table className="cr-table cr-table--stack">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Tipo</th>
                  <th className="cr-num">Total</th>
                  <th>Estatus</th>
                  <th className="cr-num">Enviada</th>
                </tr>
              </thead>
              <tbody>
                {recientes.map((m) => (
                  <tr key={m.folio}>
                    <td className="cr-code" data-label="Folio">
                      {m.folio}
                    </td>
                    <td data-label="Tipo">{m.tipo === 'SERVICIO' ? 'Servicio' : 'Mercancia'}</td>
                    <td className="cr-num" data-label="Total">
                      {m.total}
                    </td>
                    <td data-label="Estatus">
                      <span className="cr-status" data-tone={TONO_ESTATUS[m.status] ?? undefined}>
                        {ETIQUETA_PROVEEDOR[m.status]}
                      </span>
                    </td>
                    <td className="cr-num" data-label="Enviada">
                      {fechaCorta(m.enviada)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="cr-pager">
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
