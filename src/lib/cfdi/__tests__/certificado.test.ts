import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verificarCertificado } from '../certificado'

/**
 * Verificacion del certificado de sello digital (§12.2 regla CERTIFICADO_EMISOR).
 *
 * LOS CERTIFICADOS SE GENERAN AQUI, no se guardan en el repositorio. Uno de
 * verdad del SAT es de una empresa concreta y no pinta nada en un repositorio;
 * uno guardado ademas caducaria, y volveria roja una prueba que no tiene nada
 * malo. Se fabrican con openssl al empezar y se tiran al acabar.
 *
 * LA CLAVE ESTA EN EL NUMERO DE SERIE. El SAT guarda en el X.509 los BYTES
 * ASCII de los 20 digitos de `NoCertificado`, no el numero: la serie `3030...`
 * en hexadecimal se lee "0000...". `-set_serial 0x<hex de los digitos>`
 * reproduce exactamente eso.
 */

const SERIE = '00001000000504465028'
const RFC = 'AAA010101AAA'
/** Dentro de la vigencia que se le pone al certificado de prueba. */
const TIMBRADO = new Date('2026-03-14T12:31:05Z')

let dir: string
let certificado: string
let certificadoDeOtro: string

/** Genera un X.509 autofirmado con la serie y el RFC que se le pidan. */
function generar(nombre: string, rfc: string, serieDigitos: string): string {
  const hex = Buffer.from(serieDigitos, 'ascii').toString('hex')
  const pem = join(dir, `${nombre}.pem`)
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, `${nombre}.key`),
      '-out', pem,
      '-set_serial', `0x${hex}`,
      '-not_before', '20250101000000Z',
      '-not_after', '20281231235959Z',
      '-subj', `/CN=CERTIFICADO DE PRUEBA/O=PRUEBA/x500UniqueIdentifier=${rfc}`,
    ],
    { stdio: 'ignore' },
  )

  return execFileSync('openssl', ['x509', '-in', pem, '-outform', 'DER']).toString('base64')
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kps-cert-'))
  certificado = generar('emisor', RFC, SERIE)
  certificadoDeOtro = generar('otro', 'XAXX010101000', SERIE)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const base = () => ({
  certificadoBase64: certificado,
  noCertificado: SERIE,
  rfcEmisor: RFC,
  fechaTimbrado: TIMBRADO,
})

describe('verificarCertificado — el caso bueno', () => {
  it('acepta un certificado con la serie, el RFC y la vigencia que tocan', () => {
    const r = verificarCertificado(base())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.numeroSerie).toBe(SERIE)
    expect(r.rfc).toBe(RFC)
  })

  it('acepta el base64 sea cual sea su longitud', () => {
    // Regresion: al armar el PEM a mano, un base64 de longitud multiplo de 64
    // dejaba una linea en blanco antes de END y Node rechazaba un certificado
    // perfectamente valido. Se paso a pasarle el DER crudo.
    expect(readFileSync(join(dir, 'emisor.pem'), 'utf8')).toContain('BEGIN CERTIFICATE')
    expect(verificarCertificado(base()).ok).toBe(true)
  })
})

describe('verificarCertificado — lo que tiene que rechazar', () => {
  it('rechaza algo que no es un certificado', () => {
    const r = verificarCertificado({ ...base(), certificadoBase64: 'Y2VydGlmaWNhZG8=' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('NO_ES_CERTIFICADO')
  })

  it('rechaza un comprobante sin certificado', () => {
    const r = verificarCertificado({ ...base(), certificadoBase64: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('NO_ES_CERTIFICADO')
  })

  it('rechaza cuando el NoCertificado declarado no es el del certificado', () => {
    const r = verificarCertificado({ ...base(), noCertificado: '00001000000504465099' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('SERIE_NO_COINCIDE')
  })

  it('rechaza el certificado de otra empresa', () => {
    // Es el ataque que importa: sellar tu factura con el CSD de otro.
    const r = verificarCertificado({ ...base(), certificadoBase64: certificadoDeOtro })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('RFC_NO_COINCIDE')
  })

  it('rechaza un sello puesto fuera de la vigencia del certificado', () => {
    const r = verificarCertificado({ ...base(), fechaTimbrado: new Date('2030-01-01T00:00:00Z') })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('NO_VIGENTE')
  })

  it('juzga la vigencia el dia del timbrado, no el de hoy', () => {
    // Un CSD caducado no invalida lo que sello mientras estaba vigente. Usar la
    // fecha de hoy rechazaria facturas legitimas del historico.
    expect(verificarCertificado({ ...base(), fechaTimbrado: new Date('2025-06-01T00:00:00Z') }).ok).toBe(
      true,
    )
  })
})
