# E2E App Full (API + Reglas de Negocio)

Script: `scripts/e2e_app_full.ps1`

## Qué valida de punta a punta

1. Login por roles (`admin`, `supervisora`, `empleado`).
2. Consentimiento legal.
3. Perfil (`users_manage.me`) y directorios de usuarios.
4. Creación de empleado semilla y restaurante semilla.
5. Asignación de supervisora y staff al restaurante.
6. Dashboard/listados base (empleado y supervisora).
7. Programación de turnos:
   - creación válida,
   - conflicto esperado (`409 BUSINESS`),
   - creación válida no solapada.
8. Listado de turnos y verificación de IDs creados.
9. Generación de reporte y consulta de `list_shifts`.
10. Limpieza: cancelación de turnos creados.

## Cómo ejecutarlo

```powershell
pwsh -File scripts/e2e_app_full.ps1
```

## Resultado esperado

- Si todo está bien: termina con `RESULT=PASS` (exit code `0`).
- Si algo falla: termina con `RESULT=FAIL` (exit code `1`) y deja el detalle por paso con `request_id`.
