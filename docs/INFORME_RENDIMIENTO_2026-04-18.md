# Informe de rendimiento (2026-04-18)

## Resumen ejecutivo

La lentitud percibida en `comenzar turno` y `cerrar turno` viene principalmente de latencia de backend + varios llamados secuenciales obligatorios (OTP, evidencia, cierre), no de render del frontend.

## Como se midio

- Script: `pwsh -File scripts/perf_diagnostics.ps1`
- Salida JSON: `test-results/perf_diagnostics.latest.json`
- Corridas ejecutadas: 3
- Resultado: `RESULT=PASS` en las 3 corridas

## Hallazgos principales

1. `shifts_start` y `shifts_end` son los pasos mas lentos por si solos.
   - `shifts_start`: entre ~5.0s y ~6.5s
   - `shifts_end`: entre ~4.7s y ~5.2s

2. El cierre suma varios pasos secuenciales de evidencia.
   - `summary_by_shift` + `request_upload` + `PUT signed URL` + `finalize_upload` + `shifts_end`
   - Con 1 sola foto final ya queda cerca de ~9.4s a ~9.9s
   - Cada foto adicional agrega aprox ~3.5s (por el ciclo request/upload/finalize secuencial)

3. OTP agrega tiempo real cuando no hay sesion OTP vigente.
   - `phone_otp_send`: ~1.0s a ~1.2s
   - `phone_otp_verify`: ~1.0s a ~1.2s
   - Sobre costo OTP total: ~2.1s a ~2.4s

4. El flujo exige GPS verificado y usa geolocalizacion de alta precision con timeout de 10s.
   - Si el GPS tarda, impacta fuerte la espera percibida
   - En codigo hay `timeout: 10000` y `maximumAge: 0`

5. En reportes, `reports_generate` no esta critico pero no es inmediato.
   - Entre ~1.5s y ~2.5s por llamada en las corridas
   - Hay retry de timeout 45s -> 60s, por eso cuando falla se puede sentir "congelado"

## Muestras de la ultima corrida (run 3)

- `employee_dashboard`: ~0.98s a ~2.08s (5 iteraciones)
- `employee_active_shift`: ~0.97s a ~1.55s (5 iteraciones)
- `reports_generate`: ~1.56s, ~1.58s, ~2.07s
- `shifts_start`: ~5.19s
- `shifts_end`: ~5.15s
- `request_upload_fin`: ~1.65s
- `upload_signed_fin_put`: ~0.52s
- `finalize_upload_fin`: ~1.51s

## Causa raiz tecnica (codigo)

- Upload de evidencias secuencial:
  - `js/app.js` en `uploadShiftEvidenceBatch` hace `for ... await` por cada foto (request -> upload -> finalize)
- En inicio y cierre se hace OTP gate antes de operar:
  - `js/app.js` en `ensureOtpVerification`
- Geolocalizacion estricta:
  - `js/app.js` en `captureLocation` (high accuracy, timeout 10s, sin cache)
- Timeout general API:
  - `js/api.js` `DEFAULT_TIMEOUT_MS = 15000`
- Reportes con retry largo al timeout:
  - `js/app.js` `runReportGenerate(45000)` y fallback `runReportGenerate(60000)`

## Recomendaciones priorizadas

### P1 (alto impacto, bajo/medio riesgo)

1. Paralelizar evidencia por lotes con concurrencia controlada (2-3) en vez de 100% secuencial.
2. Reusar GPS reciente (ej: 60-120s) para no forzar verificacion completa cada vez que se abre el flujo.
3. Mostrar progreso por etapa (OTP, geolocalizacion, subida N/N, cierre) para reducir percepcion de bloqueo.

### P2 (impacto medio)

1. Revisar backend de `shifts_start` y `shifts_end` (query plan, bloqueos, llamadas externas) porque ambos dominan el tiempo total.
2. Reducir llamadas no esenciales previas al cierre cuando el estado ya es conocido.

### P3 (UX)

1. Mensajes de estado mas detallados en cada paso de `finalizeShift`.
2. Opcional: permitir continuar UI mientras actualizaciones secundarias terminan en background cuando sea seguro.

## Conclusiones

- La app no esta "rota"; responde, pero hay acumulacion de latencia en pasos encadenados.
- El principal cuello esta en operaciones backend criticas (`start/end`) y en el pipeline secuencial de evidencias.
- Con paralelizacion controlada de evidencias + ajuste de GPS/UX, la mejora percibida debe ser notable.
