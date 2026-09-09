import Image from 'next/image'

/**
 * Layout de las pantallas de acceso.
 *
 * Tarjeta centrada sobre lienzo BLANCO: en una pantalla que solo tiene una
 * tarjeta no hay contenido alrededor del que separarla, asi que tenir el fondo
 * solo ensucia el unico elemento que importa.
 *
 * Vive fuera del grupo (portal), asi que no arrastra la barra lateral: nadie
 * navega el portal antes de entrar.
 *
 * EL LOGOTIPO YA VIENE EN BANNER. El PNG es de 431x150 —2.87:1— y esta recortado
 * a la tinta: no lleva margen propio. Antes era un tile de 200x200 con la marca
 * flotando en medio y habia que recortarlo a 3:1 con `object-fit: cover`; ese
 * recorte ahora sobra y ademas se comeria las letras, porque no queda aire que
 * sacrificar. Se deja correr la proporcion natural con `height: auto`.
 *
 * El aire lo pone el CSS, no el archivo: con margen dentro del PNG el padding se
 * aplicaria dos veces y la marca encogeria.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="au-canvas">
      <div className="cr-card au-card">
        <Image
          className="au-logo"
          src="/group-kps.png"
          alt="Group KPS"
          width={431}
          height={150}
          priority
        />
        {/* Eyebrow sobre el titulo, que es el sitio que el sistema le da a este
            tipo de rotulo: dice DONDE estas, y "Iniciar sesion" dice que vas a
            hacer. Los dos hacen falta y no compiten porque estan en escalones
            distintos —mono de 9.5px contra los 26px del titulo—. */}
        <p className="cr-label au-eyebrow">Portal de Proveedores</p>
        {children}
      </div>


    </div>
  )
}
