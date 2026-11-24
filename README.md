# Asociación de Vecinos Vega de San Juan

Aplicación web de la asociación, diseñada para ejecutarse en un VPS propio con **Node.js, Plesk y MySQL/MariaDB**. El código se puede mantener en GitHub; los datos se conservan en la base de datos del servidor, independientemente del repositorio. Incluye web pública, área familiar y administración.

> **Antes de usar datos reales o aceptar pagos:** completa la configuración, revisa los textos legales con la asociación, verifica las reglas y pruebas descritas más abajo y realiza una copia y una prueba de restauración. La web previa no se modifica automáticamente.

## Preparación en Plesk

1. Haz copia de seguridad verificable de la web y de la base de datos actuales. Como una respuesta identificada como Googlebot devolvió contenido ajeno en la web anterior, revisa el servidor y el sitio WordPress antiguo por posible spam o modificación no autorizada antes de reutilizarlo; no asumas que un reemplazo de la web desinfectará todo el VPS.
2. Crea una base de datos MySQL y un usuario propios con permisos sobre esa base. Prepara una carpeta de aplicación independiente y clona allí el repositorio GitHub. No sobrescribas la instalación antigua sin un plan de reversión.
3. En Plesk, activa Node.js 20.19 o posterior, selecciona la carpeta del repositorio como *Application Root* y `server/index.js` como *Application Startup File*. Activa HTTPS en el dominio. Instala dependencias y compila con `npm ci` y `npm run build` desde esa carpeta.
4. Configura las siguientes **variables de entorno en la configuración de Node.js de Plesk**, no en un fichero `.env`. Los valores sensibles nunca deben guardarse en Git ni compartirse en capturas:

   - `NODE_ENV`: `production`.
   - `DATABASE_URL`: conexión MySQL, con usuario y contraseña escapados para URL, por ejemplo `mysql://USUARIO:CLAVE@HOST:3306/BASE`.
   - `SESSION_SECRET`: cadena aleatoria exclusiva de al menos 32 caracteres.
   - `APP_ORIGIN`: `https://vegadesanjuan.es` cuando el dominio apunte a esta instalación.
   - `SMTP_PASSWORD`: contraseña SMTP, si se configura correo. El resto de la configuración SMTP y los destinatarios se gestionan en administración.
   - `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`: claves del entorno de Stripe que se vaya a usar; primero deben ser de prueba.
   - `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD`: solo durante la creación del primer administrador. La contraseña debe tener al menos 12 caracteres. Opcionalmente `BOOTSTRAP_ADMIN_NAME`.
   - `PORT`: normalmente lo proporciona Plesk; si no, la aplicación utiliza 3000.

5. Con el mismo entorno que utilizará Node.js, ejecuta `npm run migrate` y `npm run admin:create`. Retira después `BOOTSTRAP_ADMIN_PASSWORD` del entorno. Reinicia la aplicación desde Plesk. No hay cuentas predeterminadas ni datos reales de ejemplo.
6. Comprueba el funcionamiento de los formularios, acceso, aislamiento entre familias, SMTP, cuotas, eventos y pagos **con datos y claves de prueba**, antes de introducir datos reales o activar Stripe en producción. Verifica que los correos lleguen a las direcciones correctas. La recepción de contactos no debe considerarse confirmada si falla el envío.

Si los comandos de mantenimiento ejecutados por SSH no heredan las variables definidas para la aplicación en Plesk, utiliza una tarea de Plesk con las mismas variables o facilítalas temporalmente a la sesión de forma segura. No pegues claves en comandos que queden en el historial.

## Stripe

