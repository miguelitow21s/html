// @ts-nocheck
import { CACHE_TTLS, DEFAULT_SYSTEM_SETTINGS } from '../constants.js';
import { apiClient } from '../api.js';
import {
    asArray,
    buildAreaMeta,
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
            this.data.currentShift = this.enrichEmployeeShiftRecord(dashboard?.active_shift, dashboard);
            this.data.currentScheduledShift = this.data.currentShift
                ? null
                : this.enrichEmployeeShiftRecord(
                      this.getEmployeePendingScheduledShift(dashboard?.scheduled_shifts),
                      dashboard
                  );
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
        return (this.data.employee.openTasks || []).filter((t) => this.isRestaurantScopedTask(t));
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
            detailsCopy.textContent = [
                task.description || dueText,
                restaurantName ? `Restaurante: ${restaurantName}` : '',
            ]
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
        this.showLoading('Verificando turno...', 'Consultando si tienes un turno disponible para continuar.');

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
                    title: 'Turno no disponible',
                });
                this.navigate('employee-dashboard');
                return;
            }

            this.navigate('employee-shift-start');
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible validar tu turno actual.'), {
                tone: 'error',
                title: 'No fue posible continuar',
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
                title: 'Turno no disponible',
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
            hasActiveShift ? 'Restaurante del turno activo' : 'Restaurante del turno programado'
        );
        document.getElementById('shift-start-schedule').textContent = this.getEmployeeShiftScheduleText(shift, {
            hasActiveShift,
        });

        if (button) {
            button.innerHTML = hasActiveShift
                ? this.shouldResumeActiveShiftInCleaning(shift)
                    ? 'Continuar con el Turno Activo <i class="fas fa-arrow-right"></i>'
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
            this.showToast('Tu ubicación no está verificada. Pulsa "Verificar Ubicación" para continuar.', {
                tone: 'warning',
                title: 'Ubicación pendiente',
            });
            return;
        }

        if (!this.healthCertified) {
            this.showToast('Debes marcar el certificado de salud/aptitud antes de iniciar el turno.', {
                tone: 'warning',
                title: 'Falta certificado de salud',
            });
            return;
        }

        if (!hasActiveShift && !canStartShift) {
            this.showToast(this.getShiftStartWindowCopy(scheduledShift), {
                tone: 'warning',
                title: 'Turno no disponible',
            });
            return;
        }

        this.showLoading('Iniciando turno...', 'Espera un momento.');

        try {
            await this.ensureOtpVerification();
            const location = this.location || (await this.captureLocation({ updateUi: false }));

            if (!this.data.currentShift) {
                const result = await apiClient.startShift({
                    restaurant_id: scheduledShift.restaurant_id,
                    scheduled_shift_id: scheduledShift.id,
                    lat: location.lat,
                    lng: location.lng,
                    fit_for_work: true,
                    declaration: 'Me encuentro en condiciones de iniciar labores.',
                });

                this.data.currentShift = this.enrichEmployeeShiftRecord(
                    {
                        ...scheduledShift,
                        id: result?.shift_id,
                        scheduled_shift_id: scheduledShift.id,
                        restaurant_id: scheduledShift.restaurant_id,
                        restaurant: scheduledShift.restaurant,
                        start_time: new Date().toISOString(),
                        state: 'activo',
                    },
                    this.data.employee.dashboard
                );
                this.data.currentScheduledShift = null;
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
                this.showToast(
                    'Aún faltan evidencias iniciales del turno activo. Completa las fotos de inicio para continuar.',
                    {
                        tone: 'info',
                        title: 'Faltan fotos iniciales',
                    }
                );
            }

            this.navigate('employee-shift-photos');
        } catch (error) {
            if (this.isShiftStartOutsideWindow(error)) {
                this.showToast(this.getShiftStartWindowOutsideMessage(error), {
                    tone: 'warning',
                    title: 'Turno fuera de ventana',
                });
                void this.loadEmployeeDashboard(true);
                return;
            }

            if (this.isOutsideAllowedShiftArea(error)) {
                this.showToast('No se puede iniciar el turno porque no estás dentro del área permitida o asignada.', {
                    tone: 'warning',
                    title: 'Área no permitida',
                });
                return;
            }

            this.showToast(this.getErrorMessage(error, 'No fue posible iniciar el turno.'), {
                tone: 'error',
                title: 'No fue posible iniciar el turno',
            });
        } finally {
            this.hideLoading();
        }
    },

    async uploadShiftEvidenceBatch(type, filesMap, uploadedMap) {
        const entries = Object.entries(filesMap).filter(([area, file]) => file && !uploadedMap[area]);
        const shiftId = this.data.currentShift?.id;

        if (!shiftId) {
            throw new Error('No hay un turno activo para adjuntar evidencias.');
        }

        if (entries.length === 0) return;

        const location = this.location || (await this.captureLocation({ updateUi: false }));

        await Promise.all(
            entries.map(async ([area, file]) => {
                const [requestUpload, compressed] = await Promise.all([
                    apiClient.requestShiftEvidenceUpload(shiftId, type),
                    this.compressImage(file),
                ]);

                const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
                const path = requestUpload?.path || requestUpload?.upload?.path;

                if (!signedUrl || !path) {
                    throw new Error('No fue posible preparar la subida de la foto.');
                }

                await apiClient.uploadToSignedUrl(signedUrl, compressed, 'image/jpeg');

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
            this.showToast('Selecciona al menos un área antes de registrar las fotos iniciales.', {
                tone: 'warning',
                title: 'Selecciona áreas',
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
                ? `Faltan ${progress.remainingCount} evidencia(s) inicial(es) para continuar con el turno activo.`
                : 'Debes tomar las fotos iniciales de todas las subáreas requeridas.';
            this.showToast(message, {
                tone: 'warning',
                title: 'Faltan evidencias',
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
                            title: 'Evidencia inicial incompleta',
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

        this.showLoading('Subiendo imágenes', 'Espera');

        try {
            await this.ensureOtpVerification();
            await this.uploadShiftEvidenceBatch('inicio', this.photoFiles, this.uploadedStartAreas);
            await this.hydrateShiftEvidenceSummary(this.data.currentShift);
            this.persistCurrentShiftAreaSelection();
            this.navigate('employee-shift-cleaning');
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible subir las fotos de inicio.'), {
                tone: 'error',
                title: 'No fue posible continuar',
            });
        } finally {
            this.hideLoading();
        }
    },

    updateCleaningUI() {
        const shift = this.data.currentShift || this.data.currentScheduledShift;
        const restaurantElement = document.getElementById('cleaning-restaurant');
        if (restaurantElement) {
            restaurantElement.textContent = this.getResolvedShiftRestaurantName(shift, 'Turno activo');
        }
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
            this.showToast('Primero debes seleccionar las áreas trabajadas y registrar sus evidencias.', {
                tone: 'warning',
                title: 'Selecciona áreas',
            });
            return;
        }

        const requireEndPhotos = this.getSystemSetting(
            'evidence.require_end_photos',
            DEFAULT_SYSTEM_SETTINGS.evidence.require_end_photos
        );
        if (requireEndPhotos && Object.keys(this.endPhotoFiles).length < this.employeePhotoSlots.length) {
            this.showToast('Debes tomar las fotos finales de todas las subáreas antes de continuar.', {
                tone: 'warning',
                title: 'Faltan evidencias',
            });
            return;
        }

        const openTasks = (this.data.employee.openTasks || []).filter((t) => !this.isRestaurantScopedTask(t));
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
                    title: 'Evidencia obligatoria',
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
            'Restaurante asignado'
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
                ? 'Motivo de salida anticipada (obligatorio)'
                : 'Motivo de salida anticipada (si aplica)';
        }

        this.navigate('employee-shift-summary');
    },

    async uploadTaskEvidence(taskId, file) {
        const requestUpload = await apiClient.operationalTasksManage('request_evidence_upload', {
            task_id: taskId,
            mime_type: file.type || 'image/jpeg',
        });

        const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
        const path = requestUpload?.path || requestUpload?.upload?.path;

        if (!signedUrl || !path) {
            throw new Error('No fue posible preparar la subida de la foto de la tarea.');
        }

        await apiClient.uploadToSignedUrl(signedUrl, file, file.type);
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
            throw new Error('Debes confirmar la tarea especial antes de finalizar el turno.');
        }

        if (!confirmed) {
            return;
        }

        await Promise.all(
            tasks.map(async (task) => {
                const taskId = task.task_id || task.id;
                if (!taskId) {
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

                    const evidencePath = await this.uploadTaskEvidence(taskId, file);
                    await apiClient.operationalTasksManage('complete', {
                        task_id: taskId,
                        evidence_path: evidencePath,
                        notes,
                    });
                    return;
                }

                await apiClient.operationalTasksManage('close', {
                    task_id: taskId,
                    notes,
                });
            })
        );
    },

    async finalizeShift() {
        if (!this.data.currentShift?.id) {
            this.showToast('No hay un turno activo para finalizar.', {
                tone: 'warning',
                title: 'Sin turno activo',
            });
            return;
        }

        this.showLoading('Subiendo imágenes', 'Espera');
        const startEvidencePrecheck = {
            status: 'not-run',
            has_start_evidence: null,
            request_id: '',
        };

        try {
            await this.ensureOtpVerification();
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
                              'No fue posible validar summary_by_shift antes de finalizar el turno.',
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
                    'Debes indicar el motivo de salida anticipada para finalizar el turno antes de la hora programada.',
                    {
                        tone: 'warning',
                        title: 'Falta el motivo',
                    }
                );
                earlyEndReasonInput?.focus();
                return;
            }

            await Promise.all([
                precheckPromise,
                this.uploadShiftEvidenceBatch('fin', this.endPhotoFiles, this.uploadedEndAreas),
                this.resolveOpenEmployeeTasks(notes),
            ]);

            const endShiftPayload = await apiClient.endShift({
                shift_id: this.data.currentShift.id,
                lat: location.lat,
                lng: location.lng,
                fit_for_work: true,
                declaration: notes,
                early_end_reason: earlyEndReason,
            });
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
            this.invalidateCache('employeeDashboard', 'employeeHoursHistory');
            this.showSuccessScreen();
            void this.loadEmployeeDashboard(true).catch((error) => {
                console.warn('No fue posible refrescar el dashboard después de finalizar el turno.', error);
            });
        } catch (error) {
            const detailedMessage = this.getShiftFinalizeDetailedErrorMessage(error);
            const visibleMessage = detailedMessage || this.getErrorMessage(error, 'No fue posible finalizar el turno.');
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
                            title: 'Motivo obligatorio',
                            keepLoginMessages: true,
                            duration: 9000,
                        }
                    );
                    earlyEndReasonInput?.focus();
                }
            }

            this.showToast(visibleMessage, {
                tone: 'error',
                title: 'No fue posible finalizar el turno',
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
            restaurantName ? `Restaurante: ${escapeHtml(restaurantName)}` : '',
            dueText ? `Vence: ${escapeHtml(dueText)}` : '',
            requiresEvidence ? 'Requiere foto de evidencia.' : '',
        ].filter(Boolean);

        const actionsHtml = isDone
            ? ''
            : requiresEvidence
              ? `
            <div class="rtask-actions">
                <button type="button" class="btn btn-primary btn-sm" data-rtask-action="show-evidence" data-task-id="${taskId}">Completar tarea</button>
                <div class="rtask-evidence-wrap hidden" id="rtask-evidence-wrap-${taskId}">
                    <input type="file" accept="image/*" capture="environment" class="rtask-file-input" id="rtask-file-${taskId}">
                    <input type="text" placeholder="Observaciones (opcional)" class="rtask-notes-input dark-control" id="rtask-notes-${taskId}">
                    <button type="button" class="btn btn-primary btn-sm" data-rtask-action="submit-evidence" data-task-id="${taskId}">Enviar evidencia</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-rtask-action="cancel-evidence" data-task-id="${taskId}">Cancelar</button>
                </div>
            </div>`
              : `
            <div class="rtask-actions">
                <button type="button" class="btn btn-success btn-sm" data-rtask-action="close" data-task-id="${taskId}">Marcar completada</button>
            </div>`;

        return `<div class="rtask-card" data-task-id="${taskId}">
            <div class="rtask-header">
                <span class="rtask-title">${escapeHtml(task.title || 'Tarea de restaurante')}</span>
                <span class="badge ${getBadgeClass(status)}">${escapeHtml(status)}</span>
            </div>
            ${task.description ? `<p class="rtask-desc">${escapeHtml(task.description)}</p>` : ''}
            <p class="rtask-meta">${metaParts.join(' · ')}</p>
            ${actionsHtml}
        </div>`;
    },

    initRestaurantTaskDelegation() {
        const list = document.getElementById('employee-restaurant-tasks-list');
        if (!list || list.dataset.delegationReady) return;
        list.dataset.delegationReady = '1';
        list.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-rtask-action]');
            if (!btn) return;
            const taskId = btn.dataset.taskId;
            const action = btn.dataset.rtaskAction;
            if (action === 'close') void this.employeeCloseRestaurantTask(taskId);
            else if (action === 'submit-evidence') void this.employeeCompleteRestaurantTask(taskId);
            else if (action === 'show-evidence')
                document.getElementById(`rtask-evidence-wrap-${taskId}`)?.classList.remove('hidden');
            else if (action === 'cancel-evidence')
                document.getElementById(`rtask-evidence-wrap-${taskId}`)?.classList.add('hidden');
        });
    },

    renderEmployeeRestaurantTasks() {
        const section = document.getElementById('employee-restaurant-tasks-section');
        if (!section) return;

        const tasks = this.getEmployeeRestaurantOpenTasks();
        if (tasks.length === 0) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        const list = document.getElementById('employee-restaurant-tasks-list');
        if (!list) return;

        this.initRestaurantTaskDelegation();
        const dashboard = this.data.employee.dashboard || {};
        list.innerHTML = tasks.map((task) => this.buildRestaurantTaskCardHtml(task, dashboard)).join('');
    },

    async employeeCloseRestaurantTask(taskId) {
        try {
            await apiClient.operationalTasksManage('close', { task_id: taskId });
            this.data.employee.openTasks = (this.data.employee.openTasks || []).filter(
                (t) => (t.task_id || t.id) !== taskId
            );
            this.renderEmployeeRestaurantTasks();
            this.showToast('Tarea marcada como completada.', { tone: 'success', title: 'Listo' });
        } catch (error) {
            this.showToast(this.getEmployeeRestaurantTaskErrorMessage(error, 'No fue posible completar la tarea.'), {
                tone: 'error',
                title: 'Error al completar',
            });
        }
    },

    async employeeCompleteRestaurantTask(taskId) {
        const fileInput = document.getElementById(`rtask-file-${taskId}`);
        const notesInput = document.getElementById(`rtask-notes-${taskId}`);
        const file = fileInput?.files?.[0];
        const notes = notesInput?.value?.trim() || undefined;

        if (!file) {
            this.showToast('Selecciona una foto de evidencia antes de enviar.', {
                tone: 'warning',
                title: 'Foto requerida',
            });
            return;
        }

        this.showLoading('Subiendo evidencia...', 'Espera un momento.');
        try {
            const evidencePath = await this.uploadTaskEvidence(taskId, file);
            await apiClient.operationalTasksManage('complete', {
                task_id: taskId,
                evidence_path: evidencePath,
                notes,
            });
            this.data.employee.openTasks = (this.data.employee.openTasks || []).filter(
                (t) => (t.task_id || t.id) !== taskId
            );
            this.renderEmployeeRestaurantTasks();
            this.showToast('Tarea completada con evidencia.', { tone: 'success', title: 'Listo' });
        } catch (error) {
            this.showToast(this.getEmployeeRestaurantTaskErrorMessage(error, 'No fue posible completar la tarea.'), {
                tone: 'error',
                title: 'Error al completar',
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
            return 'Necesitas tener un turno activo en este restaurante para completar esta tarea.';
        if (code === 'RESTAURANT_FORBIDDEN') return 'No tienes permiso para operar tareas en este restaurante.';
        const httpCode = error?.payload?.error?.code;
        if (httpCode === 409) return 'Esta tarea ya fue completada o cancelada.';
        if (httpCode === 404) return 'La tarea no fue encontrada.';
        return this.getErrorMessage(error, fallback);
    },
};
