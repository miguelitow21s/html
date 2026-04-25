# INFORME DE DIAGNÓSTICO DE RENDIMIENTO — WorkTrace
**Fecha:** 2026-04-23  
**Analista:** Claude Code  
**Severidad máxima encontrada:** CRÍTICA

---

## RESUMEN EJECUTIVO

La aplicación WorkTrace tiene **tres capas de problemas** que se acumulan para producir los 43 segundos reportados en el cierre de turno con 12 fotos:

1. **Capa de red** — Las fotos se suben de una en una (secuencial), no en paralelo. Eso solo ya explica entre 30 y 42 segundos.
2. **Capa de JavaScript** — Un solo archivo de 548KB que el navegador tiene que parsear y ejecutar completamente antes de que funcione cualquier cosa.
3. **Capa de CSS** — 132KB sin minificar con efectos GPU costosos en lugares donde no hacen falta.

---

## PARTE 1 — PROBLEMAS CRÍTICOS (impacto directo en los 43 segundos)

### PROBLEMA #1 — SUBIDA DE FOTOS COMPLETAMENTE SECUENCIAL
**Archivo:** `js/app.js` — línea 6992  
**Impacto estimado:** +30 a +42 segundos con 12 fotos  
**Severidad:** CRÍTICA

El método `uploadShiftEvidenceBatch` usa un `for...of` con `await` dentro del ciclo:

```javascript
// CÓDIGO ACTUAL — SECUENCIAL (MALO)
for (const [area, file] of entries) {
    const requestUpload = await apiClient.requestShiftEvidenceUpload(shiftId, type); // ~300ms
    await apiClient.uploadToSignedUrl(signedUrl, file, file.type);                  // ~1.5-3s por foto
    await apiClient.finalizeShiftEvidenceUpload({ ... });                           // ~300ms
}
```

Cada foto hace **3 llamadas de red secuenciales**. Con 12 fotos:
- `request_upload` × 12 = ~3.6 segundos
- `uploadToSignedUrl` × 12 = ~18-36 segundos (dependiendo del tamaño de cada imagen)
- `finalize_upload` × 12 = ~3.6 segundos
- **Total estimado: 25 a 43 segundos**

**Solución:** `Promise.all()` para paralelizar todas las subidas:

```javascript
// CÓDIGO PROPUESTO — PARALELO (CORRECTO)
const uploadTasks = entries.map(async ([area, file]) => {
    if (!file || uploadedMap[area]) return;
    const requestUpload = await apiClient.requestShiftEvidenceUpload(shiftId, type);
    const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
    const path = requestUpload?.path || requestUpload?.upload?.path;
    await apiClient.uploadToSignedUrl(signedUrl, file, file.type);
    await apiClient.finalizeShiftEvidenceUpload({ shift_id: shiftId, type, path, ... });
    uploadedMap[area] = true;
});
await Promise.all(uploadTasks);
```

Con 12 fotos en paralelo, el tiempo caería de ~43s a ~5-8s (limitado por la foto más lenta, no por la suma de todas).

---

### PROBLEMA #2 — SIN COMPRESIÓN DE IMÁGENES ANTES DE SUBIR
**Archivo:** `js/app.js` — línea 5213  
**Impacto estimado:** +15 a +30 segundos por subida con fotos de cámara real  
**Severidad:** CRÍTICA

El método `processPhotoFile` guarda el archivo **tal como llega de la cámara**:

```javascript
targetFiles[area] = file; // archivo crudo, sin comprimir
```

Las cámaras modernas de smartphone producen fotos de **3 a 8MB por imagen**. Con 12 fotos:
- Peor caso: 12 × 8MB = 96MB subiendo a Supabase Storage
- Conexión móvil a 5 Mbps: 96MB ÷ 0.625 MB/s = **153 segundos solo de subida**

En la captura desde cámara interna (`capturePhoto`, línea ~5175) sí se usa `canvas.toBlob` pero con calidad 0.9, que apenas reduce el peso. No hay redimensionamiento de resolución.

**Solución:** Comprimir y redimensionar antes de guardar en `photoFiles`:

