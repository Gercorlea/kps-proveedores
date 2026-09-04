import { FACTURAS } from '@/lib/demo/portal'

/** Pagos vista proveedor: que se ha pagado y que falta por cobrar. */
export default function Page() {
  const pagadas = FACTURAS.filter((f) => f.estatus === 'PAGADA' || f.estatus === 'CERRADA')
  const porCobrar = FACTURAS.filter((f) =>
    ['APROBADA_PAGO', 'CUENTAS_POR_PAGAR', 'EN_REVISION'].includes(f.estatus),
  )

  return (
    <>
      <div className="cr-page-head">
        <div>
          <h1>Pagos</h1>
          <p className="cr-lead cr-flush">
            {pagadas.length} facturas pagadas · {porCobrar.length} en proceso de cobro
          </p>
        </div>
        <div className="cr-page-head__meta">
          <span className="cr-meta">Proveedor · P-10442</span>
          <br />
          <span className="cr-meta">Datos de muestra</span>
        </div>
      </div>

      {/* §08 nota de diseno: el estatus de pago lo captura KPS a mano en el MVP. */}
      <div className="cr-info">
        <span className="cr-info__label">Como se actualiza esta pantalla</span>
        <p>
          KPS paga fuera del portal y despues marca la factura como pagada. Por eso puede haber unas
          horas entre que recibes la transferencia y que aparece aqui. Si ya cobraste y sigue sin
          aparecer, sube el recibo igualmente: el bloqueo por recibo pendiente corre desde que KPS
          marca el pago, no desde que tu lo ves.
        </p>
      </div>

      <section className="cr-section">
        <span className="cr-label">Pagadas</span>
        {pagadas.length === 0 ? (
          <div className="cr-empty">
            <div className="cr-empty__title">Todavia no tienes pagos registrados.</div>
          </div>
        ) : (
          <table className="cr-table cr-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Tipo</th>
                <th className="cr-num">Monto</th>
                <th>Recibo</th>
                <th className="cr-num">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {pagadas.map((f) => (
                <tr key={f.id}>
                  <td className="cr-code" data-label="Folio">
                    <a href={`/facturas/${f.id}`}>{f.folio}</a>
                  </td>
                  <td data-label="Tipo">{f.tipo}</td>
                  <td className="cr-num" data-label="Monto">
                    {f.total}
                  </td>
                  <td data-label="Recibo">
                    <span className="cr-status" data-tone={f.estatus === 'CERRADA' ? 'ok' : 'warn'}>
                      {f.estatus === 'CERRADA' ? 'Registrado' : 'Pendiente'}
                    </span>
                  </td>
                  <td className="cr-num" data-label="Fecha">
                    {f.fecha}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="cr-section">
        <span className="cr-label">En proceso de cobro</span>
        {porCobrar.length === 0 ? (
          <div className="cr-empty">
            <div className="cr-empty__title">No tienes facturas esperando pago.</div>
          </div>
        ) : (
          <table className="cr-table cr-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th className="cr-num">Monto</th>
                <th className="cr-num">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {porCobrar.map((f) => (
                <tr key={f.id}>
                  <td className="cr-code" data-label="Folio">
                    <a href={`/facturas/${f.id}`}>{f.folio}</a>
                  </td>
                  <td className="cr-num" data-label="Monto">
                    {f.total}
                  </td>
                  <td className="cr-num" data-label="Fecha">
                    {f.fecha}
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
