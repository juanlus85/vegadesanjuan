# Formulario actual de alta: revisión

**Fuente:** https://vegadesanjuan.es/asociate/ y https://vegadesanjuan.es/wp-json/wp/v2/pages/32. Revisión del 24 de noviembre de 2026, sin enviar datos, pagos ni archivos. En el navegador se visualizó la página de la asociación; una extracción automatizada de la misma URL devolvió contenido comercial ajeno. Debe verificarse el sitio y contrastar los datos bancarios por un canal independiente antes de utilizarlos.

## Datos solicitados en la web actual

- Titular: nombre, apellidos, fecha de nacimiento, teléfono y correo, marcados como obligatorios.
- Segundo asociado de la misma unidad familiar: selección obligatoria sí/no; si se elige sí, se muestran nombre, apellidos, teléfono, correo y fecha de nacimiento, sin marcar como obligatorios los campos individuales.
- Hijos convivientes: número de 0 a 5; al elegir uno o más se muestra una fecha de nacimiento por hijo, sin marcarla como obligatoria. No se piden nombres de hijos ni DNI en el formulario observado.
- Vivienda: urbanización y calle mediante selectores. Urbanizaciones: Real de Valdomina, Valparaíso, Valparaiso Hills, Jardines de Valparaíso, Residencial Europa, Pórtico de Simón Verde y Célere San Juan. Calles: Venecia, Munich, Mónaco, Av. Europa, Londres, Madrid y París. Número de calle opcional. Para urbanizaciones distintas de Real de Valdomina se muestran bloque 1–16, piso Bajo, Primero, Segundo o Tercero / Ático y letra A–D, marcados como obligatorios al mostrarse. El formulario anterior no ofrece «otra» urbanización o calle.
- Comentarios u otra información, opcionales. Un justificante de transferencia también es opcional; el formulario admite un archivo. No se probó la carga de archivos.
- No se observó una casilla de aceptación de privacidad ni condiciones en el formulario. Esto no permite concluir que la asociación carezca de política de privacidad.

## Pago y decisiones que prevalecen

La web anterior menciona transferencia bancaria de 20 € por vivienda. No se ha verificado el IBAN por un canal independiente y no se ha incorporado al proyecto. Por indicación directa del usuario, **2026 es exento y la cuota anual es de 20 € por familia o vivienda desde 2027**; por tanto, no debe copiarse sin matices la instrucción anterior de transferir inmediatamente. El alta nueva no efectúa ningún cobro.

## Diferencias con el formulario nuevo implementado

- El titular introduce nombre y apellidos en un solo campo, correo, contraseña y confirmación, dirección libre y fecha de nacimiento obligatoria; el teléfono es opcional, a diferencia del formulario previo. Se crea la cuenta y la familia queda pendiente de aprobación.
- En lugar de la elección obligatoria de segundo asociado y el número de hijos, se pueden añadir hasta 99 personas individualmente: en el formulario nuevo cada una requiere nombre y relación, con fecha de nacimiento opcional. No solicita teléfono ni correo por cada segundo asociado. La fecha del titular es obligatoria en el alta y las de los demás familiares son opcionales, conforme a la decisión del usuario; se validan como fechas reales no futuras. No se inventan fechas para registros antiguos.
- La dirección es un campo de texto libre, sin los selectores anteriores de urbanización, calle, número, bloque, piso y letra; tampoco hay campo equivalente de comentarios en el alta.
- El nuevo formulario incorpora información y una casilla obligatoria de aceptación para tramitar el alta. La aceptación de privacidad **no es consentimiento para cobros recurrentes**. Deben revisarse la finalidad, el texto, la autorización de quien facilita datos ajenos, los permisos y los plazos de conservación y borrado, especialmente para menores. Las fechas se pueden consultar y gestionar en el área familiar; administración puede verlas y exportarlas, pero no editarlas individualmente desde su panel.
- Puede elegirse gestión manual, solicitar pago único con tarjeta o solicitar suscripción anual. La preferencia se guarda, se muestra en los paneles de socio y administración y se incluye en el CSV de familias, pero no puede editarse desde el panel. No inicia Stripe, no solicita una tarjeta y no crea un pago ni una suscripción.
- En la opción manual se puede seleccionar un justificante PDF, JPEG o PNG de hasta 8 MiB, que se sube **después** de registrar el alta, en una petición separada. Administración puede listarlo y descargarlo; su recepción no acredita un pago. Si la carga falla o no se confirma, el alta ya está registrada: no repetirla, sino consultar a la asociación antes de reenviar.

Stripe está bloqueado en producción incluso con claves de prueba, y las suscripciones están desactivadas también en pruebas. Los pagos únicos de prueba solo deben ensayarse con credenciales y webhooks de prueba en una instalación de desarrollo y base de datos aisladas, sin datos reales. Antes de habilitar pagos reales siguen pendientes la conciliación, las salvaguardas y las pruebas descritas en el README; no se han realizado pruebas de cobro contra Stripe.

## Operación y pendientes

Para arrancar es obligatorio configurar `UPLOADS_DIR`: directorio Linux absoluto y persistente, creado previamente, propiedad del usuario efectivo de Node, modo `0700`, sin enlaces simbólicos en la ruta, fuera del proyecto y de todas las raíces y alias web, con `/proc/self/fd` disponible y padres no modificables por terceros. La aplicación no comprueba por sí misma todos los webroots ni los permisos de los padres. Hay que permitir cuerpos de 8 MiB en los proxies y servidores, respaldar y restaurar tanto el directorio como MySQL y establecer revisión aislada, conservación y borrado de justificantes; la comprobación de firma no descarta malware.

Al vincular una cuenta pendiente a una familia histórica, la familia provisional se conserva inactiva; miembros, fechas, preferencias y justificantes no se fusionan ni trasladan automáticamente. Administración debe revisarlos y gestionarlos. Antes de producción quedan pendientes las comprobaciones de instalación, carga y fallos, permisos, copias, privacidad, aislamiento entre familias y los flujos de pago en un entorno aislado. La revisión de la web anterior indicada arriba no probó la carga ni constituye una prueba nueva del sistema.
