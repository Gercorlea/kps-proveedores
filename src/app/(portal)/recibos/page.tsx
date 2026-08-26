import { FACTURAS } from '@/lib/demo/portal'

/**
 * P11 · Recibos de pago.
 *
 * §08 P1: un proveedor con recibos pendientes no recibe pagos nuevos. El
 * proceso se retiene, no se cancela — y eso hay que decirlo con esas palabras,
 * porque "bloqueado" suena a que se perdio el dinero.
 */
export default function Page() {
  const pendientes = FACTURAS.filter((f) => f.estatus === 'PAGADA')
  const registrados = FACTURAS.filter((f) => f.estatus === 'CERRADA')

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>Recibos de pago</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {pendientes.length} pendientes · {registrados.length} registrados
          </p>
        </div>
        <div className="ar-page-head__meta">
          <span className="ar-meta">Proveedor · P-10442</span>
          <br />
          <span className="ar-meta">Vence 24 AGO</span>
        </div>
      </div>

      {pendientes.length > 0 && (
        <div className="ar-info" data-tone="warn">
          <span className="ar-info__label">
            {pendientes.length === 1
              ? 'Un recibo pendiente'
              : `${pendientes.length} recibos pendientes`}
          </span>
          <p>
            Estas facturas ya se pagaron y esperan tu comprobante. Si no lo subes antes del 24 de
            agosto, tus pagos futuros quedan retenidos hasta que lo registres. El proceso no se
            cancela: se detiene, y se reanuda solo en cuanto subas el recibo.
          </p>
        </div>
      )}

      <section className="ar-section">
        <span className="ar-eyebrow">Pendientes de recibo</span>
        {pendientes.length === 0 ? (
          <div className="ar-empty">
            <div className="ar-empty__title">Todos tus recibos estan al dia.</div>
          </div>
        ) : (
          <table className="ar-table ar-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th className="ar-num">Monto pagado</th>
                <th className="ar-num">Pagada el</th>
                <th>Accion</th>
              </tr>
            </thead>
            <tbody>
              {pendientes.map((f) => (
                <tr key={f.id}>
                  <td className="ar-code" data-label="Folio">
                    <a href={`/facturas/${f.id}`}>{f.folio}</a>
                  </td>
                  <td className="ar-num" data-label="Monto pagado">
                    {f.total}
                  </td>
                  <td className="ar-num" data-label="Pagada el">
                    {f.fecha}
                  </td>
                  <td data-label="Accion">
                    <button type="button" className="ar-btn" data-variant="secondary" disabled>
                      Subir recibo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* No hay boton gris sin explicacion: §01 del documento de diseno. */}
        <div className="ar-info" style={{ marginTop: 'var(--ar-s4)' }}>
          <span className="ar-info__label">Por que no puedes subirlo todavia</span>
          <p>
            La carga de archivos necesita el almacen de documentos y el endpoint
            POST /invoices/&#123;id&#125;/payment-receipt, que aun no estan conectados. En cuanto lo
            esten, el boton se activa aqui mismo.
          </p>
        </div>
      </section>

      <section className="ar-section">
        <span className="ar-eyebrow">Registrados</span>
        {registrados.length === 0 ? (
          <div className="ar-empty">
            <div className="ar-empty__title">Aun no has registrado ningun recibo.</div>
          </div>
        ) : (
          <table className="ar-table ar-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th className="ar-num">Monto</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {registrados.map((f) => (
                <tr key={f.id}>
                  <td className="ar-code" data-label="Folio">
                    <a href={`/facturas/${f.id}`}>{f.folio}</a>
                  </td>
                  <td className="ar-num" data-label="Monto">
                    {f.total}
                  </td>
                  <td data-label="Estado">
                    <span className="ar-status" data-tone="ok">
                      Cerrada
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}