```javascript
async compressImage(file, maxWidth = 1280, quality = 0.75) {
    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const scale = Math.min(1, maxWidth / img.width);
            const canvas = document.createElement('canvas');
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);
                resolve(new File([blob], file.name, { type: 'image/jpeg' }));
            }, 'image/jpeg', quality);
        };
        img.src = url;
    });
}
```

Con `maxWidth=1280` y `quality=0.75`, una foto de 6MB quedaría en ~300-500KB. Reducción de peso: **90%**. Tiempo de subida de 12 fotos: de potencialmente 150s a ~8s.

---

### PROBLEMA #3 — GPS CON `maximumAge: 0` SE LLAMA MÚLTIPLES VECES
**Archivo:** `js/app.js` — línea 4543  
**Impacto estimado:** +10 a +30 segundos acumulados  
**Severidad:** ALTA

La función `captureLocation` usa:

```javascript
navigator.geolocation.getCurrentPosition(resolve, reject, {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0   // ← NUNCA usa caché
});
```

`maximumAge: 0` significa que el GPS nunca reutiliza la posición previamente obtenida. El problema es que `captureLocation` se llama **en múltiples puntos del flujo**:

- `startShiftFlow` línea 6921: `this.location || await this.captureLocation()`
- `uploadShiftEvidenceBatch` línea 7000: `this.location || await this.captureLocation()` (se llama DENTRO del loop de fotos si `this.location` es null)
- `finalizeShift` línea 7358: `this.location || await this.captureLocation()`

Si por cualquier motivo `this.location` se pierde entre pasos, el usuario espera hasta 10 segundos varias veces. Además, `enableHighAccuracy: true` en móviles puede tardar **15-30 segundos** si la señal es débil.

**Solución:** Cachear la ubicación con TTL de 5 minutos y reducir a `enableHighAccuracy: false` para el flujo de fotos (ya se verificó la ubicación al inicio):

```javascript
async captureLocation({ updateUi = true, maxAge = 300000 } = {}) {
    if (this.location && this.locationTimestamp && Date.now() - this.locationTimestamp < maxAge) {
        return this.location; // Reutilizar si es fresca
    }
    // ... resto del código con maximumAge: maxAge
}
```

---

### PROBLEMA #4 — TOKEN REFRESH FORZADO EN CADA ACCIÓN CRÍTICA
**Archivo:** `js/app.js` — líneas 7109 y 7326  
**Impacto estimado:** +400 a +800ms por operación  
**Severidad:** ALTA

Tanto en `completeShiftStartPhotos` como en `finalizeShift`:

```javascript
const accessToken = await this.getValidAccessToken({ forceRefresh: true });
```

`forceRefresh: true` hace una llamada a `supabase.auth.refreshSession()` **siempre**, aunque el token actual sea válido por horas. Esto es una llamada de red innecesaria que bloquea el inicio de la operación.

**Solución:** Quitar `forceRefresh: true`. Ya existe lógica en `getValidAccessToken` que refresca automáticamente cuando el token está por vencer (`expires_at < Date.now() + 60_000`).

---

## PARTE 2 — PROBLEMAS DE ARQUITECTURA (impacto en carga inicial y mantenibilidad)

### PROBLEMA #5 — app.js: 548KB, 14,598 LÍNEAS EN UN SOLO ARCHIVO
**Archivo:** `js/app.js`  
**Tamaño:** 548,649 bytes  
**Severidad:** ALTA

El navegador tiene que:
1. **Descargar** 548KB (en 3G: ~3-8 segundos)
2. **Parsear** 548KB de JavaScript (~800ms en dispositivo móvil gama media)
3. **Compilar JIT** todo antes de ejecutar cualquier función

Todo el código está en un solo objeto literal masivo:
```javascript
const app = {
    // ... 14,000 líneas de métodos de empleados, supervisores, admin, todo junto
};
```

V8 (motor de Chrome) no puede optimizar bien objetos con cientos de propiedades. Tampoco puede hacer tree-shaking ni lazy evaluation de código que no se usa en la sesión actual.

**Impacto real:** Un empleado que nunca usa funciones de supervisor carga y parsea todo el código de supervisión igual.

**Solución propuesta:**
```
js/
├── core/
│   ├── app.js           (~200KB) — bootstrap, auth, navegación, utilitarios
│   ├── employee.js      (~150KB) — flujo completo del empleado
│   ├── supervisor.js    (~100KB) — flujo del supervisor
│   └── admin.js         (~50KB)  — panel admin
```

