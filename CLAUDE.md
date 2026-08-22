# WorkTrace — Contexto del proyecto

SPA en vanilla JS + Vite + Supabase (Edge Functions) + Vercel, para R3 Service & Solutions Inc. Provista por **VerifiK**. Deploy prod: https://turnos-front-three.vercel.app

## Stack

- **Frontend**: vanilla JS (ESM), Vite 5, sin frameworks. FontAwesome + XLSX + Supabase JS.
- **Backend**: Supabase Edge Functions (Deno). No hay REST propio — todo pasa por RPC-style functions.
- **Auth**: Supabase Auth (email+password), OTP telefónico opcional, device fingerprint.
- **Hosting**: Vercel. `npm run build` genera `dist/` (SPA rewrite en `vercel.json`).
- **i18n**: solo español (`js/i18n.js` estático, sin swap runtime).

## Estructura

```
index.html              # SPA con TODAS las "pages" en <section> y modales al final
css/styles.css          # tema light global (variables --bg-app / --card-bg / --text-primary…)
public/config.js        # runtime config (Supabase URL, anonKey, Google Maps key) — se sirve tal cual
js/
  app.js                # controlador central WorkTraceApp (~10k LOC), maneja navegación, dashboards, fotos
  api.js                # cliente único (fetch wrapper para Edge Functions)
  constants.js          # STORAGE_KEYS, ROLE_ROUTES, AREA_META, DEFAULT_SYSTEM_SETTINGS
  utils.js              # helpers puros
  i18n.js               # t('llave.punto.notación')
  modules/
    employee.js         # contratista: iniciar visita, fotos, tareas del día, finalizar
    supervisor.js       # inspector: reportes, auditorías, aprobar tareas, gestionar empleados
    admin.js            # super_admin: crear usuarios, restaurantes, ajustes
    adminModals.js      # modales pesados de admin (agrupados aparte por peso)
```

## Roles y rutas

- `empleado` (contratista) → `employee-dashboard`
- `supervisora` (inspector de calidad) → `supervisor-dashboard`
- `super_admin` → `admin-dashboard`

Alias legacy en `ROLE_ROUTES`: `employee`, `supervisor`, `superuser`. Labels en `ROLE_LABELS`:
- empleado → "Contratista de Limpieza"
- supervisora → "Inspector de Calidad"

## Config runtime (public/config.js)

Se sirve estático desde `public/`, editable sin rebuild. Valores actuales:

- `supabaseUrl`: `https://orwingqtwoqfhcogggac.supabase.co`
- `apiBaseUrl`: `<supabaseUrl>/functions/v1`
- `supabaseAnonKey`: JWT anon (público, safe en cliente)
- `googleMapsApiKey`: `AIzaSyAugcqnN-QxUH2mRmgPH_hA5zo-5_RBtX0`
- `timeoutMs`: 15000

**No hay `.env`** — la config vive en `public/config.js` como `window.WORKTRACE_CONFIG`. Cambios se aplican al desplegar.

## CSP (vercel.json)

- `img-src`/`media-src` incluyen `https://orwingqtwoqfhcogggac.supabase.co`
- `connect-src` incluye supabase + `wss://…` para Realtime + Google Maps
- `script-src` permite Google Maps
- `frame-ancestors 'none'`, `X-Frame-Options: DENY`
- `Permissions-Policy: camera=(self), geolocation=(self), microphone=()`

## Credenciales de prueba

- **Contratista**: `miguelopsal@gmail.com` / `123456`
- **Inspector (supervisora)**: `miguel.lopez81@correo.tdea.edu.co` / `123456`
- **Super Admin**: `admin@gmail.com` / `123456`

## Edge Functions clave

Convención: cada endpoint recibe `{ action: 'verbo', ...payload }` y responde JSON. Cliente en `js/api.js`.

- `shifts_start` — inicia visita ad-hoc (solo `restaurant_id` requerido)
- `shifts_complete` — finaliza visita (envía evidencias fin, notas)
- `shifts_upload_evidence` — sube foto (start o end), asocia a subárea
- `operational_tasks_manage` — CRUD tareas especiales
  - actions: `list`, `list_my_open`, `create`, `update`, `complete`, `list_evidences`
- `admin_users_manage` — CRUD usuarios (contratistas + inspectores)
  - actions: `list role=empleado|supervisora|super_admin`, `create`, `update`, `deactivate`
- `admin_restaurants_manage` — CRUD sitios + áreas/subáreas
- `admin_reports` / `supervisor_reports` — generación PDF/Excel (audits, visits)
- `profile_phone_change_request` / `profile_phone_change_confirm` — flujo OTP cambio de teléfono
- `trusted_device_*` / `phone_otp_*` — flujos de OTP y dispositivos confiables

