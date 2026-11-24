# Asociación de Vecinos Vega de San Juan

Aplicación web de la asociación, diseñada para ejecutarse en un VPS propio con **Node.js, Plesk y MySQL/MariaDB**. El código se puede mantener en GitHub; los datos se conservan en la base de datos del servidor, independientemente del repositorio. Incluye web pública, área familiar y administración.

> **No está lista para producción ni para usar datos reales o aceptar pagos.** Antes hay que resolver las limitaciones de seguridad y operación descritas más abajo y en `TODO.md`, revisar los textos legales con la asociación, completar las pruebas y verificar una copia y su restauración. La web previa no se modifica automáticamente.

## Preparación en Plesk

1. Haz copia de seguridad verificable de la web y de la base de datos actuales. Como una respuesta identificada como Googlebot devolvió contenido ajeno en la web anterior, revisa el servidor y el sitio WordPress antiguo por posible spam o modificación no autorizada antes de reutilizarlo; no asumas que un reemplazo de la web desinfectará todo el VPS.
2. Crea una base de datos MySQL y un usuario propios con permisos sobre esa base. Prepara una carpeta de aplicación independiente y clona allí el repositorio GitHub. No sobrescribas la instalación antigua sin un plan de reversión.
3. En Plesk, activa Node.js 20.19 o posterior, selecciona la carpeta del repositorio como *Application Root* y `server/index.js` como *Application Startup File*. Activa HTTPS en el dominio. Instala dependencias y compila con `npm ci` y `npm run build` desde esa carpeta.
4. Configura las siguientes **variables de entorno en la configuración de Node.js de Plesk**, no en un fichero `.env`. Los valores sensibles nunca deben guardarse en Git ni compartirse en capturas:

   - `NODE_ENV`: `production`.
   - `DATABASE_URL`: conexión MySQL, con usuario y contraseña escapados para URL, por ejemplo `mysql://USUARIO:CLAVE@HOST:3306/BASE`.
   - `SESSION_SECRET`: cadena aleatoria exclusiva de al menos 32 caracteres.
   - `APP_ORIGIN`: `https://vegadesanjuan.es` cuando el dominio apunte a esta instalación, sin barra final ni ruta; la subida exige que coincida exactamente con el origen del navegador.
   - `SMTP_PASSWORD`: contraseña SMTP, si se configura correo. El resto de la configuración SMTP y los destinatarios se gestionan en administración.
   - `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`: no son necesarias para el alta ni para la gestión manual. Stripe está bloqueado con `NODE_ENV=production`; usa credenciales de prueba solo en una instalación y base de datos aisladas, como se indica abajo.
   - `UPLOADS_DIR`: **obligatoria para arrancar**, incluso si no se usan justificantes. Ruta absoluta de un directorio privado y persistente en Linux, creado de antemano fuera del proyecto y de todas las raíces y alias web, propiedad del usuario efectivo de Node.js y con permisos exactamente `0700`. No debe haber enlaces simbólicos en ningún componente de la ruta y `/proc/self/fd` debe estar disponible. Si falta o no supera la validación, la aplicación no escucha peticiones.
   - `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD`: solo durante la creación del primer administrador. La contraseña debe tener al menos 12 caracteres. Opcionalmente `BOOTSTRAP_ADMIN_NAME`.
   - `PORT`: normalmente lo proporciona Plesk; si no, la aplicación utiliza 3000.

5. Con el mismo entorno que utilizará Node.js, ejecuta `npm run migrate` y `npm run admin:create`. Retira después `BOOTSTRAP_ADMIN_PASSWORD` del entorno. Reinicia la aplicación desde Plesk. No hay cuentas predeterminadas ni datos reales de ejemplo.
6. Comprueba formularios, acceso, aislamiento entre familias, SMTP, cuotas, eventos y justificantes con datos de prueba antes de introducir datos reales. Ensaya los pagos únicos únicamente en la instalación aislada descrita abajo. Verifica que los correos lleguen a las direcciones correctas; la recepción de contactos no debe considerarse confirmada si falla el envío.

Si los comandos de mantenimiento ejecutados por SSH no heredan las variables definidas para la aplicación en Plesk, utiliza una tarea de Plesk con las mismas variables o facilítalas temporalmente a la sesión de forma segura. No pegues claves en comandos que queden en el historial.

La versión v1.1.1 completa en el lockfile los binarios opcionales de Rollup y esbuild para instalaciones limpias en distintas plataformas, incluidos Linux x64 y Alpine, para resolver el fallo observado en v1.1.0. La corrección aún no se ha validado mediante una compilación en el contenedor hospedado y no garantiza por sí misma el arranque o la publicación. El contenedor gestionado de publicación tiene almacenamiento efímero y no cumple el requisito de persistencia de `UPLOADS_DIR`: no lo sustituyas por una carpeta temporal ni lo uses para guardar justificantes reales. Para un despliegue gestionado se requiere adaptar previamente el almacenamiento a un servicio privado y persistente compatible, además de configurar y comprobar separadamente la base de datos y los secretos. La instalación prevista aquí es el VPS propio con almacenamiento persistente.

