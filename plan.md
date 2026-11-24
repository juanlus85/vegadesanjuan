# Vega de San Juan — plan de implementación

## Objetivo y alcance
Aplicación web responsive, en castellano y sin marcas de terceros, para la Asociación de Vecinos Vega de San Juan. Tres áreas: web pública; área privada por vivienda o unidad familiar; y administración. El código debe poder ejecutarse en Node.js en un VPS con Plesk y actualizarse mediante `git pull origin main`. Los datos pertenecerán a la asociación y serán exportables en CSV y mediante MySQL. Las credenciales se configurarán como variables de entorno de Plesk, no mediante archivos `.env`.

### Web pública
Portada con identidad visual real, presentación de la asociación, actividades, cuota familiar de 20 €/año, contacto y acceso. El formulario de contacto guardará la solicitud y la remitirá por SMTP a una o dos direcciones configurables. Solicitud de alta familiar con datos mínimos y consentimiento; el pago será con Stripe cuando corresponda, sin cobrar como cuota un año marcado exento. Información legal pendiente de revisión por la asociación, sin inventar datos.

### Socios
Cuenta con acceso propio y permisos de unidad familiar. Editar sus datos y personas que integran la vivienda. Consultar cuotas y estado, registrar su preferencia de pago manual por transferencia o configurar tarjeta recurrente con consentimiento específico mediante Stripe. Los datos de tarjetas nunca pasan por la aplicación. Próximos eventos, confirmación de asistencia, compra segura y resumen de entradas/pagos.

### Administración
Socios y unidades familiares; altas y aprobación; exportación CSV; cuotas y cargos extraordinarios, consulta y registro de pagos manuales; eventos y lista de asistentes y de entradas pagadas; configuración de contacto y SMTP. Parámetros no sensibles editables; contraseñas y claves de Stripe en variables de entorno de Plesk, sin exponerlas a la interfaz.

### Reglas de cuotas y evento
2025 pagado para las unidades familiares existentes importadas o marcadas por administración; 2026 exento, sin contabilizar como ingreso; cuota 2027 y posteriores 20 € por vivienda, exigible desde el 1 de enero según Europe/Madrid; generación idempotente, sin alterar cuotas pagadas o exentas. Los cobros recurrentes son por tarjeta (no adeudo bancario SEPA). Stripe controla tarjetas, reintentos y cancelación; confirmar el pago solo mediante webhook autenticado y persistente. Evitar pagos duplicados y admitir conciliación/reembolsos.

Evento del Cartero Real con fecha y precio configurables, inicialmente pendientes de confirmación: 13 de diciembre de 2026; 2,50 € por persona de la unidad familiar, con un máximo acumulado de sus miembros; 4 € por invitado, sin límite salvo aforo general. Cálculo íntegro del lado servidor en céntimos; reservas transaccionales, expiración y deduplicación; registrar solo entradas confirmadas por webhook y mostrar pagos pendientes por separado.

## Implementación
- Frontend React/TypeScript y CSS responsive; API propia con Node.js/Express. Gestión de rutas y construcción preparadas para Plesk. La vista pública incluirá metadatos y contenido indexable.
- MySQL/InnoDB con esquema y migraciones reproducibles, claves foráneas e índices, para familias, miembros, usuarios/roles, cuotas, pagos, eventos, inscripciones, entradas, contactos, configuración, sesiones y eventos Stripe procesados. Cantidades en céntimos.
- Autenticación propia con contraseñas protegidas, sesiones persistentes, autorización por rol y vivienda, cookies seguras, limitación de intentos, validación, protección CSRF, y recuperación mediante correo cuando esté configurado.
- Stripe Checkout desde el servidor; webhook firmado con cuerpo sin parsear, identificadores de evento y transacciones idempotentes. Alta de método de pago para futuro cobro no significa cuota abonada. Las claves y destinatarios deberán configurarse antes de operar.
- SMTP con host, puerto, remitente y destinatarios configurables por administrador; secreto en entorno protegido. Sin simulación de envío o de pago real.
- Scripts reproducibles de instalación, migración, arranque y creación del primer administrador. Documentación operativa para Plesk, variables de entorno del sistema, webhook Stripe y GitHub. Sin importar datos reales hasta disponer de ellos.

## Dirección visual
Tres alternativas consideradas: 1) vecindario mediterráneo editorial, cálido y actual (0,07); 2) identidad cívica azul y verde con fotografías luminosas (0,06); 3) revista local de papeles recortados y colores vivos (0,04). Se elige la identidad cívica azul y verde.

**Movimiento:** diseño editorial contemporáneo con detalles cívicos y mediterráneos. **Principios:** proximidad, legibilidad, claridad funcional y accesibilidad móvil. **Color:** azul profundo del logotipo como confianza, verde para comunidad y acción, blancos cálidos y azul claro para aire. **Composición:** portada editorial asimétrica, una imagen protagonista y bloques ordenados; en área privada, navegación clara y paneles compactos. **Motivos:** curvas amables inspiradas en las ondas del logotipo y etiquetas de sección discretas. **Interacción:** textos directos, estados visibles y controles grandes. **Animación:** transiciones cortas, sin movimiento obligatorio, respetando `prefers-reduced-motion`. **Tipografía:** Manrope o similar para textos e identidad; una serif editorial de contraste para titulares, con alternativas de sistema. **Esencia:** la asociación que mantiene conectado y activo al vecindario de Vega de San Juan; cercana, vital, confiable. **Voz:** inclusiva y sencilla: «Un barrio mejor se construye entre vecinos»; «Tu casa también forma parte». **Marca:** utilizar el logotipo horizontal suministrado, sin recrearlo. **Color principal:** azul profundo propio del logotipo.

## Estructura prevista
`client/` para interfaz y estilos; `server/` para API, seguridad y Stripe; `database/` para esquema/migraciones; `public/` para recursos propios y rutas públicas; `docs/` para despliegue y operación; `scripts/` para migraciones y bootstrap.

Las decisiones sobre el año del Cartero Real, el precio reducido y el inicio efectivo de las suscripciones se deben confirmar antes de habilitar cobros reales. El proyecto no se publicará ni desplegará en el VPS sin configuración de la asociación.
