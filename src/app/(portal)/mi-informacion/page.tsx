import { getSession } from '@/lib/auth/server'
import { SupplierStatus, SupplierType } from '@/lib/domain/enums'
import { getProveedorActual } from '@/lib/suppliers/current'

/**
 * Mi informacion · la ficha completa de lo que KPS tiene registrado.
 *
 * Se muestra ENTERA a proposito. Antes solo salian razon social, codigo y tipo,
 * y el proveedor no tenia como comprobar el dato que mas devoluciones causa: el
 * RFC y el domicilio con los que se emite el CFDI. Si aqui no coinciden con los
 * suyos, lo sabe antes de facturar y no despues del rechazo.
 *
 * Para uno de servicios ademas no es informativa sino operativa: el catalogo de
 * servicios vigentes es lo que acota lo que puede facturar —el papel que en
 * mercancia hace la orden de compra—, asi que tiene que poder consultarlo sin
 * llamar por telefono.
 */
export const dynamic = 'force-dynamic'

const MES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

/** Formato a mano y no `toLocaleDateString`: el locale del servidor no tiene por que ser el del navegador. */
function fecha(valor: Date | null): string {
  if (!valor) return '—'
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2, '0')} ${MES[d.getMonth()]} ${d.getFullYear()}`
}

const ETIQUETA_ESTATUS: Record<SupplierStatus, string> = {
  ALTA_PENDIENTE: 'Alta pendiente de revision',
  ALTA_CORRECCION: 'Alta devuelta para correccion',
  ALTA_RECHAZADA: 'Alta rechazada',
  ACTIVO: 'Activo',
  BLOQUEADO: 'Bloqueado',
  INACTIVO: 'Inactivo',
}

/**
 * Etiquetas de los campos del domicilio y del contacto.
 *
 * Los dos son documentos libres —vienen de B1 y su forma la fija SAP, no el
 * portal—, asi que se recorren en vez de leerse campo a campo: si manana B1
 * empieza a mandar `colonia` o `numeroExterior`, sale sola en la tabla en vez de
 * perderse en silencio. Este diccionario solo mejora el texto de las claves que
 * ya se conocen; a las demas se les da formato a partir de la propia clave.
 */
const ETIQUETAS: Record<string, string> = {
  calle: 'Calle y numero',
  numero: 'Numero',
  colonia: 'Colonia',
  municipio: 'Municipio o alcaldia',
  ciudad: 'Ciudad',
  estado: 'Estado',
  cp: 'Codigo postal',
  codigoPostal: 'Codigo postal',
  pais: 'Pais',
  nombre: 'Nombre',
  correo: 'Correo',
  email: 'Correo',
  telefono: 'Telefono',
  puesto: 'Puesto',
}

function etiqueta(clave: string): string {
  if (ETIQUETAS[clave]) return ETIQUETAS[clave]
  // camelCase -> "Camel case", que es lo mas legible que se puede sacar de una
  // clave desconocida sin inventarse una traduccion.
  const separado = clave.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return separado.charAt(0).toUpperCase() + separado.slice(1)
}

/** Pares [etiqueta, valor] de un documento libre, sin los campos vacios. */
function filas(doc: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(doc)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => [etiqueta(k), String(v)] as [string, string])
}

function Matriz({ datos }: { datos: Array<[string, string]> }) {
  return (
    <dl className="cr-perfil__datos">
      {datos.map(([label, valor]) => <div key={label}><dt>{label}</dt><dd>{valor}</dd></div>)}
    </dl>
  )
}

export default async function Page() {
  const [session, proveedor] = await Promise.all([getSession(), getProveedorActual()])

  if (!proveedor) {
    return (
      <>
        <div className="cr-page-head cr-page-head--listado"><div><h1>Mi información</h1><p className="cr-lead cr-flush">Datos de tu cuenta y registro de proveedor</p></div></div>
        <div className="cr-perfil">
          {session && <section className="cr-panel"><div className="cr-panel__head"><h2 className="cr-panel__title">Tu cuenta de acceso</h2></div><Matriz datos={[[ 'Nombre', session.name ], ['Correo', session.email], ['Permisos', session.roles.join(', ')]]} /></section>}
          <section className="cr-panel"><div className="cr-panel__head"><h2 className="cr-panel__title">Registro de proveedor</h2></div><div className="cr-empty cr-empty--compacto"><div className="cr-empty__title">Ficha de proveedor no disponible</div><p>Tu cuenta no está vinculada a un proveedor o no se pudo consultar su ficha. Si deberías tener acceso, contacta a KPS.</p></div></section>
        </div>
      </>
    )
  }

  const esServicio = proveedor.tipo === SupplierType.SERVICIO

  const fiscales: Array<[string, string]> = [
    ['Razon social', proveedor.nombre],
    ['RFC', proveedor.rfc],
    ['Codigo en Business One', proveedor.supplierCode],
    ['Tipo de proveedor', esServicio ? 'Servicios' : 'Mercancia'],
    ['Estatus', ETIQUETA_ESTATUS[proveedor.estatus] ?? proveedor.estatus],
    ['Constancia de situacion fiscal', fecha(proveedor.constanciaFecha)],
  ]

  const comerciales: Array<[string, string]> = [
    ['Condiciones de pago', proveedor.condicionesPago ?? '—'],
    ['Moneda pactada', proveedor.moneda ?? '—'],
    ['Grupo en Business One', proveedor.grupoB1 === null ? '—' : String(proveedor.grupoB1)],
  ]

  const registro: Array<[string, string]> = [
    ['Alta en el portal', fecha(proveedor.altaEn)],
    ['Ultima actualizacion', fecha(proveedor.actualizadoEn)],
    ['Ultima sincronizacion con Business One', fecha(proveedor.sincronizadoEn)],
  ]

  const domicilio = filas(proveedor.domicilio)
  const contacto = filas(proveedor.contacto)

  const cuenta: Array<[string, string]> = session
    ? [
        ['Nombre', session.name],
        ['Correo', session.email],
        ['Permisos', session.roles.join(', ')],
      ]
    : []

  return (
    <>
      <div className="cr-page-head cr-page-head--listado">
        <div>
          <h1>Mi información</h1>
          <p className="cr-lead cr-flush">
            {proveedor.nombre}
          </p>
        </div>
        <div className="cr-page-head__meta">
          <span className="cr-meta">Proveedor · {proveedor.supplierCode}</span>
          <br />
          <span className="cr-badge" data-tone={proveedor.bloqueado ? 'danger' : 'ok'}>
            {proveedor.bloqueado ? 'Retenido' : 'Activo'}
          </span>
        </div>
      </div>

      {proveedor.bloqueado && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">
            Tu cuenta esta retenida
            {proveedor.bloqueadoDesde ? ` desde el ${fecha(proveedor.bloqueadoDesde)}` : ''}
          </span>
          <p>
            {proveedor.motivoBloqueo ??
              'KPS retuvo tu cuenta y mientras siga asi no se admiten facturas nuevas.'}
          </p>
        </div>
      )}

      <div className="cr-perfil">
      <section className="cr-panel">
        <div className="cr-panel__head"><h2 className="cr-panel__title">Datos fiscales</h2></div>
        <p className="cr-small">
          Es con estos datos con los que tienes que emitir el CFDI. Si alguno no coincide con el que
          usa tu facturador, la factura se devuelve: avisa a KPS antes de emitirla.
        </p>
        <Matriz datos={fiscales} />
      </section>

      <section className="cr-panel">
        <div className="cr-panel__head"><h2 className="cr-panel__title">Domicilio fiscal</h2></div>
        {domicilio.length === 0 ? (
          <div className="cr-empty">
            <div className="cr-empty__title">KPS no tiene tu domicilio fiscal registrado.</div>
            <p>Pide que lo capturen: forma parte de la ficha con la que se coteja tu CFDI.</p>
          </div>
        ) : (
          <Matriz datos={domicilio} />
        )}
      </section>

      <section className="cr-panel">
        <div className="cr-panel__head"><h2 className="cr-panel__title">Contacto registrado</h2></div>
        {contacto.length === 0 ? (
          <div className="cr-empty">
            <div className="cr-empty__title">No hay contacto registrado.</div>
            <p>
              Es a donde KPS escribe cuando una factura tuya necesita correccion. Sin el, los avisos
              no llegan a nadie.
            </p>
          </div>
        ) : (
          <Matriz datos={contacto} />
        )}
      </section>

      <section className="cr-panel">
        <div className="cr-panel__head"><h2 className="cr-panel__title">Condiciones comerciales</h2></div>
        <Matriz datos={comerciales} />
      </section>

      {/* Solo para servicios: en mercancia este bloque no existe porque lo que
          acota la facturacion son las ordenes de compra, que tienen su propia
          seccion en el menu. */}
      {esServicio && (
        <section className="cr-panel">
          <div className="cr-panel__head"><h2 className="cr-panel__title">Servicios contratados</h2></div>
          {proveedor.servicios.length === 0 ? (
            <div className="cr-empty">
              <div className="cr-empty__title">No tienes servicios vigentes.</div>
              <p>
                Tus facturas se cargan contra un servicio contratado, asi que hasta que KPS registre
                al menos uno no vas a poder enviar facturas. Pideselo a tu contacto en compras.
              </p>
            </div>
          ) : (
            <>
              <p className="cr-small">
                Esto es lo que puedes facturar. Si prestaste un servicio que no esta en la lista,
                pide que lo registren antes de emitir el CFDI: una factura que no corresponde a
                ninguno se devuelve.
              </p>
              <table className="cr-table cr-table--stack">
                <thead>
                  <tr>
                    <th>Servicio</th>
                    <th>Alcance</th>
                    <th>Estatus</th>
                  </tr>
                </thead>
                <tbody>
                  {proveedor.servicios.map((s) => (
                    <tr key={s.id}>
                      <td data-label="Servicio">{s.title}</td>
                      <td data-label="Alcance">{s.description}</td>
                      <td data-label="Estatus">
                        <span className="cr-badge" data-tone="ok">
                          Vigente
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {/* Los de baja van aparte y despues: en la misma tabla, quien la mira por
          encima creeria que tambien puede facturarlos. */}
      {esServicio && proveedor.serviciosBaja.length > 0 && (
        <section className="cr-panel">
          <div className="cr-panel__head"><h2 className="cr-panel__title">Servicios dados de baja</h2></div>
          <p className="cr-small">
            Ya no se pueden facturar. Se listan para que sepas por que una factura contra ellos se
            rechaza.
          </p>
          <table className="cr-table cr-table--stack">
            <thead>
              <tr>
                <th>Servicio</th>
                <th>Alcance</th>
                <th>Estatus</th>
              </tr>
            </thead>
            <tbody>
              {proveedor.serviciosBaja.map((s) => (
                <tr key={s.id}>
                  <td data-label="Servicio">{s.title}</td>
                  <td data-label="Alcance">{s.description}</td>
                  <td data-label="Estatus">
                    <span className="cr-badge" data-tone="danger">
                      De baja
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {cuenta.length > 0 && (
        <section className="cr-panel">
          <div className="cr-panel__head"><h2 className="cr-panel__title">Tu cuenta de acceso</h2></div>
          <Matriz datos={cuenta} />
        </section>
      )}

      <section className="cr-panel">
        <div className="cr-panel__head"><h2 className="cr-panel__title">Registro</h2></div>
        <Matriz datos={registro} />
      </section>

      <section className="cr-panel">
        <div className="cr-info">
          <span className="cr-info__label">Que puedes cambiar y que no</span>
          <p>
            La razon social, el RFC y el domicilio fiscal vienen de Business One, que es la fuente de
            verdad de los datos del proveedor. Para modificarlos hay que pedirselo a KPS: el portal
            no los reescribe por su cuenta.
          </p>
          {esServicio && (
            <p>
              El alta y la baja de servicios tambien las hace KPS. Tu no puedes anadirte uno, porque
              es lo que determina contra que presupuesto se aprueba tu factura.
            </p>
          )}
        </div>
      </section>
      </div>
    </>
  )
}
