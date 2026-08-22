// @ts-nocheck
import { apiClient } from '../api.js';
import { CACHE_TTLS, ROLE_LABELS } from '../constants.js';
import { t } from '../i18n.js';
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
                <div class="stat-label">${escapeHtml(t('admin.dashboard.restaurants'))}</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(totalShifts))}</div>
                <div class="stat-label">${escapeHtml(t('admin.dashboard.shifts'))}</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(formatHours(totalHours))}</div>
                <div class="stat-label">${escapeHtml(t('admin.metrics.scheduled.hours'))}</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(incidents))}</div>
                <div class="stat-label">${escapeHtml(t('admin.metrics.incidents'))}</div>
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

                    console.warn(`No fue posible listar auditorías para ${restaurant?.name || restaurant?.id}.`, error);
                }

                if (index < visibleRestaurants.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 120));
                }
            }

            const sorted = grouped.sort((left, right) => {
                const leftTime = new Date(left.recorded_at || left.observed_at || left.created_at || left.registered_at || 0).getTime();
                const rightTime = new Date(right.recorded_at || right.observed_at || right.created_at || right.registered_at || 0).getTime();
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
                    full_name: item.full_name || item.email || t('admin.supervisors.role.fallback'),
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
                            t('admin.supervisors.role.fallback'),
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

        // Bind del onchange una sola vez. El HTML tiene onchange inline pero en
        // algunos móviles / con re-renders del DOM el handler puede quedar sin
        // efecto. Con addEventListener explícito nos aseguramos que siempre
        // aplique el filtro cuando el usuario cambia el dropdown.
        if (!select.dataset.filterBound) {
            select.dataset.filterBound = '1';
            select.addEventListener('change', () => {
                this.applyAdminSupervisionMonitorFilter();
            });
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
                label: item.full_name || item.email || t('admin.supervisors.role.fallback'),
            });
        });

        asArray(items).forEach((item) => {
            const id = String(item?.supervisor?.id || item?.supervisor_id || '').trim();
            if (!id || optionMap.has(id)) {
                return;
            }

            optionMap.set(id, {
                id,
                label:
                    item?.supervisor?.full_name ||
                    item?.supervisor_name ||
                    item?.supervisor?.email ||
                    t('admin.supervisors.role.fallback'),
            });
        });

        const options = Array.from(optionMap.values()).sort((left, right) =>
            String(left.label || '').localeCompare(String(right.label || ''), 'es', { sensitivity: 'base' })
        );

        select.innerHTML = `
            <option value="">${escapeHtml(t('admin.supervision.monitor.filter.all'))}</option>
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

        // Aceptamos varios aliases porque backend puede usar user_id o
        // registered_by en lugar de supervisor_id según la vista.
        return asArray(items).filter((item) => {
            const candidates = [
                item?.supervisor?.id,
                item?.supervisor?.user_id,
                item?.supervisor_id,
                item?.user_id,
                item?.registered_by,
                item?.created_by,
            ]
                .map((v) => String(v || '').trim())
                .filter(Boolean);
            return candidates.some((c) => c === selectedSupervisorId);
        });
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
                ? 'No hay auditorías hoy para este inspector.'
                : 'Aún no hay auditorías registradas hoy para seguimiento.',
        });
    },

    renderAdminSupervisions(items, options = {}) {
        const {
            containerId = 'admin-supervisions-list',
            maxItems = 6,
            emptyMessage = t('admin.audits.none.today'),
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

        // Guardamos por id para poder recuperar la evidencia cuando se clickea "Ver fotos".
        this._adminSupervisionsIndex = this._adminSupervisionsIndex || {};
        visibleItems.forEach((item) => {
            const key = String(item?.id || item?.supervisor_presence_id || item?.uuid || '').trim();
            if (key) this._adminSupervisionsIndex[key] = item;
        });

        // Log detallado por supervision — permite diagnosticar en 5 seg cuál
        // campo del payload contiene las fotos si el usuario ve 'Sin fotos'.
        console.info('[admin] renderAdminSupervisions', {
            containerId,
            total: visibleItems.length,
            supervisions: visibleItems.map((item, idx) => ({
                idx,
                id: item?.id || item?.supervisor_presence_id || null,
                restaurant: item?.restaurant?.name || item?.restaurant_name,
                supervisor:
                    item?.supervisor?.full_name || item?.supervisor_name || null,
                topLevelKeys: Object.keys(item || {}),
                extractedEvidenceCount: this.extractSupervisionEvidences(item).length,
                rawBuckets: {
                    evidences_is_array: Array.isArray(item?.evidences),
                    evidences_count: Array.isArray(item?.evidences) ? item.evidences.length : null,
                    evidences_type: typeof item?.evidences,
                    evidence_urls: asArray(item?.evidence_urls).length,
                    photos: asArray(item?.photos).length,
                    photo_urls: asArray(item?.photo_urls).length,
                    images: asArray(item?.images).length,
                    photo_count_field: item?.photo_count ?? item?.evidence_count ?? null,
                },
                firstEvidenceRecord: Array.isArray(item?.evidences) && item.evidences[0]
                    ? {
                          keys: Object.keys(item.evidences[0]),
                          sample: item.evidences[0],
                      }
                    : null,
            })),
        });

        // Backend v3: cada item puede venir con supervisor_id plano SIN objeto
        // supervisor anidado. Resolvemos nombre/email con la lista cargada.
        const supervisorLookup = new Map();
        asArray(this.data.admin.supervisionSupervisorOptions).forEach((s) => {
            const id = String(s?.id || '').trim();
            if (id) supervisorLookup.set(id, s);
        });
        asArray(this.data.admin.supervisors).forEach((s) => {
            const id = String(s?.id || '').trim();
            if (id && !supervisorLookup.has(id)) supervisorLookup.set(id, s);
        });

        container.innerHTML = `
            <div class="admin-supervisions-stack">
                ${visibleItems
                    .map((item) => {
                        const supervisorId = String(
                            item?.supervisor?.id ||
                                item?.supervisor_id ||
                                item?.user_id ||
                                item?.registered_by ||
                                ''
                        ).trim();
                        const supervisorFromLookup = supervisorId ? supervisorLookup.get(supervisorId) : null;
                        const supervisorName =
                            item.supervisor?.full_name ||
                            item.supervisor_name ||
                            supervisorFromLookup?.full_name ||
                            t('admin.supervisors.role.fallback');
                        const supervisorDetail =
                            item.supervisor?.email ||
                            item.supervisor_email ||
                            supervisorFromLookup?.email ||
                            '';
                        const restaurantName = getRestaurantDisplayName(
                            item,
                            getRestaurantDisplayName(item.restaurant || null, 'Sitio sin nombre visible')
                        );
                        const observedAt = item.recorded_at || item.observed_at || item.created_at || item.registered_at || '';
                        const evidences = this.extractSupervisionEvidences(item);
                        const observationCount = evidences.length;
                        const itemKey = String(item?.id || item?.supervisor_presence_id || item?.uuid || '').trim();

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
                                <span class="badge badge-success admin-supervision-status">Auditoría registrada</span>
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
                                    <span class="admin-supervision-meta-value">${escapeHtml(observationCount > 0 ? `${observationCount} foto(s)` : 'Sin fotos disponibles')}</span>
                                </div>
                            </div>
                            ${
                                observationCount > 0 && itemKey
                                    ? `<div style="margin-top:12px;">
                                        <button type="button" class="btn btn-secondary btn-sm" data-action="openAdminSupervisionEvidences" data-args="${escapeHtml(itemKey)}">
                                            <i class="fas fa-images"></i> Ver ${observationCount} foto(s)
                                        </button>
                                       </div>`
                                    : ''
                            }
                        </article>
                    `;
                    })
                    .join('')}
            </div>
        `;
    },

    /**
     * Extrae la lista de URLs firmadas de evidencia de una supervisión, aceptando
     * varios formatos que puede devolver el backend (evidences[].signed_url,
     * evidence_urls[], photos[].url, etc.).
     */
    extractSupervisionEvidences(supervision) {
        const collected = [];
        const seen = new Set();
        const pushUrl = (raw, meta = {}) => {
            const url = String(raw || '').trim();
            if (!url || seen.has(url)) return;
            seen.add(url);
            collected.push({ url, ...meta });
        };

        // Objeto {area: {...}} o array [{...}]
        const pushFromRecord = (ev) => {
            if (!ev || typeof ev !== 'object') return;
            const url =
                ev.signed_url ||
                ev.url ||
                ev.public_url ||
                ev.href ||
                ev.file_url ||
                ev.image_url ||
                '';
            pushUrl(url, {
                is_video: Boolean(ev.is_video || String(ev.mime_type || '').startsWith('video/')),
                captured_at: ev.captured_at || ev.observed_at || ev.created_at || '',
                // Backend v3 envía 'label' plano; mantenemos aliases legacy.
                label: ev.label || ev.area_label || ev.subarea_label || ev.name || '',
            });
        };

        asArray(supervision?.evidences).forEach(pushFromRecord);
        asArray(supervision?.evidence_items).forEach(pushFromRecord);
        asArray(supervision?.photos).forEach(pushFromRecord);
        asArray(supervision?.images).forEach(pushFromRecord);

        // Arrays de strings (URLs sueltas)
        asArray(supervision?.evidence_urls).forEach((url) => pushUrl(url));
        asArray(supervision?.photo_urls).forEach((url) => pushUrl(url));
        asArray(supervision?.image_urls).forEach((url) => pushUrl(url));
        asArray(supervision?.signed_urls).forEach((url) => pushUrl(url));

        // Objeto {area1: 'url', area2: 'url'} — algunas APIs devuelven así
        if (supervision?.evidences && typeof supervision.evidences === 'object' && !Array.isArray(supervision.evidences)) {
            Object.entries(supervision.evidences).forEach(([label, val]) => {
                if (typeof val === 'string') pushUrl(val, { label });
                else if (val && typeof val === 'object') pushFromRecord({ ...val, label: val.label || label });
            });
        }

        return collected;
    },

    openAdminSupervisionEvidences(itemKey) {
        const supervision = this._adminSupervisionsIndex?.[String(itemKey || '').trim()];
        if (!supervision) {
            this.showToast('No fue posible recuperar los datos de esta auditoría.', {
                tone: 'error',
                title: 'Auditoría no disponible',
            });
            return;
        }
        const evidences = this.extractSupervisionEvidences(supervision);
        if (evidences.length === 0) {
            this.showToast('Esta auditoría no tiene fotos registradas.', {
                tone: 'info',
                title: 'Sin evidencias',
            });
            return;
        }
        this.showAdminSupervisionEvidencesModal(supervision, evidences);
    },

    showAdminSupervisionEvidencesModal(supervision, evidences) {
        let modal = document.getElementById('modal-admin-supervision-evidences');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-admin-supervision-evidences';
            modal.className = 'modal';
            document.body.appendChild(modal);
        }

        const supervisorName =
            supervision?.supervisor?.full_name || supervision?.supervisor_name || t('admin.supervisors.role.fallback');
        const restaurantName = getRestaurantDisplayName(
            supervision,
            getRestaurantDisplayName(supervision?.restaurant || null, 'Sitio sin nombre visible')
        );
        const observedAt = supervision?.recorded_at || supervision?.observed_at || supervision?.created_at || supervision?.registered_at || '';

        modal.innerHTML = `
            <div class="modal-content" style="max-width: 900px;">
                <div class="modal-header">
                    <h3>Evidencias de auditoría</h3>
                    <button class="btn-close" aria-label="Cerrar" data-action="closeModal" data-args="modal-admin-supervision-evidences">&times;</button>
                </div>
                <div class="modal-body">
                    <p class="muted-copy" style="margin: 0 0 12px;">
                        <strong>${escapeHtml(supervisorName)}</strong> en <strong>${escapeHtml(restaurantName)}</strong>
                        ${observedAt ? `— ${escapeHtml(formatDateTime(observedAt))}` : ''}
                    </p>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
                        ${evidences
                            .map((ev, i) => {
                                const safe = String(ev.url).replace(/"/g, '&quot;');
                                const label = ev.label || `Evidencia ${i + 1}`;
                                if (ev.is_video) {
                                    return `<div style="border-radius:8px;overflow:hidden;background:rgba(0,0,0,0.35);">
                                        <video controls playsinline preload="metadata" style="width:100%;max-height:220px;background:#000;" src="${safe}"></video>
                                        <div style="padding:6px 8px;font-size:12px;">${escapeHtml(label)}</div>
                                    </div>`;
                                }
                                return `<a href="${safe}" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none;color:inherit;border-radius:8px;overflow:hidden;background:rgba(0,0,0,0.35);">
                                    <img src="${safe}" alt="${escapeHtml(label)}" loading="lazy" style="width:100%;height:180px;object-fit:cover;display:block;">
                                    <div style="padding:6px 8px;font-size:12px;">${escapeHtml(label)}</div>
                                </a>`;
                            })
                            .join('')}
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-action="closeModal" data-args="modal-admin-supervision-evidences">Cerrar</button>
                </div>
            </div>
        `;

        modal.classList.add('active');
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
                <div class="stat-label">Auditorías</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${escapeHtml(String(uniqueSupervisors.size))}</div>
                <div class="stat-label">${escapeHtml(t('admin.supervisors.stat.active'))}</div>
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
        // Invalidar cache al entrar a la pantalla: si el user acaba de hacer
        // una auditoría desde otra pestaña o dispositivo, tiene que aparecer.
        this.invalidateCache?.('adminSupervisions');
        this.cache.adminSupervisionsQuery = '';

        const restaurants = await this.ensureAdminRestaurants();
        // Buffer de ±1 día en el filtro para que auditorías registradas en zona
        // del sitio (ej. US Pacific) no queden fuera por diferencia de husos
        // horarios con la zona del navegador (Colombia UTC-5). Después
        // renderAdminSupervisionMonitorSummary aplica el filtro fino por sitio.
        const todayStart = getTodayStart();
        const todayEnd = getTodayEnd();
        const fromWithBuffer = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
        const toWithBuffer = new Date(todayEnd.getTime() + 24 * 60 * 60 * 1000);
        const [supervisors, supervisions] = await Promise.all([
            this.ensureAdminSupervisionMonitorSupervisors(),
            this.fetchAdminSupervisions(restaurants, {
                restaurantLimit: restaurants.length,
                from: toIsoDate(fromWithBuffer),
                to: toIsoDate(toWithBuffer),
                limit: 100,
            }),
        ]);

        this.data.admin.supervisions = supervisions;
        console.info('[admin] supervisions cargadas', {
            count: supervisions.length,
            from: toIsoDate(fromWithBuffer),
            to: toIsoDate(toWithBuffer),
            sample: supervisions[0]
                ? {
                      keys: Object.keys(supervisions[0]),
                      supervisor_id_variants: {
                          'supervisor.id': supervisions[0].supervisor?.id,
                          supervisor_id: supervisions[0].supervisor_id,
                          user_id: supervisions[0].user_id,
                          registered_by: supervisions[0].registered_by,
                      },
                      evidence_variants: {
                          evidences: asArray(supervisions[0].evidences).length,
                          evidence_urls: asArray(supervisions[0].evidence_urls).length,
                          photos: asArray(supervisions[0].photos).length,
                          photo_urls: asArray(supervisions[0].photo_urls).length,
                          images: asArray(supervisions[0].images).length,
                      },
                  }
                : null,
        });
        this.populateAdminSupervisionMonitorSupervisorFilter(supervisors, supervisions);
        this.applyAdminSupervisionMonitorFilter();
        if (typeof this.prepareAdminSupervisionMonitorReport === 'function') {
            this.prepareAdminSupervisionMonitorReport().catch((error) => {
                console.warn('[monitor] no fue posible preparar el card de informe de auditorías', error);
            });
        }
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
        const formTitle = document.getElementById('modal-admin-supervisor-title');
        const submitLabel = document.getElementById('admin-supervisor-submit-label');
        const activeCheckbox = document.getElementById('admin-supervisor-active');

        if (editId) editId.value = '';
        if (formTitle) formTitle.textContent = 'Nuevo Inspector';
        if (submitLabel) submitLabel.textContent = 'Guardar Inspector';
        if (activeCheckbox) activeCheckbox.checked = true;
    },

    openAdminSupervisorModal(mode = 'new') {
        if (mode === 'new') {
            this.resetAdminSupervisorForm();
        }
        this.openModal('modal-admin-supervisor');
    },

    closeAdminSupervisorModal() {
        this.closeModal('modal-admin-supervisor');
        this.resetAdminSupervisorForm();
    },

    beginEditAdminSupervisor(userId) {
        const supervisor = this.data.admin.supervisors.find((item) => String(item.id) === String(userId));
        if (!supervisor) {
            this.showToast(t('admin.toast.cannot.load.supervisor'), {
                tone: 'error',
                title: t('toast.common.cannot.continue'),
            });
            return;
        }

        document.getElementById('admin-supervisor-edit-id').value = supervisor.id;
        document.getElementById('admin-supervisor-full-name').value = supervisor.full_name || '';
        document.getElementById('admin-supervisor-email').value = supervisor.email || '';
        document.getElementById('admin-supervisor-phone').value = supervisor.phone_e164 || '';
        // Cuenta activa: el chulo visible se quitó (pedido del cliente),
        // pero al editar debemos PRESERVAR el estado actual — no forzar
        // a true, o un admin editando el teléfono re-activaría un
        // inspector previamente desactivado sin pedirlo.
        const activeCheckbox = document.getElementById('admin-supervisor-active');
        if (activeCheckbox) activeCheckbox.checked = supervisor.is_active !== false;
        const modalTitle = document.getElementById('modal-admin-supervisor-title');
        if (modalTitle) modalTitle.textContent = 'Editar Inspector';
        const submitLabel = document.getElementById('admin-supervisor-submit-label');
        if (submitLabel) submitLabel.textContent = 'Actualizar Inspector';

        this.openModal('modal-admin-supervisor');
    },

    async submitAdminSupervisorForm() {
        const editId = document.getElementById('admin-supervisor-edit-id')?.value?.trim();
        const fullName = document.getElementById('admin-supervisor-full-name')?.value?.trim();
        const email = document.getElementById('admin-supervisor-email')?.value?.trim();
        const phone = document.getElementById('admin-supervisor-phone')?.value?.trim();
        const isActive = document.getElementById('admin-supervisor-active')?.checked ?? true;

        if (!fullName || !email || !phone) {
            this.showToast(t('admin.toast.fill.fields'), {
                tone: 'warning',
                title: t('toast.common.missing.data'),
            });
            return;
        }

        if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
            this.showToast(t('toast.common.phone.format'), {
                tone: 'warning',
                title: t('toast.common.invalid.phone'),
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

        this.showLoading(isEditing ? 'Actualizando inspector...' : 'Creando inspector...', t('toast.common.saving'));

        try {
            const result = await apiClient.adminUsersManage(isEditing ? 'update' : 'create', payload);
            this.invalidateCache('adminSupervisors');
            this.closeAdminSupervisorModal();
            await this.loadAdminSupervisors(true);

            if (!isEditing) {
                const initialPin = result?.initial_pin;
                if (initialPin) {
                    this.showInitialPinModal({
                        pin: initialPin,
                        email,
                        emailSent: Boolean(result?.pin_email_sent),
                    });
                } else {
                    this.showToast(t('admin.toast.inspector.created'), {
                        tone: 'success',
                        title: t('toast.common.created'),
                    });
                }
            } else {
                this.showToast(t('admin.toast.inspector.updated'), {
                    tone: 'success',
                    title: t('toast.common.updated'),
                });
            }
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible guardar el inspector.'), {
                tone: 'error',
                title: t('admin.toast.inspector.cannot.save'),
            });
        } finally {
            this.hideLoading();
        }
    },

    async loadAdminSupervisors(force = false) {
        const container = document.getElementById('admin-supervisors-list');
        if (container && (force || this.data.admin.supervisors.length === 0)) {
            container.innerHTML = `<div class="empty-state">${escapeHtml(t('admin.supervisors.list.loading'))}</div>`;
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
                                t('admin.supervisors.role.fallback'),
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
            container.innerHTML = `<div class="empty-state">${escapeHtml(t('admin.supervisors.empty'))}</div>`;
            return;
        }

        container.innerHTML = supervisors
            .map((supervisor) => {
                const supervisorId = String(supervisor.id || '');
                const statusLabel = supervisor.is_active ? 'Activa' : 'Inactiva';
                const statusClass = supervisor.is_active ? 'badge-success' : 'badge-danger';
                // "Desvincular Teléfono" eliminado por pedido del cliente.
                const clearPhoneButton = '';

                return `
                <article class="admin-supervisor-card">
                    <div class="admin-supervisor-top">
                        <div class="admin-supervisor-identity">
                            <div class="employee-avatar admin-supervisor-avatar">${escapeHtml(initials(supervisor.full_name || supervisor.email))}</div>
                            <div class="admin-supervisor-copy">
                                <h4>${escapeHtml(supervisor.full_name || t('admin.supervisors.role.fallback'))}</h4>
                                <p>${escapeHtml(supervisor.email || '-')} • ${escapeHtml(supervisor.phone_e164 || '-')}</p>
                                <div class="audit-meta">ID: ${escapeHtml(supervisorId || '-')}</div>
                            </div>
                        </div>
                        <span class="badge ${statusClass} admin-supervisor-status">${statusLabel}</span>
                    </div>

                    <!-- Bloque de asignacion de restaurantes retirado en el corte
                         "Sin asignacion de sitios": los inspectores pueden
                         auditar cualquier sitio activo sin asignacion previa. -->

                    <div class="admin-supervisor-actions">
                        ${clearPhoneButton}
                        <button
                            type="button"
                            class="btn btn-outline-warning btn-inline"
                            data-action="admin-revoke-device-supervisor"
                            data-supervisor-id="${escapeHtml(supervisorId)}"
                            data-user-name="${escapeHtml(supervisor.full_name || supervisor.email || '')}"
                            title="Libera el dispositivo registrado para que el inspector pueda ingresar desde un dispositivo nuevo."
                        >
                            <i class="fas fa-mobile-screen"></i>
                            <span>${escapeHtml(t('contractor.btn.revoke.device'))}</span>
                        </button>
                        <button
                            type="button"
                            class="btn btn-secondary btn-inline"
                            data-action="admin-reset-pin-supervisor"
                            data-supervisor-id="${escapeHtml(supervisorId)}"
                            data-email="${escapeHtml(supervisor.email || '')}"
                            title="Genera un nuevo PIN y obliga al inspector a cambiarlo al ingresar."
                        >
                            <i class="fas fa-key"></i>
                            <span>Resetear PIN</span>
                        </button>
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
            isCurrentlyActive ? t('admin.supervisors.status.deactivating') : t('admin.supervisors.status.activating'),
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
                isCurrentlyActive ? t('admin.supervisors.status.deactivated') : t('admin.supervisors.status.activated'),
                {
                    tone: 'success',
                    title: t('toast.common.saved'),
                }
            );
        } catch (error) {
            this.showToast(this.getErrorMessage(error, t('admin.supervisors.status.error')), {
                tone: 'error',
                title: t('admin.toast.cannot.update.status'),
            });
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
            this.showToast(t('admin.toast.action.preparing'), {
                tone: 'info',
                title: t('toast.common.coming.soon'),
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
            title: t('toast.common.notifications'),
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
