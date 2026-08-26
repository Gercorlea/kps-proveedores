import { getConfig } from '../config'
import {
  B1_OBJECT_TYPE,
  SapError,
  type AttachmentInput,
  type B1BusinessPartner,
  type B1ObjectType,
  type B1PurchaseCreditNote,
  type B1PurchaseDeliveryNote,
  type B1PurchaseInvoice,
  type B1BinLocation,
  type B1Item,
  type B1Warehouse,
  type B1PurchaseOrder,
  type CreateBusinessPartnerPayload,
  type CreatePurchaseCreditNotePayload,
  type CreatePurchaseDeliveryNotePayload,
  type CreatePurchaseInvoiceFromDeliveryPayload,
  type CreatePurchaseOrderPayload,
  type CreateServiceInvoicePayload,
  type B1PaymentTermsType,
  type ListOptions,
  type Page,
  type SapB1Client,
  type SapErrorKind,
} from './types'

/**
 * Cliente real del Service Layer de SAP Business One (OData v4).
 *
 * Solo debe usarse desde codigo de servidor. §04 principio 2: ninguna llamada a
 * SAP ocurre dentro de un request HTTP del portal — esto vive en workers.
 *
 * Sobre el manejo de sesion (§00 consecuencia 05): se mantiene UNA sesion
 * compartida y se deduplican los logins concurrentes con una promesa. Es el
 * mismo patron que ya funciona en kps-dashboard, y consume una sola del cupo de
 * sesiones concurrentes de B1, que es el recurso escaso.
 */

interface Session {
  cookie: string
  expiresAt: number
}

/** Margen para renovar antes de que B1 la caduque y nos devuelva un 401. */
const RENEW_MARGIN_MS = 60_000

/**
 * Campos que se piden de cada entidad. Sin $select, B1 devuelve la entidad
 * completa: 311 campos en Items. Satura la red y el log sin aportar nada.
 */
const SELECT = {
  businessPartner:
    'CardCode,CardName,CardType,GroupCode,Phone1,EmailAddress,CurrentAccountBalance,Currency,Valid,FederalTaxID,PayTermsGrpCode,UpdateDate',
  document:
    'DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocCurrency,DocRate,DocTotal,VatSum,DocumentStatus,Cancelled,NumAtCard,Comments,UpdateDate,AttachmentEntry,PaymentGroupCode',
  /**
   * Cabecera minima MAS los renglones. `DocumentLines` es una coleccion
   * anidada: pedirla en el $select la trae entera, sin $expand. Se recorta la
   * cabecera a lo imprescindible porque cada documento ya viene cargado con sus
   * lineas y el resto de campos no se usa para cruzar.
   */
  documentWithLines:
    'DocEntry,DocNum,CardCode,CardName,DocDate,DocCurrency,DocRate,DocTotal,VatSum,DocumentStatus,Cancelled,PaymentGroupCode,DocumentLines',
} as const

/**
 * Escapa un literal para un $filter de OData: la comilla simple se duplica.
 * Sin esto, un CardCode con apostrofe rompe la consulta — y es la via por la
 * que se inyecta OData.
 */
function odataLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Fecha en el formato que acepta el Service Layer. */
function toB1Date(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function kindFromStatus(status: number): SapErrorKind {
  if (status === 401) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limit'
  if (status >= 400 && status < 500) return 'validation'
  return 'unknown'
}

/** Traduce un fallo de red de undici a un SapError con su causa util. */
function kindFromNetworkError(error: unknown): { kind: SapErrorKind; message: string } {
  const code =
    (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code
  const name = (error as { name?: string })?.name

  if (name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return { kind: 'timeout', message: 'El Service Layer no respondio a tiempo.' }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { kind: 'network', message: 'No se resolvio el host del Service Layer.' }
  }
  if (code === 'ECONNREFUSED') {
    return { kind: 'network', message: 'El Service Layer rechazo la conexion.' }
  }
  if (typeof code === 'string' && code.includes('CERT')) {
    return {
      kind: 'network',
      message: `Problema de certificado TLS con el Service Layer (${code}).`,
    }
  }
  return {
    kind: 'network',
    message: error instanceof Error ? error.message : 'Fallo de red contra el Service Layer.',
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Backoff exponencial con jitter, para no sincronizar los reintentos. */
function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8_000)
  return base + Math.floor(Math.random() * 250)
}

async function readError(res: Response): Promise<{ code?: string | number; message: string }> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string | number; message?: { value?: string } | string }
    }
    const raw = body.error?.message
    const message = (typeof raw === 'string' ? raw : raw?.value) ?? `HTTP ${res.status}`
    return { code: body.error?.code, message }
  } catch {
    return { message: `El Service Layer respondio ${res.status} sin cuerpo interpretable.` }
  }
}

