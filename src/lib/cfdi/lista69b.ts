import { getConfig } from '../config'

/**
 * Lista del articulo 69-B del CFF: los EFOS (§12.2 regla LISTA_69B).
 *
 * QUE ES. El SAT publica los RFC de quienes emitieron comprobantes sin tener con
 * que respaldarlos. Un contribuyente pasa por cuatro situaciones:
 *
 *   Presunto             el SAT lo senala y le abre plazo para defenderse
 *   Desvirtuado          se defendio y gano: su factura vale
 *   Definitivo           no se defendio o perdio: sus facturas NO tienen efecto
 *   Sentencia favorable  un tribunal le dio la razon: su factura vale
 *
 * POR QUE IMPORTA MAS QUE CASI TODO LO DEMAS. Una factura de un DEFINITIVO no es
 * deducible ni acreditable, y el efecto es RETROACTIVO: alcanza a las facturas
 * que KPS ya pago y ya dedujo. El SAT puede exigir el IVA acreditado y el ISR
 * deducido de vuelta, con recargos, anos despues. Es la unica validacion del
 * portal cuyo coste de omitir se mide en dinero que ya salio.
 *
 * PRESUNTO NO BLOQUEA, DEFINITIVO SI. Un presunto todavia puede desvirtuar, y
 * bloquear a un proveedor por una presuncion que quiza se caiga seria castigarle
 * antes de tiempo. Se avisa; la decision de seguir comprandole es de KPS.
 *
 * LA LISTA SE DESCARGA Y SE GUARDA EN MEMORIA. Son unos pocos miles de RFC: cabe
 * de sobra. Se rebaja cada `LISTA_69B_MAX_AGE_HOURS` porque el SAT la publica
 * quincenalmente, y un fallo de descarga NO invalida la copia que ya se tenia:
 * una lista de hace nueve dias es infinitamente mejor que ninguna.
 */

export type SituacionEfos = 'PRESUNTO' | 'DESVIRTUADO' | 'DEFINITIVO' | 'SENTENCIA_FAVORABLE'

export interface ResultadoEfos {
  /** `true` si el RFC aparece en la lista, sea cual sea su situacion. */
  readonly listado: boolean
  readonly situacion: SituacionEfos | null
  readonly nombre: string | null
  /** Cuando se descargo la lista con la que se contesto. */
  readonly listaDescargadaEl: Date | null
  /** Cuantos RFC tiene la lista cargada. Sirve para detectar una descarga rota. */
  readonly rfcEnLista: number
  /** Por que no se pudo contestar. Null si la consulta funciono. */
  readonly motivo: string | null
}

interface ListaCargada {
  readonly porRfc: Map<string, { situacion: SituacionEfos; nombre: string }>
  readonly descargadaEl: Date
}

let lista: ListaCargada | null = null
/** Descarga en vuelo. Evita que diez cargas simultaneas bajen diez veces el CSV. */
let enVuelo: Promise<ListaCargada | null> | null = null

/** Solo para pruebas: descarta la lista en memoria. */
export function limpiarCacheLista69b(): void {
  lista = null
  enVuelo = null
}

/**
 * Parte una linea de CSV respetando las comillas.
 *
 * La razon social de un contribuyente lleva comas con toda naturalidad
 * ("COMERCIALIZADORA X, S.A. DE C.V."), asi que partir por comas a secas
 * desplaza todas las columnas siguientes y la situacion se lee de otra celda.
 */
function partirCsv(linea: string): string[] {
  const campos: string[] = []
  let actual = ''
  let entreComillas = false

  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]
    if (c === '"') {
      // Dos comillas seguidas dentro de un campo entrecomillado son una comilla.
      if (entreComillas && linea[i + 1] === '"') {
        actual += '"'
        i++
      } else {
        entreComillas = !entreComillas
      }
    } else if (c === ',' && !entreComillas) {
      campos.push(actual)
      actual = ''
    } else {
      actual += c
    }
  }
  campos.push(actual)
  return campos.map((c) => c.trim())
}

/** Sin acentos y en minusculas, para comparar encabezados. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

function situacionDe(valor: string): SituacionEfos | null {
  const v = normalizar(valor)
  if (v.startsWith('definitivo')) return 'DEFINITIVO'
  if (v.startsWith('presunto')) return 'PRESUNTO'
  if (v.startsWith('desvirtuado')) return 'DESVIRTUADO'
  if (v.includes('sentencia')) return 'SENTENCIA_FAVORABLE'
  return null
}

/**
 * Convierte el CSV del SAT en un indice por RFC.
 *
 * El archivo trae unas lineas de preambulo antes del encabezado y el numero de
 * columnas ha cambiado entre publicaciones. Por eso NO se leen columnas por
 * posicion fija: se busca la fila que contiene "RFC" y se localizan ahi los
 * indices que hacen falta. Una publicacion con una columna de mas seguiria
 * funcionando; con posiciones fijas se leeria basura en silencio.
 */