Con `import()` dinámico:
```javascript
// En app.js (core)
async function loadRoleModule(role) {
    if (role === 'empleado') {
        const { initEmployee } = await import('./employee.js');
        initEmployee(app);
    }
}
```

El empleado nunca descarga `supervisor.js` ni `admin.js`. El tiempo de parseo inicial cae de ~800ms a ~250ms.

---

### PROBLEMA #6 — DEPENDENCIAS EXTERNAS CARGADAS EN TIEMPO DE EJECUCIÓN SIN BUNDLING
**Archivos:** `js/app.js` línea 2, `index.html` línea 8  
**Severidad:** ALTA

**6a. Supabase desde esm.sh:**
```javascript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
```

`esm.sh` es un CDN que **transpila y sirve NPM packages en tiempo real**. Cada primera visita requiere:
- DNS lookup → esm.sh
- TLS handshake
- Descarga de `@supabase/supabase-js@2` (~180KB minificado)
- Descarga de sus dependencias transitivas

Esto puede agregar **1-3 segundos** a la primera carga. No hay garantía de versión exacta (el `@2` puede cambiar sin aviso).

**6b. Font Awesome completo (1,500+ iconos):**
```html
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
```

Font Awesome 6 `all.min.css` = **80KB CSS + 4 archivos de fuentes web (~300KB total)**. La app usa aproximadamente 35-40 iconos de los 1,500+ disponibles. El 97% del CSS de iconos se descarga y nunca se usa.

**Solución:**
- Supabase: usar una build local con npm/Vite o descargar el bundle manualmente
- Font Awesome: usar solo los iconos necesarios como SVG inline, o usar la versión de kit con tree-shaking

---

### PROBLEMA #7 — TODAS LAS PÁGINAS EN EL HTML INICIAL (No hay lazy loading de vistas)
**Archivo:** `index.html`  
**Severidad:** MEDIA-ALTA

El HTML tiene **14 páginas completas** como divs ocultos:
- `page-login`
- `page-employee-dashboard`
- `page-employee-profile`
- `page-employee-shift-start`
- `page-employee-shift-photos`
- `page-employee-shift-cleaning`
- `page-employee-shift-complete`
- `page-employee-shift-summary`
- `page-success`
- `page-supervisor-dashboard`
- `page-supervisor-restaurants`, `employees`, `shifts`, `reports`, `supervision`
- `page-admin-dashboard`, `supervision-monitor`, `supervisors`
- Varios modales

El browser parsea, construye el DOM, y calcula estilos para **todo este HTML** en la carga inicial, aunque el usuario sea empleado y nunca vea las páginas de supervisor o admin.

**Solución:** Crear los fragmentos HTML dinámicamente en JavaScript solo cuando se navega por primera vez a esa vista ("vista perezosa"). 

---

### PROBLEMA #8 — 354 LLAMADAS A getElementById SIN CACHÉ
**Archivo:** `js/app.js`  
**Conteo:** 328 `getElementById` + 18 `querySelector`  
**Severidad:** MEDIA

Muchos de estos `getElementById` están dentro de funciones que se llaman repetidamente (render loops, timers, eventos). Cada llamada a `getElementById` hace una búsqueda en el árbol DOM aunque el elemento no haya cambiado.

Ejemplo problemático — en funciones de renderizado llamadas con cada actualización:
```javascript
document.getElementById('photos-count').textContent = count;
document.getElementById('total-photos').textContent = total;
document.getElementById('photo-progress').style.width = `${pct}%`;
```

**Solución:** Cachear referencias en el `init` del módulo correspondiente:
```javascript
const DOM = {
    photosCount: document.getElementById('photos-count'),
    totalPhotos: document.getElementById('total-photos'),
    photoProgress: document.getElementById('photo-progress'),
};
// Luego usar DOM.photosCount.textContent = count;
```

---

### PROBLEMA #9 — VERIFICACIÓN DE EVIDENCIA REDUNDANTE EN finalizeShift
**Archivo:** `js/app.js` — líneas 7334-7356  
**Severidad:** MEDIA