**Deprecated (410 Gone en backend):** `scheduledShiftsManage`, `restaurantStaffManage`, `admin_supervisors_manage assign/unassign`. No usar.

## Flujos críticos

### Iniciar visita (contratista)
1. `openEmployeeShiftStart` — detecta sitio por geofence (`findNearbyVisitableRestaurants` filtra catálogo por `visitable_restaurants[]` del dashboard).
2. `startAdHocVisit` → `shifts_start` (solo restaurant_id).
3. Fotos iniciales: 1 slot POR SUBÁREA (`buildPhotoSlotDefinitions`). Chequeo GRANULAR por slot en `completeShiftStartPhotos` (js/modules/employee.js:847): recorre `employeePhotoSlots`, valida que cada key exista en `photoFiles`. Si falta alguna → toast "Faltan N foto(s). Empieza por: {area} • {subarea}".
4. Cada foto sube vía `shifts_upload_evidence` con `Idempotency-Key` único por reintento.

### Progreso de evidencias
`getStartEvidenceProgressSnapshot` (js/app.js:6309) usa `Math.max(existing, new)` — NO suma, para evitar doble-conteo cuando se retoma sesión.

### Reportes (supervisor)
- Página `page-supervisor-reports`: calendarios default al día actual + botón "Hoy" (`setDateInputToToday`).
- Card orden: **botón descargar arriba** → lista media → **resumen colapsable abajo**.
- Individual PDF: pre-abre popup Safari sync (`window.open('about:blank')`) y luego setea `location.href`.

### Admin/Supervisor view switcher
- `updateAdminViewSwitcher` inyecta un switcher (grid 2 cols con gradient en activo) en el contenido de cada dashboard SI el user es super_admin. Vive en el contenido, no en el header.
- El botón "volver a admin" aparece para admin+supervisor via `updateRoleBasedActions`.

## Tema visual

Variables tema light en `:root` de `css/styles.css`:
- `--bg-app`, `--card-bg`, `--input-bg`
- `--text-primary` (oscuro sobre claro), `--text-secondary`
- Acentos: `--primary`, `--gradient-1`
- Alertas: `#047857` (success), `#b45309` (warning), `#0369a1` (info) — versiones oscuras
- `color-scheme: light`

**No** hay dark mode. `--white` sigue existiendo pero se usa solo en toasts. Regla: usar `var(--text-primary)` para texto normal.

Favicon: check verde de VerifiK (SVG inline en `<head>`).

## Convenciones de commits

Formato conservador, en español, con contexto. Ejemplo real:
```
Fix: validar cada slot (subarea) individualmente al iniciar limpieza

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

## Deploy

```bash
npx vercel deploy --prod --yes
```

Salida esperada: `Deployment turnos-front-XXXX ready.` alias a `turnos-front-three.vercel.app`. Cache invalida por hash de bundle (`Cache-Control: immutable`, `no-cache` en `index.html`).

## Gotchas conocidos

- **Idempotency-Key debe ser único por reintento** — reusarlo devuelve 409 "Request idempotente en procesamiento".
- **Popup preabierto en Safari iOS**: `window.open('about:blank')` sync ANTES del await; después setear `popup.location.href = url`.
- **`E.shifts.max_hours`** — no existe en constants (removido). Usar literal `18`.
- **`notes` en tareas**: mínimo 3 chars, validar en frontend con mensaje amigable.
- **`WinAnsi cannot encode 0x202f`** en PDFs: era backend, sanitiza narrow-nbsp; ya arreglado.
- **`filterEmployeeTasksByKnownShifts`** es pass-through (no filtra) — no re-agregar filtro o Henry (contratista de otro sitio) pierde tareas.
- **Tablas dispositivo/OTP** ya no aceptan escritura directa desde cliente — solo `trusted_device_*` / `phone_otp_*` endpoints.

## Comandos rápidos

```bash
npm run dev              # Vite dev server
npm run build            # build a dist/
npm run lint             # eslint js/
npm run format           # prettier
npx vercel deploy --prod --yes
```

## Docs adicionales

En `docs/`:
- `E2E_APP_FULL.md` — recorrido end-to-end
- `FRONTEND_API_SPEC.md` — spec completa del cliente API
- `FRONTEND_API_EMPLEADO.md`, `_SUPERVISORA.md`, `_SUPER_ADMIN.md` — por rol
- `GUIA_CLIENTE_WORKTRACE.md` — guía comercial
- `AGENTS.md` — instrucciones adicionales para agentes automatizados