export class ServiceLayerClient implements SapB1Client {
  private session: Session | null = null
  private loginPromise: Promise<Session> | null = null

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private get config() {
    return getConfig().sap
  }

  // -------------------------------------------------------------------------
  // Sesion
  // -------------------------------------------------------------------------

  private async login(): Promise<Session> {
    const { baseUrl, companyDb, username, password, sessionTtlMs } = this.config

    let res: Response
    try {
      res = await this.fetchImpl(`${baseUrl}/Login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CompanyDB: companyDb, UserName: username, Password: password }),
        cache: 'no-store',
      })
    } catch (error) {
      const { kind, message } = kindFromNetworkError(error)
      throw new SapError(kind, message, { cause: error, retryable: true })
    }

    if (!res.ok) {
      const { code, message } = await readError(res)
      throw new SapError(kindFromStatus(res.status), message, {
        httpStatus: res.status,
        sapCode: code,
      })
    }

    const cookie = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith('B1SESSION') || c.startsWith('ROUTEID'))
      .map((c) => c.split(';')[0])
      .join('; ')

    if (!cookie) {
      throw new SapError(
        'auth',
        'El Login respondio correctamente pero SAP no devolvio la cookie B1SESSION. Revisa si hay un proxy inverso descartando Set-Cookie.',
        { httpStatus: res.status },
      )
    }

    // B1 informa el timeout en MINUTOS. Se renueva antes, con margen, para no
    // depender nunca de recibir un 401.
    const body = (await res.json()) as { SessionTimeout?: number }
    const fromSap = (body.SessionTimeout ?? 30) * 60_000
    const ttl = Math.min(fromSap, sessionTtlMs)

    return { cookie, expiresAt: Date.now() + ttl - RENEW_MARGIN_MS }
  }

  private async getSession(): Promise<Session> {
    if (this.session && Date.now() < this.session.expiresAt) return this.session
    // Deduplica: veinte llamadas concurrentes al arrancar hacen un solo Login,
    // en vez de veinte sesiones que se comen el cupo de B1.
    this.loginPromise ??= this.login().finally(() => {
      this.loginPromise = null
    })
    this.session = await this.loginPromise
    return this.session
  }

  /** Cierra la sesion en B1. Llamarlo al apagar el worker. */
  async logout(): Promise<void> {
    if (!this.session) return
    const cookie = this.session.cookie
    this.session = null
    try {
      await this.fetchImpl(`${this.config.baseUrl}/Logout`, {
        method: 'POST',
        headers: { Cookie: cookie },
        cache: 'no-store',
      })
    } catch {
      // Si no se pudo cerrar, caduca sola. No vale la pena tumbar el apagado.
    }
  }

  // -------------------------------------------------------------------------
  // Transporte
  // -------------------------------------------------------------------------

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const { baseUrl, requestTimeoutMs, pageSize, maxRetries } = this.config
    const session = await this.getSession()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)

    let res: Response
    try {
      res = await this.fetchImpl(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          // Sin esta cabecera el Service Layer devuelve 20 filas por respuesta
          // (el PageSize de b1s.conf) aunque el $top pida mas, y la
          // sincronizacion se queda corta sin ningun error visible.
          Prefer: `odata.maxpagesize=${pageSize}`,
          ...init.headers,
          Cookie: session.cookie,
        },
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch (error) {
      const { kind, message } = kindFromNetworkError(error)
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt))
        return this.request<T>(path, init, attempt + 1)
      }
      throw new SapError(kind, message, { cause: error, retryable: true })
    } finally {
      clearTimeout(timer)
    }

    // Sesion caducada del lado de B1: se invalida, se reloguea y se reintenta
    // una sola vez. Un segundo 401 es un problema de credenciales, no de sesion.
    if (res.status === 401 && attempt === 0) {
      this.session = null
      return this.request<T>(path, init, attempt + 1)
    }

    if (!res.ok) {
      const { code, message } = await readError(res)
      const error = new SapError(kindFromStatus(res.status), message, {
        httpStatus: res.status,
        sapCode: code,
      })
      if (error.retryable && attempt < maxRetries) {
        await sleep(backoffMs(attempt))
        return this.request<T>(path, init, attempt + 1)
      }
      throw error
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  /** GET de una coleccion, con $select, $filter y paginacion. */
  private async list<T>(
    entity: string,
    select: string,
    filters: string[],
    options: ListOptions | undefined,
    orderBy: string,
  ): Promise<Page<T>> {
    const top = Math.min(options?.top ?? this.config.pageSize, this.config.pageSize)
    const skip = options?.skip ?? 0

    const params = new URLSearchParams()
    if (filters.length > 0) params.set('$filter', filters.join(' and '))
    params.set('$select', select)
    params.set('$orderby', orderBy)
    params.set('$top', String(top))
    if (skip > 0) params.set('$skip', String(skip))
    // Sin el conteo no se puede paginar: solo se sabria que hay "algo mas".
    // `$count=true` es la forma de OData 4 (Service Layer v2) y el v1 tambien la
    // acepta — comprobado contra la instancia de KPS, responde `odata.count`.
    params.set('$count', 'true')

    const body = await this.request<{
      value?: T[]
      'odata.count'?: string | number
      '@odata.count'?: string | number
      'odata.nextLink'?: string
      '@odata.nextLink'?: string
    }>(`/${entity}?${params.toString()}`)

    const items = body.value ?? []
    const contado = Number(body['odata.count'] ?? body['@odata.count'])
    const total = Number.isFinite(contado) ? contado : undefined

    // B1 solo manda `nextLink` cuando trunca por el maxpagesize de la cabecera
    // Prefer; con un $top mas pequeno que la pagina no lo manda aunque queden
    // filas por leer. Por eso el total manda, y el nextLink queda de respaldo.
    const hasNext =
      total !== undefined
        ? skip + items.length < total
        : Boolean(body['odata.nextLink'] ?? body['@odata.nextLink'])

    return {
      items,
      ...(total !== undefined ? { total } : {}),
      ...(hasNext ? { nextSkip: skip + items.length } : {}),
    }
  }

  /** Filtros comunes a los documentos de compra. */
  private documentFilters(options?: ListOptions): string[] {
    const filters: string[] = []
    if (options?.cardCode) filters.push(`CardCode eq ${odataLiteral(options.cardCode)}`)
    if (options?.afterDocEntry !== undefined) filters.push(`DocEntry gt ${options.afterDocEntry}`)
    if (options?.updatedSince) filters.push(`UpdateDate ge ${toB1Date(options.updatedSince)}`)
    if (options?.docDateFrom) filters.push(`DocDate ge ${toB1Date(options.docDateFrom)}`)
    if (options?.docEntries?.length) {
      // Se truncan a entero y se descarta lo que no sea un numero finito: estos
      // valores acaban concatenados en el $filter sin comillas, asi que son la
      // via por la que se inyectaria OData si llegaran de la URL.
      const entries = options.docEntries
        .map((e) => Math.trunc(Number(e)))
        .filter((e) => Number.isSafeInteger(e))
      if (entries.length === 0) {
        // Pedir "ninguno" no puede convertirse en "todos": sin filtro, la
        // consulta devolveria el historico entero.
        filters.push('DocEntry eq -1')
      } else {
        filters.push(`(${entries.map((e) => `DocEntry eq ${e}`).join(' or ')})`)
      }
    }
    if (options?.openOnly) filters.push("DocumentStatus eq 'bost_Open'")
    return filters
  }

  /** Un documento concreto trae ademas sus lineas; la coleccion no. */
  private async getDocument<T>(entity: string, docEntry: number): Promise<T | null> {
    try {
      return await this.request<T>(`/${entity}(${docEntry})`)
    } catch (error) {
      if (error instanceof SapError && error.kind === 'not_found') return null
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // SapB1Client
  // -------------------------------------------------------------------------

  async ping(): Promise<{ ok: boolean; companyDb: string; version?: string }> {
    await this.getSession()
    return { ok: true, companyDb: this.config.companyDb }
  }

  async getBusinessPartner(cardCode: string): Promise<B1BusinessPartner | null> {
    try {
      return await this.request<B1BusinessPartner>(
        `/BusinessPartners(${odataLiteral(cardCode)})?$select=${SELECT.businessPartner}`,
      )
    } catch (error) {
      if (error instanceof SapError && error.kind === 'not_found') return null
      throw error
    }
  }

  async listBusinessPartners(options?: ListOptions): Promise<Page<B1BusinessPartner>> {
    const filters = ["CardType eq 'cSupplier'"]
    if (options?.cardCode) filters.push(`CardCode eq ${odataLiteral(options.cardCode)}`)
    if (options?.updatedSince) filters.push(`UpdateDate ge ${toB1Date(options.updatedSince)}`)
    // Aqui NO se filtra por texto contra B1, aunque `contains` exista. Este
    // Service Layer lo resuelve distinguiendo mayusculas y no admite `toupper`
    // —responde "Property 'toupper' of 'Document' is invalid"—, asi que buscar
    // "biofarma" no encuentra "Biofarma Natural MD". Comprobado contra la
    // instancia de KPS. La busqueda vive en la pantalla, sobre el padron ya
    // traido, igual que en /ordenes.
    return this.list<B1BusinessPartner>(
      'BusinessPartners',
      SELECT.businessPartner,
      filters,
      options,
      'CardCode asc',
    )
  }

  async createBusinessPartner(payload: CreateBusinessPartnerPayload): Promise<B1BusinessPartner> {
    return this.request<B1BusinessPartner>('/BusinessPartners', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  /**
   * Catalogo de condiciones de pago. Es pequeno y practicamente inmutable, asi
   * que se memoiza en el proceso: resolverlo en cada ficha de proveedor seria
   * una llamada de mas a B1 por cada vista.
   */
  private paymentTerms: readonly B1PaymentTermsType[] | null = null

  async listPaymentTermsTypes(): Promise<readonly B1PaymentTermsType[]> {
    if (this.paymentTerms) return this.paymentTerms
    const body = await this.request<{ value?: B1PaymentTermsType[] }>(
      '/PaymentTermsTypes?$select=GroupNumber,PaymentTermsGroupName,NumberOfAdditionalDays,NumberOfAdditionalMonths,StartFrom&$top=100',
    )
    this.paymentTerms = body.value ?? []
    return this.paymentTerms
  }

  /**
   * Articulos por codigo, en UNA sola consulta.
   *
   * Se filtra con `ItemCode eq 'A' or ItemCode eq 'B'` y no con una llamada por
   * articulo: una orden de diez renglones serian diez viajes a B1 para pintar
   * una pantalla. Las comillas simples se duplican, que es como OData las
   * escapa; un codigo con comilla es raro pero romperia el filtro entero.
   */
  async listItems(itemCodes: readonly string[]): Promise<readonly B1Item[]> {
    const unicos = [...new Set(itemCodes.filter((c) => c && c.trim() !== ''))]
    if (unicos.length === 0) return []
    const filtro = unicos.map((c) => `ItemCode eq '${c.replace(/'/g, "''")}'`).join(' or ')
    const body = await this.request<{ value?: B1Item[] }>(
      `/Items?$select=ItemCode,ItemName,InventoryItem,ManageBatchNumbers,ManageSerialNumbers&$filter=${encodeURIComponent(filtro)}&$top=${unicos.length}`,
    )
    return body.value ?? []
  }