## Alta y justificantes de transferencia

El alta crea una familia pendiente de aprobación y una cuenta; pide la fecha de nacimiento del titular y permite añadir familiares con fecha opcional. La preferencia guardada —gestión manual, solicitud de pago único o solicitud de suscripción— **no inicia un cobro, no recoge datos de tarjeta ni activa una suscripción**. Está separada del método de pago operativo, se muestra en los paneles de socio y administración y se incluye en el CSV de familias; todavía no se puede editar desde el panel.

En la opción manual puede adjuntarse un PDF, JPEG o PNG de hasta **8 MiB (8.388.608 bytes)**. El archivo se envía después de registrar el alta, en una petición separada: si falla o no puede confirmarse, el alta ya existe; no hay que repetirla, sino consultar a la asociación antes de reenviar. Administración puede listar y descargar los justificantes; recibir uno no acredita un pago: debe verificarlo y registrar manualmente el pago que corresponda.

Los archivos se guardan en `UPLOADS_DIR` y sus metadatos en MySQL. Haz copias de seguridad y pruebas de restauración coordinadas de **ambos**; ni `git pull` ni un respaldo exclusivo de MySQL respaldan los archivos. Mantén el directorio fuera de `httpdocs`, del proyecto y de todos los webroots y alias web. Sus carpetas padre no deben ser modificables por terceros. La aplicación comprueba la ruta, el propietario, el modo y `/proc`, pero no conoce todos los webroots ni comprueba la seguridad de los directorios padre: el operador debe verificarlo. La firma del archivo se comprueba, pero eso no descarta malware; establece una política de conservación y borrado, límites de disco y revisión aislada de los archivos.

La aplicación limita a cuatro las subidas simultáneas por proceso y a 50 archivos o 100 MiB indexados por familia. Estos límites no sustituyen una cuota del sistema de archivos ni supervisión: los archivos huérfanos, reinicios, otros procesos o resultados de base de datos inciertos pueden superar esos límites. Los archivos de resultado incierto se conservan en privado para revisión; un nuevo intento puede crear un duplicado. Hay que establecer un procedimiento de conciliación y almacenamiento antes de borrar archivos. Estas garantías presuponen InnoDB y un único primario coherente.

Configura cada proxy o servidor que intervenga (Plesk, nginx y/o Apache) para admitir un cuerpo de al menos 8 MiB en la ruta de subida `/api/member/transfer-proof`. Por ejemplo, según los componentes activos, `client_max_body_size 8m;` en nginx y `LimitRequestBody 8388608` en Apache; aplica las directivas mediante la configuración admitida por Plesk y comprueba que no haya otro límite menor en la cadena. La subida envía el archivo como `application/octet-stream`, no como formulario multipart. Verifica la configuración y la carga de un archivo de prueba del límite en el entorno de destino.

## Stripe

**Estado actual: Stripe está bloqueado en producción, también con claves de prueba; los cobros reales se rechazan y las suscripciones están desactivadas incluso en pruebas.** Para ensayar pagos únicos se admiten exclusivamente claves `sk_test_` o `rk_test_` y webhooks de prueba, en una instalación de desarrollo separada con `NODE_ENV` distinto de `production` y una base de datos aislada sin datos reales. Nunca conectes Stripe de pruebas a la base operativa: sus webhooks podrían registrar pagos de prueba. El alta de tarjeta recurrente no crea ninguna suscripción ni recoge consentimiento para ella; una preferencia de suscripción no equivale a dicho consentimiento. Existe código preparatorio, pero no debe habilitarse cambiando una constante o variable: antes hay que completar y validar los bloqueos, la conciliación administrativa y todos los casos de concurrencia y webhook con una cuenta Stripe de prueba. No se han realizado pruebas de cobro contra Stripe.

Para futuros ensayos aislados de pagos únicos, configura en tu cuenta de pruebas un webhook en `https://TU-ENTORNO-DE-PRUEBAS/api/stripe/webhook`, con versión de API `2025-01-27.acacia` y los eventos `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.payment_failed` y `customer.subscription.deleted`; introduce su secreto de firma de prueba en `STRIPE_WEBHOOK_SECRET`. La aplicación verifica la firma y rechaza eventos en vivo. Stripe procesa los datos de la tarjeta; la aplicación no guarda números de tarjeta. El retorno a la web tras el checkout no demuestra que un pago se haya completado: la aplicación debe recibir y validar el webhook.

