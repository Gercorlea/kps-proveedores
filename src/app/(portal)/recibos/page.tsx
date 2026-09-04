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
      <div className="cr-page-head">
        <div>
          <h1>Recibos de pago</h1>
          <p className="cr-lead cr-flush">
            {pendientes.length} pendientes · {registrados.length} registrados
          </p>
        </div>
        <div className="cr-page-head__meta">
          <span className="cr-meta">Proveedor · P-10442</span>
          <br />
          <span className="cr-meta">Vence 24 AGO</span>
        </div>
      </div>

      {pendientes.length > 0 && (
        <div className="cr-info" data-tone="warn">
          <span className="cr-info__label">
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

      <section className="cr-section">
        <span className="cr-label">Pendientes de recibo</span>
        {pendientes.length === 0 ? (
          <div className="cr-empty">
            <div className="cr-empty__title">Todos tus recibos estan al dia.</div>
          </div>
        ) : (
          <table className="cr-table cr-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th className="cr-num">Monto pagado</th>
                <th className="cr-num">Pagada el</th>
                <th>Accion</th>
              </tr>
            </thead>
            <tbody>
              {pendientes.map((f) => (
                <tr key={f.id}>
                  <td className="cr-code" data-label="Folio">
                    <a href={`/facturas/${f.id}`}>{f.folio}</a>
                  </td>
                  <td className="cr-num" data-label="Monto pagado">
                    {f.total}
                  </td>
                  <td className="cr-num" data-label="Pagada el">
                    {f.fecha}
                  </td>
                  <td data-label="Accion">
                    <button type="button" className="cr-btn" data-variant="secondary" disabled>
                      Subir recibo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* No hay boton gris sin explicacion: §01 del documento de diseno. */}
        <div className="cr-info cr-mt-4">
          <span className="cr-info__label">Por que no puedes subirlo todavia</span>
          <p>
            La carga de archivos necesita el almacen de documentos y el endpoint
            POST /invoices/&#123;id&#125;/payment-receipt, que aun no estan conectados. En cuanto lo
            esten, el boton se activa aqui mismo.
          </p>
        </div>
      </section>

      <section className="cr-section">
        <span className="cr-label">Registrados</span>
        {registrados.length === 0 ? (
          <div className="cr-empty">
            <div className="cr-empty__title">Aun no has registrado ningun recibo.</div>
          </div>
        ) : (
          <table className="cr-table cr-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th className="cr-num">Monto</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {registrados.map((f) => (
                <tr key={f.id}>
                  <td className="cr-code" data-label="Folio">
                    <a href={`/facturas/${f.id}`}>{f.folio}</a>
                  </td>
                  <td className="cr-num" data-label="Monto">
                    {f.total}
                  </td>
                  <td data-label="Estado">
                    <span className="cr-status" data-tone="ok">
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
