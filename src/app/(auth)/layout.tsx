/**
 * Layout de las pantallas de acceso.
 *
 * Panel centrado sobre lienzo gris, igual que el de kps-dashboard: el isotipo
 * va en tinta porque la tarjeta es blanca. Vive fuera del grupo (portal), asi
 * que no arrastra la barra lateral — nadie navega el portal antes de entrar.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="au-canvas">
      <div className="ar-card au-card">
        <div className="au-brand">
          <svg width="30" height="30" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 1 13 12.5H1Z" fill="currentColor" />
          </svg>
          <span className="au-word">Arcanum</span>
          <span className="ar-eyebrow" style={{ margin: 0 }}>
            Portal de Proveedores KPS
          </span>
        </div>
        {children}
      </div>

      <style>{`
        .au-canvas {
          display: flex;
          min-height: 100dvh;
          align-items: center;
          justify-content: center;
          padding: var(--ar-s4);
          background: var(--ar-canvas);
        }
        .au-card {
          width: 100%;
          max-width: 384px;
          padding: var(--ar-s8);
        }
        .au-brand {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--ar-s2);
          margin-bottom: var(--ar-s6);
          color: var(--ar-ink);
        }
        .au-word {
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
      `}</style>
    </div>
  )
}