Al finalizar el turno, se hace una llamada a `getShiftEvidenceSummary` ANTES de subir las fotos finales:

```javascript
// Paso 1: Verificar si hay fotos de inicio (llamada de red extra)
const summaryPayload = await apiClient.getShiftEvidenceSummary(this.data.currentShift.id);

// Paso 2: Subir fotos finales + resolver tareas
await Promise.all([
    this.uploadShiftEvidenceBatch('fin', ...),
    this.resolveOpenEmployeeTasks(...)
]);

// Paso 3: endShift
await apiClient.endShift({ ... });
```

Esta verificación previa agrega ~300-600ms y es mayormente redundante porque el backend en `shifts_end` debería validar que hay evidencia inicial. Si ya se pasó por la pantalla de fotos de inicio correctamente, esta verificación es defensiva en exceso.

---

## PARTE 3 — PROBLEMAS EN CSS (132KB, 5,010 líneas)

### PROBLEMA #10 — `backdrop-filter: blur()` EN MÚLTIPLES ELEMENTOS
**Archivo:** `css/styles.css` — líneas 111, 367, 1472, 2104  
**Severidad:** MEDIA

`backdrop-filter: blur()` es una de las operaciones CSS más costosas para el GPU en dispositivos móviles. Crea un compositing layer separado y obliga a re-pintar constantemente el fondo de la pantalla.

Se usa en:
- Login box (`.login-box`) → `backdrop-filter: blur(10px)`
- Cards → `backdrop-filter: blur(12px)`
- Modales → `backdrop-filter: blur(14px)`
- Toast stack → `backdrop-filter: blur(10px)`

En dispositivos Android gama media-baja esto puede causar **janks (fotogramas perdidos)** al abrir modales o hacer scroll.

**Solución:** Reemplazar con un fondo sólido semi-transparente:
```css
/* ANTES (caro) */
backdrop-filter: blur(12px);
background: rgba(15, 23, 42, 0.7);

/* DESPUÉS (económico) */
background: rgba(15, 23, 42, 0.92);
```

---

### PROBLEMA #11 — `transition: all 0.3s` EN MÚLTIPLES SELECTORES
**Archivo:** `css/styles.css` — líneas 231, 283, 583, 638, 844  
**Severidad:** MEDIA

`transition: all` anima **todas** las propiedades CSS, incluyendo propiedades costosas como `box-shadow`, `width`, `height` que no son aceleradas por GPU. Esto provoca re-layouts (reflow) completos cuando cambian.

```css
/* MALO — anima todo */
transition: all 0.3s;

/* BUENO — solo lo que necesitas */
transition: background-color 0.2s ease, border-color 0.2s ease;
```

---

### PROBLEMA #12 — ANIMACIÓN INFINITA EN EL LOGIN (`float`)
**Archivo:** `css/styles.css` — línea 106  
**Severidad:** BAJA

```css
animation: float 6s ease-in-out infinite;
```

Esta animación corre indefinidamente en el elemento decorativo del login. Aunque el usuario ya inició sesión, si el elemento sigue en el DOM, la animación sigue consumiendo CPU/GPU.

**Solución:** Remover el elemento decorativo del DOM al navegar a otra página, o pausar la animación con `animation-play-state: paused` cuando no es visible.

---

### PROBLEMA #13 — CSS NO MINIFICADO, 132KB
**Archivo:** `css/styles.css`  
**Tamaño:** 134,548 bytes (unminificado)  
**Severidad:** MEDIA

El archivo CSS contiene indentación con 12 espacios (inusual), comentarios de sección, y nombres de clases en español sin abreviar. Minificado quedaría en ~80-90KB. Con gzip quedaría en ~18-22KB.

Sin gzip ni minificación, se transfieren 132KB de CSS que bloquean el renderizado inicial.

**Adicionalmente:** No hay separación de CSS crítico (above-the-fold) del resto. Todo el CSS de supervisor y admin se carga aunque el usuario sea empleado.

---

### PROBLEMA #14 — `box-shadow` EXCESIVO EN ELEMENTOS ANIMADOS/HOVER
**Archivo:** `css/styles.css` — múltiples  
**Severidad:** BAJA-MEDIA

