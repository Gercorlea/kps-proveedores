'use client'

import { mostrarToast } from '@/app/(portal)/toast'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * P02 · Login.
 *
 * Tarjeta centrada: logotipo, titulo, dos campos, error en linea y enlace de
 * recuperacion. El logotipo lo pone el layout de (auth); el titulo y todo lo
 * demas, esta pantalla.
 *
 * El mensaje de error es deliberadamente el mismo para correo inexistente y
 * contrasena mala: distinguirlos confirma que cuentas estan dadas de alta.
 */

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [cargando, setCargando] = useState(false)

  async function enviar(e: React.FormEvent) {
    e.preventDefault()
    setCargando(true)
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        mostrarToast('No se pudo completar la acción', 'error', data.error ?? 'No se pudo iniciar sesion')
        setCargando(false)
        return
      }
      // Se lee de window y no con useSearchParams: ese hook obliga a Next a
      // diferir todo el subarbol al cliente, y la tarjeta aparecia vacia hasta
      // que hidrataba.
      //
      // Solo se acepta un destino interno. Un `desde` con URL absoluta seria
      // una redireccion abierta hacia un sitio de terceros.
      const siguiente = new URLSearchParams(window.location.search).get('desde')
      router.push(siguiente && siguiente.startsWith('/') ? siguiente : '/')
      router.refresh()
    } catch {
      mostrarToast('No se pudo completar la acción', 'error', 'No se pudo contactar al servidor')
      setCargando(false)
    }
  }

  return (
    <form onSubmit={enviar} className="lg-form">
      <h1 className="cr-h1 lg-title">Iniciar sesión</h1>

      <div className="cr-field">
        <label className="cr-field__label" htmlFor="email">
          Correo
        </label>
        <input
          id="email"
          className="cr-input"
          data-machine="true"
          type="email"
          autoComplete="email"
          placeholder="tucorreo@empresa.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className="cr-field">
        <label className="cr-field__label" htmlFor="password">
          Contraseña
        </label>
        <input
          id="password"
          className="cr-input"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>



      <button type="submit" className="cr-btn cr-btn--block cr-btn--lg" disabled={cargando}>
        {cargando ? 'Entrando...' : 'Iniciar sesión'}
      </button>

      <a href="/recuperar" className="cr-small lg-link">
        ¿Olvidaste tu contraseña?
      </a>

      <p className="cr-small lg-aviso">
        Si tu alta sigue en revision por KPS, tus credenciales todavia no funcionan. Recibiras un
        correo en cuanto se resuelva.
      </p>

      <style>{`
        .lg-form { display: flex; flex-direction: column; gap: var(--cr-s4); }
        .lg-title { text-align: center; margin-bottom: var(--cr-s2); }
        .lg-form .cr-field { margin-bottom: 0; }
        /* El error usa la variante oscura del rojo: a 12px, el vivo no llega a
           AA sobre blanco. */
        .lg-error { color: var(--cr-danger-ink); margin: 0; }
        .lg-link { text-align: center; color: var(--cr-ink-2); }
        .lg-link:hover { color: var(--cr-ink); }
        .lg-aviso {
          margin: 0;
          padding-top: var(--cr-s4);
          border-top: 1px solid var(--cr-line);
          color: var(--cr-ink-3);
          text-align: center;
        }
      `}</style>
    </form>
  )
}
