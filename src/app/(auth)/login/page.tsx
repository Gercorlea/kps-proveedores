'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * P02 · Login.
 *
 * Misma estructura que el login de kps-dashboard: tarjeta centrada, titulo,
 * dos campos, error en linea y enlace de recuperacion. Lo que cambia son los
 * tokens — aqui manda arcanum-portal.css, alli el sistema Cronos.
 *
 * El mensaje de error es deliberadamente el mismo para correo inexistente y
 * contrasena mala: distinguirlos confirma que cuentas estan dadas de alta.
 */

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  async function enviar(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setCargando(true)
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'No se pudo iniciar sesion')
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
      setError('No se pudo contactar al servidor')
      setCargando(false)
    }
  }

  return (
    <form onSubmit={enviar} className="lg-form">
      <h1 className="lg-title">Iniciar sesion</h1>

      <div className="ar-field">
        <label className="ar-field__label" htmlFor="email">
          Correo
        </label>
        <input
          id="email"
          className="ar-input"
          data-machine="true"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className="ar-field">
        <label className="ar-field__label" htmlFor="password">
          Contrasena
        </label>
        <input
          id="password"
          className="ar-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error ? (
        <p className="ar-small lg-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="ar-btn lg-submit" disabled={cargando}>
        {cargando ? 'Entrando...' : 'Entrar'}
      </button>

      <a href="/recuperar" className="ar-small lg-link">
        Olvidaste tu contrasena?
      </a>

      <p className="ar-small lg-aviso">
        Si tu alta sigue en revision por KPS, tus credenciales todavia no funcionan. Recibiras un
        correo en cuanto se resuelva.
      </p>

      <style>{`
        .lg-form { display: flex; flex-direction: column; gap: var(--ar-s4); }
        .lg-title {
          font-size: 19px;
          font-weight: 600;
          text-align: center;
          margin: 0;
        }
        .lg-form .ar-field { margin-bottom: 0; }
        .lg-error { color: var(--ar-danger); margin: 0; }
        .lg-submit { width: 100%; height: 36px; }
        .lg-link { text-align: center; color: var(--ar-ink-2); border-bottom: 0; }
        .lg-link:hover { color: var(--ar-ink); }
        .lg-aviso {
          margin: 0;
          padding-top: var(--ar-s4);
          border-top: 1px solid var(--ar-line);
          color: var(--ar-ink-3);
          text-align: center;
        }
      `}</style>
    </form>
  )
}
