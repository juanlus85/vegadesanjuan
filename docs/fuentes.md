# Fuentes y observaciones para la asociación

## Información pública comprobada

La web de la asociación, https://vegadesanjuan.es/, se presenta como Asociación de Vecinos Vega de San Juan, en San Juan de Aznalfarache (Sevilla), fundada en abril de 2011. Enumera como ámbito Real de Valdomina, Valparaíso, Valparaíso Hills, Residencial Europa, Jardines de Europa, Pórtico de Simón Verde y Vía Célere San Juan. La web menciona defensa de intereses vecinales, colaboración solidaria y actividades de convivencia.

La cuota de 20 € por vivienda y año ha sido confirmada directamente por el usuario; prevalece sobre cualquier dato anterior. La ficha municipal https://www.ayto-sanjuan.es/es/municipio/asociaciones/Vega-de-San-Juan-Asociacion-de-Vecinos/ publica el email avvvegadesanjuan@gmail.com. Las redes enlazadas por la web anterior son https://www.facebook.com/vegadesanjuan, https://www.instagram.com/avvvegadesanjuan y https://twitter.com/asociacionvega. Las imágenes `barrio.jpg`, `ambito.png` y `barrio-ilustracion.jpg` se han copiado de la web de la asociación a la carpeta local del proyecto.

El 24/11/2026 una consulta HTTP normal de la web devolvió el título de la asociación; una consulta identificada como Googlebot devolvió una página comercial en alemán, no relacionada. Esto es indicio de posible spam o contenido diferenciado para rastreadores, no un diagnóstico concluyente. Antes de actualizar producción conviene revisar el alojamiento, la instalación anterior y los accesos, y respaldar la información.

## Documentación oficial de Stripe consultada

- https://docs.stripe.com/api/checkout/sessions/create
- https://docs.stripe.com/payments/checkout/free-trials?ui=full-page
- https://docs.stripe.com/billing/subscriptions/trials/free-trials
- https://docs.stripe.com/billing/subscriptions/billing-cycle
- https://docs.stripe.com/api/events/types
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/billing/testing

Una sesión de suscripción con prueba puede producir una factura de cero euros: nunca debe interpretarse como cuota pagada. `trial_end` de Checkout debe estar al menos 48 horas en el futuro. Webhooks deben verificarse sobre bytes originales y ser idempotentes. No puede garantizarse ausencia absoluta de pagos duplicados si, independientemente del sistema, alguien también transfiere dinero: se requiere conciliación y posible devolución. No se han realizado pruebas de cobro ni de suscripción en una cuenta real de Stripe.