function indexar(csv: string): Map<string, { situacion: SituacionEfos; nombre: string }> {
  const lineas = csv.split(/\r?\n/)

  let iRfc = -1
  let iSituacion = -1
  let iNombre = -1
  let primeraFila = -1

  for (let i = 0; i < Math.min(lineas.length, 20); i++) {
    const celdas = partirCsv(lineas[i]).map(normalizar)
    const rfc = celdas.findIndex((c) => c === 'rfc')
    if (rfc === -1) continue
    iRfc = rfc
    iSituacion = celdas.findIndex((c) => c.includes('situacion'))
    iNombre = celdas.findIndex((c) => c.includes('nombre'))
    primeraFila = i + 1
    break
  }

  if (iRfc === -1 || iSituacion === -1) {
    throw new Error(
      'El CSV del SAT no trae las columnas RFC y Situacion donde se esperaban. Puede que hayan cambiado el formato.',
    )
  }

  const porRfc = new Map<string, { situacion: SituacionEfos; nombre: string }>()
  for (let i = primeraFila; i < lineas.length; i++) {
    if (!lineas[i].trim()) continue
    const celdas = partirCsv(lineas[i])
    const rfc = (celdas[iRfc] ?? '').toUpperCase().replace(/\s+/g, '')
    if (!rfc) continue
    const situacion = situacionDe(celdas[iSituacion] ?? '')
    if (!situacion) continue

    // Un RFC puede aparecer varias veces al pasar de presunto a definitivo o a
    // desvirtuado. Se conserva la situacion mas grave: entre "definitivo" y
    // cualquier otra, la que importa para no deducir es definitivo.
    const previo = porRfc.get(rfc)
    if (previo?.situacion === 'DEFINITIVO') continue
    porRfc.set(rfc, { situacion, nombre: celdas[iNombre] ?? '' })
  }

  return porRfc
}

/** Descarga el CSV y lo indexa. Devuelve null si no se pudo. */
async function descargar(): Promise<ListaCargada | null> {
  const cfg = getConfig().lista69b
  try {
    const r = await fetch(cfg.url, { signal: AbortSignal.timeout(cfg.timeoutMs) })
    if (!r.ok) return null

    // El SAT publica el archivo en Windows-1252, no en UTF-8: leerlo como UTF-8
    // rompe los acentos de las razones sociales y, con ellos, el encabezado
    // "Situacion del contribuyente" que sirve para localizar la columna.
    const bytes = new Uint8Array(await r.arrayBuffer())
    let csv: string
    try {
      csv = new TextDecoder('windows-1252').decode(bytes)
    } catch {
      csv = new TextDecoder('utf-8').decode(bytes)
    }

    const porRfc = indexar(csv)
    // Una lista vacia es una descarga rota disfrazada de exito —una pagina de
    // mantenimiento, un redirect—. Se rechaza para conservar la copia anterior.
    if (porRfc.size === 0) return null

    return { porRfc, descargadaEl: new Date() }
  } catch {
    return null
  }
}

/** La lista, rebajandola si esta vieja. Conserva la copia anterior si falla. */
async function obtenerLista(): Promise<ListaCargada | null> {
  const cfg = getConfig().lista69b
  const maxEdadMs = cfg.maxAgeHours * 60 * 60 * 1000
  if (lista !== null && Date.now() - lista.descargadaEl.getTime() < maxEdadMs) {
    return lista
  }

  enVuelo ??= descargar().finally(() => {
    enVuelo = null
  })

  const nueva = await enVuelo
  // Si la descarga fallo se conserva la copia vieja: una lista de la semana
  // pasada detecta igual al 99% de los EFOS, y quedarse sin ninguna significaria
  // dejar de comprobar justo cuando el SAT tiene su sitio caido.
  if (nueva) lista = nueva
  return lista
}

/**
 * Busca un RFC en la lista del 69-B.
 *
 * NUNCA LANZA. Si no hay lista se contesta con `motivo` y sin veredicto, y quien
 * llama lo reporta como no comprobado.
 */
export async function consultarLista69b(rfc: string): Promise<ResultadoEfos> {
  const cfg = getConfig().lista69b

  if (!cfg.enabled) {
    return {
      listado: false,
      situacion: null,
      nombre: null,
      listaDescargadaEl: null,
      rfcEnLista: 0,
      motivo: 'La comprobacion del 69-B esta apagada (LISTA_69B_ENABLED=false).',
    }
  }

  const cargada = await obtenerLista()
  if (!cargada) {
    return {
      listado: false,
      situacion: null,
      nombre: null,
      listaDescargadaEl: null,
      rfcEnLista: 0,
      motivo: 'No se pudo descargar la lista del 69-B del SAT.',
    }
  }

  const encontrado = cargada.porRfc.get(rfc.trim().toUpperCase())
  return {
    listado: encontrado !== undefined,
    situacion: encontrado?.situacion ?? null,
    nombre: encontrado?.nombre || null,
    listaDescargadaEl: cargada.descargadaEl,
    rfcEnLista: cargada.porRfc.size,
    motivo: null,
  }
}