`box-shadow` fuerza un repaint en cada frame cuando está en un elemento con hover o animación. Se usa en botones con `:hover` (líneas 293-298, 850-855) con transición. El GPU no puede acelerar `box-shadow`.

**Solución para elementos frecuentemente interactuados:** usar `filter: drop-shadow()` o pseudo-elemento `::after` con `opacity` transition.

---

## PARTE 4 — MALAS PRÁCTICAS GENERALES

### PROBLEMA #15 — FUNCIÓN `createScopedConsole` DUPLICADA
**Archivos:** `js/app.js` línea 134, `js/api.js` línea 12  
**Severidad:** BAJA

La misma función está definida dos veces, en archivos separados. Si se cambia en uno no se cambia en el otro. Debería estar en un módulo utilitario compartido.

---

### PROBLEMA #16 — OBJETO `app` DE 14,000 LÍNEAS — V8 NO PUEDE OPTIMIZARLO BIEN
**Archivo:** `js/app.js`  
**Severidad:** ALTA

Toda la aplicación es un único objeto literal enorme:
```javascript
const app = {
    // propiedad 1
    // propiedad 2
    // ...
    // propiedad N (hay cientos)
};
```

Los motores de JavaScript modernos (V8) usan "hidden classes" para optimizar objetos. Cuando un objeto tiene **cientos de propiedades definidas de una vez**, V8 no puede crear una hidden class eficiente. El acceso a propiedades se vuelve más lento (usa hash lookup en vez de offset fijo).

Además, al ser un solo módulo plano, **no hay lazy evaluation**: todas las funciones se compilan cuando se carga la página, aunque 70% nunca se ejecuten en esa sesión.

---

### PROBLEMA #17 — MÚLTIPLES LLAMADAS A `getValidAccessToken` EN SECUENCIA
**Archivo:** `js/app.js`  
**Severidad:** BAJA-MEDIA

En varios flujos, se llama a `getValidAccessToken` y luego el apiClient también llama `resolveAccessToken` internamente (línea 1579):

```javascript
apiClient.setAccessTokenResolver(async (options = {}) => this.getValidAccessToken(options));
```

Esto puede causar que el token se refresque dos veces en la misma operación. Existe protección con `tokenRefreshPromise` (línea 2053) pero el flujo es difícil de razonar.

---

### PROBLEMA #18 — NO HAY MINIFICACIÓN NI BUNDLING EN PRODUCCIÓN
**Archivos:** `vercel.json`, configuración general  
**Severidad:** ALTA

El proyecto se despliega en Vercel enviando los archivos JavaScript y CSS tal como están escritos. No hay:
- Minificación de JS/CSS
- Bundling con Vite, Rollup, esbuild u otro
- Tree-shaking de dependencias no usadas
- Code splitting automático
- Gzip/Brotli habilitado explícitamente (Vercel lo hace automático pero los assets deben tener headers correctos)

**Comparación de tamaños:**

| Archivo | Actual | Minificado | Minificado + Gzip |
|---------|--------|-----------|-------------------|
| app.js | 548KB | ~220KB | ~55KB |
| styles.css | 132KB | ~85KB | ~18KB |
| api.js | 23KB | ~10KB | ~3KB |
| **Total** | **703KB** | **315KB** | **76KB** |

La diferencia entre 703KB y 76KB es la diferencia entre 5-8s de carga en 3G y 1s.

---

## RESUMEN DE TIEMPOS ESTIMADOS

### Flujo actual: Finalizar turno con 12 fotos

| Paso | Tiempo actual | Causa principal |
|------|--------------|----------------|
| Refresh de token forzado | ~500ms | `forceRefresh: true` innecesario |
| OTP (si aplica) | ~2-3s | OK, es necesario |
| Verificación summary previa | ~500ms | Llamada extra innecesaria |
| GPS (si no cacheado) | 0-10s | `maximumAge: 0` |
| Upload 12 fotos (secuencial) | **25-43s** | Loop secuencial + fotos sin comprimir |
| `endShift` | ~5-6s | Backend (normal) |
| **TOTAL** | **~33-63s** | |

### Flujo propuesto: Finalizar turno con 12 fotos

