# WorkTrace — Frontend

App web (SPA) para **R3 Service & Solutions Inc.**, provista por **VerifiK**. Los **contratistas** registran sus visitas de limpieza con fotos por subárea y los **inspectores** auditan los sitios y crean tareas especiales. El **super admin** gestiona usuarios y sitios.

- Producción: https://turnos-front-three.vercel.app
- Stack: JavaScript sin frameworks (ES modules) + Vite. Backend: Supabase (Auth + Edge Functions). Hosting: Vercel.

## Empezar

```bash
npm install
npm run dev        # servidor local (Vite)
npm run build      # genera dist/
npm run lint       # eslint sobre js/
```

No hay `.env`: la configuración (URL de Supabase, anon key, llave de Google Maps) está en `public/config.js`, que se sirve tal cual.

## Cómo está armada (leer antes de tocar código)

1. **Un solo objeto `app`.** `js/app.js` crea el objeto `app` con todo lo común: arranque, sesión, login/OTP, navegación, avisos, errores, GPS, cámara y fotos.
2. **Módulos por rol, mezclados en ese objeto.** Después del login se carga el módulo del rol y se "pega" a `app` con `Object.assign`:
   - contratista → `js/modules/employee.js`
   - inspector → `js/modules/supervisor.js` + `js/modules/adminModals.js`
   - super admin → `supervisor.js` + `admin.js` + `adminModals.js`

   Por eso todo el código usa `this.metodo()` como si fuera un solo archivo. Dos consecuencias:
   - Si dos archivos definen un método con el mismo nombre, **gana el que se carga último** y la otra copia queda muerta sin avisar. No dupliques: lo compartido va en `app.js` (varios roles) o en `supervisor.js` (inspector y admin).
   - Lo que usan **dos roles distintos** tiene que vivir en `app.js`, porque cada rol carga solo su módulo.
3. **Pantallas.** Todas están en `index.html` como `<div id="page-NOMBRE">`. `app.navigate('NOMBRE')` muestra una y `loadPageData('NOMBRE')` carga sus datos.
4. **Clics.** Hay dos mecanismos:
   - `data-action="metodo" data-args="a|b"` llama `app.metodo(a, b)`. Es la forma recomendada.
   - `data-action="accion-con-guiones"` pasa por el `switch` de `handleDelegatedClick`.
5. **Backend.** Todo pasa por `js/api.js` (`apiClient`), que llama a Supabase Edge Functions con `{ action, ...datos }`. Antes de llamar, pedir el token con `app.getValidAccessToken()`.

## Dónde está cada cosa

| Archivo | Qué tiene |
|---|---|
| `js/app.js` | Núcleo. Busca `SECCIÓN:` para saltar entre bloques. |
| `js/modules/employee.js` | Contratista: iniciar visita, fotos, tareas especiales, finalizar. |
| `js/modules/supervisor.js` | Inspector: auditoría, sitios, contratistas, tareas, informes. |
| `js/modules/admin.js` | Super admin: dashboard, seguimiento de inspecciones, inspectores. |
| `js/modules/adminModals.js` | Modales de sitio (con Google Maps) y de contratista. |
| `js/api.js` | Cliente del backend (headers, token, OTP, reintentos, errores). |
| `js/utils.js` | Funciones puras: fechas, nombres, `escapeHtml`, `asArray`, teléfonos. |
| `js/constants.js` | Roles, claves de localStorage, TTL de caché, áreas por defecto. |
| `js/i18n.js` | Textos ES/EN (`t('clave')`, `data-i18n`). |
| `css/styles.css` | Estilos. Variables del tema en `:root`; índice al inicio. |
| `index.html` | Todas las pantallas y modales. |

Cada archivo empieza con un comentario que explica qué hace y cómo se conecta con el resto. El código del agendamiento de turnos (anterior a las visitas ad-hoc) y el de funciones que el cliente pidió quitar (cambio de teléfono desde el perfil, desvincular teléfono) se borraron en 2026-09; si hace falta consultarlos, están en el historial de git.

## Reglas que evitan los bugs que ya pasaron

- Texto del backend dentro de `innerHTML` → siempre con `escapeHtml()`.
- Fecha "de hoy" para un calendario → `toInputDate()` / `toLocalDateKey()` (fecha local). Con `toISOString().slice(0, 10)` da la fecha UTC, y en Colombia marca "mañana" desde las 7 p. m.
- Cada pedido al backend lleva una `Idempotency-Key` nueva (`api.js` ya lo hace). Reusarla da 409.
- `operational_tasks_manage` acepta `limit` de hasta 200; con más responde 422.
- En Safari de iPhone, para abrir un PDF: `window.open('about:blank')` **antes** de cualquier `await`, y después asignar la URL.
- La geocerca de la auditoría tiene una sola fuente de tolerancia: `getSupervisionEffectiveRadius()`.
- El reintento de OTP tiene un mutex (`retryWithFreshOtp`) para no abrir varios modales. No quitarlo.

## Deploy

Al mergear un PR a `main`, Vercel despliega solo. Si no se actualiza, desde `main` al día y con el working tree limpio:

```bash
npx vercel deploy --prod --yes
```

## Más documentación

- `CONTRIBUTING.md`: ramas, PRs y commits.
- `CLAUDE.md`: contexto detallado de flujos, gotchas e historial de cambios.
- `docs/`: especificación de la API por rol (`FRONTEND_API_*.md`), recorrido end-to-end y guía para el cliente.
