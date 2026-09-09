import { AvisoToast } from '../toast'
import Link from 'next/link'
import { Buscador } from '../buscador'
import { TablaAdaptable } from '../tabla-adaptable'
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

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; f?: string; p?: string }> }) {
  const { q = '', f, p } = await searchParams
  const termino = q.trim()
  const filtro = f === 'vencidos' || f === 'vigentes' ? f : 'todos'
  const session = await getSession()
  if (!session) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Sin sesion</span>
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

  const visibles = pendientes.filter((c) => {
    const coincide = !termino || [c.folio, c.uuid, c.total].some((v) => v?.toLocaleLowerCase().includes(termino.toLocaleLowerCase()))
    return coincide && (filtro === 'todos' || (filtro === 'vencidos' ? (c.diasRestantes ?? 1) < 0 : c.diasRestantes !== null && c.diasRestantes >= 0))
  })
  const filtros = { q: termino || undefined, f: filtro === 'todos' ? undefined : filtro }

  return (
    <>
      <div className="cr-page-head cr-page-head--listado">
        <div><h1>Complementos de pago</h1><p className="cr-lead cr-flush">Carga de XML para facturas PPD pagadas</p></div>
      </div>
      {error ? <><AvisoToast mensaje={error} /><div className="cr-empty"><p>No se pudieron consultar los complementos. Intenta recargar la página.</p></div></> : (
        <section className="cr-panel cr-listado cr-complementos" aria-label="Complementos pendientes">
          <div className="cr-panel__head">
            <div><h2 className="cr-panel__title">Pendientes de complemento</h2><p className="cr-panel__sub">{pendientes.length} {pendientes.length === 1 ? 'pendiente' : 'pendientes'}{vencidos > 0 ? ` \u00b7 ${vencidos} ${vencidos === 1 ? 'vencido' : 'vencidos'}` : ''}</p></div>
            <div className="cr-panel__controles">
              <Buscador base="/complementos" termino={termino} filtros={filtros} placeholder="Factura, UUID o importe" etiqueta="Buscar complementos" />
              <nav className="cr-segment" aria-label="Filtrar por plazo">
                {([['todos', 'Todos'], ['vencidos', 'Vencidos'], ['vigentes', 'En plazo']] as const).map(([valor, etiqueta]) => {
                  const params = new URLSearchParams()
                  if (termino) params.set('q', termino)
                  if (valor !== 'todos') params.set('f', valor)
                  return <Link key={valor} href={`/complementos${params.size ? '?' + params : ''}`} scroll={false} className="cr-segment__item" data-active={filtro === valor ? 'true' : undefined} aria-current={filtro === valor ? 'page' : undefined}>{etiqueta}</Link>
                })}
              </nav>
            </div>
          </div>
          {visibles.length === 0 ? <div className="cr-empty cr-empty--compacto"><div className="cr-empty__title">{pendientes.length === 0 ? 'Sin complementos pendientes' : 'Sin resultados'}</div><p>{pendientes.length === 0 ? 'Aquí aparecerán las facturas PPD cuando se registre su pago.' : 'Prueba con otra búsqueda o cambia el filtro de plazo.'}</p></div> : (
            <TablaAdaptable base="/complementos" unidad="complementos" pagina={p} filtros={filtros} reservaInferior={48}
              className="cr-table cr-table--stack cr-listado__tabla cr-complementos__tabla"
              cabecera={<thead><tr><th>Factura</th><th className="cr-num">Total</th><th>Pagada</th><th>Fecha límite</th><th className="cr-num">Acción</th></tr></thead>}
              filas={visibles.map((c) => { const limite = plazo(c); return (
                <tr key={c.folio}>
                  <td className="cr-code" data-label="Factura" title={c.folio}>{c.folio}</td>
                  <td className="cr-num" data-label="Total">{c.total}</td>
                  <td className="cr-code" data-label="Pagada">{fecha(c.pagadaEl)}</td>
                  <td data-label="Fecha límite"><span className="cr-badge" data-tone={limite.tono}>{limite.texto}</span></td>
                  <td className="cr-complementos__accion" data-label="Acción"><Subir folio={c.folio} /></td>
                </tr>
              )})} />
          )}
        </section>
      )}
      <p className="cr-complementos__nota">El complemento vence el día 5 del mes siguiente al pago. Solo aplica a facturas PPD.</p>
    </>
  )
}