| Paso | Tiempo propuesto | Mejora |
|------|-----------------|--------|
| Verificación de token (lazy) | ~0ms | Token ya válido |
| OTP | ~2-3s | Sin cambio |
| GPS (cacheado) | ~0ms | Cache de 5 min |
| Upload 12 fotos (paralelo + comprimidas) | **4-8s** | Promise.all + compresión |
| `endShift` | ~5-6s | Sin cambio |
| **TOTAL** | **~11-17s** | **Reducción: 65-80%** |

---

## PLAN DE IMPLEMENTACIÓN — PRIORIDADES

### FASE 1 — Cambios de impacto inmediato (1-2 días de trabajo)
Estos cambios no requieren refactoring mayor y dan el mayor beneficio:

1. **[ CRÍTICO ]** Hacer `uploadShiftEvidenceBatch` paralelo con `Promise.all`
   - Archivo: `js/app.js` función `uploadShiftEvidenceBatch` (línea 6992)
   - Impacto: −30 a −40 segundos en uploads de 12 fotos

2. **[ CRÍTICO ]** Agregar compresión de imágenes en `processPhotoFile`
   - Archivo: `js/app.js` función `processPhotoFile` (línea 5213)
   - Impacto: −50 a −90% en tamaño de archivos subidos

3. **[ ALTO ]** Agregar caché de ubicación GPS con TTL de 5 minutos
   - Archivo: `js/app.js` función `captureLocation` (línea 4517)
   - Impacto: −0 a −10 segundos

4. **[ ALTO ]** Quitar `forceRefresh: true` en `completeShiftStartPhotos` y `finalizeShift`
   - Archivos: `js/app.js` líneas 7109 y 7326
   - Impacto: −400 a −800ms

5. **[ MEDIO ]** Quitar la llamada extra a `getShiftEvidenceSummary` en `finalizeShift`
   - Archivo: `js/app.js` líneas 7334-7356
   - Impacto: −300 a −600ms

### FASE 2 — Optimizaciones de carga inicial (3-5 días)

6. **[ ALTO ]** Minificar y comprimir assets para producción
   - Introducir Vite como build tool (o al menos `esbuild`)
   - Impacto: app.js de 548KB → ~55KB en red

7. **[ ALTO ]** Reemplazar `import from 'https://esm.sh/...'` con bundle local
   - Bajar `supabase-js` como archivo local
   - Impacto: −1 a −3s en primera carga

8. **[ ALTO ]** Reemplazar Font Awesome completo con solo los iconos usados (SVGs inline)
   - Impacto: −80KB CSS + −300KB de fuentes web

9. **[ MEDIO ]** Quitar `backdrop-filter: blur()` en CSS
   - Reemplazar con fondos semi-transparentes sólidos
   - Impacto: menos jank en móviles de gama media-baja

### FASE 3 — Refactoring estructural (1-2 semanas)

10. **[ ALTO ]** Dividir `app.js` en módulos por rol
    - `core/boot.js` — auth, routing, utilitarios
    - `modules/employee.js` — flujo del empleado
    - `modules/supervisor.js` — flujo del supervisor
    - `modules/admin.js` — panel admin
    - Usar `import()` dinámico para cargar solo el módulo del rol activo
    - Impacto: parseado inicial de 800ms → ~250ms

11. **[ MEDIO ]** Cachear referencias del DOM al inicializar cada módulo
    - Impacto: menos traversals del DOM en renders frecuentes

12. **[ BAJO ]** Extraer función `createScopedConsole` a módulo compartido
    - Eliminar duplicación entre `app.js` y `api.js`

13. **[ BAJO ]** Reemplazar `transition: all` con propiedades específicas en CSS
    - Evitar reflows innecesarios

---

## CONCLUSIÓN

**El problema de los 43 segundos tiene una causa principal clara y corregible en pocas horas:** la subida secuencial de fotos sin compresión. Los cambios de la Fase 1 pueden implementarse en 1-2 días y reducirán ese tiempo a menos de 15 segundos.

Las fases 2 y 3 son mejoras de calidad que harán la app más rápida al cargar, más fácil de mantener, y preparada para escalar, pero no son urgentes.

**Prioridad inmediata:** Fase 1, ítems 1 y 2. Con solo esos dos cambios el flujo de 12 fotos bajará de 43s a ~8-12s.