  /**
   * Los articulos con lote, numero de serie o no inventariables.
   *
   * UNA consulta filtrada en B1, no el catalogo entero filtrado aqui: son los
   * pocos que complican la captura, y traerlos todos para descartar la mayoria
   * seria pagar el catalogo completo en cada visita a la lista de ordenes.
   *
   * Se cachea por proceso: la gestion de un articulo no cambia de un minuto a
   * otro y esto se llama al pintar la lista.
   */
  private gestionCache: readonly B1Item[] | null = null

  async listItemsConGestion(): Promise<readonly B1Item[]> {
    if (this.gestionCache) return this.gestionCache
    const filtro =
      "ManageBatchNumbers eq 'tYES' or ManageSerialNumbers eq 'tYES' or InventoryItem eq 'tNO'"
    const body = await this.request<{ value?: B1Item[] }>(
      `/Items?$select=ItemCode,InventoryItem,ManageBatchNumbers,ManageSerialNumbers&$filter=${encodeURIComponent(filtro)}&$top=2000`,
    )
    this.gestionCache = body.value ?? []
    return this.gestionCache
  }

  /**
   * La ubicacion de sistema de cada almacen que use ubicaciones.
   *
   * Son dos consultas y no una por almacen: primero cuales tienen ubicaciones
   * activas —en KPS solo el 1— y luego sus `IsSystemBin`. Los que no las usan se
   * quedan fuera del mapa a proposito: mandarles un reparto de ubicaciones haria
   * que B1 rechazara el documento entero.
   *
   * Se cachea por proceso. Las ubicaciones de un almacen no cambian de un
   * minuto a otro, y esto se llama en cada captura de entrada.
   */
  private binsCache: Map<string, number> | null = null

