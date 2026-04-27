// @ts-nocheck
import { apiClient } from '../api.js';
import { CACHE_TTLS, ROLE_LABELS } from '../constants.js';
import {
    asArray,
    escapeHtml,
    formatDateTime,
    formatHours,
    getMonthStart,
    getRestaurantDisplayName,
    getTodayEnd,
    getTodayStart,
    initials,
    toInputDate,
    toIsoDate,
} from '../utils.js';

export const adminMethods = {
    async loadAdminDashboard() {
        const restaurants = await this.ensureAdminRestaurants();
        const canUseMetricsCache =
            this.data.admin.metrics && this.isCacheFresh('adminMetrics', CACHE_TTLS.adminMetrics);

        const metricsPromise = canUseMetricsCache
            ? Promise.resolve(this.data.admin.metrics)
            : !this.cache.adminMetricsUnavailable && restaurants.length > 0
              ? apiClient
                    .adminDashboardMetrics(
                        {
                            restaurant_id: restaurants[0].id || restaurants[0].restaurant_id,
                            period_start: toInputDate(getMonthStart()),
                            period_end: toInputDate(new Date()),
                        },
                        {
                            retryOnInvalidJwt: false,
                        }
                    )
                    .catch((error) => {
                        if (error?.status === 401 || error?.status === 403) {
                            this.cache.adminMetricsUnavailable = true;
                        }
                        console.warn('No fue posible cargar admin_dashboard_metrics.', error);
                        return null;
                    })
              : Promise.resolve(null);

        const [metrics, supervisions] = await Promise.all([
            metricsPromise,
            this.fetchAdminSupervisions(restaurants, {
                limit: 50,
            }),
        ]);

        this.data.admin.metrics = metrics;
        this.data.admin.supervisions = supervisions;
        if (!canUseMetricsCache) {
            this.touchCache('adminMetrics');
        }
        this.renderAdminMetrics(restaurants, metrics);
        this.renderAdminSupervisions(supervisions);
        this.warmAdminWorkspace();
    },

    getAdminSupervisionsRequestKey(restaurants, options = {}) {
        const {
            restaurantLimit = restaurants.length,
            from = toIsoDate(getTodayStart()),
            to = toIsoDate(getTodayEnd()),
            limit = 50,
        } = options;
        const restaurantIds = restaurants
            .slice(0, restaurantLimit)
            .map((restaurant) => String(restaurant.id || restaurant.restaurant_id || '').trim())
            .filter(Boolean)
            .join(',');

        return [
            this.currentUser?.id || this.currentUser?.email || this.currentUser?.role || 'admin',
            from,
            to,
            String(limit),
            restaurantIds,
        ].join('|');
    },

    renderAdminMetrics(restaurants, metrics) {
        const container = document.getElementById('admin-metrics-summary');
        if (!container) {
            return;
        }

        const totalRestaurants = restaurants.length;
        const totalShifts =
            metrics?.shifts?.scheduled_total ??
            metrics?.total_shifts ??
            metrics?.shifts_total ??
            metrics?.completed_shifts ??
            0;
        const totalHours =
            metrics?.productivity?.scheduled_hours_total ??
            metrics?.total_scheduled_hours ??
            metrics?.scheduled_hours_total ??
            metrics?.total_assigned_hours ??
            metrics?.total_hours ??
            metrics?.hours_worked ??
            metrics?.worked_hours ??
            0;
        const incidents = metrics?.incidents_total ?? metrics?.total_incidents ?? 0;

        container.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(totalRestaurants))}</div>
                <div class="stat-label">Restaurantes</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(totalShifts))}</div>
                <div class="stat-label">Turnos programados</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(formatHours(totalHours))}</div>
                <div class="stat-label">Horas programadas</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(incidents))}</div>
                <div class="stat-label">Novedades</div>
            </div>
        `;
    },

    async fetchAdminSupervisions(restaurants, options = {}) {
        if (this.cache.adminSupervisionsUnavailable) {
            return [];
        }

        const {
            restaurantLimit = restaurants.length,
            from = toIsoDate(getTodayStart()),
            to = toIsoDate(getTodayEnd()),
            limit = 50,
        } = options;

        const requestKey = this.getAdminSupervisionsRequestKey(restaurants, {
            restaurantLimit,
            from,
            to,
            limit,
        });
        const hasMatchingCache = this.cache.adminSupervisionsQuery === requestKey;
        const cachedSupervisions = hasMatchingCache ? asArray(this.data.admin.supervisions) : [];

        if (cachedSupervisions.length > 0 && this.isCacheFresh('adminSupervisions', CACHE_TTLS.adminSupervisions)) {
            return cachedSupervisions;
        }

        if (hasMatchingCache && this.isCacheFresh('adminSupervisions', CACHE_TTLS.adminSupervisions)) {
            return cachedSupervisions;
        }

        if ((this.cache.adminSupervisionsRateLimitedUntil || 0) > Date.now()) {
            return cachedSupervisions;
        }

        return this.runPending(`adminSupervisions:${requestKey}`, async () => {
            const grouped = [];
            const visibleRestaurants = restaurants.slice(0, restaurantLimit);

            for (let index = 0; index < visibleRestaurants.length; index += 1) {
                const restaurant = visibleRestaurants[index];

                try {
                    const result = await apiClient.supervisorPresenceManage(
                        'list_by_restaurant',
                        {
                            restaurant_id: restaurant.id || restaurant.restaurant_id,
                            from,
                            to,
                            limit,
                        },
                        {
                            retryOnInvalidJwt: false,
                        }
                    );

                    const rawItems = asArray(result);
                    if (rawItems.length > 0) {
                        console.log(
                            '[admin] supervisor_presence raw item sample:',
                            JSON.stringify(rawItems[0], null, 2)
                        );
                    }
                    grouped.push(
                        ...rawItems.map((item) => ({
                            ...item,
                            restaurant_name: getRestaurantDisplayName(item, getRestaurantDisplayName(restaurant)),
                            restaurant: item.restaurant || {
                                id: restaurant.id || restaurant.restaurant_id,
                                name: getRestaurantDisplayName(restaurant),
                            },
                        }))
                    );
                } catch (error) {
                    if (error?.status === 401 || error?.status === 403) {
                        this.cache.adminSupervisionsUnavailable = true;
                        console.warn(
                            'No fue posible cargar supervisor_presence_manage para el dashboard admin.',
                            error
                        );
                        return [];
                    }

                    if (error?.status === 429) {
                        this.cache.adminSupervisionsRateLimitedUntil = Date.now() + 90 * 1000;
                        console.warn(
                            'Se alcanzó el rate limit de supervisor_presence_manage para el monitoreo admin.',
                            error
                        );
                        return cachedSupervisions.length > 0 ? cachedSupervisions : grouped;
                    }

                    console.warn(
                        `No fue posible listar supervisiones para ${restaurant?.name || restaurant?.id}.`,
                        error
                    );
                }

                if (index < visibleRestaurants.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 120));
                }
            }

            const sorted = grouped.sort((left, right) => {
                const leftTime = new Date(left.observed_at || left.created_at || left.registered_at || 0).getTime();
                const rightTime = new Date(right.observed_at || right.created_at || right.registered_at || 0).getTime();
                return rightTime - leftTime;
            });

            this.data.admin.supervisions = sorted;
            this.cache.adminSupervisionsQuery = requestKey;
            this.cache.adminSupervisionsRateLimitedUntil = 0;
            this.touchCache('adminSupervisions');
            return sorted;
        });
    },

    async ensureAdminSupervisionMonitorSupervisors(force = false) {
        if (
            !force &&
            this.data.admin.supervisionSupervisorOptions.length > 0 &&
            this.isCacheFresh('adminMonitorSupervisors', CACHE_TTLS.adminSupervisors)
        ) {
            return this.data.admin.supervisionSupervisorOptions;
        }

        return this.runPending(`adminMonitorSupervisors:${force ? 'force' : 'default'}`, async () => {
            let supervisors = [];

            if (!force && this.data.admin.supervisors.length > 0) {
                supervisors = this.data.admin.supervisors.map((item) => ({
                    id: item.id,
                    full_name: item.full_name || item.email || 'Supervisora',
                    email: item.email || '',
                }));
            } else {
                const result = await apiClient.adminUsersManage('list', {
                    role: 'supervisora',
                    limit: 100,
                });

                supervisors = asArray(result)
                    .map((item) => ({
                        id: item.id || item.user_id || '',
                        full_name:
                            item.full_name ||
                            item.name ||
                            `${item.first_name || ''} ${item.last_name || ''}`.trim() ||
                            item.email ||
                            'Supervisora',
                        email: item.email || '',
                    }))
                    .filter((item) => item.id);
            }

            supervisors.sort((left, right) =>
                String(left.full_name || '').localeCompare(String(right.full_name || ''), 'es', { sensitivity: 'base' })
            );

            this.data.admin.supervisionSupervisorOptions = supervisors;
            this.touchCache('adminMonitorSupervisors');
            return supervisors;
        });
    },

    populateAdminSupervisionMonitorSupervisorFilter(supervisors = [], items = []) {
        const select = document.getElementById('admin-supervision-supervisor-filter');
        if (!select) {
            return;
        }

        const currentValue = String(select.value || '');
        const optionMap = new Map();

        asArray(supervisors).forEach((item) => {
            const id = String(item?.id || '').trim();
            if (!id) {
                return;
            }

            optionMap.set(id, {
                id,
                label: item.full_name || item.email || 'Supervisora',
            });
        });

        asArray(items).forEach((item) => {
            const id = String(item?.supervisor?.id || item?.supervisor_id || '').trim();
            if (!id || optionMap.has(id)) {
                return;
            }

            optionMap.set(id, {
                id,
                label: item?.supervisor?.full_name || item?.supervisor_name || item?.supervisor?.email || 'Supervisora',
            });
        });

        const options = Array.from(optionMap.values()).sort((left, right) =>
            String(left.label || '').localeCompare(String(right.label || ''), 'es', { sensitivity: 'base' })
        );

        select.innerHTML = `
            <option value="">Todas las supervisoras</option>
            ${options
                .map(
                    (item) => `
                <option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>
            `
                )
                .join('')}
        `;

        if (currentValue && optionMap.has(currentValue)) {
            select.value = currentValue;
        }
    },

    getFilteredAdminSupervisions(items = []) {
        const selectedSupervisorId = String(
            document.getElementById('admin-supervision-supervisor-filter')?.value || ''
        ).trim();
        if (!selectedSupervisorId) {
            return asArray(items);
        }

        return asArray(items).filter(
            (item) => String(item?.supervisor?.id || item?.supervisor_id || '').trim() === selectedSupervisorId
        );
    },

    applyAdminSupervisionMonitorFilter() {
        const filteredSupervisions = this.getFilteredAdminSupervisions(this.data.admin.supervisions);
        const hasSupervisorFilter = Boolean(
            String(document.getElementById('admin-supervision-supervisor-filter')?.value || '').trim()
        );

        this.renderAdminSupervisionMonitorSummary(filteredSupervisions);
        this.renderAdminSupervisions(filteredSupervisions, {
            containerId: 'admin-supervision-monitor-list',
            maxItems: Number.POSITIVE_INFINITY,
            emptyMessage: hasSupervisorFilter
                ? 'No hay supervisiones hoy para esta supervisora.'
                : 'Aún no hay supervisiones registradas hoy para monitorear.',
        });
    },

    renderAdminSupervisions(items, options = {}) {
        const {
            containerId = 'admin-supervisions-list',
            maxItems = 6,
            emptyMessage = 'Aún no hay supervisiones registradas para hoy.',
        } = options;
        const container = document.getElementById(containerId);
        if (!container) {
            return;
        }

        if (items.length === 0) {
            container.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
            return;
        }

        const visibleItems = Number.isFinite(maxItems) ? items.slice(0, maxItems) : items;

        container.innerHTML = `
            <div class="admin-supervisions-stack">
                ${visibleItems
                    .map((item) => {
                        const supervisorName = item.supervisor?.full_name || item.supervisor_name || 'Supervisora';
                        const supervisorDetail = item.supervisor?.email || item.supervisor_email || '';
                        const restaurantName = getRestaurantDisplayName(
                            item,
                            getRestaurantDisplayName(item.restaurant || null, 'Restaurante sin nombre visible')
                        );
                        const observedAt = item.observed_at || item.created_at || item.registered_at || '';
                        const observationCount =
                            asArray(item.evidences).length ||
                            Number(item.photo_count || item.evidence_count || item.photos_count || 0);

                        return `
                        <article class="admin-supervision-card">
                            <div class="admin-supervision-top">
                                <div class="admin-supervision-identity">
                                    <div class="employee-avatar admin-supervision-avatar">
                                        <i class="fas fa-user-tie"></i>
                                    </div>
                                    <div class="admin-supervision-copy">
                                        <h4>${escapeHtml(supervisorName)}</h4>
                                        <p>${escapeHtml(supervisorDetail || restaurantName)}</p>
                                    </div>
                                </div>
                                <span class="badge badge-success admin-supervision-status">Supervisión registrada</span>
                            </div>
                            <div class="admin-supervision-meta">
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Restaurante</span>
                                    <span class="admin-supervision-meta-value">${escapeHtml(restaurantName)}</span>
                                </div>
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Hora</span>
                                    <span class="admin-supervision-meta-value">${escapeHtml(formatDateTime(observedAt))}</span>
                                </div>
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Observación</span>
                                    <span class="admin-supervision-meta-value">${escapeHtml(item.observations || item.notes || 'Sin observaciones registradas')}</span>
                                </div>
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Evidencias</span>
                                    <span class="admin-supervision-meta-value">${escapeHtml(observationCount > 0 ? `${observationCount} foto(s)` : 'Sin conteo disponible')}</span>
                                </div>
                            </div>
                        </article>
                    `;
                    })
                    .join('')}
            </div>
        `;
    },

    renderAdminSupervisionMonitorSummary(items) {
        const container = document.getElementById('admin-supervision-monitor-summary');
        if (!container) {
            return;
        }

        const supervisions = asArray(items);
        const totalSupervisions = supervisions.length;
        const uniqueSupervisors = new Set();
        const uniqueRestaurants = new Set();
        let totalEvidences = 0;

        supervisions.forEach((item) => {
            const supervisorKey = String(
                item.supervisor?.id || item.supervisor_id || item.supervisor_name || ''
            ).trim();
            const restaurantKey = String(
                item.restaurant?.id || item.restaurant_id || item.restaurant_name || ''
            ).trim();
            if (supervisorKey) {
                uniqueSupervisors.add(supervisorKey);
            }
            if (restaurantKey) {
                uniqueRestaurants.add(restaurantKey);
            }
            totalEvidences +=
                asArray(item.evidences).length ||
                Number(item.photo_count || item.evidence_count || item.photos_count || 0);
        });

        container.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(totalSupervisions))}</div>
                <div class="stat-label">Supervisiones</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(uniqueSupervisors.size))}</div>
                <div class="stat-label">Supervisoras activas</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(uniqueRestaurants.size))}</div>
                <div class="stat-label">Restaurantes visitados</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(totalEvidences))}</div>
                <div class="stat-label">Evidencias</div>
            </div>
        `;
    },

    async loadAdminSupervisionMonitor() {
        const restaurants = await this.ensureAdminRestaurants();
        const [supervisors, supervisions] = await Promise.all([
            this.ensureAdminSupervisionMonitorSupervisors(),
            this.fetchAdminSupervisions(restaurants, {
                restaurantLimit: restaurants.length,
                from: toIsoDate(getTodayStart()),
                to: toIsoDate(getTodayEnd()),
                limit: 50,
            }),
        ]);

        this.data.admin.supervisions = supervisions;
        this.populateAdminSupervisionMonitorSupervisorFilter(supervisors, supervisions);
        this.applyAdminSupervisionMonitorFilter();
    },

    populateAdminSupervisorRestaurantFilter() {
        const select = document.getElementById('admin-supervisor-restaurant-filter');
        if (!select) {
            return;
        }

        const currentValue = select.value;
        select.innerHTML = `
            <option value="">Todos los restaurantes</option>
            ${this.data.admin.restaurants
                .map(
                    (restaurant) => `
                <option value="${escapeHtml(String(restaurant.id || restaurant.restaurant_id))}">
                    ${escapeHtml(getRestaurantDisplayName(restaurant))}
                </option>
            `
                )
                .join('')}
        `;

        if (currentValue) {
            select.value = currentValue;
        }
    },

    resetAdminSupervisorForm() {
        const form = document.getElementById('admin-supervisor-form');
        form?.reset();

        const editId = document.getElementById('admin-supervisor-edit-id');
        const formTitle = document.getElementById('admin-supervisor-form-title');
        const submitLabel = document.getElementById('admin-supervisor-submit-label');
        const cancelButton = document.getElementById('admin-supervisor-cancel-btn');
        const activeCheckbox = document.getElementById('admin-supervisor-active');

        if (editId) {
            editId.value = '';
        }

        if (formTitle) {
            formTitle.textContent = 'Nueva Supervisora';
        }

        if (submitLabel) {
            submitLabel.textContent = 'Guardar Supervisora';
        }

        if (cancelButton) {
            cancelButton.classList.add('hidden');
        }

        if (activeCheckbox) {
            activeCheckbox.checked = true;
        }
    },

    beginEditAdminSupervisor(userId) {
        const supervisor = this.data.admin.supervisors.find((item) => String(item.id) === String(userId));
        if (!supervisor) {
            this.showToast('No fue posible cargar la supervisora seleccionada.', {
                tone: 'error',
                title: 'No fue posible continuar',
            });
            return;
        }

        document.getElementById('admin-supervisor-edit-id').value = supervisor.id;
        document.getElementById('admin-supervisor-full-name').value = supervisor.full_name || '';
        document.getElementById('admin-supervisor-email').value = supervisor.email || '';
        document.getElementById('admin-supervisor-phone').value = supervisor.phone_e164 || '';
        document.getElementById('admin-supervisor-active').checked = supervisor.is_active !== false;
        document.getElementById('admin-supervisor-form-title').textContent = 'Editar Supervisora';
        document.getElementById('admin-supervisor-submit-label').textContent = 'Actualizar Supervisora';
        document.getElementById('admin-supervisor-cancel-btn').classList.remove('hidden');

        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    async submitAdminSupervisorForm() {
        const editId = document.getElementById('admin-supervisor-edit-id')?.value?.trim();
        const fullName = document.getElementById('admin-supervisor-full-name')?.value?.trim();
        const email = document.getElementById('admin-supervisor-email')?.value?.trim();
        const phone = document.getElementById('admin-supervisor-phone')?.value?.trim();
        const isActive = document.getElementById('admin-supervisor-active')?.checked ?? true;

        if (!fullName || !email || !phone) {
            this.showToast('Completa nombre, correo y teléfono de la supervisora.', {
                tone: 'warning',
                title: 'Faltan datos',
            });
            return;
        }

        if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
            this.showToast('El teléfono debe estar en formato E.164, por ejemplo +573001112233.', {
                tone: 'warning',
                title: 'Teléfono inválido',
            });
            return;
        }

        const isEditing = Boolean(editId);
        const payload = isEditing
            ? {
                  user_id: editId,
                  full_name: fullName,
                  email,
                  phone_number: phone,
                  is_active: isActive,
              }
            : {
                  role: 'supervisora',
                  full_name: fullName,
                  email,
                  phone_number: phone,
                  is_active: isActive,
              };

        this.showLoading(isEditing ? 'Actualizando supervisora...' : 'Creando supervisora...', 'Guardando los datos.');

        try {
            const result = await apiClient.adminUsersManage(isEditing ? 'update' : 'create', payload);
            this.invalidateCache('adminSupervisors');
            this.resetAdminSupervisorForm();
            await this.loadAdminSupervisors(true);

            const initialPassword =
                result?.temporary_password || result?.generated_password || result?.password || '123456';
            if (!isEditing) {
                this.showToast(`Supervisora creada correctamente. Clave inicial: ${initialPassword}.`, {
                    tone: 'success',
                    title: 'Creación exitosa',
                    duration: 5200,
                });
            } else {
                this.showToast('Supervisora actualizada correctamente.', {
                    tone: 'success',
                    title: 'Actualización exitosa',
                });
            }
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible guardar la supervisora.'), {
                tone: 'error',
                title: 'No fue posible guardar la supervisora',
            });
        } finally {
            this.hideLoading();
        }
    },

    async loadAdminSupervisors(force = false) {
        const container = document.getElementById('admin-supervisors-list');
        if (container && (force || this.data.admin.supervisors.length === 0)) {
            container.innerHTML = '<div class="empty-state">Cargando supervisoras...</div>';
        }

        await this.ensureAdminRestaurants(force);
        this.populateAdminSupervisorRestaurantFilter();

        const search = document.getElementById('admin-supervisor-search')?.value?.trim();
        const statusFilter = document.getElementById('admin-supervisor-status-filter')?.value || 'all';
        const restaurantFilter = document.getElementById('admin-supervisor-restaurant-filter')?.value || '';
        const queryKey = JSON.stringify({
            search: search || '',
            statusFilter,
            restaurantFilter,
        });

        if (
            !force &&
            this.data.admin.supervisors.length > 0 &&
            this.cache.adminSupervisorsQuery === queryKey &&
            this.isCacheFresh('adminSupervisors', CACHE_TTLS.adminSupervisors)
        ) {
            const cachedSupervisors = restaurantFilter
                ? this.data.admin.supervisors.filter((item) =>
                      item.assignments.some(
                          (assignment) => String(assignment.restaurant_id) === String(restaurantFilter)
                      )
                  )
                : this.data.admin.supervisors;
            this.renderAdminSupervisorList(cachedSupervisors);
            return;
        }

        const payload = {
            role: 'supervisora',
            limit: 100,
        };

        if (search) {
            payload.search = search;
        }

        if (statusFilter === 'active') {
            payload.is_active = true;
        } else if (statusFilter === 'inactive') {
            payload.is_active = false;
        }

        const supervisors = await this.runPending(
            `adminSupervisors:${queryKey}:${force ? 'force' : 'default'}`,
            async () => {
                const result = await apiClient.adminUsersManage('list', payload);
                return Promise.all(
                    asArray(result).map(async (item) => {
                        const supervisorId = item.id || item.user_id;
                        let assignments = [];

                        if (supervisorId) {
                            try {
                                assignments = asArray(
                                    await apiClient.adminSupervisorsManage('list_by_supervisor', {
                                        supervisor_id: supervisorId,
                                    })
                                );
                            } catch (error) {
                                console.warn(
                                    `No fue posible cargar asignaciones para la supervisora ${supervisorId}.`,
                                    error
                                );
                            }
                        }

                        const normalizedAssignments = assignments
                            .map((assignment) => {
                                const restaurantId = assignment.restaurant_id || assignment.restaurant?.id;
                                const restaurant = this.data.admin.restaurants.find(
                                    (candidate) =>
                                        String(candidate.id || candidate.restaurant_id) === String(restaurantId)
                                );

                                if (!restaurantId) {
                                    return null;
                                }

                                return {
                                    restaurant_id: restaurantId,
                                    name: getRestaurantDisplayName(assignment, getRestaurantDisplayName(restaurant)),
                                };
                            })
                            .filter(Boolean);

                        return {
                            id: supervisorId,
                            full_name:
                                item.full_name ||
                                item.name ||
                                `${item.first_name || ''} ${item.last_name || ''}`.trim() ||
                                'Supervisora',
                            email: item.email || '-',
                            phone_e164: item.phone_e164 || item.phone_number || '-',
                            is_active: item.is_active !== false,
                            assignments: normalizedAssignments,
                            raw: item,
                        };
                    })
                );
            }
        );

        this.data.admin.supervisors = supervisors;

        const filteredSupervisors = restaurantFilter
            ? supervisors.filter((item) =>
                  item.assignments.some((assignment) => String(assignment.restaurant_id) === String(restaurantFilter))
              )
            : supervisors;

        this.cache.adminSupervisorsQuery = queryKey;
        this.touchCache('adminSupervisors');
        this.renderAdminSupervisorList(filteredSupervisors);
    },

    renderAdminSupervisorList(supervisors) {
        const container = document.getElementById('admin-supervisors-list');
        if (!container) {
            return;
        }

        if (supervisors.length === 0) {
            container.innerHTML =
                '<div class="empty-state">No hay supervisoras que coincidan con el filtro actual.</div>';
            return;
        }

        const canManagePhoneBinding = this.currentUser?.role === 'super_admin';
        container.innerHTML = supervisors
            .map((supervisor) => {
                const supervisorId = String(supervisor.id || '');
                const assignedRestaurants = supervisor.assignments || [];
                const availableRestaurants = this.data.admin.restaurants.filter(
                    (restaurant) =>
                        !assignedRestaurants.some(
                            (assignment) =>
                                String(assignment.restaurant_id) === String(restaurant.id || restaurant.restaurant_id)
                        )
                );
                const selectId = `admin-supervisor-assign-${supervisorId}`;
                const statusLabel = supervisor.is_active ? 'Activa' : 'Inactiva';
                const statusClass = supervisor.is_active ? 'badge-success' : 'badge-danger';
                const assignDisabled = availableRestaurants.length === 0 ? 'disabled' : '';
                const phoneBindingAction = this.getPhoneBindingActionState(supervisor);
                const clearPhoneButton =
                    canManagePhoneBinding && phoneBindingAction.visible
                        ? `
                        <button
                            type="button"
                            class="btn btn-warning btn-inline"
                            data-action="clear-phone-supervisor"
                            data-supervisor-id="${escapeHtml(supervisorId)}"
                            title="Remover el teléfono actual del perfil para poder registrar otro."
                        >
                            <i class="fas fa-unlink"></i>
                            <span>Desvincular Teléfono</span>
                        </button>
                    `
                        : '';

                return `
                <article class="admin-supervisor-card">
                    <div class="admin-supervisor-top">
                        <div class="admin-supervisor-identity">
                            <div class="employee-avatar admin-supervisor-avatar">${escapeHtml(initials(supervisor.full_name || supervisor.email))}</div>
                            <div class="admin-supervisor-copy">
                                <h4>${escapeHtml(supervisor.full_name || 'Supervisora')}</h4>
                                <p>${escapeHtml(supervisor.email || '-')} • ${escapeHtml(supervisor.phone_e164 || '-')}</p>
                                <div class="audit-meta">ID: ${escapeHtml(supervisorId || '-')}</div>
                            </div>
                        </div>
                        <span class="badge ${statusClass} admin-supervisor-status">${statusLabel}</span>
                    </div>

                    <div class="admin-supervisor-section">
                        <span class="info-item-label">Restaurantes asignados</span>
                        ${
                            assignedRestaurants.length > 0
                                ? `
                            <div class="assignment-list">
                                ${assignedRestaurants
                                    .map(
                                        (assignment) => `
                                    <span class="assignment-chip">
                                        ${escapeHtml(getRestaurantDisplayName(assignment))}
                                        <button
                                            type="button"
                                            title="Desasignar"
                                            data-action="admin-unassign-restaurant"
                                            data-supervisor-id="${escapeHtml(supervisorId)}"
                                            data-restaurant-id="${escapeHtml(String(assignment.restaurant_id))}"
                                        >
                                            <i class="fas fa-times"></i>
                                        </button>
                                    </span>
                                `
                                    )
                                    .join('')}
                            </div>
                        `
                                : '<p class="muted-copy">Sin restaurantes asignados todavía.</p>'
                        }
                    </div>

                    <div class="admin-supervisor-assignment-row">
                        <div class="form-group admin-panel-field admin-supervisor-select-wrap">
                            <label>Asignar restaurante</label>
                            <select id="${escapeHtml(selectId)}" class="dark-control" ${assignDisabled}>
                                <option value="">${availableRestaurants.length > 0 ? 'Selecciona un restaurante' : 'Sin restaurantes disponibles'}</option>
                                ${availableRestaurants
                                    .map(
                                        (restaurant) => `
                                    <option value="${escapeHtml(String(restaurant.id || restaurant.restaurant_id))}">
                                        ${escapeHtml(getRestaurantDisplayName(restaurant))}
                                    </option>
                                `
                                    )
                                    .join('')}
                            </select>
                        </div>
                        <button
                            type="button"
                            class="btn btn-primary btn-inline admin-assign-btn"
                            data-action="admin-assign-restaurant"
                            data-supervisor-id="${escapeHtml(supervisorId)}"
                            ${assignDisabled}
                        >
                            <i class="fas fa-link"></i>
                            <span>Asignar</span>
                        </button>
                    </div>

                    <div class="admin-supervisor-actions">
                        ${clearPhoneButton}
                        <button
                            type="button"
                            class="btn btn-secondary btn-inline"
                            data-action="admin-edit-supervisor"
                            data-supervisor-id="${escapeHtml(supervisorId)}"
                        >
                            <i class="fas fa-pen"></i>
                            <span>Editar</span>
                        </button>
                        <button
                            type="button"
                            class="btn ${supervisor.is_active ? 'btn-danger' : 'btn-success'} btn-inline"
                            data-action="admin-toggle-supervisor-status"
                            data-supervisor-id="${escapeHtml(supervisorId)}"
                            data-currently-active="${supervisor.is_active ? 'true' : 'false'}"
                        >
                            <i class="fas ${supervisor.is_active ? 'fa-user-slash' : 'fa-user-check'}"></i>
                            <span>${supervisor.is_active ? 'Desactivar' : 'Activar'}</span>
                        </button>
                    </div>
                </article>
            `;
            })
            .join('');
    },

    async toggleAdminSupervisorStatus(userId, isCurrentlyActive) {
        this.showLoading(
            isCurrentlyActive ? 'Desactivando supervisora...' : 'Activando supervisora...',
            'Actualizando el acceso.'
        );

        try {
            await apiClient.adminUsersManage(isCurrentlyActive ? 'deactivate' : 'activate', {
                user_id: userId,
                ...(isCurrentlyActive ? { reason: 'Actualización desde el panel administrativo.' } : {}),
            });

            this.invalidateCache('adminSupervisors');
            await this.loadAdminSupervisors(true);
            this.showToast(
                isCurrentlyActive ? 'Supervisora desactivada correctamente.' : 'Supervisora activada correctamente.',
                {
                    tone: 'success',
                    title: 'Cambio guardado',
                }
            );
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible actualizar el estado de la supervisora.'), {
                tone: 'error',
                title: 'No fue posible actualizar el estado',
            });
        } finally {
            this.hideLoading();
        }
    },

    async assignRestaurantToSupervisor(supervisorId) {
        const select = document.getElementById(`admin-supervisor-assign-${supervisorId}`);
        const restaurantId = select?.value;

        if (!restaurantId) {
            this.showToast('Selecciona un restaurante para asignar.', {
                tone: 'warning',
                title: 'Falta seleccionar restaurante',
            });
            return;
        }

        this.showLoading('Asignando restaurante...', 'Guardando el cambio.');

        try {
            await apiClient.adminSupervisorsManage('assign', {
                supervisor_id: supervisorId,
                restaurant_id: Number.isFinite(Number(restaurantId)) ? Number(restaurantId) : restaurantId,
            });

            this.invalidateCache('adminSupervisors');
            await this.loadAdminSupervisors(true);
            this.showToast('Restaurante asignado correctamente.', {
                tone: 'success',
                title: 'Asignación exitosa',
            });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible asignar el restaurante.'), {
                tone: 'error',
                title: 'No fue posible asignar el restaurante',
            });
        } finally {
            this.hideLoading();
        }
    },

    async unassignRestaurantFromSupervisor(supervisorId, restaurantId) {
        this.showLoading('Desasignando restaurante...', 'Guardando el cambio.');

        try {
            await apiClient.adminSupervisorsManage('unassign', {
                supervisor_id: supervisorId,
                restaurant_id: Number.isFinite(Number(restaurantId)) ? Number(restaurantId) : restaurantId,
            });

            this.invalidateCache('adminSupervisors');
            await this.loadAdminSupervisors(true);
            this.showToast('Restaurante desasignado correctamente.', {
                tone: 'success',
                title: 'Cambio guardado',
            });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible desasignar el restaurante.'), {
                tone: 'error',
                title: 'No fue posible desasignar el restaurante',
            });
        } finally {
            this.hideLoading();
        }
    },

    async requestPasswordReset() {
        if (!this.supabase) {
            this.setLoginError('Supabase Auth no está disponible para recuperar la contraseña.');
            return;
        }

        const email = document.getElementById('login-email')?.value?.trim();
        if (!email) {
            this.setLoginError('Escribe primero tu correo electrónico para enviar el enlace de recuperación.');
            return;
        }

        this.setLoginError('');
        this.setLoginNotice('');

        this.showLoading('Enviando recuperación...', 'Solicitando enlace de restablecimiento de contraseña.');

        try {
            const result = await this.supabase.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.href,
            });

            if (result.error) {
                throw result.error;
            }

            this.setLoginNotice(`Si el correo ${email} existe, Supabase enviará las instrucciones de recuperación.`);
        } catch (error) {
            this.setLoginError(this.getErrorMessage(error, 'No fue posible solicitar la recuperación de contraseña.'));
        } finally {
            this.hideLoading();
        }
    },

    adminAction(action) {
        const routes = {
            supervisores: 'admin-supervisors',
            'monitoreo-supervisoras': 'admin-supervision-monitor',
        };

        const page = routes[action];
        if (!page) {
            this.showToast('Acción administrativa en preparación.', {
                tone: 'info',
                title: 'Próximamente',
            });
            return;
        }

        this.navigate(page);
    },

    showNotification() {
        const backendStatus = this.backend.connected ? 'Sistema listo' : 'Sistema en revisión';
        const userRole = this.currentUser ? ROLE_LABELS[this.currentUser.role] || this.currentUser.role : 'Sin sesión';
        this.showToast(`• ${backendStatus}\n• Rol actual: ${userRole}\n• Sesión lista para operar.`, {
            tone: 'info',
            title: 'Notificaciones',
        });
    },

    updateDebugInfo() {
        const debugStatus = document.getElementById('debug-status');
        const debugPage = document.getElementById('debug-page');
        const debugUser = document.getElementById('debug-user');
        const debugBackend = document.getElementById('debug-backend');

        if (debugStatus) {
            debugStatus.textContent = this.backend.connected ? 'OK' : 'APP';
        }

        if (debugPage) {
            debugPage.textContent = this.currentPage;
        }

        if (debugUser) {
            debugUser.textContent = this.currentUser?.email || 'none';
        }

        if (debugBackend) {
            debugBackend.textContent = this.backend.statusText;
        }
    },
};
