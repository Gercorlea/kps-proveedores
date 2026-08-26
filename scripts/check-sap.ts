
import 'dotenv/config'

const REQUIRED = ['SAP_SL_URL', 'SAP_SL_COMPANY_DB', 'SAP_SL_USERNAME', 'SAP_SL_PASSWORD'] as const

const OK = '  OK  '
const FAIL = ' FALLO'
const INFO = '  ··  '

function line(mark: string, text: string): void {
  process.stdout.write(`[${mark}] ${text}\n`)
}


function redact(value: string): string {
  if (value.length <= 2) return '**'
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(value.length - 2, 10))}`
}

function diagnose(error: unknown): string {
  const cause = (error as { cause?: { code?: string } })?.cause
  const code = cause?.code ?? (error as { code?: string })?.code
  const name = (error as { name?: string })?.name

  if (name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return 'Se agoto el tiempo de espera. Suele ser el firewall o que no estas en la VPN de KPS.'
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'No se resolvio el nombre del servidor. Revisa el host de SAP_SL_URL y el DNS.'
    case 'ECONNREFUSED':
      return 'El servidor rechazo la conexion. El Service Layer puede estar apagado, o el puerto no es el correcto (suele ser 50000).'
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'El certificado es autofirmado. En un entorno interno pon SAP_SL_REJECT_UNAUTHORIZED=false; contra produccion, instala el certificado en su lugar.'
    case 'CERT_HAS_EXPIRED':
      return 'El certificado del servidor esta caducado.'
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'El certificado no cubre ese nombre de host. Usa el nombre exacto que aparece en el certificado.'
    default:
      return error instanceof Error ? error.message : String(error)
  }
}

function diagnoseB1(status: number, code: string | number | undefined, message: string): string {
  const c = String(code ?? '')
  if (status === 401 || c === '-304') {
    return 'Usuario o contrasena incorrectos para esa base de datos de la empresa.'
  }
  if (c === '-111' || /company/i.test(message)) {
    return 'SAP_SL_COMPANY_DB no existe o esta mal escrita. Es el nombre de la base, no el de la empresa.'
  }
  if (c === '-119' || /license/i.test(message)) {
    return 'El usuario no tiene licencia asignada en Business One.'
  }
  if (/maximum number of.*session/i.test(message)) {
    return 'Se alcanzo el maximo de sesiones concurrentes del Service Layer. Cierra sesiones o sube el limite en b1s.conf.'
  }
  return message
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
    return { message: `HTTP ${res.status} sin cuerpo interpretable` }
  }
}

async function main(): Promise<void> {
  const faltantes = REQUIRED.filter((k) => !process.env[k])
  if (faltantes.length > 0) {
    line(FAIL, `Faltan variables en tu .env: ${faltantes.join(', ')}`)
    line(INFO, 'Copia .env.example a .env y rellena esos valores.')
    process.exitCode = 1
    return
  }

  const baseUrl = process.env.SAP_SL_URL!.replace(/\/+$/, '')
  const companyDb = process.env.SAP_SL_COMPANY_DB!
  const userName = process.env.SAP_SL_USERNAME!
  const password = process.env.SAP_SL_PASSWORD!
  const timeoutMs = Number(process.env.SAP_SL_REQUEST_TIMEOUT_MS ?? 30_000)
  const pageSize = Number(process.env.SAP_SL_PAGE_SIZE ?? 100)
  const rejectUnauthorized = process.env.SAP_SL_REJECT_UNAUTHORIZED !== 'false'

  line(INFO, `Servidor    ${baseUrl}`)
  line(INFO, `Empresa     ${companyDb}`)
  line(INFO, `Usuario     ${userName}`)
  line(INFO, `Contrasena  ${redact(password)}`)

  if (!rejectUnauthorized) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    line(INFO, 'Verificacion de certificado DESACTIVADA (SAP_SL_REJECT_UNAUTHORIZED=false)')
  }
  process.stdout.write('\n')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let cookie = ''
  const arrancado = Date.now()

  // --- 1 · Login ---------------------------------------------------------
  try {
    const res = await fetch(`${baseUrl}/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CompanyDB: companyDb, UserName: userName, Password: password }),
      signal: controller.signal,
      cache: 'no-store',
    })

    if (!res.ok) {
      const { code, message } = await readError(res)
      line(FAIL, `Login rechazado (HTTP ${res.status}${code !== undefined ? `, B1 ${code}` : ''})`)
      line(INFO, diagnoseB1(res.status, code, message))
      process.exitCode = 1
      return
    }

    cookie = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith('B1SESSION') || c.startsWith('ROUTEID'))
      .map((c) => c.split(';')[0])
      .join('; ')

    if (!cookie) {
      line(FAIL, 'El Login respondio 200 pero SAP no devolvio la cookie B1SESSION.')
      line(INFO, 'Suele pasar con un proxy inverso que descarta Set-Cookie. Revisa el proxy.')
      process.exitCode = 1
      return
    }

    const data = (await res.json()) as {
      SessionId?: string
      SessionTimeout?: number
      Version?: string
    }
    const minutos = data.SessionTimeout ?? 30
    line(OK, `Login correcto en ${Date.now() - arrancado} ms`)
    line(
      INFO,
      `La sesion caduca en ${minutos} min · version del Service Layer ${data.Version ?? 'no informada'}`,
    )
  } catch (error) {
    line(FAIL, 'No se pudo conectar con el Service Layer.')
    line(INFO, diagnose(error))
    process.exitCode = 1
    return
  } finally {
    clearTimeout(timer)
  }

  const sapFetch = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers, Cookie: cookie },
      cache: 'no-store',
    })

  // --- 2 · Lectura de prueba --------------------------------------------
  try {
    const params = new URLSearchParams({
      $select: 'CardCode,CardName,CardType,Currency,Valid',
      $filter: "CardType eq 'cSupplier'",
      $top: '3',
      $inlinecount: 'allpages',
    })
    const res = await sapFetch(`/BusinessPartners?${params}`, {
      headers: { Prefer: `odata.maxpagesize=${pageSize}` },
    })

    if (!res.ok) {
      const { code, message } = await readError(res)
      line(FAIL, `El usuario conecta pero no puede leer BusinessPartners (HTTP ${res.status})`)
      line(INFO, diagnoseB1(res.status, code, message))
      process.exitCode = 1
    } else {
      const body = (await res.json()) as {
        value?: Array<{ CardCode: string; CardName: string; Valid?: string }>
        'odata.count'?: string | number
        '@odata.count'?: number
      }
      const filas = body.value ?? []
      const total = body['odata.count'] ?? body['@odata.count']
      line(OK, `Lectura correcta · ${total ?? '?'} proveedores en la empresa`)
      for (const bp of filas) {
        line(
          INFO,
          `${bp.CardCode.padEnd(12)} ${bp.CardName} ${bp.Valid === 'tNO' ? '(inactivo)' : ''}`,
        )
      }
    }
  } catch (error) {
    line(FAIL, 'La sesion abrio pero la consulta fallo.')
    line(INFO, diagnose(error))
    process.exitCode = 1
  }

  // --- 3 · Logout --------------------------------------------------------
  try {
    const res = await sapFetch('/Logout', { method: 'POST' })
    if (res.ok || res.status === 204) line(OK, 'Sesion cerrada')
    else line(INFO, `No se pudo cerrar la sesion (HTTP ${res.status}); caducara sola`)
  } catch {
    line(INFO, 'No se pudo cerrar la sesion; caducara sola')
  }

  process.stdout.write('\n')
  if (process.exitCode) {
    line(FAIL, 'La conexion con SAP NO esta operativa.')
  } else {
    line(OK, 'La conexion con SAP esta operativa.')
    line(INFO, 'Ya puedes poner SAP_DRIVER=service-layer en tu .env.')
  }
}

main().catch((error) => {
  line(FAIL, 'Error inesperado en el comprobador.')
  line(INFO, diagnose(error))
  process.exitCode = 1
})