  async binsDeSistema(warehouseCodes: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (this.binsCache) return this.binsCache

    const mapa = new Map<string, number>()
    const codigos = [...new Set(warehouseCodes.filter((c) => c && c.trim() !== ''))]
    if (codigos.length === 0) return mapa

    const almacenes = await this.request<{ value?: B1Warehouse[] }>(
      '/Warehouses?$select=WarehouseCode,EnableBinLocations&$top=200',
    )
    const conBins = (almacenes.value ?? [])
      .filter((w) => w.EnableBinLocations === 'tYES')
      .map((w) => w.WarehouseCode)

    for (const w of conBins) {
      const bins = await this.request<{ value?: B1BinLocation[] }>(
        `/BinLocations?$select=AbsEntry,BinCode,Warehouse,IsSystemBin&$filter=Warehouse eq ${odataLiteral(w)} and IsSystemBin eq 'tYES'&$top=1`,
      )
      const bin = bins.value?.[0]
      if (bin) mapa.set(w, bin.AbsEntry)
    }

    this.binsCache = mapa
    return mapa
  }

  async getPurchaseOrder(docEntry: number): Promise<B1PurchaseOrder | null> {
    return this.getDocument<B1PurchaseOrder>('PurchaseOrders', docEntry)
  }

  async listPurchaseOrders(options?: ListOptions): Promise<Page<B1PurchaseOrder>> {
    return this.list<B1PurchaseOrder>(
      'PurchaseOrders',
      SELECT.document,
      this.documentFilters(options),
      options,
      'DocDate desc',
    )
  }