Stripe procesa los datos de la tarjeta; esta aplicación no guarda números de tarjeta. Configura en tu propia cuenta un endpoint de webhook `https://vegadesanjuan.es/api/stripe/webhook`, con versión de API `2025-01-27.acacia` y estos eventos: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.payment_failed` y `customer.subscription.deleted`. Introduce su secreto de firma en `STRIPE_WEBHOOK_SECRET`. El retorno a la web tras el checkout no demuestra que un pago se haya completado: la aplicación debe recibir y validar el webhook.

**Estado actual: los cobros reales y los cobros recurrentes están desactivados.** Solo se permite configurar Stripe con claves de prueba; el alta de tarjeta recurrente no crea ninguna suscripción ni recoge consentimiento. Existe código preparatorio, pero no debe habilitarse cambiando una constante: antes hay que completar y validar los bloqueos, la conciliación administrativa y todos los casos de concurrencia y webhook con una cuenta Stripe de prueba. No se han realizado pruebas de cobro contra Stripe.

Para permitir pagos reales quedan pendientes, como mínimo, un procedimiento y una herramienta administrativa auditada para conciliar intentos inciertos o caducados, pagos de entradas cuyo webhook llegue tarde, reembolsos y disputas; evitar cobros involuntarios al repetir pedidos; definir si el precio familiar requiere verificar miembros; y probar concurrencia con MySQL/InnoDB y webhooks reales del modo de pruebas de Stripe. Un pedido en revisión no garantiza entrada ni debe aprobarse sin comprobar aforo y límite familiar; puede requerir devolución. No habilites cobros en vivo antes de completar estas tareas y revisarlas con la asociación.

El Cartero Real tiene el precio reducido pendiente de confirmación. Debe revisarse la fecha, hora, lugar, aforo y precio desde administración; no actives el cobro mientras no estén confirmados. Comprueba con la tarjeta de pruebas `4242 4242 4242 4242` en la modalidad de pruebas de Stripe y revisa las entregas del webhook. No uses claves de producción para las pruebas.

## Cuotas y datos históricos

La cuota es de **20 € por vivienda y año**. Para socios existentes verificados, se puede registrar que estaban al corriente en 2025 como una acreditación histórica con fuente, sin inventar un ingreso, importe ni fecha de pago. 2026 se registra como exento, no como ingreso. A partir del 1 de enero de 2027, se generan cuotas pendientes una vez por familia y año, usando la zona horaria de Madrid. Una nueva familia no debe recibir pagos históricos ficticios.

Por seguridad, la generación automática solo crea la cuota del año en curso para familias activas: no inventa cargos de años anteriores si no se conoce el historial de bajas o si el sistema estuvo parado durante un año completo. Esos casos se deben revisar y registrar explícitamente por administración.

No se han importado datos de socios. Antes de importar, prepara el fichero real, revisa duplicados y datos personales, y valida con la asociación los registros de 2025 y 2026. Exporta y contrasta resultados. Los datos están en MySQL y los listados autorizados se pueden exportar a CSV; utiliza también los procedimientos de copia de seguridad de Plesk para respaldar la base completa.

La administración puede crear una familia histórica indicando la fuente y, después de verificar personalmente la identidad y el domicilio, vincular una cuenta pendiente a la familia correcta. La familia provisional anterior queda inactiva y sus datos se conservan: sus miembros no se copian ni se fusionan automáticamente con los de destino, por lo que deben revisarse y completarse. Las familias provisionales con movimientos, reservas u otras cuentas no se vinculan automáticamente y requieren revisión manual. No vincules por coincidencia de dirección sin una comprobación humana.

Los socios pueden gestionar los miembros de su propia unidad familiar. El panel administrativo todavía no incluye edición individual de miembros de otras familias; se pueden consultar mediante la exportación de miembros. El detalle de aceptación SMTP por destinatario se guarda en `contact_deliveries` cuando es posible, pero aún no hay pantalla ni reenvío selectivo: una aceptación SMTP no garantiza la entrega final, y un resultado incierto debe revisarse antes de reenviar.

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

Restringe el acceso al panel y a la base de datos, usa contraseñas únicas, actualiza Node y las dependencias, mantén HTTPS, planifica copias de seguridad y prueba restauraciones. Configura y verifica SPF/DKIM/DMARC del dominio remitente. Revisa los logs de aplicación y las entregas de Stripe. Ningún dato bancario debe almacenarse en el repositorio. La aplicación no sustituye la revisión jurídica de privacidad y conservación de datos, especialmente cuando se registran miembros menores.
