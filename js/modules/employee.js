// @ts-nocheck
import { CACHE_TTLS, DEFAULT_SYSTEM_SETTINGS, SUPPORTED_EVIDENCE_IMAGE_ACCEPT } from '../constants.js';
import { apiClient } from '../api.js';
import { t } from '../i18n.js';
import {
    asArray,
    buildAreaMeta,
    escapeHtml,
    formatDate,
    formatDateTime,
    formatHours,
    formatShiftLocalDate,
    formatShiftLocalRange,
    getBadgeClass,
    getMonthStart,
    getRestaurantDisplayName,
    getRestaurantRecordId,
    getScheduledHours,
    getShiftStatusLabel,
    normalizeAreaToken,
    sanitizeUrl,
    sumHours,
    toInputDate,
} from '../utils.js';

export const employeeMethods = {
    async loadEmployeeDashboard(force = false) {
        if (
            !force &&
            this.data.employee.dashboard &&
            this.isCacheFresh('employeeDashboard', CACHE_TTLS.employeeDashboard)
        ) {
            this.renderEmployeeDashboard();
            this.warmEmployeeWorkspace();
            void this.primeEmployeeWorkspacePermissions();
            return this.data.employee.dashboard;
        }

        return this.runPending('employeeDashboard', async () => {
            const [dashboard, openTasksResult] = await Promise.all([
                apiClient.getEmployeeDashboard({
                    schedule_limit: 10,
                    pending_tasks_limit: 10,
                }),
                apiClient
                    .operationalTasksManage('list_my_open', {
                        limit: 40,
                    })
                    .catch((error) => {
                        console.warn('No fue posible cargar el detalle de tareas abiertas.', error);
                        return [];
                    }),
            ]);

            const openTasks = this.filterEmployeeTasksByKnownShifts(asArray(openTasksResult), dashboard);

            this.data.employee.dashboard = dashboard;
            this.data.employee.openTasks = openTasks;

            // Backend v3: my_dashboard.today_shifts[] unifica activo+scheduled con lat/lng/radius del sitio.
            // Fallback a active_shift + scheduled_shifts para builds viejos del backend.
            const todayShifts = asArray(dashboard?.today_shifts);
            console.info('[dashboard] today_shifts recibidos', {
                count: todayShifts.length,
                haveLocation: Boolean(this.location?.lat),
                items: todayShifts.map((s) => ({
                    scheduled_shift_id: s?.scheduled_shift_id,
                    shift_id: s?.shift_id,
                    state: s?.state || s?.status,
                    restaurant_id: s?.restaurant_id,
                    restaurant_name: s?.restaurant?.name,
                    scheduled_start: s?.scheduled_start,
                    scheduled_end: s?.scheduled_end,
                    lat: s?.restaurant?.lat,
                    lng: s?.restaurant?.lng,
                    radius_meters: s?.restaurant?.radius_meters,
                })),
            });
            // Aliases de "activo" — cubre cualquier variación que envíe el backend
            // (activo/active/in_progress/started/awaiting_evidence/incomplete) para
            // no perder un turno recién iniciado que aún no ha subido evidencias.
            const activeStates = new Set(['activo', 'active', 'in_progress', 'in-progress', 'started', 'ongoing', 'awaiting_evidence', 'incomplete']);
            const findActiveCandidate = (list) =>
                asArray(list).find((shift) => {
                    const state = String(shift?.state || shift?.status || '').toLowerCase();
                    return activeStates.has(state);
                });

            // Post-migracion Visitas: no hay scheduled_shifts. Solo active_shift.
            // El dashboard trae visitable_restaurants[] que el contratista usa
            // para iniciar visita ad-hoc desde el card "Sitio disponible".
            const authoritativeActive =
                dashboard?.active_shift || findActiveCandidate(todayShifts);
            this.data.currentShift = authoritativeActive
                ? this.enrichEmployeeShiftRecord(authoritativeActive, dashboard)
                : null;
            this.data.currentScheduledShift = null;
            this.data.employee.todayShifts = [];
            if (this.data.currentShift?.id) {
                void this.hydrateShiftEvidenceSummary(this.data.currentShift).then((nextShift) => {
                    if (nextShift?.id && this.currentPage === 'employee-dashboard') {
                        this.renderEmployeeDashboard();
                    }
                });
            }
            this.touchCache('employeeDashboard');
            this.renderEmployeeDashboard();
            this.warmEmployeeWorkspace();
            void this.primeEmployeeWorkspacePermissions();

            // Capturar GPS en background para poder filtrar visitable_restaurants
            // por proximidad y mostrar el card "Sitio disponible" apenas se abre
            // el dashboard.
            if (!this.data.currentShift?.id) {
                void this.captureLocation({ updateUi: false }).catch((locError) => {
                    console.warn('No fue posible capturar ubicación en background.', locError);
                });
            }

            return dashboard;
        });
    },

    renderEmployeeProfile() {
        const history = this.data.employee.hoursHistory || {};
        const totalScheduledHours = Number(
            history?.total_scheduled_hours ?? history?.total_hours_scheduled ?? history?.total_assigned_hours
        );
        const profileHours =
            Number.isFinite(totalScheduledHours) && totalScheduledHours > 0
                ? totalScheduledHours
                : sumHours(asArray(history));

        // Optional chaining defensivo: si algun stat card se remueve del HTML
        // (ej. profile-upcoming-shifts en el corte final Visitas), no explota.
        const setText = (id, value) => {
            const node = document.getElementById(id);
            if (node) node.textContent = value;
        };
        setText('profile-hours-worked', formatHours(profileHours));
        setText('profile-total-shifts', String(history?.total_shifts || 0));
        setText('profile-pending-tasks', String(this.data.employee.dashboard?.pending_tasks_count || 0));
        const visibleTasks = this.getVisibleEmployeeTasks(this.data.employee.dashboard);
        this.renderEmployeeProfileTasks(visibleTasks);
        this.updateUserUI();
    },

    haversineMeters(lat1, lng1, lat2, lng2) {
        const R = 6371000; // metros
        const toRad = (deg) => (Number(deg) * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    },

    // Backend v3 (migración a visitas ad-hoc): my_dashboard trae
    // visitable_restaurants[] con TODOS los sitios activos + geocerca. El
    // frontend decide cuál es "el sitio donde estoy" comparando la ubicación
    // actual contra cada radius_meters. Regla decidida: mostramos SOLO los
    // que quedan dentro de su radio. Si ninguno matchea, no ofrecemos
    // iniciar visita (el usuario tendrá que acercarse a un sitio).
    findNearbyVisitableRestaurants(dashboard = this.data.employee.dashboard || {}) {
        const restaurants = asArray(dashboard?.visitable_restaurants);
        if (restaurants.length === 0) return [];
        const lat = Number(this.location?.lat);
        const lng = Number(this.location?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

        const withinRadius = restaurants
            .map((r) => {
                const rLat = Number(r?.lat);
                const rLng = Number(r?.lng);
                if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) return null;
                const radius = Number(r?.radius_meters) > 0 ? Number(r.radius_meters) : 200;
                const distance = this.haversineMeters(lat, lng, rLat, rLng);
                if (distance > radius) return null;
                return { ...r, _distanceMeters: distance, _radiusMeters: radius };
            })
            .filter(Boolean)
            .sort((a, b) => a._distanceMeters - b._distanceMeters);

        return withinRadius;
    },

    renderEmployeeVisitableCard() {
        const card = document.getElementById('employee-visitable-card');
        const list = document.getElementById('employee-visitable-list');
        const copy = document.getElementById('employee-visitable-copy');
        if (!card || !list) return;

        // Ocultar si ya hay turno activo (no se puede iniciar otro) o si el
        // dashboard todavia no cargo visitable_restaurants (backend viejo).
        const hasActiveShift = Boolean(this.data.currentShift?.id);
        const dashboard = this.data.employee.dashboard || {};
        const hasVisitableCatalog = Array.isArray(dashboard?.visitable_restaurants);
        if (hasActiveShift || !hasVisitableCatalog) {
            card.classList.add('hidden');
            list.innerHTML = '';
            return;
        }

        const nearby = this.findNearbyVisitableRestaurants(dashboard);
        if (nearby.length === 0) {
            // Mostramos el card con mensaje "no hay sitios cerca" solo si el GPS
            // esta capturado. Sin GPS ni siquiera podemos decir "no hay sitios".
            const hasLocation = Number.isFinite(Number(this.location?.lat));
            if (!hasLocation) {
                card.classList.add('hidden');
                list.innerHTML = '';
                return;
            }
            card.classList.remove('hidden');
            if (copy) copy.textContent = 'No hay sitios disponibles cerca de tu ubicación actual.';
            list.innerHTML = '';
            return;
        }

        card.classList.remove('hidden');
        if (copy) {
            copy.textContent = nearby.length === 1
                ? 'Detectamos que estás en la zona de este sitio. Puedes iniciar tu visita ahora.'
                : 'Estás dentro de la zona de estos sitios. Elige uno para iniciar la visita.';
        }
        // Log de diagnostico: primer sitio del catalogo para confirmar el shape
        // real del backend (nombre del campo id, tipo numerico o UUID, etc.).
        if (nearby.length > 0) {
            console.info('[visitable] primer sitio cercano:', {
                keys: Object.keys(nearby[0]),
                restaurant_id: nearby[0].restaurant_id,
                id: nearby[0].id,
                sample: nearby[0],
            });
        }
        list.innerHTML = nearby
            .map((r) => {
                const name = escapeHtml(String(r.name || 'Sitio sin nombre'));
                const cityState = [r.city, r.state].filter(Boolean).map((v) => escapeHtml(String(v))).join(', ');
                const distanceLabel = `A ${Math.round(r._distanceMeters)} m del centro del sitio`;
                // Aceptar aliases: restaurant_id (contrato oficial), id (fallback).
                const idValue = r.restaurant_id ?? r.id ?? '';
                return `
                    <div class="info-item" style="margin-top:8px;">
                        <i class="fas fa-store"></i>
                        <div class="info-item-content">
                            <span class="info-item-label">${name}</span>
                            <span class="info-item-value" style="font-size:12px;color:var(--gray);">${cityState ? cityState + ' · ' : ''}${distanceLabel}</span>
                        </div>
                        <button type="button" class="btn btn-primary btn-inline" data-action="startAdHocVisit" data-args="${escapeHtml(String(idValue))}" style="flex-shrink:0;">
                            <i class="fas fa-play"></i> Iniciar visita
                        </button>
                    </div>
                `;
            })
            .join('');
    },

    async startAdHocVisit(restaurantIdArg) {
        // El delegador global de data-action coerce a Number si el arg matchea
        // /^\d+(\.\d+)?$/. Aceptamos numero o string (UUID) para no rechazar
        // ids no numericos que pueda usar el backend.
        console.info('[visit-adhoc] click', { restaurantIdArg, typeArg: typeof restaurantIdArg });
        let restaurantId;
        if (typeof restaurantIdArg === 'number' && Number.isFinite(restaurantIdArg)) {
            restaurantId = restaurantIdArg;
        } else {
            const raw = String(restaurantIdArg ?? '').trim();
            if (!raw) {
                this.showToast('Sitio inválido: no se recibió el id del sitio.', {
                    tone: 'error',
                    title: 'No fue posible iniciar',
                });
                return;
            }
            const asNumber = Number(raw);
            restaurantId = Number.isFinite(asNumber) && String(asNumber) === raw ? asNumber : raw;
        }

        if (this.data.currentShift?.id) {
            this.showToast('Ya tienes un servicio activo. Ciérralo antes de iniciar otro.', {
                tone: 'warning',
                title: 'Servicio activo',
            });
            return;
        }

        this.showLoading('Iniciando visita', 'Verificando ubicación y creando la visita.');
        try {
            // GPS fresco de alta precisión — el backend valida geocerca con lat/lng.
            const location = await this.captureLocation({ updateUi: false, highAccuracy: true });

            const performRequest = async () => apiClient.startShift({
                restaurant_id: restaurantId,
                lat: location.lat,
                lng: location.lng,
                fit_for_work: true,
                declaration: 'Me encuentro en condiciones de iniciar labores.',
            });

            let result;
            try {
                result = await performRequest();
            } catch (firstError) {
                if (this.isOtpSessionError?.(firstError)) {
                    result = await this.retryWithFreshOtp(performRequest, { purpose: 'visit_start_adhoc' });
                } else {
                    throw firstError;
                }
            }

            // Enriquecer el shift con la data del restaurant del catalogo para
            // que el flujo posterior (photos/cleaning) tenga nombre/geo/tz.
            // Comparacion tolerante (string vs number) para soportar UUIDs.
            const restaurantIdKey = String(restaurantId);
            const restaurantRecord = asArray(this.data.employee.dashboard?.visitable_restaurants)
                .find((r) => String(r.restaurant_id ?? r.id) === restaurantIdKey) || null;
            this.data.currentShift = this.enrichEmployeeShiftRecord(
                {
                    id: result?.shift_id,
                    restaurant_id: restaurantId,
                    restaurant: restaurantRecord ? { id: restaurantId, ...restaurantRecord } : null,
                    start_time: new Date().toISOString(),
                    state: 'activo',
                    visit_type: 'ad_hoc',
                },
                this.data.employee.dashboard
            );
            this.data.currentScheduledShift = null;

            this.showToast('Visita iniciada. Continúa con las fotos iniciales.', {
                tone: 'success',
                title: 'Visita en curso',
            });
            // Refrescar dashboard (para que active_shift venga del backend)
            // y navegar directo a fotos iniciales.
            await this.loadEmployeeDashboard(true).catch(() => null);
            this.navigate('employee-shift-start');
        } catch (error) {
            console.error('[visit-adhoc] failed', error, error?.payload);
            this.showToast(this.getErrorMessage(error, 'No fue posible iniciar la visita.'), {
                tone: 'error',
                title: 'Error al iniciar',
            });
        } finally {
            this.hideLoading();
        }
    },

    filterEmployeeTasksByKnownShifts(tasks = []) {
        // Post-migracion Visitas: este filtro descarta tareas cuyo
        // restaurant_id no este en el scope "conocido" (scheduled_shifts +
        // assigned_restaurants). Bug reportado: si a un contratista se le
        // asigna una tarea en un sitio nuevo donde nunca tuvo shift ni
        // asignacion previa (henrry en Motosmart), la tarea queda invisible
        // aunque el backend list_my_open la haya devuelto.
        //
        // Con visitas ad-hoc el contratista puede tener tarea en cualquier
        // sitio, y el backend ya filtra por usuario. Confiamos y mostramos
        // todo lo que list_my_open / pending_tasks_preview devuelve.
        return asArray(tasks);
    },

    getEmployeeTaskRestaurantRecord(task, dashboard = this.data.employee.dashboard || {}) {
        const taskRestaurant = task?.restaurant && typeof task.restaurant === 'object' ? task.restaurant : null;
        if (taskRestaurant && getRestaurantRecordId(taskRestaurant) != null) {
            return taskRestaurant;
        }

        const restaurantId = String(
            task?.restaurant_id ||
                task?.restaurant?.restaurant_id ||
                task?.restaurant?.id ||
                task?.meta?.restaurant_id ||
                task?.metadata?.restaurant_id ||
                ''
        ).trim();

        if (!restaurantId) {
            return null;
        }

        return this.resolveEmployeeRestaurantRecord(restaurantId, dashboard) || taskRestaurant || null;
    },

    getEmployeeTaskRestaurantName(task, dashboard = this.data.employee.dashboard || {}) {
        const restaurant = this.getEmployeeTaskRestaurantRecord(task, dashboard);
        if (restaurant) {
            return getRestaurantDisplayName(restaurant, '');
        }

        return String(task?.restaurant_name || '').trim();
    },

    isRestaurantScopedTask(task) {
        return task?.task_scope === 'restaurant';
    },

    getEmployeeRestaurantOpenTasks() {
        // Solo mostrar tareas del sitio al que pertenece el turno visible (activo o próximo agendado).
        // Si no hay ningún turno visible, no debe mostrarse ninguna tarea de restaurante.
        const activeRestaurantId = String(
            this.data.currentShift?.restaurant_id ||
                this.data.currentShift?.restaurant?.id ||
                this.data.currentScheduledShift?.restaurant_id ||
                this.data.currentScheduledShift?.restaurant?.id ||
                ''
        ).trim();

        if (!activeRestaurantId) {
            return [];
        }

        return (this.data.employee.openTasks || []).filter((task) => {
            if (!this.isRestaurantScopedTask(task)) return false;
            const taskRestaurantId = String(
                task?.restaurant_id ||
                    task?.restaurant?.restaurant_id ||
                    task?.restaurant?.id ||
                    task?.meta?.restaurant_id ||
                    task?.metadata?.restaurant_id ||
                    ''
            ).trim();
            return taskRestaurantId && taskRestaurantId === activeRestaurantId;
        });
    },

    getVisibleEmployeeTasks(dashboard = this.data.employee.dashboard || {}) {
        const shiftOnly = (tasks) => tasks.filter((t) => !this.isRestaurantScopedTask(t));
        const filteredOpenTasks = shiftOnly(
            this.filterEmployeeTasksByKnownShifts(this.data.employee.openTasks, dashboard)
        );
        if (filteredOpenTasks.length > 0) {
            return filteredOpenTasks;
        }

        return shiftOnly(this.filterEmployeeTasksByKnownShifts(asArray(dashboard?.pending_tasks_preview), dashboard));
    },

    async loadEmployeeProfile(force = false) {
        if (!this.data.employee.dashboard || force) {
            await this.loadEmployeeDashboard(force);
        }

        if (
            !force &&
            this.data.employee.hoursHistory &&
            this.isCacheFresh('employeeHoursHistory', CACHE_TTLS.employeeHoursHistory)
        ) {
            this.renderEmployeeProfile();
            return this.data.employee.hoursHistory;
        }

        const history = await this.runPending('employeeHoursHistory', async () => {
            const nextHistory = await apiClient.getEmployeeHoursHistory({
                period_start: toInputDate(getMonthStart()),
                period_end: toInputDate(new Date()),
                limit: 120,
            });
            this.data.employee.hoursHistory = nextHistory;
            this.touchCache('employeeHoursHistory');
            return nextHistory;
        });

        this.data.employee.hoursHistory = history;
        this.renderEmployeeProfile();
        return history;
    },

    renderEmployeeProfileTasks(tasks) {
        const container = document.getElementById('profile-special-tasks-list');
        if (!container) {
            return;
        }

        if (!tasks || tasks.length === 0) {
            const card = document.createElement('div');
            card.className = 'task-card';
            const copy = document.createElement('p');
            copy.textContent = 'No hay tareas especiales pendientes.';
            card.appendChild(copy);
            container.replaceChildren(card);
            return;
        }

        const fragment = document.createDocumentFragment();
        tasks.forEach((task) => {
            const status = task.status || 'pendiente';
            const dueText = task.due_at ? `Entrega: ${formatDateTime(task.due_at)}` : 'Sin fecha límite';
            const restaurantName = this.getEmployeeTaskRestaurantName(task, this.data.employee.dashboard || {});

            const card = document.createElement('div');
            card.className = 'task-card';

            const title = document.createElement('h4');
            const icon = document.createElement('i');
            icon.className = 'fas fa-star';
            title.append(icon, document.createTextNode(` ${task.title || 'Tarea especial'}`));

            const statusWrap = document.createElement('p');
            const badge = document.createElement('span');
            badge.className = `badge ${getBadgeClass(status)}`;
            badge.textContent = status;
            statusWrap.appendChild(badge);

            const observations = document.createElement('div');
            observations.className = 'task-observations';
            const detailsLabel = document.createElement('strong');
            detailsLabel.textContent = 'Detalle:';
            const detailsCopy = document.createElement('p');
            detailsCopy.className = 'task-observations-copy';
            detailsCopy.textContent = [task.description || dueText, restaurantName ? `Cliente: ${restaurantName}` : '']
                .filter(Boolean)
                .join(' ');
            observations.append(detailsLabel, detailsCopy);

            card.append(title, statusWrap, observations);
            fragment.appendChild(card);
        });

        container.replaceChildren(fragment);
    },

    getPrimaryEmployeeTask() {
        const visibleTasks = this.getVisibleEmployeeTasks(this.data.employee.dashboard);
        return visibleTasks[0] || null;
    },

    async openEmployeeShiftStart() {
        this.showLoading(t('toast.verifying.service'), t('toast.verifying.service.desc'));

        try {
            await this.loadEmployeeDashboard(true);
            const hasActiveShift = Boolean(this.data.currentShift?.id);

            if (!hasActiveShift) {
                this.showToast('No tienes un servicio activo. Inicia una visita desde el sitio disponible.', {
                    tone: 'warning',
                    title: t('toast.service.unavailable'),
                });
                this.navigate('employee-dashboard');
                return;
            }

            // Post-migracion Visitas: si hay visita activa, saltarnos la
            // pantalla shift-start (GPS + salud) porque ya se firmaron al
            // iniciar la visita ad-hoc. Vamos directo a donde el usuario esta:
            //   - cleaning (cronometro) si ya subio las fotos iniciales.
            //   - photos si aun le faltan (para retomar el flujo desde ahi).
            // Hidratar summary del backend para decidir bien.
            if (typeof this.hydrateShiftEvidenceSummary === 'function') {
                await this.hydrateShiftEvidenceSummary(this.data.currentShift).catch(() => null);
            }
            const goToCleaning = this.shouldResumeActiveShiftInCleaning(this.data.currentShift);
            this.navigate(goToCleaning ? 'employee-shift-cleaning' : 'employee-shift-photos');
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible validar tu servicio actual.'), {
                tone: 'error',
                title: t('toast.cannot.continue'),
            });
        } finally {
            this.hideLoading();
        }
    },

    syncShiftCompletionTaskCard() {
        const card = document.getElementById('shift-special-task-card');
        const title = document.getElementById('shift-special-task-title');
        const detail = document.getElementById('shift-special-task-detail');
        const requirement = document.getElementById('shift-special-task-requirement');
        const evidenceSection = document.getElementById('special-task-evidence-section');
        const checkbox = document.getElementById('special-task-done');
        const toggle = card?.querySelector('.shift-complete-special-task-toggle') || null;
        const notes = document.getElementById('special-task-notes');
        const task = this.getPrimaryEmployeeTask();

        if (!card) {
            return;
        }

        if (!task) {
            card.classList.add('hidden');
            card.classList.remove('requires-evidence', 'notes-required', 'evidence-pending');
            evidenceSection?.classList.add('hidden');
            if (checkbox) {
                checkbox.checked = false;
                checkbox.disabled = false;
            }
            toggle?.classList.remove('checkbox-disabled');
            if (notes) {
                notes.value = '';
            }
            if (requirement) {
                requirement.textContent = 'Marca la casilla cuando la tarea esté completada.';
            }
            return;
        }

        card.classList.remove('hidden');

        const requiresEvidence = task.requires_evidence === true;
        const notesRequired = task.notes_required === true;
        const hasTaskEvidence =
            Boolean(this.specialTaskEvidenceFile) || Object.keys(this.endPhotoFiles || {}).length > 0;
        const lockCompletionCheck = requiresEvidence && !hasTaskEvidence;
        card.classList.toggle('requires-evidence', requiresEvidence);
        card.classList.toggle('notes-required', notesRequired);
        card.classList.toggle('evidence-pending', lockCompletionCheck);
        evidenceSection?.classList.remove('hidden');
        this.updateSpecialTaskEvidenceUI();

        if (checkbox) {
            if (lockCompletionCheck) {
                checkbox.checked = false;
            }
            checkbox.disabled = lockCompletionCheck;
        }

        if (toggle) {
            toggle.classList.toggle('checkbox-disabled', lockCompletionCheck);
            toggle.title = lockCompletionCheck
                ? 'Adjunta evidencia de tarea (o una foto final) para habilitar esta confirmación.'
                : '';
        }

        if (title) {
            title.textContent = task.title || task.name || 'Tarea especial asignada';
        }

        if (detail) {
            const details = [];
            const restaurantName = this.getEmployeeTaskRestaurantName(task, this.data.employee.dashboard || {});
            if (task.description) {
                details.push(task.description);
            }
            if (restaurantName) {
                details.push(`Aplica para ${restaurantName}.`);
            }
            const shiftOpenTasks = (this.data.employee.openTasks || []).filter((t) => !this.isRestaurantScopedTask(t));
            if (shiftOpenTasks.length > 1) {
                details.push(
                    `Hay ${shiftOpenTasks.length} tareas abiertas; se intentarán cerrar todas con este registro.`
                );
            }
            detail.textContent = details.join(' ') || 'Confirma el estado de la tarea asignada antes de finalizar.';
        }

        if (requirement) {
            const requirements = [];
            if (requiresEvidence) {
                if (lockCompletionCheck) {
                    requirements.push(
                        'Toma una foto de evidencia o adjunta una foto final para habilitar la confirmación de tarea.'
                    );
                } else {
                    requirements.push('Debes adjuntar evidencia fotográfica para completar la tarea.');
                }
            }
            if (notesRequired) {
                requirements.push('Las observaciones son obligatorias para cerrar esta tarea.');
            }
            requirement.textContent = requirements.join(' ') || 'Marca la casilla cuando la tarea esté completada.';
        }
    },

    async prepareEmployeeShiftStart() {
        if (!this.data.employee.dashboard) {
            await this.loadEmployeeDashboard();
        }

        let hasActiveShift = Boolean(this.data.currentShift?.id);
        if (hasActiveShift) {
            await this.refreshCurrentActiveShift();
            await this.hydrateShiftEvidenceSummary(this.data.currentShift);
            hasActiveShift = Boolean(this.data.currentShift?.id);
        }

        // Post-migracion Visitas: solo llegamos a la pantalla shift-start si hay
        // una visita activa. El card "Sitio disponible" del dashboard inicia
        // visitas ad-hoc y navega aca directamente cuando el backend responde.
        const shift = this.enrichEmployeeShiftRecord(
            this.data.currentShift,
            this.data.employee.dashboard
        );
        if (!shift || !hasActiveShift) {
            this.showToast('No tienes un servicio activo. Inicia una visita desde el sitio disponible.', {
                tone: 'warning',
                title: t('toast.service.unavailable'),
            });
            this.navigate('employee-dashboard');
            return;
        }

        this.data.currentShift = shift;

        const restaurant =
            shift?.restaurant ||
            this.resolveEmployeeRestaurantRecord(shift?.restaurant_id, this.data.employee.dashboard) ||
            null;
        const button = document.getElementById('continue-btn');

        void this.primeEmployeeWorkspacePermissions();

        this.setCleaningAreas(
            this.resolveCleaningAreas(
                restaurant,
                this.data.currentShift?.restaurant,
                this.data.currentScheduledShift?.restaurant
            ),
            this.resolveCleaningAreaGroups(
                restaurant,
                this.data.currentShift?.restaurant,
                this.data.currentScheduledShift?.restaurant
            )
        );

        // Los ids shift-start-restaurant / shift-start-schedule se quitaron
        // de la pantalla de Iniciar Servicio (la info se ve en el dashboard).
        // Optional chaining para no explotar si vuelve a montarse.
        const shiftStartRestaurantNode = document.getElementById('shift-start-restaurant');
        if (shiftStartRestaurantNode) {
            shiftStartRestaurantNode.textContent = this.getResolvedShiftRestaurantName(
                { ...shift, restaurant },
                hasActiveShift ? 'Sitio del servicio activo' : 'Sitio del servicio asignado'
            );
        }
        const shiftStartScheduleNode = document.getElementById('shift-start-schedule');
        if (shiftStartScheduleNode) {
            shiftStartScheduleNode.textContent = this.getEmployeeShiftScheduleText(shift, {
                hasActiveShift,
            });
        }

        if (button) {
            // Si ya se subieron las fotos iniciales al backend, el boton lleva
            // directo al cronometro (cleaning). Si no, lleva a la pantalla de
            // fotos para completarlas. Antes iba siempre a fotos, obligando
            // al contratista a "retomar" un paso que ya termino.
            const goToCleaning = hasActiveShift && this.shouldResumeActiveShiftInCleaning(shift);
            button.dataset.args = goToCleaning ? 'employee-shift-cleaning' : 'employee-shift-photos';
            button.innerHTML = hasActiveShift
                ? goToCleaning
                    ? 'Continuar con el Servicio Activo <i class="fas fa-arrow-right"></i>'
                    : 'Completar Fotos Iniciales <i class="fas fa-camera"></i>'
                : 'Registrar Inicio y Continuar <i class="fas fa-arrow-right"></i>';
        }

        const gpsButton = document.getElementById('gps-btn');
        const gpsStatus = document.getElementById('gps-status');

        // Reusar ubicación fresca del dashboard: si ya se capturó hace poco
        // (< 2 min), no hacer que el usuario la verifique otra vez. Un fix
        // GPS reciente sigue siendo valido para el matching de sitio.
        const FRESH_LOCATION_MS = 2 * 60 * 1000;
        const locationAgeMs = Number.isFinite(this.locationTimestamp)
            ? Date.now() - this.locationTimestamp
            : Infinity;
        const hasFreshLocation =
            Number.isFinite(this.location?.lat) &&
            Number.isFinite(this.location?.lng) &&
            locationAgeMs < FRESH_LOCATION_MS;

        if (hasFreshLocation) {
            this.gpsVerified = true;
            if (gpsStatus) {
                gpsStatus.className = 'gps-status valid';
                gpsStatus.innerHTML = '<i class="fas fa-check-circle"></i><span>Ubicación verificada</span>';
            }
            if (gpsButton) {
                gpsButton.disabled = false;
                gpsButton.innerHTML = '<i class="fas fa-check"></i> Verificada';
            }
        } else {
            this.gpsVerified = false;
            if (gpsStatus) {
                gpsStatus.className = 'gps-status invalid';
                gpsStatus.innerHTML =
                    '<i class="fas fa-location-crosshairs"></i><span>Ubicación lista para verificar</span>';
            }
            if (gpsButton) {
                gpsButton.disabled = false;
                gpsButton.innerHTML = '<i class="fas fa-location-crosshairs"></i> Verificar ubicación';
            }
        }

        this.checkCanContinue();
    },


    async uploadShiftEvidenceBatch(type, filesMap, uploadedMap) {
        const entries = Object.entries(filesMap).filter(([area, file]) => file && !uploadedMap[area]);
        const shiftId = this.data.currentShift?.id;

        if (!shiftId) {
            throw new Error('No hay un servicio activo para adjuntar evidencias.');
        }

        if (entries.length === 0) return;

        // Evidencia también trae lat/lng al finalize; usamos GPS fresco de alta
        // precisión para no marcar la foto con coords stale de otro sitio.
        const location = await this.captureLocation({ updateUi: false, highAccuracy: true });

        await Promise.all(
            entries.map(async ([area, file]) => {
                const compressed = await this.compressImage(file);
                const mimeType = this.getEvidenceFileContentType(compressed) || 'image/jpeg';
                const requestUpload = await apiClient.requestShiftEvidenceUpload(shiftId, type, mimeType);

                const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
                const path = requestUpload?.path || requestUpload?.upload?.path;

                if (!signedUrl || !path) {
                    throw new Error('No fue posible preparar la subida de la foto.');
                }

                await apiClient.uploadToSignedUrl(signedUrl, compressed, mimeType);

                const slot = this.getPhotoSlotDefinition(area, 'start');
                const areaMeta = buildAreaMeta(slot?.groupLabel || area);
                const finalizePayload = await apiClient.finalizeShiftEvidenceUpload({
                    shift_id: shiftId,
                    type,
                    path,
                    lat: location.lat,
                    lng: location.lng,
                    accuracy: Math.round(location.accuracy || 0),
                    captured_at: new Date().toISOString(),
                    meta: {
                        ...areaMeta,
                        subarea_key: normalizeAreaToken(slot?.subareaLabel || area),
                        subarea_label: slot?.subareaLabel || area,
                        photo_label: slot?.title || area,
                    },
                });
                this.recordShiftRequestTrace(
                    'finalize_upload',
                    this.extractRequestId(finalizePayload, apiClient.lastResponseMeta),
                    this.data.currentShift
                );
                uploadedMap[area] = true;
            })
        );
    },

    async completeShiftStartPhotos() {
        if (this.getEmployeeSelectedAreas().length === 0) {
            this.showToast(t('toast.select.areas.first'), {
                tone: 'warning',
                title: t('toast.select.areas'),
            });
            return;
        }

        const requireStartPhotos = this.getSystemSetting(
            'evidence.require_start_photos',
            DEFAULT_SYSTEM_SETTINGS.evidence.require_start_photos
        );
        const progress = this.getStartEvidenceProgressSnapshot(this.data.currentShift);
        if (requireStartPhotos && progress.remainingCount > 0) {
            const isActiveShift = Boolean(this.data.currentShift?.id);
            const message = isActiveShift
                ? `Faltan ${progress.remainingCount} evidencia(s) inicial(es) para continuar con el servicio activo.`
                : 'Debes tomar las fotos iniciales de todas las subáreas requeridas.';
            this.showToast(message, {
                tone: 'warning',
                title: t('toast.evidence.missing'),
            });
            return;
        }

        if (progress.newEvidenceCount === 0) {
            const requireBackendStartEvidence = requireStartPhotos && Boolean(this.data.currentShift?.id);
            if (requireBackendStartEvidence) {
                try {
                    const summaryPayload = await apiClient.getShiftEvidenceSummary(this.data.currentShift.id);
                    const summary = this.normalizeShiftEvidenceSummary(summaryPayload);
                    const requiredStartEvidenceCount = Number(
                        this.data.currentShift?.required_start_evidence_count ??
                            this.data.currentShift?.requiredStartEvidenceCount ??
                            this.employeePhotoSlots.length
                    );
                    const backendStartCount = Number(summary?.start_evidence_count || 0);
                    const hasEnoughStartEvidence =
                        Number.isFinite(requiredStartEvidenceCount) && requiredStartEvidenceCount > 0
                            ? backendStartCount >= requiredStartEvidenceCount
                            : summary?.has_start_evidence === true;

                    if (!hasEnoughStartEvidence) {
                        const missingCount =
                            Number.isFinite(requiredStartEvidenceCount) && requiredStartEvidenceCount > 0
                                ? Math.max(requiredStartEvidenceCount - backendStartCount, 0)
                                : 0;
                        const missingCopy =
                            missingCount > 0
                                ? `Faltan ${missingCount} foto(s) inicial(es) por registrar.`
                                : 'Aún faltan fotos iniciales por registrar.';
                        this.showToast(`${missingCopy} Toma las fotos de inicio antes de continuar.`, {
                            tone: 'warning',
                            title: t('toast.evidence.initial.incomplete'),
                        });
                        return;
                    }

                    this.data.currentShift = this.mergeShiftEvidenceSummary(this.data.currentShift, summary);
                } catch (summaryError) {
                    console.warn(
                        'No fue posible validar summary_by_shift antes de continuar a limpieza.',
                        summaryError
                    );
                }
            }

            this.navigate('employee-shift-cleaning');
            return;
        }

        this.showLoading(t('toast.uploading.images'), t('toast.wait.short'));

        try {
            // OTP se pide solo al login; el token queda vigente mientras dure la sesión.
            // Si el token expiró/se limpió (típico tras 12h o refresh), envolvemos con
            // auto-retry: modal OTP → nuevo token → reintenta el upload completo.
            const uploadStart = () =>
                this.uploadShiftEvidenceBatch('inicio', this.photoFiles, this.uploadedStartAreas);
            try {
                await uploadStart();
            } catch (firstError) {
                if (this.isOtpSessionError?.(firstError)) {
                    await this.retryWithFreshOtp(uploadStart, { purpose: 'evidence_upload' });
                } else {
                    throw firstError;
                }
            }
            await this.hydrateShiftEvidenceSummary(this.data.currentShift);
            this.persistCurrentShiftAreaSelection();
            this.navigate('employee-shift-cleaning');
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible subir las fotos de inicio.'), {
                tone: 'error',
                title: t('toast.cannot.continue'),
            });
        } finally {
            this.hideLoading();
        }
    },

    updateCleaningUI() {
        const shift = this.data.currentShift || this.data.currentScheduledShift;
        const restaurantElement = document.getElementById('cleaning-restaurant');
        if (restaurantElement) {
            restaurantElement.textContent = this.getResolvedShiftRestaurantName(shift, 'Servicio activo');
        }
        // Re-render de tareas del sitio: cuando el user llega a cleaning con turno
        // activo, las cards se mueven de la superficie dashboard a esta.
        this.renderEmployeeRestaurantTasks();
    },

    navigateToShiftCompletion() {
        this.restoreCurrentShiftAreaSelection({
            fallbackToAllAvailable: Boolean(this.data.currentShift?.id),
        });
        // Al entrar a "Evidencias de Cierre", posicionar la zona activa en la
        // PRIMERA de la lista (antes quedaba en la ultima seleccionada del
        // flujo de inicio, obligando al user a scrollear/hacer click atras).
        const areas = this.getEmployeeSelectedAreas();
        if (areas.length > 0 && typeof this.setEmployeeActiveArea === 'function') {
            this.setEmployeeActiveArea(areas[0]);
        }
        this.syncShiftCompletionTaskCard();
        this.navigate('employee-shift-complete');
    },

    prepareShiftSummary() {
        if (this.getEmployeeSelectedAreas().length === 0) {
            this.restoreCurrentShiftAreaSelection({
                fallbackToAllAvailable: Boolean(this.data.currentShift?.id),
            });
        }

        if (this.getEmployeeSelectedAreas().length === 0) {
            this.showToast(t('toast.complete.select.first'), {
                tone: 'warning',
                title: t('toast.select.areas'),
            });
            return;
        }

        const requireEndPhotos = this.getSystemSetting(
            'evidence.require_end_photos',
            DEFAULT_SYSTEM_SETTINGS.evidence.require_end_photos
        );
        if (requireEndPhotos && Object.keys(this.endPhotoFiles).length < this.employeePhotoSlots.length) {
            this.showToast(t('toast.complete.evidence.missing'), {
                tone: 'warning',
                title: t('toast.evidence.missing'),
            });
            return;
        }

        const openTasks = (this.data.employee.openTasks || []).filter((task) => !this.isRestaurantScopedTask(task));
        const hasEvidenceRequiredTask = openTasks.some((task) => task?.requires_evidence === true);
        const completionCheckRequired = this.getSystemSetting(
            'tasks.require_special_task_completion_check',
            DEFAULT_SYSTEM_SETTINGS.tasks.require_special_task_completion_check
        );
        const taskCompletionConfirmed = document.getElementById('special-task-done')?.checked === true;
        const evidenceWillBeRequired = hasEvidenceRequiredTask && (taskCompletionConfirmed || completionCheckRequired);
        const hasTaskEvidence = Boolean(this.specialTaskEvidenceFile) || Object.keys(this.endPhotoFiles).length > 0;

        if (evidenceWillBeRequired && !hasTaskEvidence) {
            this.showToast(
                'La tarea especial requiere evidencia. Toma una foto de evidencia o adjunta una foto final antes de continuar.',
                {
                    tone: 'warning',
                    title: t('toast.evidence.required'),
                }
            );
            return;
        }

        this.syncShiftCompletionTaskCard();

        this.restoreCurrentShiftAreaSelection({
            fallbackToAllAvailable: Boolean(this.data.currentShift?.id),
        });

        const shift = this.data.currentShift || this.data.currentScheduledShift;
        const summaryShift = this.enrichEmployeeShiftRecord(shift, this.data.employee.dashboard || {}) || shift;
        const restaurant = this.getEmployeeShiftRestaurantRecord(summaryShift, this.data.employee.dashboard || {});
        const durationHours =
            getScheduledHours(summaryShift) || getScheduledHours(this.data.currentScheduledShift) || 0;
        const scheduledEndSource =
            summaryShift?.scheduled_end || this.data.currentScheduledShift?.scheduled_end || null;
        const scheduledEnd = scheduledEndSource ? new Date(scheduledEndSource) : null;
        const summaryReferenceDate = summaryShift?.scheduled_start || summaryShift?.start_time || null;
        const isEarlyEnd = Boolean(
            scheduledEnd && !Number.isNaN(scheduledEnd.getTime()) && scheduledEnd.getTime() > Date.now()
        );
        const earlyEndCard = document.getElementById('shift-early-end-card');
        const earlyEndReasonInput = document.getElementById('early-end-reason');

        const setSummaryText = (id, value) => {
            const node = document.getElementById(id);
            if (node) node.textContent = value;
        };
        setSummaryText('summary-duration', formatHours(durationHours));
        setSummaryText(
            'summary-photos',
            String(
                Object.keys(this.photoFiles).length +
                    Object.keys(this.endPhotoFiles).length +
                    (this.specialTaskEvidenceFile ? 1 : 0)
            )
        );
        setSummaryText(
            'summary-restaurant',
            this.getEmployeeResolvedShiftRestaurantName({ ...summaryShift, restaurant }, 'Sitio asignado')
        );
        // Post-migracion Visitas: mostramos la hora de inicio real de la visita
        // en zona local del sitio. Sin agendamiento, "Ventana" y "Fecha" son
        // redundantes (todo pasa hoy y no hay ventana programada).
        const startedAtRaw =
            summaryShift?.local?.start?.local_time ||
            (summaryShift?.start_time || summaryShift?.started_at
                ? formatDateTime(summaryShift.start_time || summaryShift.started_at)
                : '-');
        setSummaryText('summary-started-at', startedAtRaw);

        if (earlyEndCard) {
            earlyEndCard.classList.remove('hidden');
        }

        if (earlyEndReasonInput) {
            earlyEndReasonInput.placeholder = isEarlyEnd
                ? 'Observaciones (obligatorio)'
                : 'Observaciones (opcional)';
        }

        // Buffer para adjuntos multimedia de observaciones. Sobrevive re-renders.
        this._observationsAttachments = this._observationsAttachments || [];
        this.bindObservationsAttachmentsOnce();
        this.renderObservationsAttachments();

        this.navigate('employee-shift-summary');
    },

    bindObservationsAttachmentsOnce() {
        const input = document.getElementById('shift-observations-file');
        if (!input || input.dataset.observationsBound === '1') return;
        input.dataset.observationsBound = '1';

        input.addEventListener('change', () => {
            const files = Array.from(input.files || []);
            if (files.length === 0) return;
            this._observationsAttachments = [...(this._observationsAttachments || []), ...files];
            input.value = '';
            this.renderObservationsAttachments();
        });

        const container = document.getElementById('shift-observations-attachments');
        if (container && !container.dataset.observationsDelegation) {
            container.dataset.observationsDelegation = '1';
            container.addEventListener('click', (event) => {
                const btn = event.target.closest('[data-observations-action="remove"]');
                if (!btn) return;
                const index = Number(btn.dataset.index);
                if (Number.isFinite(index) && this._observationsAttachments) {
                    this._observationsAttachments.splice(index, 1);
                    this.renderObservationsAttachments();
                }
            });
        }
    },

    renderObservationsAttachments() {
        const wrap = document.getElementById('shift-observations-attachments');
        if (!wrap) return;
        const files = this._observationsAttachments || [];
        const label = document.getElementById('shift-observations-file-label');
        const textSpan = label?.querySelector('.rtask-file-label-text');

        if (files.length === 0) {
            wrap.innerHTML = '';
            if (textSpan) textSpan.textContent = 'Agregar foto o video';
            label?.classList.remove('rtask-file-label-has-file');
            return;
        }

        if (textSpan) textSpan.textContent = `Agregar otra (${files.length})`;
        label?.classList.add('rtask-file-label-has-file');

        wrap.innerHTML = files
            .map((file, index) => {
                const isVideo = String(file.type || '').startsWith('video/');
                const icon = isVideo ? 'fa-video' : 'fa-image';
                const shortName = file.name.length > 22 ? `${file.name.slice(0, 22)}…` : file.name;
                const sizeMb = Math.round((file.size / (1024 * 1024)) * 10) / 10;
                return `<div class="rtask-attachment-item">
                    <i class="fas ${icon}"></i>
                    <span class="rtask-attachment-name">${escapeHtml(shortName)}</span>
                    <span class="rtask-attachment-size">${sizeMb} MB</span>
                    <button type="button" class="rtask-attachment-remove" data-observations-action="remove" data-index="${index}" aria-label="Quitar adjunto">
                        <i class="fas fa-times"></i>
                    </button>
                </div>`;
            })
            .join('');
    },

    async uploadObservationAttachments(shiftId, location) {
        const files = this._observationsAttachments || [];
        if (files.length === 0 || !shiftId) return [];
        const uploaded = [];
        for (const file of files) {
            const rawType = String(file.type || '').toLowerCase();
            const mime = rawType || (rawType.startsWith('video/') ? 'video/mp4' : 'image/jpeg');
            const requestUpload = await apiClient.requestShiftEvidenceUpload(shiftId, 'fin', mime);
            const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
            const path = requestUpload?.path || requestUpload?.upload?.path;
            if (!signedUrl || !path) throw new Error('No fue posible preparar la subida del adjunto.');
            await apiClient.uploadToSignedUrl(signedUrl, file, mime);
            try {
                await apiClient.finalizeShiftEvidenceUpload({
                    shift_id: shiftId,
                    type: 'fin',
                    path,
                    lat: location?.lat,
                    lng: location?.lng,
                    accuracy: Math.round(location?.accuracy || 0),
                    captured_at: new Date().toISOString(),
                    meta: {
                        source: 'observations',
                        content_kind: rawType.startsWith('video/') ? 'video' : 'photo',
                    },
                });
            } catch (finalizeError) {
                console.warn('No fue posible finalizar el adjunto de observaciones.', finalizeError);
            }
            uploaded.push(path);
        }
        return uploaded;
    },

    async uploadTaskEvidence(taskId, file) {
        const rawType = String(file?.type || '').toLowerCase();
        const isVideo = rawType.startsWith('video/');
        const isImage = this.isSupportedEvidenceImageFile(file);
        if (!isVideo && !isImage) {
            throw new Error('Formato no soportado. Usa una imagen (JPG/PNG/WebP/HEIC) o un video (MP4/MOV/WebM).');
        }

        const mimeType = isVideo
            ? rawType || 'video/mp4'
            : this.getEvidenceFileContentType(file) || 'image/jpeg';
        const numericTaskId = Number(taskId);
        const requestUpload = await apiClient.operationalTasksManage('request_evidence_upload', {
            task_id: Number.isFinite(numericTaskId) ? numericTaskId : taskId,
            mime_type: mimeType,
            evidence_type: isVideo ? 'video' : 'photo',
        });

        const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
        const path = requestUpload?.path || requestUpload?.upload?.path;

        if (!signedUrl || !path) {
            throw new Error('No fue posible preparar la subida de la evidencia de la tarea.');
        }

        await apiClient.uploadToSignedUrl(signedUrl, file, mimeType);
        return path;
    },

    async resolveOpenEmployeeTasks(notes) {
        const tasks = (this.data.employee.openTasks || []).filter((t) => !this.isRestaurantScopedTask(t));
        if (tasks.length === 0) {
            return;
        }

        const checkbox = document.getElementById('special-task-done');
        const confirmed = checkbox?.checked === true;
        const requireTaskCompletion = this.getSystemSetting(
            'tasks.require_special_task_completion_check',
            DEFAULT_SYSTEM_SETTINGS.tasks.require_special_task_completion_check
        );

        if (!confirmed && requireTaskCompletion) {
            throw new Error('Debes confirmar la tarea especial antes de finalizar el servicio.');
        }

        if (!confirmed) {
            return;
        }

        await Promise.all(
            tasks.map(async (task) => {
                const rawTaskId = task.task_id || task.id;
                const numericTaskId = Number(rawTaskId);
                if (!Number.isFinite(numericTaskId)) {
                    return;
                }

                if (task.notes_required === true && !notes) {
                    throw new Error('Esta tarea requiere observaciones antes de finalizar.');
                }

                if (task.requires_evidence === true) {
                    const file = this.specialTaskEvidenceFile || Object.values(this.endPhotoFiles)[0];
                    if (!file) {
                        throw new Error(
                            'La tarea requiere evidencia. Toma una foto de evidencia o adjunta una foto final antes de terminar.'
                        );
                    }

                    const evidencePath = await this.uploadTaskEvidence(numericTaskId, file);
                    await apiClient.operationalTasksManage('complete', {
                        task_id: numericTaskId,
                        evidence_path: evidencePath,
                        notes,
                    });
                    return;
                }

                await apiClient.operationalTasksManage('close', {
                    task_id: numericTaskId,
                    notes,
                });
            })
        );
    },

    async finalizeShift() {
        if (!this.data.currentShift?.id) {
            this.showToast(t('toast.no.active.service'), {
                tone: 'warning',
                title: t('toast.no.active.service.title'),
            });
            return;
        }

        this.showLoading(t('toast.uploading.images'), t('toast.wait.short'));
        const startEvidencePrecheck = {
            status: 'not-run',
            has_start_evidence: null,
            request_id: '',
        };

        try {
            // OTP se pide solo al login; el token queda vigente mientras dure la sesión.
            // Si expira mid-servicio, el catch de performEndShiftRequest hace auto-retry.
            const requireStartPhotos = this.getSystemSetting(
                'evidence.require_start_photos',
                DEFAULT_SYSTEM_SETTINGS.evidence.require_start_photos
            );

            const precheckPromise = requireStartPhotos
                ? apiClient
                      .getShiftEvidenceSummary(this.data.currentShift.id)
                      .then((summaryPayload) => {
                          startEvidencePrecheck.status = 'ok';
                          startEvidencePrecheck.request_id = this.extractRequestId(
                              summaryPayload,
                              apiClient.lastResponseMeta
                          );
                          this.recordShiftRequestTrace(
                              'summary_by_shift',
                              startEvidencePrecheck.request_id,
                              this.data.currentShift
                          );
                          const summary = this.normalizeShiftEvidenceSummary(summaryPayload);
                          startEvidencePrecheck.has_start_evidence = Boolean(summary?.has_start_evidence);
                          if (!summary.has_start_evidence) startEvidencePrecheck.status = 'mismatch';
                      })
                      .catch((summaryError) => {
                          startEvidencePrecheck.status = 'error';
                          startEvidencePrecheck.request_id = this.extractRequestId(
                              summaryError,
                              apiClient.lastResponseMeta
                          );
                          this.recordShiftRequestTrace(
                              'summary_by_shift',
                              startEvidencePrecheck.request_id,
                              this.data.currentShift
                          );
                          console.warn(
                              'No fue posible validar summary_by_shift antes de finalizar el servicio.',
                              summaryError
                          );
                      })
                : Promise.resolve();

            // shifts_end también valida GPS_OUT_OF_RANGE — GPS fresco de alta precisión.
            const location = await this.captureLocation({ updateUi: false, highAccuracy: true });
            const notes = document.getElementById('special-task-notes')?.value?.trim() || 'Sin incidentes';
            const earlyEndReasonInput = document.getElementById('early-end-reason');
            const enrichedShift = this.enrichEmployeeShiftRecord(
                this.data.currentShift,
                this.data.employee.dashboard || {}
            );
            if (enrichedShift?.id) {
                this.data.currentShift = enrichedShift;
            }

            const scheduledEndSource =
                this.data.currentShift?.scheduled_end || this.data.currentScheduledShift?.scheduled_end || null;
            const scheduledEnd = scheduledEndSource ? new Date(scheduledEndSource) : null;
            const earlyEndReasonRaw = earlyEndReasonInput?.value?.trim() || '';
            const requiresEarlyEndReason = Boolean(scheduledEnd && scheduledEnd.getTime() > Date.now());
            // Backend contract: si viene early_end_reason, exige >=3 caracteres.
            // Validamos aca para no mandar y recibir "String must contain at
            // least 3 character(s)" crudo del servidor.
            const MIN_REASON_LEN = 3;
            if (earlyEndReasonRaw && earlyEndReasonRaw.length < MIN_REASON_LEN) {
                this.hideLoading();
                this.showToast(
                    `Las observaciones deben tener al menos ${MIN_REASON_LEN} caracteres. Escribe una descripción más completa o deja el campo vacío.`,
                    {
                        tone: 'warning',
                        title: 'Observaciones muy cortas',
                    }
                );
                earlyEndReasonInput?.focus();
                return;
            }
            const earlyEndReason = earlyEndReasonRaw || undefined;

            if (requiresEarlyEndReason && !earlyEndReason) {
                this.hideLoading();
                this.showToast(
                    'Debes indicar el motivo para finalizar el servicio antes del cierre de la ventana de acceso.',
                    {
                        tone: 'warning',
                        title: t('toast.reason.required'),
                    }
                );
                earlyEndReasonInput?.focus();
                return;
            }

            const uploadEndEvidence = () =>
                this.uploadShiftEvidenceBatch('fin', this.endPhotoFiles, this.uploadedEndAreas);
            const uploadEndWithRetry = uploadEndEvidence().catch(async (uploadErr) => {
                if (this.isOtpSessionError?.(uploadErr)) {
                    return this.retryWithFreshOtp(uploadEndEvidence, { purpose: 'evidence_upload' });
                }
                throw uploadErr;
            });

            await Promise.all([
                precheckPromise,
                uploadEndWithRetry,
                this.resolveOpenEmployeeTasks(notes),
                this.uploadObservationAttachments(this.data.currentShift?.id, location).catch((error) => {
                    console.warn('No fue posible subir todos los adjuntos de observaciones.', error);
                }),
            ]);

            const performEndShiftRequest = () =>
                apiClient.endShift({
                    shift_id: this.data.currentShift.id,
                    lat: location.lat,
                    lng: location.lng,
                    fit_for_work: true,
                    declaration: notes,
                    // Backend contract v2: early_end_reason ahora encapsula el texto libre
                    // de "Observaciones" (obligatorio si es salida anticipada, opcional si no).
                    early_end_reason: earlyEndReason,
                    observations: earlyEndReason,
                });

            let endShiftPayload;
            try {
                endShiftPayload = await performEndShiftRequest();
            } catch (firstError) {
                if (this.isOtpSessionError?.(firstError)) {
                    console.warn('[shifts_end] OTP session invalido/expirado; reintentando tras re-verificar', {
                        error_code: this.getErrorCode?.(firstError),
                    });
                    endShiftPayload = await this.retryWithFreshOtp(() => performEndShiftRequest(), {
                        purpose: 'shift_end',
                    });
                } else {
                    throw firstError;
                }
            }
            this.recordShiftRequestTrace(
                'shifts_end',
                this.extractRequestId(endShiftPayload, apiClient.lastResponseMeta),
                this.data.currentShift
            );

            this.data.employee.lastCompletedShift = {
                completed_at: new Date().toISOString(),
                restaurant_name: this.getEmployeeResolvedShiftRestaurantName(
                    this.data.currentShift || this.data.currentScheduledShift,
                    ''
                ),
            };
            // Limpiar buffer de observaciones (esta terminado el servicio).
            this._observationsAttachments = [];
            this.invalidateCache('employeeDashboard', 'employeeHoursHistory');
            this.showSuccessScreen();
            void this.loadEmployeeDashboard(true).catch((error) => {
                console.warn('No fue posible refrescar el dashboard después de finalizar el servicio.', error);
            });
        } catch (error) {
            console.error('[shifts_end] failed', {
                error_code: this.getErrorCode?.(error),
                request_id: this.getErrorRequestIds?.(error),
                status: error?.status,
                payload: error?.payload,
            });

            // Backend contract v2: si viene error_code con acción específica, dispatchamos.
            if (this.handleErrorCodeAction?.(error)) {
                return;
            }

            const detailedMessage = this.getShiftFinalizeDetailedErrorMessage(error);
            const visibleMessage =
                detailedMessage || this.getErrorMessage(error, 'No fue posible finalizar el servicio.');
            const requestId = String(
                error?.requestId || error?.payload?.request_id || error?.payload?.error?.request_id || ''
            ).trim();
            this.recordShiftRequestTrace('shifts_end', requestId, this.data.currentShift);
            const traceSnapshot = this.getShiftRequestTraceSnapshot(this.data.currentShift);
            const finalizeUploadIds =
                traceSnapshot.finalize_upload.length > 0 ? traceSnapshot.finalize_upload.join(', ') : 'N/A';
            const summaryIds =
                traceSnapshot.summary_by_shift.length > 0 ? traceSnapshot.summary_by_shift.join(', ') : 'N/A';
            const shiftsEndIds =
                traceSnapshot.shifts_end.length > 0 ? traceSnapshot.shifts_end.join(', ') : requestId || 'N/A';
            const copyPayload = [
                `timestamp: ${new Date().toISOString()}`,
                `shift_id: ${String(this.data.currentShift?.id || '').trim() || 'N/A'}`,
                `status: ${String(error?.status || 'N/A')}`,
                `precheck_summary_status: ${startEvidencePrecheck.status}`,
                `precheck_summary_has_start_evidence: ${String(startEvidencePrecheck.has_start_evidence)}`,
                `precheck_summary_request_id: ${startEvidencePrecheck.request_id || 'N/A'}`,
                `request_id_finalize_upload: ${finalizeUploadIds}`,
                `request_id_summary_by_shift: ${summaryIds}`,
                `request_id_shifts_end: ${shiftsEndIds}`,
                `scheduled_end: ${String(this.data.currentShift?.scheduled_end || this.data.currentScheduledShift?.scheduled_end || 'N/A')}`,
                `early_end_reason_sent: ${String(document.getElementById('early-end-reason')?.value?.trim() || 'N/A')}`,
                `error_code: ${String(error?.code || error?.payload?.code || error?.payload?.error?.code || 'N/A')}`,
                `message: ${visibleMessage}`,
            ].join('\n');

            if (this.isEarlyEndReasonRequiredError(error)) {
                const earlyEndReasonInput = document.getElementById('early-end-reason');
                const enteredReason = String(earlyEndReasonInput?.value?.trim() || '');
                if (!enteredReason) {
                    this.showToast(
                        'Debes escribir una observación para este cierre y volver a finalizar.',
                        {
                            tone: 'warning',
                            title: t('toast.reason.obligatory'),
                            keepLoginMessages: true,
                            duration: 9000,
                        }
                    );
                    earlyEndReasonInput?.focus();
                }
            }

            this.showToast(visibleMessage, {
                tone: 'error',
                title: t('toast.cannot.finish.service'),
                duration: 12000,
                action: {
                    label: 'Copiar error',
                    dismissOnClick: false,
                    onClick: async () => {
                        const copied = await this.copyTextToClipboard(copyPayload);
                        this.showToast(
                            copied
                                ? 'Error copiado. Ya lo puedes pegar en WhatsApp o soporte.'
                                : 'No se pudo copiar el error. Inténtalo de nuevo.',
                            {
                                tone: copied ? 'success' : 'error',
                                title: copied ? 'Copia lista' : 'No fue posible copiar',
                                keepLoginMessages: true,
                            }
                        );
                    },
                },
            });
        } finally {
            this.hideLoading();
        }
    },

    showSuccessScreen() {
        this.getPageNodes().forEach((element) => {
            element.classList.add('hidden');
        });

        document.getElementById('page-success')?.classList.remove('hidden');
        this.stopTimer();
        this.data.currentShift = null;
        this.data.currentScheduledShift = null;
        this.resetShiftState();
    },

    parseShiftTimestamp(value) {
        if (!value) {
            return Number.NaN;
        }

        if (value instanceof Date) {
            const timestamp = value.getTime();
            return Number.isFinite(timestamp) ? timestamp : Number.NaN;
        }

        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : Number.NaN;
        }

        const raw = String(value || '').trim();
        if (!raw) {
            return Number.NaN;
        }

        const normalized = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(:\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw;

        const parsed = new Date(normalized).getTime();
        return Number.isFinite(parsed) ? parsed : Number.NaN;
    },

    resolveShiftTimerStartTime(shift = this.data.currentShift) {
        const now = Date.now();
        const futureToleranceMs = 5 * 60 * 1000;
        const scheduleAlignmentToleranceMs = 8 * 60 * 60 * 1000;
        const recentWindowMs = 24 * 60 * 60 * 1000;
        // Post-migracion Visitas: sin max_hours configurable. Backend cierra
        // visitas ad-hoc a las 16h; dejamos 18h como tope local con margen.
        const reasonableMaxHours = 18;
        const maxElapsedMs = reasonableMaxHours * 60 * 60 * 1000;

        const startMs = this.parseShiftTimestamp(shift?.start_time || shift?.started_at);
        const scheduledStartMs = this.parseShiftTimestamp(shift?.scheduled_start);

        if (Number.isFinite(startMs) && startMs > 0 && startMs <= now + futureToleranceMs) {
            if (!Number.isFinite(scheduledStartMs) || scheduledStartMs <= 0) {
                return startMs;
            }

            const elapsedFromStart = now - startMs;
            const scheduleLooksCurrent = Math.abs(now - scheduledStartMs) <= recentWindowMs;
            const startIsFarBeforeSchedule = startMs < scheduledStartMs - scheduleAlignmentToleranceMs;

            if (scheduleLooksCurrent && (elapsedFromStart > maxElapsedMs || startIsFarBeforeSchedule)) {
                return scheduledStartMs;
            }

            return startMs;
        }

        if (Number.isFinite(scheduledStartMs) && scheduledStartMs > 0 && scheduledStartMs <= now + futureToleranceMs) {
            return scheduledStartMs;
        }

        return now;
    },

    startTimerFromCurrentShift() {
        const shift = this.data.currentShift;
        const startTime = this.resolveShiftTimerStartTime(shift);
        this.timerStartTimeMs = Number.isFinite(startTime) ? startTime : Date.now();
        this.timerSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
        this.updateTimerDisplay();
        this.startTimer();
    },

    startTimer() {
        this.stopTimer();
        this.timerInterval = setInterval(() => {
            if (Number.isFinite(this.timerStartTimeMs)) {
                this.timerSeconds = Math.max(0, Math.floor((Date.now() - this.timerStartTimeMs) / 1000));
            } else {
                this.timerSeconds += 1;
            }
            this.updateTimerDisplay();
        }, 1000);
    },

    stopTimer() {
        if (!this.timerInterval) {
            return;
        }

        clearInterval(this.timerInterval);
        this.timerInterval = null;
    },

    updateTimerDisplay() {
        const hours = Math.floor(this.timerSeconds / 3600);
        const minutes = Math.floor((this.timerSeconds % 3600) / 60);
        const seconds = this.timerSeconds % 60;
        const display = document.getElementById('cleaning-timer');
        if (display) {
            display.textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
    },

    toggleSpecialTask() {
        return null;
    },

    buildRestaurantTaskCardHtml(task, dashboard) {
        const taskId = escapeHtml(String(task.task_id || task.id || ''));
        const status = task.status || 'pending';
        const requiresEvidence = task.requires_evidence === true;
        const restaurantName = this.getEmployeeTaskRestaurantName(task, dashboard);
        const dueText = task.due_at ? formatDateTime(task.due_at) : '';
        const isDone = status === 'completed' || status === 'cancelled' || status === 'closed';

        const metaParts = [
            restaurantName ? `Cliente: ${escapeHtml(restaurantName)}` : '',
            dueText ? `Vence: ${escapeHtml(dueText)}` : '',
            requiresEvidence ? 'Requiere foto de evidencia.' : '',
        ].filter(Boolean);

        const actionsHtml = isDone
            ? ''
            : requiresEvidence
              ? `
            <div class="rtask-actions">
                <button type="button" class="btn btn-primary btn-sm" data-rtask-action="show-evidence" data-task-id="${taskId}">
                    <i class="fas fa-camera"></i> Completar tarea
                </button>
                <div class="rtask-evidence-wrap hidden" id="rtask-evidence-wrap-${taskId}">
                    <input type="file" accept="${SUPPORTED_EVIDENCE_IMAGE_ACCEPT},video/*" capture="environment" multiple class="rtask-file-input" id="rtask-file-${taskId}" style="display:none;">
                    <div class="rtask-attachments" id="rtask-attachments-${taskId}"></div>
                    <label for="rtask-file-${taskId}" class="rtask-file-label" id="rtask-file-label-${taskId}">
                        <i class="fas fa-plus"></i>
                        <span class="rtask-file-label-text">Agregar foto o video</span>
                    </label>
                    <input type="text" placeholder="Observaciones (opcional)" class="rtask-notes-input dark-control" id="rtask-notes-${taskId}">
                    <div class="rtask-evidence-buttons">
                        <button type="button" class="btn btn-primary btn-sm" data-rtask-action="submit-evidence" data-task-id="${taskId}">
                            <i class="fas fa-paper-plane"></i> Enviar evidencia
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm" data-rtask-action="cancel-evidence" data-task-id="${taskId}">Cancelar</button>
                    </div>
                </div>
            </div>`
              : `
            <div class="rtask-actions">
                <button type="button" class="btn btn-success btn-sm" data-rtask-action="close" data-task-id="${taskId}">
                    <i class="fas fa-check"></i> Marcar completada
                </button>
            </div>`;

        const instructionsVideoUrl = String(
            task.instructions_video_url ||
                task.instructions_video?.url ||
                task.meta?.instructions_video_url ||
                task.metadata?.instructions_video_url ||
                ''
        ).trim();
        const safeVideoUrl = sanitizeUrl(instructionsVideoUrl);
        const videoHtml = safeVideoUrl
            ? `<div class="rtask-video-wrap" style="margin:8px 0;">
                <video controls playsinline preload="metadata" style="width:100%;border-radius:8px;background:#000;max-height:240px;" src="${escapeHtml(safeVideoUrl)}"></video>
                <p class="muted-copy" style="font-size:12px;margin:4px 0 0;">
                    <i class="fas fa-video"></i> ${escapeHtml(t('rtask.video.viewer.label'))}
                </p>
            </div>`
            : '';

        return `<div class="rtask-card" data-task-id="${taskId}">
            <div class="rtask-header">
                <span class="rtask-title">${escapeHtml(task.title || 'Tarea del sitio')}</span>
                <span class="badge ${getBadgeClass(status)}">${escapeHtml(getShiftStatusLabel({ status }))}</span>
            </div>
            ${task.description ? `<p class="rtask-desc">${escapeHtml(task.description)}</p>` : ''}
            ${videoHtml}
            <p class="rtask-meta">${metaParts.join(' · ')}</p>
            ${actionsHtml}
        </div>`;
    },

    initRestaurantTaskDelegation() {
        // Buffer de archivos adjuntos por tarea (permite múltiples fotos/videos).
        this._rtaskAttachments = this._rtaskAttachments || {};

        // Se bindea en los dos contenedores (dashboard + cleaning) porque las
        // cards se renderizan en ambos y los ids de inputs son globales.
        ['employee-restaurant-tasks-list', 'cleaning-restaurant-tasks-list'].forEach((listId) => {
            const list = document.getElementById(listId);
            if (!list || list.dataset.delegationReady) return;
            list.dataset.delegationReady = '1';

            list.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-rtask-action]');
                if (!btn) return;
                const taskId = btn.dataset.taskId;
                const action = btn.dataset.rtaskAction;
                if (action === 'close') void this.employeeCloseRestaurantTask(taskId);
                else if (action === 'submit-evidence') void this.employeeCompleteRestaurantTask(taskId);
                else if (action === 'show-evidence') {
                    // Puede existir en ambas superficies; abrir la instancia del click.
                    btn.closest('.rtask-card')
                        ?.querySelector(`#rtask-evidence-wrap-${taskId}`)
                        ?.classList.remove('hidden');
                    document.getElementById(`rtask-evidence-wrap-${taskId}`)?.classList.remove('hidden');
                } else if (action === 'cancel-evidence') {
                    document.getElementById(`rtask-evidence-wrap-${taskId}`)?.classList.add('hidden');
                    this._rtaskAttachments[taskId] = [];
                    this.renderRtaskAttachments(taskId);
                } else if (action === 'remove-attachment') {
                    const index = Number(btn.dataset.index);
                    if (Number.isFinite(index) && this._rtaskAttachments[taskId]) {
                        this._rtaskAttachments[taskId].splice(index, 1);
                        this.renderRtaskAttachments(taskId);
                    }
                }
            });
            list.addEventListener('change', (e) => {
                const fileInput = e.target.closest('.rtask-file-input');
                if (!fileInput) return;
                const taskId = fileInput.id.replace('rtask-file-', '');
                const files = Array.from(fileInput.files || []);
                if (files.length === 0) return;
                this._rtaskAttachments[taskId] = [...(this._rtaskAttachments[taskId] || []), ...files];
                fileInput.value = '';
                this.renderRtaskAttachments(taskId);
            });
        });
    },

    renderRtaskAttachments(taskId) {
        const wrap = document.getElementById(`rtask-attachments-${taskId}`);
        if (!wrap) return;
        const files = this._rtaskAttachments?.[taskId] || [];
        const label = document.getElementById(`rtask-file-label-${taskId}`);
        const textSpan = label?.querySelector('.rtask-file-label-text');

        if (files.length === 0) {
            wrap.innerHTML = '';
            if (textSpan) textSpan.textContent = 'Agregar foto o video';
            label?.classList.remove('rtask-file-label-has-file');
            return;
        }

        if (textSpan) textSpan.textContent = `Agregar otra (${files.length})`;
        label?.classList.add('rtask-file-label-has-file');

        wrap.innerHTML = files
            .map((file, index) => {
                const isVideo = String(file.type || '').startsWith('video/');
                const icon = isVideo ? 'fa-video' : 'fa-image';
                const shortName = file.name.length > 22 ? `${file.name.slice(0, 22)}…` : file.name;
                const sizeMb = Math.round((file.size / (1024 * 1024)) * 10) / 10;
                return `<div class="rtask-attachment-item">
                    <i class="fas ${icon}"></i>
                    <span class="rtask-attachment-name">${escapeHtml(shortName)}</span>
                    <span class="rtask-attachment-size">${sizeMb} MB</span>
                    <button type="button" class="rtask-attachment-remove" data-rtask-action="remove-attachment" data-task-id="${escapeHtml(String(taskId))}" data-index="${index}" aria-label="Quitar adjunto">
                        <i class="fas fa-times"></i>
                    </button>
                </div>`;
            })
            .join('');
    },

    renderEmployeeRestaurantTasks() {
        const tasks = this.getEmployeeRestaurantOpenTasks();
        const dashboard = this.data.employee.dashboard || {};
        const html = tasks.map((task) => this.buildRestaurantTaskCardHtml(task, dashboard)).join('');
        const surfaces = [
            { section: 'employee-restaurant-tasks-section', list: 'employee-restaurant-tasks-list' },
            { section: 'cleaning-restaurant-tasks-section', list: 'cleaning-restaurant-tasks-list' },
        ];

        // Las tareas del sitio SOLO se muestran en la pantalla del cronómetro
        // (servicio en progreso). Es donde el contratista tiene tiempo real de
        // trabajo. Fuera del turno activo o en la pantalla de cierre no se
        // muestran para no distraer y para evitar NO_ACTIVE_SHIFT del backend.
        const hasActiveShift = Boolean(this.data.currentShift?.id);
        const activeListId = hasActiveShift ? 'cleaning-restaurant-tasks-list' : null;

        surfaces.forEach(({ section: sectionId, list: listId }) => {
            const section = document.getElementById(sectionId);
            const list = document.getElementById(listId);
            if (!section || !list) return;
            if (listId !== activeListId || tasks.length === 0) {
                section.classList.add('hidden');
                list.innerHTML = '';
                return;
            }
            section.classList.remove('hidden');
            list.innerHTML = html;
        });

        this.initRestaurantTaskDelegation();
    },

    async employeeCloseRestaurantTask(taskId) {
        const numericTaskId = Number(taskId);
        if (!Number.isFinite(numericTaskId)) {
            this.showToast('No se pudo identificar la tarea.', {
                tone: 'error',
                title: t('toast.error.completing'),
            });
            return;
        }
        try {
            await apiClient.operationalTasksManage('close', { task_id: numericTaskId });
            this.data.employee.openTasks = (this.data.employee.openTasks || []).filter(
                (task) => String(task.task_id || task.id || '') !== String(numericTaskId)
            );
            this.renderEmployeeRestaurantTasks();
            this.showToast(t('toast.task.completed'), { tone: 'success', title: t('toast.done') });
        } catch (error) {
            this.showToast(this.getEmployeeRestaurantTaskErrorMessage(error, 'No fue posible completar la tarea.'), {
                tone: 'error',
                title: t('toast.error.completing'),
            });
        }
    },

    async employeeCompleteRestaurantTask(taskId) {
        const notesInput = document.getElementById(`rtask-notes-${taskId}`);
        const notes = notesInput?.value?.trim() || undefined;
        const files = (this._rtaskAttachments && this._rtaskAttachments[taskId]) || [];

        if (files.length === 0) {
            this.showToast(t('toast.select.photo.first'), {
                tone: 'warning',
                title: t('toast.photo.required'),
            });
            return;
        }

        const numericTaskId = Number(taskId);
        if (!Number.isFinite(numericTaskId)) {
            this.showToast('No se pudo identificar la tarea.', {
                tone: 'error',
                title: t('toast.error.completing'),
            });
            return;
        }

        this.showLoading(t('toast.uploading.evidence'), t('toast.wait'));
        try {
            const paths = [];
            for (const file of files) {
                const path = await this.uploadTaskEvidence(numericTaskId, file);
                if (!path) throw new Error('No se recibió la ruta de la evidencia subida.');
                paths.push(path);
            }
            const completePayload = {
                task_id: numericTaskId,
                // Compat: evidence_path (primero) para backends viejos.
                // Nuevo: evidence_paths (array completo) para el flow multi-adjunto.
                evidence_path: paths[0],
                evidence_paths: paths,
            };
            if (notes) {
                completePayload.notes = notes;
            }
            console.info('[rtask] complete payload', completePayload);
            await apiClient.operationalTasksManage('complete', completePayload);
            this.data.employee.openTasks = (this.data.employee.openTasks || []).filter(
                (task) => String(task.task_id || task.id || '') !== String(numericTaskId)
            );
            if (this._rtaskAttachments) this._rtaskAttachments[taskId] = [];
            this.renderEmployeeRestaurantTasks();
            this.showToast(t('toast.task.completed.evidence'), { tone: 'success', title: t('toast.done') });
        } catch (error) {
            console.error('[rtask] complete failed', {
                taskId: numericTaskId,
                error,
                payload: error?.payload,
                message: error?.message,
            });
            const detailedMessage =
                error?.payload?.error?.details?.message ||
                error?.payload?.error?.message ||
                error?.payload?.message ||
                '';
            const baseMessage = this.getEmployeeRestaurantTaskErrorMessage(error, 'No fue posible completar la tarea.');
            const finalMessage =
                detailedMessage && !baseMessage.includes(detailedMessage)
                    ? `${baseMessage} (${detailedMessage})`
                    : baseMessage;
            this.showToast(finalMessage, {
                tone: 'error',
                title: t('toast.error.completing'),
            });
        } finally {
            this.hideLoading();
        }
    },

    getEmployeeRestaurantTaskDiagnosticCode(error) {
        return error?.payload?.error?.details?.diagnostic_code || '';
    },

    getEmployeeRestaurantTaskErrorMessage(error, fallback) {
        const code = this.getEmployeeRestaurantTaskDiagnosticCode(error);
        if (code === 'NO_ACTIVE_SHIFT')
            return 'Necesitas tener un servicio activo en este sitio para completar esta tarea.';
        if (code === 'RESTAURANT_FORBIDDEN') return 'No tienes permiso para operar tareas en este sitio.';
        const httpCode = error?.payload?.error?.code;
        if (httpCode === 409) return 'Esta tarea ya fue completada o cancelada.';
        if (httpCode === 404) return 'La tarea no fue encontrada.';
        return this.getErrorMessage(error, fallback);
    },

    openPhoneChangeModal() {
        this._phoneChangePendingNumber = '';
        const inputNew = document.getElementById('phone-change-new');
        const inputCode = document.getElementById('phone-change-code');
        const stepReq = document.getElementById('phone-change-step-request');
        const stepConf = document.getElementById('phone-change-step-confirm');
        const err = document.getElementById('phone-change-error');
        const errConf = document.getElementById('phone-change-confirm-error');
        const btnReq = document.getElementById('phone-change-request-btn');
        const btnConf = document.getElementById('phone-change-confirm-btn');
        const btnResend = document.getElementById('phone-change-resend-btn');

        if (inputNew) inputNew.value = '';
        if (inputCode) inputCode.value = '';
        if (stepReq) stepReq.classList.remove('hidden');
        if (stepConf) stepConf.classList.add('hidden');
        if (err) { err.classList.add('hidden'); err.textContent = ''; }
        if (errConf) { errConf.classList.add('hidden'); errConf.textContent = ''; }
        if (btnReq) btnReq.classList.remove('hidden');
        if (btnConf) btnConf.classList.add('hidden');
        if (btnResend) btnResend.classList.add('hidden');

        this.openModal('modal-phone-change');
    },

    closePhoneChangeModal() {
        this.closeModal('modal-phone-change');
    },

    _validatePhoneE164(value) {
        // E.164: + seguido de 8 a 15 dígitos, primer dígito 1-9.
        return /^\+[1-9]\d{7,14}$/.test(String(value || '').trim());
    },

    async requestPhoneChangeOtp() {
        const inputNew = document.getElementById('phone-change-new');
        const err = document.getElementById('phone-change-error');
        const rawPhone = String(inputNew?.value || '').trim().replace(/\s+/g, '');

        if (err) { err.classList.add('hidden'); err.textContent = ''; }

        if (!this._validatePhoneE164(rawPhone)) {
            if (err) {
                err.textContent = 'El teléfono debe estar en formato E.164 (ej. +13235550123).';
                err.classList.remove('hidden');
            }
            return;
        }

        this.showLoading('Enviando código', 'Estamos enviando el código a tu correo.');
        try {
            const result = await apiClient.profilePhoneChangeRequest({ new_phone: rawPhone });
            if (result?.noop) {
                this.showToast('El teléfono ingresado es el mismo que ya tienes registrado.', {
                    tone: 'info',
                    title: 'Sin cambios',
                });
                this.closePhoneChangeModal();
                return;
            }
            this._phoneChangePendingNumber = rawPhone;
            const maskedNode = document.getElementById('phone-change-masked-email');
            if (maskedNode) maskedNode.textContent = result?.masked_email || 'tu correo';

            document.getElementById('phone-change-step-request')?.classList.add('hidden');
            document.getElementById('phone-change-step-confirm')?.classList.remove('hidden');
            document.getElementById('phone-change-request-btn')?.classList.add('hidden');
            document.getElementById('phone-change-confirm-btn')?.classList.remove('hidden');
            document.getElementById('phone-change-resend-btn')?.classList.remove('hidden');
            document.getElementById('phone-change-code')?.focus();
        } catch (error) {
            const code = String(error?.payload?.error_code || error?.payload?.error?.error_code || '').toUpperCase();
            let msg = this.getErrorMessage(error, 'No fue posible enviar el código.');
            if (code === 'PHONE_ALREADY_IN_USE') msg = 'Este teléfono ya está registrado por otra cuenta.';
            else if (code === 'RATE_LIMITED') msg = 'Superaste el límite de intentos. Intenta de nuevo en unos minutos.';
            else if (code === 'PHONE_FORMAT_INVALID') msg = 'Formato de teléfono inválido. Usa E.164 (+país+numero).';
            if (err) { err.textContent = msg; err.classList.remove('hidden'); }
        } finally {
            this.hideLoading();
        }
    },

    async confirmPhoneChangeOtp() {
        const inputCode = document.getElementById('phone-change-code');
        const err = document.getElementById('phone-change-confirm-error');
        const code = String(inputCode?.value || '').trim();

        if (err) { err.classList.add('hidden'); err.textContent = ''; }

        if (!/^\d{6}$/.test(code)) {
            if (err) {
                err.textContent = 'Ingresa los 6 dígitos del código.';
                err.classList.remove('hidden');
            }
            return;
        }
        if (!this._phoneChangePendingNumber) {
            if (err) {
                err.textContent = 'Vuelve a solicitar el código.';
                err.classList.remove('hidden');
            }
            return;
        }

        this.showLoading('Confirmando', 'Estamos actualizando tu teléfono.');
        try {
            const result = await apiClient.profilePhoneChangeConfirm({
                new_phone: this._phoneChangePendingNumber,
                code,
            });
            const newPhone = result?.phone || this._phoneChangePendingNumber;
            this.showToast(
                result?.auth_synced === false
                    ? 'Teléfono actualizado. La sincronización con el sistema de SMS quedó pendiente; los futuros códigos por SMS pueden llegar al número anterior hasta que se sincronice.'
                    : 'Teléfono actualizado correctamente.',
                { tone: 'success', title: 'Cambio guardado' }
            );
            // Refleja el nuevo teléfono en la UI sin necesidad de refetch.
            const phoneNode = document.getElementById('profile-phone');
            if (phoneNode) phoneNode.textContent = newPhone;
            if (this.currentUser) this.currentUser.phone = newPhone;
            this.closePhoneChangeModal();
            this.loadEmployeeProfile(true).catch(() => null);
        } catch (error) {
            const errCode = String(error?.payload?.error_code || error?.payload?.error?.error_code || '').toUpperCase();
            let msg = this.getErrorMessage(error, 'No fue posible confirmar el cambio.');
            if (errCode === 'INVALID_CODE') msg = 'Código inválido. Verifícalo o pide uno nuevo.';
            else if (errCode === 'CODE_EXPIRED') msg = 'El código expiró. Solicita uno nuevo.';
            else if (errCode === 'PHONE_ALREADY_IN_USE') msg = 'Este teléfono ya está registrado por otra cuenta.';
            else if (errCode === 'RATE_LIMITED') msg = 'Superaste el límite de intentos. Espera unos minutos.';
            if (err) { err.textContent = msg; err.classList.remove('hidden'); }
        } finally {
            this.hideLoading();
        }
    },
};
