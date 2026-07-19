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
    formatShiftRange,
    getBadgeClass,
    getMonthStart,
    getRestaurantDisplayName,
    getRestaurantRecordId,
    getScheduledHours,
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
            if (todayShifts.length > 0) {
                const activeCandidate = todayShifts.find((shift) => {
                    const state = String(shift?.state || shift?.status || '').toLowerCase();
                    return state === 'activo' || state === 'active' || state === 'in_progress';
                });
                this.data.currentShift = activeCandidate
                    ? this.enrichEmployeeShiftRecord(activeCandidate, dashboard)
                    : this.enrichEmployeeShiftRecord(dashboard?.active_shift, dashboard);

                if (this.data.currentShift) {
                    this.data.currentScheduledShift = null;
                } else {
                    const pending = this.pickEmployeeScheduledShiftByGpsOrProximity(todayShifts);
                    this.data.currentScheduledShift = pending
                        ? this.enrichEmployeeShiftRecord(pending, dashboard)
                        : null;
                }
                // Expose todos los turnos del día para vistas que quieran mostrar el listado completo.
                this.data.employee.todayShifts = todayShifts;
            } else {
                this.data.currentShift = this.enrichEmployeeShiftRecord(dashboard?.active_shift, dashboard);
                this.data.currentScheduledShift = this.data.currentShift
                    ? null
                    : this.enrichEmployeeShiftRecord(
                          this.getEmployeePendingScheduledShift(dashboard?.scheduled_shifts),
                          dashboard
                      );
                this.data.employee.todayShifts = [];
            }
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

        document.getElementById('profile-hours-worked').textContent = formatHours(profileHours);
        document.getElementById('profile-total-shifts').textContent = String(history?.total_shifts || 0);
        document.getElementById('profile-upcoming-shifts').textContent = String(
            asArray(this.data.employee.dashboard?.scheduled_shifts).filter((shift) =>
                this.getEmployeePendingScheduledShift([shift])
            ).length
        );
        document.getElementById('profile-pending-tasks').textContent = String(
            this.data.employee.dashboard?.pending_tasks_count || 0
        );
        const visibleTasks = this.getVisibleEmployeeTasks(this.data.employee.dashboard);
        this.renderEmployeeProfileTasks(visibleTasks);
        this.updateUserUI();
    },

    /**
     * De la lista `today_shifts[]` (backend v3), elige el turno programado que
     * corresponde al sitio donde el contratista está físicamente. Si no hay
     * ubicación disponible o ningún restaurante está dentro del radio, cae al
     * scheduled_start más cercano en el tiempo. Ignora turnos activos y cerrados.
     */
    pickEmployeeScheduledShiftByGpsOrProximity(todayShifts = []) {
        const candidates = asArray(todayShifts).filter((shift) => {
            const state = String(shift?.state || shift?.status || '').toLowerCase();
            if (!state || state === 'activo' || state === 'active' || state === 'in_progress') return false;
            const closed = new Set([
                'cancelado',
                'cancelled',
                'completed',
                'completado',
                'finalizado',
                'finished',
                'closed',
                'done',
                'auto_ended',
            ]);
            return !closed.has(state);
        });

        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        const location = this.location;
        const hasLocation =
            location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng));

        if (hasLocation) {
            // 1) Preferir el turno cuyo sitio contenga la ubicación actual dentro del radio.
            const inRange = candidates
                .map((shift) => {
                    const rLat = Number(shift?.restaurant?.lat);
                    const rLng = Number(shift?.restaurant?.lng);
                    const radius = Number(shift?.restaurant?.radius_meters || 100);
                    if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) return null;
                    const distance = this.haversineMeters(location.lat, location.lng, rLat, rLng);
                    return { shift, distance, radius };
                })
                .filter(Boolean)
                .sort((a, b) => a.distance - b.distance);

            const inside = inRange.find((entry) => entry.distance <= entry.radius);
            if (inside) return inside.shift;
            if (inRange.length > 0) return inRange[0].shift; // el más cercano aunque esté fuera de radio
        }

        // 2) Sin GPS o sin coords en el sitio: el scheduled_start más cercano en tiempo.
        const now = Date.now();
        return candidates
            .map((shift) => {
                const start = shift?.scheduled_start || shift?.start_time;
                const startMs = start ? new Date(start).getTime() : Number.POSITIVE_INFINITY;
                const delta = Math.abs(startMs - now);
                return { shift, delta };
            })
            .sort((a, b) => a.delta - b.delta)[0].shift;
    },

    /**
     * Cuando la ubicación cambia y el contratista tiene múltiples turnos programados
     * hoy en distintos sitios, re-elige el turno pending que corresponde al sitio
     * actual. NO se ejecuta si ya hay un turno activo (para no cambiar mid-servicio).
     */
    rebuildEmployeeScheduledShiftFromLocation() {
        if (this.data.currentShift?.id) return;
        const todayShifts = asArray(this.data.employee.todayShifts);
        if (todayShifts.length <= 1) return;
        const nextPending = this.pickEmployeeScheduledShiftByGpsOrProximity(todayShifts);
        const currentId = String(this.data.currentScheduledShift?.id || '').trim();
        const nextId = String(nextPending?.id || '').trim();
        if (!nextId || nextId === currentId) return;
        this.data.currentScheduledShift = this.enrichEmployeeShiftRecord(
            nextPending,
            this.data.employee.dashboard || {}
        );
        if (this.currentPage === 'employee-dashboard') {
            this.renderEmployeeDashboard();
        }
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

    filterEmployeeTasksByKnownShifts(tasks = [], dashboard = this.data.employee.dashboard || {}) {
        const activeShiftId = String(dashboard?.active_shift?.id || this.data.currentShift?.id || '').trim();
        const knownScheduledShiftIds = new Set(
            asArray(dashboard?.scheduled_shifts)
                .map((shift) => String(shift?.id || shift?.scheduled_shift_id || '').trim())
                .filter(Boolean)
        );
        const hasKnownShiftScope = Boolean(activeShiftId) || knownScheduledShiftIds.size > 0;

        if (activeShiftId) {
            knownScheduledShiftIds.add(activeShiftId);
        }

        const knownRestaurantIds = new Set();
        const pushRestaurantId = (value) => {
            const normalizedValue = String(getRestaurantRecordId(value) || value || '').trim();
            if (normalizedValue) {
                knownRestaurantIds.add(normalizedValue);
            }
        };

        pushRestaurantId(this.data.currentShift?.restaurant_id || this.data.currentShift?.restaurant?.id);
        pushRestaurantId(
            this.data.currentScheduledShift?.restaurant_id || this.data.currentScheduledShift?.restaurant?.id
        );
        asArray(dashboard?.scheduled_shifts).forEach((shift) => {
            pushRestaurantId(
                shift?.restaurant_id ||
                    shift?.restaurant?.restaurant_id ||
                    shift?.restaurant?.id ||
                    shift?.location_id ||
                    shift?.location?.id
            );
        });
        this.getEmployeeAssignedRestaurants(dashboard).forEach((restaurant) => {
            pushRestaurantId(restaurant);
        });

        return asArray(tasks).filter((task) => {
            const linkedScheduledShiftId = String(
                task?.scheduled_shift_id ||
                    task?.scheduledShiftId ||
                    task?.scheduled_shift?.id ||
                    task?.scheduled_shift?.scheduled_shift_id ||
                    task?.meta?.scheduled_shift_id ||
                    task?.metadata?.scheduled_shift_id ||
                    ''
            ).trim();
            const linkedShiftId = String(
                task?.shift_id ||
                    task?.shiftId ||
                    task?.shift?.id ||
                    task?.meta?.shift_id ||
                    task?.metadata?.shift_id ||
                    ''
            ).trim();
            const linkedRestaurantId = String(
                task?.restaurant_id ||
                    task?.restaurant?.restaurant_id ||
                    task?.restaurant?.id ||
                    task?.meta?.restaurant_id ||
                    task?.metadata?.restaurant_id ||
                    ''
            ).trim();

            if (!linkedScheduledShiftId && !linkedShiftId && !linkedRestaurantId) {
                return hasKnownShiftScope || knownRestaurantIds.size > 0;
            }

            if (linkedScheduledShiftId && knownScheduledShiftIds.has(linkedScheduledShiftId)) {
                return true;
            }

            if (linkedShiftId && (linkedShiftId === activeShiftId || knownScheduledShiftIds.has(linkedShiftId))) {
                return true;
            }

            if (linkedRestaurantId && knownRestaurantIds.has(linkedRestaurantId)) {
                return true;
            }

            return false;
        });
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
            const canStartShift =
                !hasActiveShift &&
                this.canEmployeeStartScheduledShift(this.data.currentScheduledShift, this.data.employee.dashboard);
            const hasShiftAvailable = hasActiveShift || canStartShift;

            if (!hasShiftAvailable) {
                this.showToast(this.getShiftStartWindowCopy(this.data.currentScheduledShift), {
                    tone: 'warning',
                    title: t('toast.service.unavailable'),
                });
                this.navigate('employee-dashboard');
                return;
            }

            this.navigate('employee-shift-start');
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

        const canStartShift =
            !hasActiveShift &&
            this.canEmployeeStartScheduledShift(this.data.currentScheduledShift, this.data.employee.dashboard);
        const shift = this.enrichEmployeeShiftRecord(
            this.data.currentShift || this.data.currentScheduledShift,
            this.data.employee.dashboard
        );
        if (!shift || (!hasActiveShift && !canStartShift)) {
            this.showToast(this.getShiftStartWindowCopy(this.data.currentScheduledShift), {
                tone: 'warning',
                title: t('toast.service.unavailable'),
            });
            this.navigate('employee-dashboard');
            return;
        }

        if (hasActiveShift) {
            this.data.currentShift = shift;
        } else {
            this.data.currentScheduledShift = shift;
        }

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

        document.getElementById('shift-start-restaurant').textContent = this.getResolvedShiftRestaurantName(
            { ...shift, restaurant },
            hasActiveShift ? 'Sitio del servicio activo' : 'Sitio del servicio asignado'
        );
        document.getElementById('shift-start-schedule').textContent = this.getEmployeeShiftScheduleText(shift, {
            hasActiveShift,
        });

        if (button) {
            button.innerHTML = hasActiveShift
                ? this.shouldResumeActiveShiftInCleaning(shift)
                    ? 'Continuar con el Servicio Activo <i class="fas fa-arrow-right"></i>'
                    : 'Completar Fotos Iniciales <i class="fas fa-camera"></i>'
                : 'Registrar Inicio y Continuar <i class="fas fa-arrow-right"></i>';
        }

        const gpsButton = document.getElementById('gps-btn');
        const gpsStatus = document.getElementById('gps-status');
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

        this.checkCanContinue();
    },

    async startShiftFlow() {
        const scheduledShift = this.data.currentScheduledShift;
        let hasActiveShift = Boolean(this.data.currentShift?.id);
        if (hasActiveShift) {
            await this.refreshCurrentActiveShift();
            await this.hydrateShiftEvidenceSummary(this.data.currentShift);
            hasActiveShift = Boolean(this.data.currentShift?.id);
        }

        const canStartShift =
            !hasActiveShift && this.canEmployeeStartScheduledShift(scheduledShift, this.data.employee.dashboard);

        if (!this.gpsVerified) {
            this.showToast(t('toast.location.unverified'), {
                tone: 'warning',
                title: t('toast.location.pending'),
            });
            return;
        }

        if (!this.healthCertified) {
            this.showToast(t('toast.health.required'), {
                tone: 'warning',
                title: t('toast.health.missing'),
            });
            return;
        }

        if (!hasActiveShift && !canStartShift) {
            this.showToast(this.getShiftStartWindowCopy(scheduledShift), {
                tone: 'warning',
                title: t('toast.service.unavailable'),
            });
            return;
        }

        this.showLoading(t('toast.starting.service'), t('toast.wait'));

        const performStartShiftRequest = async () => {
            // Si ya hay turno activo (usuario reentró después de un start exitoso pero fotos pendientes),
            // NO tocamos scheduledShift (que en ese caso es null): el turno ya está corriendo en el backend.
            if (this.data.currentShift) {
                return;
            }

            // Backend v3: en today_shifts los turnos programados vienen con
            // shift_id=null; el id real esta en scheduled_shift_id. Aceptamos
            // cualquiera de los dos como fuente.
            const scheduledShiftIdentifier = scheduledShift?.scheduled_shift_id || scheduledShift?.id;
            const otpTokenLength = String(apiClient.getConfig()?.shiftOtpToken || '').length;
            console.info('[shifts_start] pre-request diagnostic', {
                otpTokenPresent: otpTokenLength > 0,
                otpTokenLength,
                scheduledShiftId: scheduledShiftIdentifier,
                restaurantId: scheduledShift?.restaurant_id,
            });
            const location = this.location || (await this.captureLocation({ updateUi: false }));

            const result = await apiClient.startShift({
                restaurant_id: scheduledShift.restaurant_id,
                scheduled_shift_id: scheduledShiftIdentifier,
                lat: location.lat,
                lng: location.lng,
                fit_for_work: true,
                declaration: 'Me encuentro en condiciones de iniciar labores.',
            });

            this.data.currentShift = this.enrichEmployeeShiftRecord(
                {
                    ...scheduledShift,
                    id: result?.shift_id,
                    scheduled_shift_id: scheduledShiftIdentifier,
                    restaurant_id: scheduledShift.restaurant_id,
                    restaurant: scheduledShift.restaurant,
                    start_time: new Date().toISOString(),
                    state: 'activo',
                },
                this.data.employee.dashboard
            );
            this.data.currentScheduledShift = null;
        };

        try {
            // OTP se pide UNA sola vez al login; no volvemos a pedirlo aquí.
            // Si el backend responde OTP_SESSION_EXPIRED/REQUIRED/INVALID, el
            // catch de abajo dispara retryWithFreshOtp (una sola vez).
            try {
                await performStartShiftRequest();
            } catch (firstError) {
                if (this.isOtpSessionError?.(firstError)) {
                    console.warn('[shifts_start] OTP session invalido/expirado; reintentando tras re-verificar', {
                        error_code: this.getErrorCode?.(firstError),
                    });
                    await this.retryWithFreshOtp(() => performStartShiftRequest(), { purpose: 'shift_start' });
                } else {
                    throw firstError;
                }
            }

            this.persistCurrentShiftAreaSelection();

            this.data.employee.lastCompletedShift = null;
            this.invalidateCache('employeeDashboard', 'employeeHoursHistory');

            const resumeInCleaning = this.shouldResumeActiveShiftInCleaning(this.data.currentShift);
            this.updateCleaningUI();
            if (hasActiveShift && resumeInCleaning) {
                this.navigate('employee-shift-cleaning');
                return;
            }

            if (hasActiveShift && !resumeInCleaning) {
                this.showToast(t('toast.evidence.initial.incomplete'), {
                    tone: 'info',
                    title: t('toast.photos.missing'),
                });
            }

            this.navigate('employee-shift-photos');
        } catch (error) {
            console.error('[shifts_start] failed', {
                error_code: this.getErrorCode?.(error),
                request_id: this.getErrorRequestIds?.(error),
                status: error?.status,
                payload: error?.payload,
            });

            // Backend contract v2: si viene error_code con acción específica, dispatchamos.
            if (this.handleErrorCodeAction?.(error)) {
                return;
            }

            if (this.isShiftStartOutsideWindow(error)) {
                this.showToast(this.getShiftStartWindowOutsideMessage(error), {
                    tone: 'warning',
                    title: t('toast.window.outside'),
                });
                void this.loadEmployeeDashboard(true);
                return;
            }

            if (this.isOutsideAllowedShiftArea(error)) {
                this.showToast(t('toast.cannot.start.outside'), {
                    tone: 'warning',
                    title: t('toast.area.notallowed'),
                });
                return;
            }

            this.showToast(this.getErrorMessage(error, 'No fue posible iniciar el servicio.'), {
                tone: 'error',
                title: t('toast.cannot.start.service'),
            });
        } finally {
            this.hideLoading();
        }
    },

    async uploadShiftEvidenceBatch(type, filesMap, uploadedMap) {
        const entries = Object.entries(filesMap).filter(([area, file]) => file && !uploadedMap[area]);
        const shiftId = this.data.currentShift?.id;

        if (!shiftId) {
            throw new Error('No hay un servicio activo para adjuntar evidencias.');
        }

        if (entries.length === 0) return;

        const location = this.location || (await this.captureLocation({ updateUi: false }));

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
            await this.uploadShiftEvidenceBatch('inicio', this.photoFiles, this.uploadedStartAreas);
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

        document.getElementById('summary-duration').textContent = formatHours(durationHours);
        document.getElementById('summary-photos').textContent = String(
            Object.keys(this.photoFiles).length +
                Object.keys(this.endPhotoFiles).length +
                (this.specialTaskEvidenceFile ? 1 : 0)
        );
        document.getElementById('summary-restaurant').textContent = this.getEmployeeResolvedShiftRestaurantName(
            { ...summaryShift, restaurant },
            'Sitio asignado'
        );
        document.getElementById('summary-schedule').textContent = formatShiftRange(
            summaryShift?.scheduled_start || summaryShift?.start_time,
            summaryShift?.scheduled_end || new Date().toISOString()
        );
        document.getElementById('summary-date').textContent = summaryReferenceDate
            ? formatDate(summaryReferenceDate, {
                  weekday: 'long',
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
              })
            : '-';

        if (earlyEndCard) {
            earlyEndCard.classList.remove('hidden');
        }

        if (earlyEndReasonInput) {
            earlyEndReasonInput.placeholder = isEarlyEnd
                ? 'Observaciones (obligatorio para salida anticipada)'
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

            const location = this.location || (await this.captureLocation({ updateUi: false }));
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

            await Promise.all([
                precheckPromise,
                this.uploadShiftEvidenceBatch('fin', this.endPhotoFiles, this.uploadedEndAreas),
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
                        'Backend exige motivo de salida anticipada para este cierre. Escríbelo y vuelve a finalizar.',
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
        const configuredMaxHours = Number(
            this.getSystemSetting('shifts.max_hours', DEFAULT_SYSTEM_SETTINGS.shifts.max_hours)
        );
        const reasonableMaxHours =
            Number.isFinite(configuredMaxHours) && configuredMaxHours > 0 ? Math.max(configuredMaxHours + 6, 18) : 18;
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
                <span class="badge ${getBadgeClass(status)}">${escapeHtml(status)}</span>
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
};
