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
- **Duplicaciones de funciones entre app.js y adminModals.js**: mismo namespace `WorkTraceApp`; la última cargada pisa. Bug histórico repetido (populateSupervisorAreaOptions, setSupervisorSelectedArea, resetSupervisorSupervisionState). Al agregar métodos verificar que no exista otra definición del mismo nombre. Consolidadas en app.js (PR #16, #22).
- **Badge `.supervision-upload-badge` con `hidden` no funciona**: el CSS `display: inline-flex` pisaba `[hidden]`. Se usa la ausencia/presencia de `data-status` para toggle (`.badge:not([data-status]){display:none}`). Ver `css/styles.css`.

## Upload progresivo end-to-end (2026-09, arquitectura vigente)

Reemplaza el batch bloqueante al finalizar (60-90s con 20-50 fotos) por uploads en background durante el recorrido.

### Auditoría (inspector) — `supervisor_presence_manage`
Backend agregó (2026-09) los actions `start`, `get_active_draft`, `attach_evidence`, `finalize`. Guard viejo `SUPERVISION_ALREADY_COMPLETED_TODAY` REMOVIDO — permite varias auditorías/día por sitio. Ver [reference_supervision_drafts.md] en memoria.

**Flujo front** (`supervisor.js`):
1. `verifySupervisorSupervisionLocation` OK → `resumeSupervisionDraftIfAny()` o `ensureSupervisionDraft()` → `presence_id` guardado en `this.supervisionDraftId`.
2. Al agregar foto (`processPhotoFile` type='supervision' en app.js) → `enqueueSupervisionSlotUpload(area, file)` → compress + PUT + `attach_evidence` en background. Badge visual en la miniatura.
3. Al agregar observación (`bindSupervisionObservationsAttachmentsOnce`) → `enqueueSupervisionObservationUpload(index, file)` idem.
4. `saveSupervision` → `awaitAllSupervisionUploads()` (Promise.allSettled) → `finalize` solo con `notes`.
5. `resetSupervisionProgressiveState` limpia todo al finalizar/salir. `ensureSupervisionDraft` invalida draft cacheado si cambia el restaurant (backend permite drafts paralelos por sitio, PR #20).

### Contratista — `shifts_upload_evidence`
Backend YA soportaba shift_id como parent. Solo se cablearon los hooks del front.

**State** (`employee.js`):
- `_employeeStartUploads` / `_employeeEndUploads` — Map(slotKey → {status, promise, path}) por fotos de subárea
- `_employeeObsUploads` — Map por observaciones libres al finalizar
- `_employeeTaskUploads` — Map por evidencia de tarea especial (infra dejada, no cableada aún)
- `_employeeLocationCache` — reusa lat/lng por 2 min para no disparar N GPS calls en ráfagas

Todos los Maps se **inicializan lazy** en cada `enqueue*` (bug histórico PR #28: si el user retomaba un shift activo sin pasar por `resetShiftState`, los maps quedaban undefined y el enqueue era silent-return).

**Hooks**:
- `processPhotoFile` type='start'/'end' → `enqueueEmployeeSlotUpload`
- `bindObservationsAttachmentsOnce` → `enqueueEmployeeObservationUpload`
- `completeShiftStartPhotos` / `completeShift` → `awaitAllEmployeeUploads('start'|'end')` ANTES del batch legacy. El batch marca `uploadedStartAreas[key]=true` cuando el background OK, así el batch salta las ya subidas y solo reintenta las que fallaron.

### Retry OTP con MUTEX (crítico)
`request_evidence_upload` y `finalize_evidence_upload` requieren OTP session (`requiresOtp:true`). Si el token expira mid-batch, N uploads paralelos fallan a la vez. **Sin mutex, cada uno abría su propio modal OTP → race condition → algunos completan, otros no.**

Fix en `retryWithFreshOtp` (app.js:2077): `this._otpRefreshInFlight` guarda la promise; el primero que falla abre el modal, los demás hacen await y reintentan con el token nuevo. **Nunca revertir este mutex.**

Pipelines background (`enqueueEmployee*Upload`, `_runEmployeeUpload`) llevan wrapper `runWithOtpRetry` que detecta `isOtpSessionError` y llama `retryWithFreshOtp`. Igual patrón que el batch legacy.

### Compresión de imágenes global
`compressImage` (app.js:5657): JPEG 0.85, max 2560px por lado, respeta EXIF orientation, no upscale, no recomprime si ya es <=1.5MB. Se llama en TODOS los uploads de imagen (contratista start/end/obs/task, inspector auditoría/obs). Videos no se comprimen (requiere FFmpeg.wasm, 25MB, lento). Ver PR #17.

### UI: badge de estado por miniatura
Clase compartida `.supervision-upload-badge` (auditoría + contratista); distingue por data-attribute:
- Auditoría: `data-supervision-upload-badge="slot:{area}"` o `"obs:{index}"`
- Contratista: `data-employee-upload-badge="{start|end|obs}:{key}"`

Estados: `data-status="uploading"` (⏳ azul) / `"done"` (✓ verde) / `"error"` (⚠ naranja). Injectado en `updatePhotoSlot` (app.js) y en `render*Attachments`.

## Guard de geofence — tarea especial
`validateRestaurantTaskFileByGeofence` (supervisor.js) — solo aplica al INSPECTOR creando tarea especial (no al contratista respondiendo).

Reglas (PR #33):
- Dentro del sitio → cualquier archivo (cámara + galería).
- Fuera del sitio → rechaza archivos con `lastModified < 60s` (heurística "cámara reciente"). Aceptar archivos viejos de galería.
- **Tolerancia GPS indoor**: `accuracyBuffer` sin cap agresivo (max 250m), radio mínimo 50m, **bypass total si accuracy > 200m** (GPS demasiado pobre para concluir).
- Mensaje diagnóstico con la distancia real. `console.info('[rtask-file-geofence] calc', {...})` para debug.

Instrucción del inspector puede ser imagen O video (backend acepta `image/jpeg`, `image/png`, `image/heic`, `image/webp` en `request_instructions_upload` desde 2026-09). Create task recibe `instructions_media_path` (nuevo) o `instructions_video_path` (legacy). Render en employee.js decide `<img>` vs `<video>` por extensión del path.

## Auditoría — cambio de zona (UX)
- Solo una nav de zonas ABAJO del grid (`#supervision-area-nav`). La nav-top fue removida (PR #22).
- Al tocar Anterior/Siguiente: `scrollSupervisionAreaToTop()` scroll suave al top con **doble rAF + fallback timeout 350ms** (iOS Safari cancela smooth scroll durante reflow del grid).
- Placeholder "Selecciona un área" del select removido — auto-selecciona la primera área (PR #15).

## Límites de observaciones (contratista + inspector)
Mismo patrón en ambos flows:
- Máx **5 imágenes** + **2 videos** (validación al agregar, no al enviar).
- Videos ≤ **30 segundos** cada uno (probado con `probeVideoDurationSeconds` — en app.js core desde PR #29).
- Rechazos se acumulan en un solo toast.
- Chip informativo azul arriba del listado: `.supervision-attachments-hint`.

Helper `formatSecondsAsMmSs` también en app.js core (antes solo en supervisorMethods).

## Terminología UI
- **contratista** (nunca "empleado" en UI)
- **inspector** (nunca "supervisor" o "supervisora" en UI)
- **auditoría** (nunca "supervisión" en UI — es nombre interno del backend `supervisor_presence_logs`)
- Toasts post-guardar auditoría: "Auditoría registrada correctamente." (PR #26).

## Deploy y auto-deploy
Vercel↔GitHub integration puede caerse silenciosamente. **Síntoma**: PRs se mergean pero el bundle en prod no cambia. **Fix**: `npx vercel deploy --prod --yes` desde main actualizado (verificar `git status` limpio Y en branch `main`, sino se despliega el working tree del branch actual — bug histórico donde se desplegó desde branch viejo).

Verificar deploy con `curl` del HTML → obtener hash del bundle `main-*.js` y comparar contra el anterior. Marcadores únicos por PR (strings que Vite no minifica) sirven para grep contra el bundle.

## PRs recientes destacados (2026-09)
- #15/#16: quitar placeholder "Selecciona un área" (duplicación adminModals/app)
- #17: compresión global de imágenes
- #18/#19: upload progresivo auditoría + contratista
- #22: fix badge fantasma CSS + nav-top quitada + obs con progressivo + validation limits
- #24/#28: bugs del badge del contratista (silent early-return sin shift, lazy init)
- #25/#27/#33: guard de geofence de tarea especial (removido → restaurado → más tolerante)
- #26: copy "auditoría" en toasts
- #29/#30: límites 5+2/30s en contratista, placeholder obligatorio en tarea
- #31/#32: OTP retry con mutex para uploads paralelos

## Guard de geofence — auditoría
`getSupervisionEffectiveRadius(radiusMeters, accuracyMeters)` (supervisor.js) es la ÚNICA fuente de tolerancia GPS de la auditoría. La usan **ambos** consumidores:
- `renderSupervisionRestaurantAutoDetect` (auto-detectar el sitio al entrar)
- `verifySupervisorSupervisionLocation` (botón "Verificar en sitio")

Reglas: piso de radio **50 m** + buffer = accuracy real con tope **150 m**. Sin bypass total (a diferencia del guard de tarea especial): la auditoría ES el chequeo de presencia, dejar pasar accuracy pésima permitiría auditar desde cualquier lado.

**Bug histórico (cerrado, reportado por Henry vía WhatsApp 2026-09)**: "Auditoría no reconoce el sitio donde estoy". Causa: auto-detect usaba buffer 60 m y verify usaba 35 m → el sitio se pre-seleccionaba ("Ubicación lista para verificar en Burbank") pero Verificar decía fuera de rango. **No agregar un segundo cálculo de tolerancia — siempre pasar por el helper.**

Log diagnóstico: `console.info('[auditoria-verify] calc', {...})` y `[auditoria-autodetect] evaluación por sitio`. Mensajes de error muestran el radio EFECTIVO (no el configurado) + la precisión del GPS.

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
