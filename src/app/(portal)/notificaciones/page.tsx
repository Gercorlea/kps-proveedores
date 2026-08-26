import { getSession } from '@/lib/auth/server'
import { listarAvisos, materializarAvisos, type Aviso } from '@/lib/notifications'
import MarcarTodas from './marcar-todas'

/**
 * Todos los avisos del proveedor.
 *
 * En la campana de la topbar solo caben los ultimos veinte y sin el texto
 * completo; esta pantalla es donde se lee lo que hay que hacer con cada uno —el
 * motivo por el que KPS devolvio una factura, sobre todo— y desde donde se llega
 * a ella.
 */
export const dynamic = 'force-dynamic'

const MES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

function fechaHora(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${String(d.getDate()).padStart(2, '0')} ${MES[d.getMonth()]} ${d.getFullYear()} · ${hh}:${mm}`
}

export default async function Page() {
  const session = await getSession()

  if (!session?.supplierCode) {
    return (
      <div className="ar-info">
        <span className="ar-info__label">Sin avisos</span>
        <p>
          Los avisos son de un proveedor, y tu cuenta no esta vinculada a ninguno. Si eres personal
          de KPS, la bandeja de peticiones esta en el dashboard.
        </p>
      </div>
    )
  }

  // Igual que en la campana: se materializa antes de leer para recoger lo que
  // haya escrito kps-dashboard, y si falla se pinta lo que ya estuviera guardado.
  try {
    await materializarAvisos(session.supplierCode)
  } catch (error) {
    console.warn('[avisos] no se pudieron materializar:', error)
  }

  let avisos: Aviso[] = []
  let noLeidos = 0
  try {
    const lista = await listarAvisos({
      supplierCode: session.supplierCode,
      userId: session.userId,
      limite: 100,
    })
    avisos = lista.avisos
    noLeidos = lista.noLeidos
  } catch {
    return (
      <div className="ar-info" data-tone="danger">
        <span className="ar-info__label">No se pudieron leer tus avisos</span>
        <p>Vuelve a intentarlo en un momento; si sigue igual, avisa a KPS.</p>
      </div>
    )
  }

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>Avisos</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {noLeidos > 0
              ? `${noLeidos} sin leer de ${avisos.length}`
              : 'Todo lo que KPS ha decidido sobre tus facturas.'}
          </p>
        </div>
        {noLeidos > 0 && (
          <div className="ar-page-head__meta">
            <MarcarTodas />
          </div>
        )}
      </div>

      {avisos.length === 0 ? (
        <div className="ar-empty">
          <div className="ar-empty__title">No tienes avisos.</div>
          <p className="ar-small">Aqui salen las decisiones de KPS sobre tus facturas.</p>
        </div>
      ) : (
        <section className="ar-section">
          <ul className="av-lista">
            {avisos.map((a) => (
              <li key={a.id} className="ar-card av-item" data-nuevo={a.leido ? undefined : 'si'}>
                <div className="av-item__cabeza">
                  <span className="ar-status" data-tone={a.tono ?? undefined}>
                    {a.titulo}
                  </span>
                  <span className="ar-small ar-muted">{fechaHora(a.cuando)}</span>
                </div>
                <p className="av-item__texto">{a.mensaje}</p>
                <div className="av-item__pie">
                  <span className="ar-small ar-muted ar-mono">{a.folio}</span>
                  {a.facturaFolio && (
                    <span className="ar-small ar-muted">
                      <span className="ar-mono">{a.facturaFolio}</span>
                      {a.ordenCompra ? ` · OC ${a.ordenCompra}` : ''}
                    </span>
                  )}
                  {a.link && (
                    <a href={a.link} className="ar-small">
                      Ver la factura
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <style>{`
        .av-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ar-s3); }
        .av-item { padding: var(--ar-s4); }
        /* Misma marca que en la campana: barra a la izquierda para el no leido. */
        .av-item[data-nuevo='si'] { box-shadow: inset 3px 0 0 var(--ar-accent); }
        .av-item__cabeza {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--ar-s3);
          flex-wrap: wrap;
        }
        .av-item__texto { margin: var(--ar-s2) 0; font-size: 13px; }
        .av-item__pie {
          display: flex;
          align-items: center;
          gap: var(--ar-s3);
          flex-wrap: wrap;
        }
      `}</style>
    </>
  )
}