  async listPurchaseOrdersWithLines(options?: ListOptions): Promise<Page<B1PurchaseOrder>> {
    return this.list<B1PurchaseOrder>(
      'PurchaseOrders',
      SELECT.documentWithLines,
      this.documentFilters(options),
      options,
      'DocDate desc',
    )
  }

  async createPurchaseOrder(payload: CreatePurchaseOrderPayload): Promise<B1PurchaseOrder> {
    return this.request<B1PurchaseOrder>('/PurchaseOrders', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async getPurchaseDeliveryNote(docEntry: number): Promise<B1PurchaseDeliveryNote | null> {
    return this.getDocument<B1PurchaseDeliveryNote>('PurchaseDeliveryNotes', docEntry)
  }

  async listPurchaseDeliveryNotes(options?: ListOptions): Promise<Page<B1PurchaseDeliveryNote>> {
    return this.list<B1PurchaseDeliveryNote>(
      'PurchaseDeliveryNotes',
      SELECT.document,
      this.documentFilters(options),
      options,
      'DocDate desc',
    )
  }

  async listPurchaseDeliveryNotesWithLines(
    options?: ListOptions,
  ): Promise<Page<B1PurchaseDeliveryNote>> {
    return this.list<B1PurchaseDeliveryNote>(
      'PurchaseDeliveryNotes',
      SELECT.documentWithLines,
      this.documentFilters(options),
      options,
      // Ascendente y no descendente como el resto: quien lee entradas quiere la
      // cronologia de las entregas, y asi la primera pagina es la primera que
      // llego.
      'DocDate asc',
    )
  }

  async createPurchaseDeliveryNote(
    payload: CreatePurchaseDeliveryNotePayload,
  ): Promise<B1PurchaseDeliveryNote> {
    return this.request<B1PurchaseDeliveryNote>('/PurchaseDeliveryNotes', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async getPurchaseInvoice(docEntry: number): Promise<B1PurchaseInvoice | null> {
    return this.getDocument<B1PurchaseInvoice>('PurchaseInvoices', docEntry)
  }

  /**
   * Idempotencia (§04 principio 3): antes de crear se busca por el UUID. Donde
   * vive el UUID lo decide CFDI_UUID_STRATEGY, porque B1 no tiene campo estandar
   * para el (§00 consecuencia 06, BLOQUEANTE).
   */
  async findPurchaseInvoiceByCfdiUuid(uuid: string): Promise<B1PurchaseInvoice | null> {
    return this.findByCfdiUuid<B1PurchaseInvoice>('PurchaseInvoices', uuid)
  }

  async findPurchaseCreditNoteByCfdiUuid(uuid: string): Promise<B1PurchaseCreditNote | null> {
    return this.findByCfdiUuid<B1PurchaseCreditNote>('PurchaseCreditNotes', uuid)
  }

  private async findByCfdiUuid<T>(entity: string, uuid: string): Promise<T | null> {
    const { strategy, userField } = this.config.cfdiUuid
    if (strategy === 'AddOn') {
      // Sin saber donde guarda el UUID el add-on de localizacion, buscar seria
      // adivinar. Se devuelve null y quien llama decide; el pendiente sigue vivo.
      return null
    }
    const field = strategy === 'NumAtCard' ? 'NumAtCard' : userField
    const params = new URLSearchParams({
      $filter: `${field} eq ${odataLiteral(uuid)}`,
      $select: SELECT.document,
      $top: '1',
    })
    const body = await this.request<{ value?: T[] }>(`/${entity}?${params.toString()}`)
    return body.value?.[0] ?? null
  }

  async createPurchaseInvoiceFromDelivery(
    payload: CreatePurchaseInvoiceFromDeliveryPayload,
  ): Promise<B1PurchaseInvoice> {
    const { userFields, ...rest } = payload
    return this.request<B1PurchaseInvoice>('/PurchaseInvoices', {
      method: 'POST',
      body: JSON.stringify({ ...rest, ...(userFields ?? {}) }),
    })
  }

  async createServiceInvoice(payload: CreateServiceInvoicePayload): Promise<B1PurchaseInvoice> {
    const { userFields, ...rest } = payload
    return this.request<B1PurchaseInvoice>('/PurchaseInvoices', {
      method: 'POST',
      body: JSON.stringify({ ...rest, ...(userFields ?? {}) }),
    })
  }

  async createPurchaseCreditNote(
    payload: CreatePurchaseCreditNotePayload,
  ): Promise<B1PurchaseCreditNote> {
    const { userFields, ...rest } = payload
    return this.request<B1PurchaseCreditNote>('/PurchaseCreditNotes', {
      method: 'POST',
      body: JSON.stringify({ ...rest, ...(userFields ?? {}) }),
    })
  }

  async attachToDocument(
    objectType: B1ObjectType,
    docEntry: number,
    files: readonly AttachmentInput[],
  ): Promise<number> {
    // Attachments2 se sube como multipart; el Service Layer devuelve el
    // AbsoluteEntry, que luego se enlaza al documento por AttachmentEntry.
    const form = new FormData()
    for (const file of files) {
      form.append(
        'files',
        new Blob([new Uint8Array(file.content)]),
        `${file.fileName}.${file.fileExtension}`,
      )
    }

    const created = await this.request<{ AbsoluteEntry: number }>('/Attachments2', {
      method: 'POST',
      body: form,
      // FormData pone su propio Content-Type con el boundary.
      headers: { 'Content-Type': '' },
    })

    const entity =
      objectType === B1_OBJECT_TYPE.PurchaseOrder
        ? 'PurchaseOrders'
        : objectType === B1_OBJECT_TYPE.PurchaseDeliveryNote
          ? 'PurchaseDeliveryNotes'
          : 'PurchaseInvoices'

    await this.request(`/${entity}(${docEntry})`, {
      method: 'PATCH',
      body: JSON.stringify({ AttachmentEntry: created.AbsoluteEntry }),
    })

    return created.AbsoluteEntry
  }
}
