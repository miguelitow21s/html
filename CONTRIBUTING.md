# Cómo contribuir a WorkTrace

Guía corta del flow de trabajo del repo. Léela antes de tu primer commit.

## Reglas de branches

- **`main`** es la rama de producción. Cada push a `main` se auto-despliega a Vercel (`turnos-front-three.vercel.app`).
- **Nadie hace push directo a `main`.** GitHub lo bloquea (branch protection).
- Todo cambio pasa por Pull Request → review de @miguelitow21s → merge.

## Nombres de rama

Usá el prefijo según el tipo de cambio:

| Prefijo | Cuándo |
|---------|--------|
| `feature/…` | Nueva funcionalidad visible al usuario |
| `fix/…` | Bug en producción |
| `ux/…` | Cambio visual, copy o UX sin lógica nueva |
| `refactor/…` | Reorganización sin cambio de comportamiento |
| `chore/…` | Dependencias, build, config del repo |
| `docs/…` | Documentación |

Ejemplo: `fix/auditoria-fotos-residuales`, `feature/reporte-mensual-excel`.

## Flujo del PR

1. Cortá una rama desde `main` actualizada:
   ```
   git checkout main
   git pull
   git checkout -b fix/mi-cambio
   ```
2. Hacé tus commits (podés hacer varios pequeños; se squashean al mergear).
3. Corré local antes de pushear:
   ```
   npm run build     # debe pasar sin errores
   npm run lint      # opcional pero recomendado
   ```
4. Pushá y abrí el PR:
   ```
   git push -u origin fix/mi-cambio
   gh pr create --fill
   ```
5. Completá el template del PR (qué cambia, cómo probar, checklist).
6. Esperá review de @miguelitow21s. Aplicá los cambios pedidos en la misma rama.
7. Una vez aprobado, @miguelitow21s hace el merge (squash). Tu rama se borra automáticamente.

## Cómo se aprueba

- El PR **debe** tener 1 review aprobado de @miguelitow21s (via CODEOWNERS).
- Los conflictos con `main` los resolvés vos antes del merge (rebase preferido).
- No se permite auto-approval ni auto-merge.

## Convenciones de commit

Formato: `<tipo>: <descripción corta en español>`

Ejemplos reales del repo:
```
Fix: validar cada slot (subarea) individualmente al iniciar limpieza
UX: card auditoría oculta select cuando hay 1 sitio detectado
```

Cierre del commit body, si aplica:
```
Co-Authored-By: <nombre> <email>
```

## Qué NO hacer

- **No push a `main`** directo (te va a rebotar por branch protection).
- **No commitees secretos** (.env, tokens, credenciales). Este proyecto no usa `.env`; la config viva se edita en `public/config.js` con PR review.
- **No cambies `vercel.json`** sin coordinar con Miguel — impacta el CSP.
- **No apruebes tu propio PR**. Requerido review externo.
- **No inventes rutas** de assets — si movés archivos, verificá que Vite los reescriba (paths absolutos `/css/logos/...` NO los procesa el bundler; deben vivir en `public/`).

## Contexto rápido del stack

Para todo lo demás (arquitectura, endpoints, convenciones, gotchas), ver [CLAUDE.md](CLAUDE.md).

## Ante duda

Preguntá a @miguelitow21s antes de mergear algo grande. Vale más una pregunta a tiempo que revertir en producción.