Para permitir pagos reales quedan pendientes, como mínimo, un procedimiento y una herramienta administrativa auditada para conciliar intentos inciertos o caducados, pagos de entradas cuyo webhook llegue tarde, reembolsos y disputas; evitar cobros involuntarios al repetir pedidos; definir si el precio familiar requiere verificar miembros; y probar concurrencia con MySQL/InnoDB y webhooks reales del modo de pruebas de Stripe. Un pedido en revisión no garantiza entrada ni debe aprobarse sin comprobar aforo y límite familiar; puede requerir devolución. No habilites cobros en vivo antes de completar estas tareas y revisarlas con la asociación.

El Cartero Real tiene el precio reducido pendiente de confirmación. Deben revisarse la fecha, hora, lugar, aforo y precio antes de publicarlo; actualmente la interfaz administrativa no permite configurar el aforo. No actives el cobro mientras no estén confirmados. Cuando se hagan ensayos, comprueba con la tarjeta de pruebas `4242 4242 4242 4242` y revisa las entregas del webhook, solo en el entorno aislado. No uses claves de producción para las pruebas.

## Cuotas y datos históricos

La cuota es de **20 € por familia o vivienda y año**. Para socios existentes verificados, se puede registrar que estaban al corriente en 2025 como una acreditación histórica con fuente, sin inventar un ingreso, importe ni fecha de pago. 2026 se registra como exento, no como ingreso. A partir del 1 de enero de 2027, se generan cuotas pendientes una vez por familia y año, usando la zona horaria de Madrid. Una nueva familia no debe recibir pagos históricos ficticios.

Por seguridad, la generación automática solo crea cargos pendientes del año en curso para familias activas; también puede registrar la exención de 2026 de familias activas que ya existían entonces. No inventa cargos pendientes de años anteriores si no se conoce el historial de bajas o si el sistema estuvo parado durante un año completo. Esos casos deben revisarse: aún no hay una función para registrar como anualidad una cuota omitida desde 2027.

No se han importado datos de socios. Antes de importar, prepara el fichero real, revisa duplicados y datos personales, y valida con la asociación los registros de 2025 y 2026. Exporta y contrasta resultados. Los datos están en MySQL y los listados autorizados se pueden exportar a CSV; utiliza también los procedimientos de copia de seguridad de Plesk para respaldar la base completa.

La administración puede crear una familia histórica indicando la fuente y, después de verificar personalmente la identidad y el domicilio, vincular una cuenta pendiente a la familia correcta. La familia provisional anterior queda inactiva y sus datos se conservan: sus miembros, fechas, preferencias y justificantes no se copian ni se fusionan automáticamente con los de destino, por lo que deben revisarse y gestionarse. Las familias provisionales con movimientos, reservas u otras cuentas no se vinculan automáticamente y requieren revisión manual. No vincules por coincidencia de dirección sin una comprobación humana.

Los socios pueden gestionar los miembros y sus fechas de nacimiento en su propia unidad familiar. Administración puede consultarlos en el panel y exportarlos, pero todavía no dispone de edición individual de miembros de otras familias. El CSV de miembros incluye fechas de nacimiento: custódialo como dato personal. El detalle de aceptación SMTP por destinatario se guarda en `contact_deliveries` cuando es posible, pero aún no hay pantalla ni reenvío selectivo: una aceptación SMTP no garantiza la entrega final, y un resultado incierto debe revisarse antes de reenviar.

## Actualizaciones desde GitHub

Una vez conectado el repositorio y realizadas copias de seguridad:

```bash
cd /ruta/de/la/aplicacion
git pull origin main
npm ci
npm run build
npm run migrate
```

Reinicia después la aplicación Node.js en Plesk. Revisa los cambios y el estado de Git antes del `pull`; no sobrescribas archivos modificados ni hagas migraciones destructivas sin un respaldo probado. Mantén separadas las credenciales de pruebas y de producción.

## Seguridad y operación

Restringe el acceso al panel, a la base de datos, a los justificantes, a las copias y a los CSV; usa contraseñas únicas, actualiza Node y las dependencias, mantén HTTPS y prueba las restauraciones. Configura y verifica SPF/DKIM/DMARC del dominio remitente. Revisa los logs de aplicación y, en el entorno aislado, las entregas de Stripe. El puerto directo de Node debe quedar inaccesible desde Internet y el proxy confiable debe sanear las cabeceras reenviadas; valida la topología porque el servidor confía en un salto de proxy. Antes de desplegar, establece protección frente a enmarcado no autorizado sin romper la vista previa, mecanismos de auditoría de lecturas/exportaciones, retención y borrado, verificación del cambio de correo y una política de CSRF para todas las mutaciones. Ningún dato bancario debe almacenarse en el repositorio. Antes de tratar datos reales, revisa con asesoramiento jurídico la finalidad, la minimización, el acceso autorizado y los plazos de conservación y borrado, especialmente para datos de menores, y asegúrate de que quien los facilita esté autorizado. La aplicación no sustituye esa revisión.
