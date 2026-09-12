// @ts-nocheck
/**
 * ============================================================================
 * modules/supervisor.js — Inspector de calidad (rol "supervisora")
 * ============================================================================
 *
 * QUÉ ES
 *   Todo lo que hace el inspector. También lo carga el super_admin, que
 *   puede ver la app "como inspector". Se mezcla en el objeto `app` de
 *   app.js con Object.assign, así que `this` es la app completa.
 *
 * FUNCIONALIDADES (busca "SECCIÓN:" para saltar)
 *   - Auditoría en sitio: detectar el sitio por GPS, verificar la geocerca,
 *     tomar fotos por subárea y observaciones (5 fotos + 2 videos de 30 s)
 *     con subida progresiva, y guardar (saveSupervision).
 *   - Gestión de Sitios: tarjetas con tareas pendientes, eliminar sitio.
 *   - Gestión de contratistas: lista, filtros, crear/editar/eliminar.
 *   - Tareas especiales: crear (con foto/video de instrucciones), ver las
 *     pendientes de un sitio, alertas de tareas completadas.
 *   - Informes: visitas y auditorías (PDF/Excel del período e individual).
 *
 * BACKEND (Edge Functions vía apiClient)
 *   supervisor_presence_manage (auditoría) · operational_tasks_manage
 *   (tareas) · reports_generate (informes) · admin_users_manage /
 *   admin_restaurants_manage (contratistas y sitios).
 *
 * OJO
 *   - No redefinas aquí un método que ya exista en app.js o en adminModals.js:
 *     como todos se mezclan en el mismo objeto, gana el que se carga último
 *     y la otra copia queda muerta sin avisar. Lo que usan varios roles
 *     (getKnownRestaurantRecord, probeVideoDurationSeconds…) vive en app.js.
 *   - El agendamiento de turnos (plan semanal, importación de Excel) se borró
 *     en 2026-09: quedó sin uso tras la migración a visitas ad-hoc. Si hace
 *     falta consultarlo, está en el historial de git.
 */

import {
    CACHE_TTLS,
    DEFAULT_SYSTEM_SETTINGS,
    REPORT_COLUMNS,
    scopedConsole,
} from '../constants.js';

// Rebind local: info/warn/log noop en prod. error sí bindea al real.
// eslint-disable-next-line no-unused-vars
const console = scopedConsole;
import { apiClient, buildIdempotencyKey } from '../api.js';
import { t } from '../i18n.js';
import {
    asArray,
    buildJwtFullDebugSummary,
    collectEvidenceUrls,
    countEndedEarlyShifts,
    decodeJwtHeader,
    decodeJwtPayload,
    escapeHtml,
    isHttpUrl,
    formatDate,
    formatDateTime,
    formatHours,
    formatShiftLocalDate,
    formatShiftLocalRange,
    getBadgeClass,
    getEmployeeDisplayName,
    getRestaurantDisplayName,
    getRestaurantRecordId,
    getShiftEmployeeName,
    getShiftStatusLabel,
    getWorkedHours,
    initials,
    normalizePhoneToE164,
    normalizeRestaurantId,
    pickMeaningfulRestaurantName,
    sumHours,
    sumWorkedHours,
    summarizeShiftStatuses,
    toIsoDate,
    toLocalDateKey,
    getTodayStart,
    getTodayEnd,
} from '../utils.js';

// ==========================================================================
// SECCIÓN: Helpers de datos y distancia GPS
// --------------------------------------------------------------------------
// resolveRecordNumber lee un número probando varias rutas del objeto (el
// backend no siempre usa el mismo nombre de campo). calculateDistanceMeters
// es la distancia en metros entre dos coordenadas (fórmula de Haversine):
// la usan las geocercas de la auditoría y de las tareas especiales.
// ==========================================================================

function toFiniteNumber(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
}

function getNestedValue(record, path = '') {
    if (!record || typeof record !== 'object' || !path) {
        return undefined;
    }

    return path
        .split('.')
        .reduce((current, segment) => (current && typeof current === 'object' ? current[segment] : undefined), record);
}

function resolveRecordNumber(record, paths = []) {
    for (const path of paths) {
        const value = getNestedValue(record, path);
        const numericValue = toFiniteNumber(value);
        if (numericValue != null) {
            return numericValue;
        }
    }

    return null;
}

function toRadians(value) {
    return (Number(value) * Math.PI) / 180;
}

function calculateDistanceMeters(from, to) {
    const fromLat = toFiniteNumber(from?.lat);
    const fromLng = toFiniteNumber(from?.lng);
    const toLat = toFiniteNumber(to?.lat);
    const toLng = toFiniteNumber(to?.lng);

    if (fromLat == null || fromLng == null || toLat == null || toLng == null) {
        return null;
    }

    const earthRadiusMeters = 6371000;
    const deltaLat = toRadians(toLat - fromLat);
    const deltaLng = toRadians(toLng - fromLng);
    const lat1 = toRadians(fromLat);
    const lat2 = toRadians(toLat);
    const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusMeters * c;
}

export const supervisorMethods = {
    // ==========================================================================
    // SECCIÓN: Selects de sitios y normalización de contratistas
    // --------------------------------------------------------------------------
    // Llenan los <select> de sitios de las distintas pantallas y unifican el
    // formato de los contratistas que llegan del backend.
    // ==========================================================================

    populateSupervisorRestaurantOptions(selectId, includePlaceholder = true) {
        const select = document.getElementById(selectId);
        if (!select) {
            return;
        }

        const currentValue = select.value;
        const placeholder = includePlaceholder ? '<option value="">Selecciona un sitio</option>' : '';
        const restaurants = this.data.supervisor.restaurants.filter(
            (restaurant) => getRestaurantRecordId(restaurant) != null
        );
        select.innerHTML = `
            ${placeholder}
            ${restaurants
                .map(
                    (restaurant) => `
                <option value="${escapeHtml(String(getRestaurantRecordId(restaurant)))}">
                    ${escapeHtml(getRestaurantDisplayName(restaurant))}
                </option>
            `
                )
                .join('')}
        `;

        if (
            currentValue &&
            restaurants.some((restaurant) => String(getRestaurantRecordId(restaurant)) === String(currentValue))
        ) {
            select.value = currentValue;
        } else if (!includePlaceholder && restaurants[0]) {
            select.value = String(getRestaurantRecordId(restaurants[0]));
        }
    },


    // ==========================================================================
    // SECCIÓN: Tareas: normalizar valores del payload
    // --------------------------------------------------------------------------
    // normalizeTaskCreatePayloadValue convierte ids numéricos en número (el
    // backend valida tipos) y deja los UUID como texto.
    // ==========================================================================

    normalizeTaskCreatePayloadValue(value) {
        if (value == null || value === '') {
            return undefined;
        }

        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : value;
    },

    // ==========================================================================
    // SECCIÓN: Diagnóstico y tarjetas de soporte
    // --------------------------------------------------------------------------
    // Guardan en window.__worktrace*Debug el detalle de los últimos pedidos que
    // fallaron (crear tarea, informe, auditoría) y permiten copiarlo para
    // mandárselo a soporte o al backend.
    // ==========================================================================

    summarizeJwtTokenForDebug(token = '') {
        const normalizedToken = String(token || '').trim();
        if (!normalizedToken) {
            return {
                present: false,
                fingerprint: null,
                length: 0,
                kid: null,
                alg: null,
                iss: null,
                aud: null,
                sub: null,
                iat: null,
                exp: null,
                iat_utc: null,
                exp_utc: null,
            };
        }

        const header = decodeJwtHeader(normalizedToken) || {};
        const payload = decodeJwtPayload(normalizedToken) || {};
        const iat = Number(payload?.iat);
        const exp = Number(payload?.exp);

        return {
            present: true,
            fingerprint: `${normalizedToken.slice(0, 16)}...${normalizedToken.slice(-12)}`,
            length: normalizedToken.length,
            kid: header?.kid || null,
            alg: header?.alg || null,
            iss: payload?.iss || null,
            aud: payload?.aud || null,
            sub: payload?.sub || null,
            iat: Number.isFinite(iat) ? iat : null,
            exp: Number.isFinite(exp) ? exp : null,
            iat_utc: Number.isFinite(iat) ? new Date(iat * 1000).toISOString() : null,
            exp_utc: Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : null,
        };
    },

    getSupabaseAuthBaseUrl() {
        const configuredBaseUrl = String(apiClient.getConfig()?.baseUrl || '').trim();
        if (!configuredBaseUrl) {
            return '';
        }

        return configuredBaseUrl.replace(/\/functions\/v1\/?$/i, '');
    },

    async probeAuthUserWithToken(token = '') {
        const normalizedToken = String(token || '').trim();
        const authBaseUrl = this.getSupabaseAuthBaseUrl();
        const anonKey = String(apiClient.getConfig()?.anonKey || '').trim();

        if (!normalizedToken || !authBaseUrl || !anonKey) {
            return {
                ok: false,
                status: null,
                message: 'No fue posible ejecutar la sonda de Auth por falta de token o configuración.',
            };
        }

        try {
            const response = await fetch(`${authBaseUrl}/auth/v1/user`, {
                method: 'GET',
                headers: {
                    apikey: anonKey,
                    Authorization: `Bearer ${normalizedToken}`,
                },
            });

            const text = await response.text();
            let body = null;

            if (text) {
                try {
                    body = JSON.parse(text);
                } catch (error) {
                    body = { raw: text };
                }
            }

            return {
                ok: response.ok,
                status: response.status,
                body,
            };
        } catch (error) {
            return {
                ok: false,
                status: null,
                message: error?.message || 'No fue posible consultar /auth/v1/user',
            };
        }
    },

    registerTaskAuthDebug(entry = {}) {
        const debugEntry = {
            at: new Date().toISOString(),
            ...entry,
        };

        if (!Array.isArray(window.__worktraceTaskAuthDebug)) {
            window.__worktraceTaskAuthDebug = [];
        }

        window.__worktraceTaskAuthDebug.unshift(debugEntry);
        window.__worktraceTaskAuthDebug = window.__worktraceTaskAuthDebug.slice(0, 20);
        console.warn('Diagnóstico JWT create task', debugEntry);
        return debugEntry;
    },

    registerTaskCreateDebug(payload, error, context = {}) {
        const debugEntry = {
            at: new Date().toISOString(),
            request_id: error?.requestId || error?.payload?.request_id || error?.payload?.error?.request_id || null,
            status: error?.status || null,
            code: error?.code || error?.payload?.code || error?.payload?.error?.code || null,
            category: error?.category || error?.payload?.category || error?.payload?.error?.category || null,
            message: error?.message || null,
            payload_sent: payload,
            backend_response: error?.payload || null,
            context,
        };

        if (!Array.isArray(window.__worktraceTaskCreateDebug)) {
            window.__worktraceTaskCreateDebug = [];
        }

        window.__worktraceTaskCreateDebug.unshift(debugEntry);
        window.__worktraceTaskCreateDebug = window.__worktraceTaskCreateDebug.slice(0, 20);
        console.warn('Fallo creando tarea especial', debugEntry);
        return debugEntry;
    },

    registerReportGenerateDebug(payload, error, requestContext = {}) {
        const debugEntry = {
            at: new Date().toISOString(),
            request_id: error?.requestId || error?.payload?.request_id || error?.payload?.error?.request_id || null,
            status: error?.status || null,
            code: error?.code || error?.payload?.code || error?.payload?.error?.code || null,
            category: error?.category || error?.payload?.category || error?.payload?.error?.category || null,
            message: error?.message || null,
            payload_sent: payload,
            request_context: requestContext,
            backend_response: error?.payload || null,
        };

        if (!Array.isArray(window.__worktraceReportDebug)) {
            window.__worktraceReportDebug = [];
        }

        window.__worktraceReportDebug.unshift(debugEntry);
        window.__worktraceReportDebug = window.__worktraceReportDebug.slice(0, 20);
        console.warn('Fallo generando informe', debugEntry);
        return debugEntry;
    },

    registerSupervisionDebug(payload, error, context = {}) {
        const debugEntry = {
            at: new Date().toISOString(),
            request_id: error?.requestId || error?.payload?.request_id || error?.payload?.error?.request_id || null,
            status: error?.status || null,
            code: error?.code || error?.payload?.code || error?.payload?.error?.code || null,
            category: error?.category || error?.payload?.category || error?.payload?.error?.category || null,
            message: error?.message || null,
            payload_sent: payload,
            backend_response: error?.payload || null,
            context,
        };

        if (!Array.isArray(window.__worktraceSupervisionDebug)) {
            window.__worktraceSupervisionDebug = [];
        }

        window.__worktraceSupervisionDebug.unshift(debugEntry);
        window.__worktraceSupervisionDebug = window.__worktraceSupervisionDebug.slice(0, 20);
        console.warn('Fallo guardando supervisión', debugEntry);
        return debugEntry;
    },

    updateReportSupportCard(debugEntry = null) {
        const supportCard = document.getElementById('report-support-card');
        if (!supportCard) {
            return;
        }

        const latestEntry =
            debugEntry || (Array.isArray(window.__worktraceReportDebug) ? window.__worktraceReportDebug[0] : null);
        supportCard.classList.toggle('hidden', !latestEntry);
    },

    async copyLatestReportDebug() {
        const latestEntry = Array.isArray(window.__worktraceReportDebug) ? window.__worktraceReportDebug[0] : null;
        if (!latestEntry) {
            this.showToast(t('sup.toast.no.recent.error'), {
                tone: 'info',
                title: t('sup.toast.no.detail'),
            });
            return;
        }

        const payload = JSON.stringify(latestEntry, null, 2);

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
            } else {
                const tempInput = document.createElement('textarea');
                tempInput.value = payload;
                tempInput.setAttribute('readonly', 'readonly');
                tempInput.style.position = 'fixed';
                tempInput.style.opacity = '0';
                document.body.appendChild(tempInput);
                tempInput.select();
                document.execCommand('copy');
                document.body.removeChild(tempInput);
            }

            this.showToast(t('sup.toast.detail.copied'), {
                tone: 'success',
                title: t('sup.toast.copy.ready'),
            });
        } catch (error) {
            this.showToast(t('sup.toast.copy.failed'), {
                tone: 'error',
                title: t('toast.common.copy.failed'),
            });
        }
    },

    updateSupervisionSupportCard(debugEntry = null) {
        const supportCard = document.getElementById('supervision-support-card');
        if (!supportCard) {
            return;
        }

        const latestEntry =
            debugEntry ||
            (Array.isArray(window.__worktraceSupervisionDebug) ? window.__worktraceSupervisionDebug[0] : null);
        supportCard.classList.toggle('hidden', !latestEntry);
    },

    hideSupervisionSupportCard() {
        const supportCard = document.getElementById('supervision-support-card');
        if (!supportCard) {
            return;
        }

        supportCard.classList.add('hidden');
    },

    setSupervisionSubmitState(isSaving = false) {
        this.supervisionSavePending = Boolean(isSaving);
        const button = document.getElementById('supervision-save-button');
        if (!button) {
            return;
        }

        button.disabled = this.supervisionSavePending;
        button.setAttribute('aria-busy', this.supervisionSavePending ? 'true' : 'false');
    },

    clearSupervisionRegisterRetryState() {
        this.supervisionRegisterIdempotencyKey = '';
        this.supervisionRegisterRetrySignature = '';
    },

    async copyLatestSupervisionDebug() {
        const latestEntry = Array.isArray(window.__worktraceSupervisionDebug)
            ? window.__worktraceSupervisionDebug[0]
            : null;
        if (!latestEntry) {
            this.showToast(t('sup.toast.no.recent.error'), {
                tone: 'info',
                title: t('sup.toast.no.detail'),
            });
            return;
        }

        const payload = JSON.stringify(latestEntry, null, 2);

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
            } else {
                const tempInput = document.createElement('textarea');
                tempInput.value = payload;
                tempInput.setAttribute('readonly', 'readonly');
                tempInput.style.position = 'fixed';
                tempInput.style.opacity = '0';
                document.body.appendChild(tempInput);
                tempInput.select();
                document.execCommand('copy');
                document.body.removeChild(tempInput);
            }

            this.showToast(t('sup.toast.detail.copied'), {
                tone: 'success',
                title: t('sup.toast.copy.ready'),
            });
        } catch (error) {
            this.showToast(t('sup.toast.copy.failed'), {
                tone: 'error',
                title: t('toast.common.copy.failed'),
            });
        }
    },

    // ==========================================================================
    // SECCIÓN: Crear tareas: diagnóstico de errores y reintento con token nuevo
    // --------------------------------------------------------------------------
    // createOperationalTaskWithFreshToken reintenta una vez con un token recién
    // refrescado si el backend responde "JWT inválido". Lo de "scheduled
    // shifts" es LEGADO del agendamiento.
    // ==========================================================================

    isInvalidJwtForTaskCreate(error) {
        const status = Number(error?.status || 0);
        const source = [
            error?.message,
            error?.payload?.error?.message,
            error?.payload?.message,
            error?.payload?.error?.details?.message,
            error?.payload?.details?.message,
            error?.payload?.error?.code,
            error?.payload?.code,
            error?.code,
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        if (status !== 401 || !source) {
            return false;
        }

        return source.includes('invalid jwt') || source.includes('jwt');
    },

    async createOperationalTaskWithFreshToken(payload) {
        const freshToken = await this.getValidAccessToken({ forceRefresh: true });
        if (freshToken) {
            apiClient.setAccessToken(freshToken);
        }

        const initialTokenSummary = this.summarizeJwtTokenForDebug(freshToken);

        try {
            return await apiClient.operationalTasksManage('create', payload, {
                accessToken: freshToken,
                retryOnInvalidJwt: false,
            });
        } catch (error) {
            if (!this.isInvalidJwtForTaskCreate(error)) {
                throw error;
            }

            const initialProbe = await this.probeAuthUserWithToken(freshToken);
            const retryToken = await this.getValidAccessToken({ forceRefresh: true });
            if (retryToken) {
                apiClient.setAccessToken(retryToken);
            }

            const retryTokenSummary = this.summarizeJwtTokenForDebug(retryToken);

            try {
                return await apiClient.operationalTasksManage('create', payload, {
                    accessToken: retryToken,
                    retryOnInvalidJwt: false,
                });
            } catch (retryError) {
                if (this.isInvalidJwtForTaskCreate(retryError)) {
                    const retryProbe = await this.probeAuthUserWithToken(retryToken);
                    this.registerTaskAuthDebug({
                        action: 'operational_tasks_manage.create',
                        payload_sent: payload,
                        initial_token: initialTokenSummary,
                        retry_token: retryTokenSummary,
                        initial_attempt_error: {
                            status: Number(error?.status || 0) || null,
                            message: String(error?.message || ''),
                            request_id:
                                error?.requestId ||
                                error?.payload?.request_id ||
                                error?.payload?.error?.request_id ||
                                null,
                        },
                        retry_attempt_error: {
                            status: Number(retryError?.status || 0) || null,
                            message: String(retryError?.message || ''),
                            request_id:
                                retryError?.requestId ||
                                retryError?.payload?.request_id ||
                                retryError?.payload?.error?.request_id ||
                                null,
                        },
                        auth_probe_initial: initialProbe,
                        auth_probe_retry: retryProbe,
                    });
                }

                throw retryError;
            }
        }
    },

    // ==========================================================================
    // SECCIÓN: Resolver contratistas y sitios ya cargados
    // --------------------------------------------------------------------------
    // Buscan un contratista en lo que ya está en memoria para mostrar nombres
    // sin pedirlos de nuevo al backend. Las de sitios (getKnownRestaurantRecord
    // y compañía) están en app.js porque también las usa el contratista.
    // ==========================================================================

    getKnownSupervisorEmployeeRecord(employeeId) {
        const normalizedEmployeeId = String(employeeId || '').trim();
        if (!normalizedEmployeeId) {
            return null;
        }
        return (
            asArray(this.data.supervisor.employees).find(
                (employee) => String(employee?.id || '').trim() === normalizedEmployeeId
            ) || null
        );
    },

    getKnownEmployeeRecord(employeeId) {
        const normalizedEmployeeId = String(employeeId || '').trim();
        if (!normalizedEmployeeId) {
            return null;
        }

        if (String(this.currentUser?.id || '').trim() === normalizedEmployeeId) {
            return this.currentUser;
        }

        const supervisorEmployee = this.getKnownSupervisorEmployeeRecord(normalizedEmployeeId);
        if (supervisorEmployee) {
            return supervisorEmployee;
        }

        const dashboardEmployee = asArray(this.data.employee.dashboard?.scheduled_shifts)
            .map((item) => item?.employee || item?.user || item?.staff || item?.worker || null)
            .find((employee) => String(employee?.id || '').trim() === normalizedEmployeeId);
        if (dashboardEmployee) {
            return dashboardEmployee;
        }

        const activeShiftEmployee = this.data.currentShift?.employee || this.data.currentShift?.user || null;
        if (String(activeShiftEmployee?.id || '').trim() === normalizedEmployeeId) {
            return activeShiftEmployee;
        }

        const scheduledShiftEmployee =
            this.data.currentScheduledShift?.employee || this.data.currentScheduledShift?.user || null;
        if (String(scheduledShiftEmployee?.id || '').trim() === normalizedEmployeeId) {
            return scheduledShiftEmployee;
        }

        return null;
    },

    getKnownEmployeeRecordByAlias(aliasCandidates = []) {
        const normalizedAliases = new Set(
            asArray(aliasCandidates)
                .map((value) =>
                    String(value || '')
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
        );

        if (normalizedAliases.size === 0) {
            return null;
        }

        const matchesAlias = (record) => {
            if (!record || typeof record !== 'object') {
                return false;
            }
            const candidateValues = [
                record.id,
                record.username,
                record.user_name,
                record.employee_username,
                record.employee_code,
                record.code,
                record.email,
                record.employee_email,
                record.user?.id,
                record.user?.username,
                record.user?.user_name,
                record.user?.email,
                record.auth_user?.id,
                record.auth_user?.email,
                record.raw?.id,
                record.raw?.username,
                record.raw?.email,
            ];
            return candidateValues.some((value) =>
                normalizedAliases.has(
                    String(value || '')
                        .trim()
                        .toLowerCase()
                )
            );
        };

        if (matchesAlias(this.currentUser)) {
            return this.currentUser;
        }

        const supervisorMatch = asArray(this.data.supervisor.employees).find(matchesAlias);
        if (supervisorMatch) {
            return supervisorMatch;
        }

        const dashboardMatch = asArray(this.data.employee.dashboard?.scheduled_shifts)
            .map((item) => item?.employee || item?.user || item?.staff || item?.worker || null)
            .find(matchesAlias);
        if (dashboardMatch) {
            return dashboardMatch;
        }

        const activeShiftEmployee = this.data.currentShift?.employee || this.data.currentShift?.user || null;
        if (matchesAlias(activeShiftEmployee)) {
            return activeShiftEmployee;
        }

        const scheduledShiftEmployee =
            this.data.currentScheduledShift?.employee || this.data.currentScheduledShift?.user || null;
        if (matchesAlias(scheduledShiftEmployee)) {
            return scheduledShiftEmployee;
        }

        return null;
    },

    getResolvedShiftEmployeeName(shift, fallback = 'Contratista') {
        const employeeId =
            shift?.employee_id || shift?.assigned_employee_id || shift?.employee?.id || shift?.user_id || '';
        const employeeAliasCandidates = [
            shift?.employee,
            shift?.employee_username,
            shift?.employee_email,
            shift?.employee_code,
            shift?.username,
            shift?.user_name,
            shift?.email,
            shift?.employee?.username,
            shift?.employee?.email,
            shift?.employee?.id,
            shift?.user?.username,
            shift?.user?.email,
            shift?.user?.id,
        ];
        const employeeRecord =
            this.getKnownEmployeeRecord(employeeId) ||
            this.getKnownEmployeeRecordByAlias(employeeAliasCandidates) ||
            null;
        return (
            getShiftEmployeeName(shift, {
                employeeRecord,
            }) || fallback
        );
    },

    getSupervisorRestaurantShifts() {
        const restaurant = this.getSupervisorSelectedRestaurant();
        const restaurantId = restaurant ? String(getRestaurantRecordId(restaurant) || '') : '';
        if (!restaurantId) {
            return [];
        }
        return asArray(this.data.supervisor.shifts)
            .filter((shift) => {
                const shiftRestaurantId = String(
                    shift?.restaurant_id ||
                        shift?.restaurant?.restaurant_id ||
                        shift?.restaurant?.id ||
                        shift?.location_id ||
                        shift?.location?.id ||
                        shift?.site_id ||
                        shift?.site?.id ||
                        ''
                );
                return shiftRestaurantId === restaurantId;
            })
            .sort((left, right) => {
                const leftTime = new Date(
                    left?.scheduled_start || left?.start_time || left?.created_at || ''
                ).getTime();
                const rightTime = new Date(
                    right?.scheduled_start || right?.start_time || right?.created_at || ''
                ).getTime();
                return (
                    (Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER) -
                    (Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER)
                );
            });
    },

    // ========== UPLOAD PROGRESIVO DE AUDITORÍA ==========
    // Flujo nuevo (2026-09): en vez de esperar al final para subir 20-50 fotos
    // (60-90s bloqueante), el inspector crea un "draft" al verificar ubicación
    // y cada foto/observación se sube en background durante el recorrido.
    //
    // Backend: supervisor_presence_manage (actions start / get_active_draft /
    // attach_evidence / finalize). El draft es un supervisor_presence_logs
    // con status='draft'; finalize lo pasa a 'completed'.
    //
    // State:
    //   supervisionDraftId          → presence_id del draft actual
    //   supervisionDraftPromise     → inflight promise de start() (evita dobles)
    //   _supervisionSlotUploads     → Map(slotKey → { status, promise, evidence_id, path, error })
    //   _supervisionObsUploads      → Map(index    → { status, promise, evidence_id, path, error })
    // status ∈ 'uploading' | 'done' | 'error'

    // ==========================================================================
    // SECCIÓN: Auditoría: subida progresiva de evidencias (borradores)
    // --------------------------------------------------------------------------
    // Al verificar la ubicación se crea (o se retoma) un BORRADOR de auditoría
    // en el backend (ensureSupervisionDraft / resumeSupervisionDraftIfAny →
    // supervisor_presence_manage 'start' / 'get_active_draft'). Cada foto se
    // sube en segundo plano apenas se toma (enqueueSupervisionSlotUpload →
    // 'attach_evidence'), y al guardar solo se espera a que terminen
    // (awaitAllSupervisionUploads) y se hace 'finalize' con las observaciones.
    // updateSupervisionUploadBadge muestra ⏳ / ✓ / ⚠ en cada miniatura.
    // ==========================================================================

    resetSupervisionProgressiveState() {
        this.supervisionDraftId = null;
        this.supervisionDraftPromise = null;
        this.supervisionDraftRestaurantId = null;
        this._supervisionSlotUploads = new Map();
        this._supervisionObsUploads = new Map();
    },

    async ensureSupervisionDraft() {
        // Devuelve el presence_id del draft actual. Si no existe, lo crea con
        // action:'start'. La llamada es idempotente por Idempotency-Key único
        // por request; ante double-tap el backend devuelve already_exists:true.
        //
        // Guard de restaurant: backend permite drafts paralelos (uno por sitio).
        // Si el user cambió de sitio dentro de la página sin resetear, el
        // supervisionDraftId cacheado apunta al sitio anterior — hay que
        // invalidarlo o las fotos se attachearían al draft equivocado.
        const { restaurant } = this.getSupervisorSupervisionReference() || {};
        const restaurantId = restaurant?.restaurant_id || restaurant?.id;
        if (!restaurantId) {
            throw new Error('No hay sitio seleccionado para iniciar la auditoría.');
        }
        if (this.supervisionDraftId && this.supervisionDraftRestaurantId
            && String(this.supervisionDraftRestaurantId) !== String(restaurantId)) {
            // Cambió el sitio — descartar el draft cacheado; se creará uno nuevo.
            this.supervisionDraftId = null;
            this.supervisionDraftPromise = null;
            this.supervisionDraftRestaurantId = null;
        }
        if (this.supervisionDraftId) return this.supervisionDraftId;
        if (this.supervisionDraftPromise) return await this.supervisionDraftPromise;
        const location = this.supervisionLocationCheck?.location || this.location;
        if (!location) {
            throw new Error('Verificá tu ubicación antes de tomar fotos.');
        }

        this.supervisionDraftPromise = (async () => {
            try {
                const res = await apiClient.supervisorPresenceManage(
                    'start',
                    {
                        restaurant_id: restaurantId,
                        lat: location.lat,
                        lng: location.lng,
                        accuracy: Math.round(location.accuracy || 0),
                    },
                    {
                        requiresIdempotency: false,
                        headers: { 'Idempotency-Key': buildIdempotencyKey() },
                    }
                );
                const presenceId = res?.presence_id || res?.supervision_id
                    || res?.data?.presence_id || res?.data?.supervision_id;
                if (!presenceId) {
                    throw new Error('El backend no devolvió presence_id para el start de auditoría.');
                }
                this.supervisionDraftId = presenceId;
                this.supervisionDraftRestaurantId = restaurantId;
                return presenceId;
            } finally {
                this.supervisionDraftPromise = null;
            }
        })();
        return await this.supervisionDraftPromise;
    },

    async resumeSupervisionDraftIfAny() {
        // Reanudación: si el inspector cerró la app y vuelve con una auditoría
        // en curso, backend devuelve el draft abierto (mismo día, mismo sitio).
        // Corre después de seleccionar restaurant y ANTES de verificar ubicación.
        try {
            const { restaurant } = this.getSupervisorSupervisionReference() || {};
            const restaurantId = restaurant?.restaurant_id || restaurant?.id;
            if (!restaurantId) return null;
            if (this.supervisionDraftId && this.supervisionDraftRestaurantId === restaurantId) {
                return this.supervisionDraftId;
            }
            const res = await apiClient.supervisorPresenceManage('get_active_draft', {
                restaurant_id: restaurantId,
            });
            const draft = res?.draft || res?.data?.draft || null;
            if (draft) {
                this.supervisionDraftId = draft.presence_id || draft.supervision_id;
                this.supervisionDraftRestaurantId = restaurantId;
                const count = Number(draft.evidence_count || 0);
                this.showToast(
                    count > 0
                        ? `Retomando auditoría en curso (${count} evidencia${count === 1 ? '' : 's'} ya subida${count === 1 ? '' : 's'}).`
                        : 'Retomando auditoría en curso.',
                    { tone: 'info', title: 'Auditoría reanudada' }
                );
                return this.supervisionDraftId;
            }
            return null;
        } catch (err) {
            console.warn('[supervision] get_active_draft falló:', err?.message || err);
            return null;
        }
    },

    enqueueSupervisionSlotUpload(slotKey, file) {
        // Dispara upload background para una foto por área. Si ya había un
        // upload en curso para ese slot y era 'error', lo reemplaza. Si estaba
        // 'uploading' o 'done', aceptamos duplicado (backend permite hasta 50).
        if (!slotKey || !file) return;
        if (!this._supervisionSlotUploads) this._supervisionSlotUploads = new Map();

        const slot = this.getPhotoSlotDefinition
            ? this.getPhotoSlotDefinition(slotKey, 'supervision')
            : null;
        const label = slot?.title || slotKey;
        const meta = { area: slot?.groupLabel || null, subarea: slot?.subareaLabel || null };

        const state = { status: 'uploading', promise: null, evidence_id: null, path: null, error: null };
        this._supervisionSlotUploads.set(slotKey, state);
        this.updateSupervisionUploadBadge('slot', slotKey, 'uploading');

        state.promise = this._runSupervisionUpload(file, { label, meta })
            .then((result) => {
                state.status = 'done';
                state.evidence_id = result.evidence_id;
                state.path = result.path;
                this.updateSupervisionUploadBadge('slot', slotKey, 'done');
            })
            .catch((err) => {
                state.status = 'error';
                state.error = err;
                this.updateSupervisionUploadBadge('slot', slotKey, 'error');
                console.warn('[supervision] upload slot falló', slotKey, err?.message || err);
            });
    },

    enqueueSupervisionObservationUpload(index, file) {
        if (!Number.isFinite(index) || !file) return;
        if (!this._supervisionObsUploads) this._supervisionObsUploads = new Map();

        const state = { status: 'uploading', promise: null, evidence_id: null, path: null, error: null };
        this._supervisionObsUploads.set(index, state);
        this.updateSupervisionUploadBadge('obs', index, 'uploading');

        state.promise = this._runSupervisionUpload(file, { label: 'Observación', meta: { source: 'observation' } })
            .then((result) => {
                state.status = 'done';
                state.evidence_id = result.evidence_id;
                state.path = result.path;
                this.updateSupervisionUploadBadge('obs', index, 'done');
            })
            .catch((err) => {
                state.status = 'error';
                state.error = err;
                this.updateSupervisionUploadBadge('obs', index, 'error');
                console.warn('[supervision] upload obs falló', index, err?.message || err);
            });
    },

    async _runSupervisionUpload(file, { label, meta }) {
        // Pipeline: ensureDraft → compress → request signed URL → PUT → attach_evidence.
        const presenceId = await this.ensureSupervisionDraft();

        const rawType = String(file?.type || '').toLowerCase();
        const isVideo = rawType.startsWith('video/');
        const payload = isVideo ? file : await this.compressImage(file);
        const mimeType = isVideo ? (rawType || 'video/mp4') : (payload.type || 'image/jpeg');

        const requestUpload = await apiClient.supervisorPresenceManage('request_evidence_upload', {
            phase: 'start',
            mime_type: mimeType,
        });
        const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
        const path = requestUpload?.path || requestUpload?.upload?.path;
        if (!signedUrl || !path) throw new Error('No fue posible preparar la subida.');

        await apiClient.uploadToSignedUrl(signedUrl, payload, mimeType);

        const attach = await apiClient.supervisorPresenceManage(
            'attach_evidence',
            { presence_id: presenceId, path, label, meta },
            {
                requiresIdempotency: false,
                headers: { 'Idempotency-Key': buildIdempotencyKey() },
            }
        );
        return {
            evidence_id: attach?.evidence_id || attach?.data?.evidence_id || null,
            path,
        };
    },

    async awaitAllSupervisionUploads() {
        // Espera todos los uploads pendientes. Devuelve { done, failed, total }.
        const collect = (m) => Array.from((m || new Map()).values());
        const all = [...collect(this._supervisionSlotUploads), ...collect(this._supervisionObsUploads)];
        if (all.length === 0) return { done: 0, failed: 0, total: 0 };
        await Promise.allSettled(all.map((s) => s.promise));
        const failed = all.filter((s) => s.status === 'error').length;
        const done = all.filter((s) => s.status === 'done').length;
        return { done, failed, total: all.length };
    },

    updateSupervisionUploadBadge(kind, key, status) {
        // Inyecta/actualiza un badge visual en la miniatura correspondiente.
        // 'uploading' → ⏳ (spinner) / 'done' → ✓ verde / 'error' → ⚠ rojo.
        // Buscamos el elemento por convención: data-supervision-upload-badge="{kind}:{key}".
        try {
            const selector = `[data-supervision-upload-badge="${kind}:${String(key).replace(/"/g, '\\"')}"]`;
            const badge = document.querySelector(selector);
            if (!badge) return;
            badge.dataset.status = status;
            badge.hidden = false;
            if (status === 'uploading') {
                badge.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                badge.title = 'Subiendo…';
            } else if (status === 'done') {
                badge.innerHTML = '<i class="fas fa-check"></i>';
                badge.title = 'Subida';
            } else if (status === 'error') {
                badge.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
                badge.title = 'Error al subir — se reintentará al finalizar';
            }
        } catch (_) { /* ignore DOM issues */ }
    },

    // ==========================================================================
    // SECCIÓN: Auditoría: estado de la pantalla y adjuntos de observaciones
    // --------------------------------------------------------------------------
    // resetSupervisorSupervisionState limpia fotos, observaciones y selección.
    // Los adjuntos de observaciones se validan AL AGREGARLOS: máximo 5 fotos y
    // 2 videos de hasta 30 segundos (mismo límite que el contratista).
    // ==========================================================================

    resetSupervisorSupervisionState() {
        // Al resetear estado, revertimos también el chip auto-lock para
        // que la próxima entrada arranque con picker visible (o el chip
        // según lo que detecte el auto-detect).
        if (typeof this.setSupervisionRestaurantAutoLock === 'function') {
            try { this.setSupervisionRestaurantAutoLock(null); } catch (_) { /* ignore */ }
        }
        // Progresivo: limpiar draft y buffers de upload.
        this.resetSupervisionProgressiveState();
        this.services.images.clearMap(this.supervisionPhotos);
        this.supervisionPhotos = {};
        this.supervisionPhotoFiles = {};
        this.selectedSupervisorArea = '';
        this.supervisionPhotoCatalog = [];
        this.clearSupervisionRegisterRetryState();
        if (this.currentPhotoType === 'supervision') {
            this.currentPhotoArea = null;
            this.currentPhotoContext = null;
        }
        // Bug reportado: al reabrir una auditoría después de enviar,
        // el input <input type="file"> mantenía el valor anterior y
        // reaparecían fotos residuales. Reseteamos explícitamente el
        // input y los observations para dejar el formulario limpio.
        const photoInput = document.getElementById('supervision-photo-input');
        if (photoInput) {
            try { photoInput.value = ''; } catch (_) { /* ignore */ }
        }
        const observations = document.getElementById('supervision-observations');
        if (observations) {
            observations.value = '';
        }
        // Adjuntos de observaciones del inspector (foto/video): mismo
        // patrón que _observationsAttachments del contratista.
        this._supervisionObservationsAttachments = [];
        const obsInput = document.getElementById('supervision-observations-file');
        if (obsInput) {
            try { obsInput.value = ''; } catch (_) { /* ignore */ }
        }
        if (typeof this.renderSupervisionObservationsAttachments === 'function') {
            try { this.renderSupervisionObservationsAttachments(); } catch (_) { /* ignore */ }
        }
        this.populateSupervisorAreaOptions();
        // Render SÍNCRONO — antes usaba queueUiRender (debounced) y quedaba
        // el grid con thumbs viejos hasta el próximo tick. Ahora forzamos
        // el flush inmediato para que el DOM se limpie al mismo tiempo
        // que el buffer.
        if (typeof this.renderSupervisorPhotoGridNow === 'function') {
            try { this.renderSupervisorPhotoGridNow(); } catch (_) { /* ignore */ }
        } else {
            this.renderSupervisorPhotoGrid();
        }
        this.hideSupervisionSupportCard();
    },

    bindSupervisionObservationsAttachmentsOnce() {
        const input = document.getElementById('supervision-observations-file');
        if (!input || input.dataset.observationsBound === '1') return;
        input.dataset.observationsBound = '1';

        input.addEventListener('change', async () => {
            const files = Array.from(input.files || []);
            input.value = ''; // limpiar SIEMPRE para permitir re-elegir
            if (files.length === 0) return;

            // Límites por bloque de observaciones (adicionales a las fotos
            // obligatorias por subárea, que van aparte):
            //   - Máx 5 imágenes + 2 videos
            //   - Videos ≤ 30 segundos cada uno
            // Validación INMEDIATA al elegir el archivo (no al enviar) —
            // el user no debe subir 10 archivos y enterarse al final que
            // había un tope. Los rechazos se acumulan y se muestran
            // juntos al final para no bombardear con toasts sucesivos.
            const MAX_IMAGES = 5;
            const MAX_VIDEOS = 2;
            const MAX_VIDEO_SECONDS = 30;

            const current = this._supervisionObservationsAttachments || [];
            let imageCount = current.filter((f) => String(f?.type || '').toLowerCase().startsWith('image/')).length;
            let videoCount = current.filter((f) => String(f?.type || '').toLowerCase().startsWith('video/')).length;

            const accepted = [];
            const rejections = [];

            for (const file of files) {
                const isVideo = String(file.type || '').toLowerCase().startsWith('video/');

                // Cap por tipo. Mensaje sin file.name (el nombre real de
                // cámara "image.jpg" no aporta al inspector y hace ruido).
                if (isVideo && videoCount >= MAX_VIDEOS) {
                    rejections.push(`Ya tenés el máximo de ${MAX_VIDEOS} videos agregados.`);
                    continue;
                }
                if (!isVideo && imageCount >= MAX_IMAGES) {
                    rejections.push(`Ya tenés el máximo de ${MAX_IMAGES} imágenes agregadas.`);
                    continue;
                }

                // Duración de video ≤ 30s
                if (isVideo) {
                    let seconds = 0;
                    let probeUrl = null;
                    try {
                        probeUrl = URL.createObjectURL(file);
                        seconds = await this.probeVideoDurationSeconds(probeUrl);
                    } catch (_) { /* si falla, dejamos pasar y backend rechazará */ }
                    finally { if (probeUrl) URL.revokeObjectURL(probeUrl); }
                    if (Number.isFinite(seconds) && seconds > MAX_VIDEO_SECONDS) {
                        rejections.push(`El video supera los ${MAX_VIDEO_SECONDS} segundos permitidos.`);
                        continue;
                    }
                }

                accepted.push(file);
                if (isVideo) videoCount += 1;
                else imageCount += 1;
            }

            if (accepted.length > 0) {
                const baseIndex = current.length;
                this._supervisionObservationsAttachments = [...current, ...accepted];
                this.renderSupervisionObservationsAttachments();
                // Progresivo: disparar upload background para cada nueva observación.
                if (typeof this.enqueueSupervisionObservationUpload === 'function') {
                    accepted.forEach((file, i) => {
                        this.enqueueSupervisionObservationUpload(baseIndex + i, file);
                    });
                }
            }
            if (rejections.length > 0) {
                this.showToast(rejections.join('\n'), {
                    tone: 'warning',
                    title: rejections.length === 1 ? 'No se agregó' : `No se agregaron ${rejections.length} archivos`,
                    duration: 8000,
                });
            }
        });

        const container = document.getElementById('supervision-observations-attachments');
        if (container && !container.dataset.observationsDelegation) {
            container.dataset.observationsDelegation = '1';
            container.addEventListener('click', (event) => {
                const btn = event.target.closest('[data-supervision-observations-action="remove"]');
                if (!btn) return;
                const index = Number(btn.dataset.index);
                if (Number.isFinite(index) && this._supervisionObservationsAttachments) {
                    this._supervisionObservationsAttachments.splice(index, 1);
                    this.renderSupervisionObservationsAttachments();
                }
            });
        }
    },

    renderSupervisionObservationsAttachments() {
        const wrap = document.getElementById('supervision-observations-attachments');
        if (!wrap) return;
        const files = this._supervisionObservationsAttachments || [];
        const label = document.getElementById('supervision-observations-file-label');
        const textSpan = label?.querySelector('.rtask-file-label-text');

        if (files.length === 0) {
            wrap.innerHTML = '';
            if (textSpan) textSpan.textContent = 'Tomar foto o video';
            label?.classList.remove('rtask-file-label-has-file');
            return;
        }

        if (textSpan) textSpan.textContent = `Tomar otra (${files.length})`;
        label?.classList.add('rtask-file-label-has-file');

        wrap.innerHTML = files
            .map((file, index) => {
                const isVideo = String(file.type || '').startsWith('video/');
                const icon = isVideo ? 'fa-video' : 'fa-image';
                // Ya no mostramos file.name — el nombre real que asigna la cámara
                // ("image.jpg") no aporta info al inspector. Usamos un label
                // amable "Foto N" / "Video N" y el tamaño en MB.
                const kindLabel = isVideo ? 'Video' : 'Foto';
                const displayLabel = `${kindLabel} ${index + 1}`;
                const sizeMb = Math.round((file.size / (1024 * 1024)) * 10) / 10;
                return `<div class="rtask-attachment-item">
                    <i class="fas ${icon}"></i>
                    <span class="rtask-attachment-name">${escapeHtml(displayLabel)}</span>
                    <span class="rtask-attachment-size">${sizeMb} MB</span>
                    <span class="supervision-upload-badge supervision-upload-badge-inline" data-supervision-upload-badge="obs:${index}" hidden></span>
                    <button type="button" class="rtask-attachment-remove" data-supervision-observations-action="remove" data-index="${index}" aria-label="Quitar adjunto">
                        <i class="fas fa-times"></i>
                    </button>
                </div>`;
            })
            .join('');

        // Refrescar badges de estados conocidos tras re-render.
        if (this._supervisionObsUploads && typeof this.updateSupervisionUploadBadge === 'function') {
            this._supervisionObsUploads.forEach((state, idx) => {
                this.updateSupervisionUploadBadge('obs', idx, state.status);
            });
        }
    },

    // ==========================================================================
    // SECCIÓN: Dashboard del inspector y alertas de tareas completadas
    // --------------------------------------------------------------------------
    // getSupervisorRestaurants trae el catálogo de sitios (con caché).
    // loadSupervisorCompletedTasks arma las alertas de "tareas especiales
    // completadas hoy" con su botón "Ver evidencias".
    // getSupervisorShiftList quedó como no-op: sin agendamiento no hay lista.
    // ==========================================================================

    getShiftReferenceDate(shift) {
        const value = shift?.scheduled_start || shift?.start_time || shift?.scheduled_end || shift?.end_time || null;
        if (!value) {
            return null;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    },

    /**
     * Backend v3: preferir shift.local.start.local_date (día en zona del sitio)
     * cuando esté disponible. El fallback a toDateString() del navegador
     * descartaba turnos que en zona del sitio son "hoy" pero en el navegador
     * (Colombia UTC-5) aparecían como "mañana" por el cruce de medianoche.
     */
    isShiftFromToday(shift, baseDate = new Date()) {
        const startDateKey = shift?.local?.start?.local_date;
        const endDateKey = shift?.local?.end?.local_date;

        if (startDateKey || endDateKey) {
            const todayKey = `${baseDate.getFullYear()}-${String(baseDate.getMonth() + 1).padStart(2, '0')}-${String(baseDate.getDate()).padStart(2, '0')}`;
            // Cuenta si HOY cae dentro de la ventana del turno (start_date <= hoy <= end_date).
            const startOk = !startDateKey || startDateKey <= todayKey;
            const endOk = !endDateKey || todayKey <= endDateKey;
            return startOk && endOk;
        }

        const shiftDate = this.getShiftReferenceDate(shift);
        return Boolean(shiftDate && shiftDate.toDateString() === baseDate.toDateString());
    },

    getTodayShifts(shifts = []) {
        const now = new Date();
        return asArray(shifts).filter((shift) => this.isShiftFromToday(shift, now));
    },

    async getSupervisorRestaurants(force = false) {
        if (
            !force &&
            this.data.supervisor.restaurants.length > 0 &&
            this.isCacheFresh('supervisorRestaurants', CACHE_TTLS.supervisorRestaurants)
        ) {
            return this.data.supervisor.restaurants;
        }

        return this.runPending(
            `supervisorRestaurants:${this.currentUser?.role || 'unknown'}:${force ? 'force' : 'default'}`,
            async () => {
                let restaurants = [];
                const mapRestaurantList = (result) =>
                    asArray(result)
                        .map((item) => ({
                            ...item,
                            id: getRestaurantRecordId(item),
                            restaurant_id: getRestaurantRecordId(item),
                            is_active: item.is_active !== false,
                            name:
                                pickMeaningfulRestaurantName(
                                    [
                                        item.restaurant_name,
                                        item.restaurant_visible_name,
                                        item.restaurant_label,
                                        item.restaurant?.restaurant_name,
                                        item.restaurant?.restaurant_visible_name,
                                        item.restaurant?.restaurant_label,
                                        item.name,
                                        item.display_name,
                                        item.label,
                                        item.title,
                                        item.restaurant?.name,
                                        item.restaurant?.display_name,
                                        item.restaurant?.label,
                                        item.restaurant?.title,
                                    ],
                                    item
                                ) || '',
                            address_line: item.address_line || item.restaurant?.address_line,
                            city: item.city || item.restaurant?.city,
                            state: item.state || item.restaurant?.state,
                            country: item.country || item.restaurant?.country,
                            cleaning_areas: item.cleaning_areas || item.restaurant?.cleaning_areas,
                            effective_cleaning_areas:
                                item.effective_cleaning_areas ||
                                item.restaurant?.effective_cleaning_areas ||
                                item.cleaning_areas ||
                                item.restaurant?.cleaning_areas,
                            raw: item,
                        }))
                        .filter((item) => item.is_active !== false && getRestaurantRecordId(item) != null);

                try {
                    const result = await apiClient.adminRestaurantsManage('list', {
                        is_active: true,
                        limit: 500,
                    });
                    restaurants = mapRestaurantList(result);
                } catch (error) {
                    console.warn('No fue posible cargar el listado global de sitios para supervisora.', error);
                    restaurants = [];
                }

                this.data.supervisor.restaurants = restaurants;
                this.touchCache('supervisorRestaurants');
                return restaurants;
            }
        );
    },

    // No-op post migracion Visitas: sin agendamiento no hay listado de
    // turnos programados que precargar.
    async getSupervisorShiftList() {
        return [];
    },

    async loadSupervisorDashboard() {
        const [restaurants, shifts] = await Promise.all([
            this.getSupervisorRestaurants(),
            this.getSupervisorShiftList({ forceRestaurants: false }),
            this.loadSupervisorEmployees(false).catch((error) => {
                console.warn(
                    'No fue posible precargar el directorio de contratistas para resolver nombres en alertas.',
                    error
                );
            }),
        ]);
        // Si la sesión se cerró mientras las requests estaban en vuelo, abortar sin tocar el DOM/currentUser.
        if (!this.currentUser) {
            return;
        }
        const todayShifts = this.getTodayShifts(shifts);
        this.data.supervisor.shifts = todayShifts;

        // Welcome banner removido del HTML; optional chaining defensivo por
        // si algún flujo legacy lo espera. El saludo era inconsistente
        // (admin veia "Hola, Admin" en vista supervisor, y nada en vista
        // admin) — decidimos quitarlo en ambas para consistencia.
        const firstName = (this.currentUser.full_name || this.currentUser.email).split(' ')[0];
        const welcomeTitle = document.getElementById('supervisor-welcome-title');
        if (welcomeTitle) {
            welcomeTitle.textContent = `${t('supervisor.welcome.greeting')}, ${firstName}`;
        }
        const welcomeSubtitle = document.getElementById('supervisor-welcome-subtitle');
        if (welcomeSubtitle) {
            welcomeSubtitle.textContent = `${restaurants.length} ${t('supervisor.welcome.sites.suffix')}`;
        }

        // Card "Tareas especiales completadas": intentamos poblar con las
        // últimas tareas del sitio en estado completado (o cerrado). Si el
        // backend no acepta la acción o devuelve vacio, dejamos el
        // placeholder original.
        void this.loadSupervisorCompletedTasks();

        this.warmSupervisorWorkspace();
    },

    async loadSupervisorCompletedTasks() {
        const alertsContainer = document.getElementById('supervisor-alerts-container');
        if (!alertsContainer) return;
        try {
            // 1 solo fetch: list_recent_completed ya trae pending_count
            // exacto (confirmado por backend). Antes hacíamos también
            // list status=open limit=200 en paralelo, era redundante.
            const recentResult = await apiClient.operationalTasksManage('list_recent_completed', { limit: 50 });

            // Contador de pendientes (chip arriba) — viene con el mismo request.
            const pendingCount = Number(
                recentResult?.pending_count ?? recentResult?.data?.pending_count ?? 0
            ) || 0;
            const pendingPill = document.getElementById('supervisor-alerts-pending');
            const pendingCountEl = document.getElementById('supervisor-alerts-pending-count');
            if (pendingCountEl) pendingCountEl.textContent = String(pendingCount);
            if (pendingPill) {
                pendingPill.classList.toggle('hidden', pendingCount === 0);
            }

            // Filtro por HOY (día local del navegador). completed_at viene ISO.
            const allItems = asArray(recentResult?.items || recentResult?.data?.items || recentResult);
            const now = new Date();
            const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const items = allItems.filter((task) => {
                if (!task?.completed_at) return false;
                const d = new Date(task.completed_at);
                if (Number.isNaN(d.getTime())) return false;
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                return key === todayKey;
            });

            console.info('[supervisor-alerts] tareas', {
                pendingCount,
                completedTodayCount: items.length,
                completedRecentTotal: allItems.length,
            });

            if (items.length === 0) {
                alertsContainer.innerHTML = `<p class="muted-copy" style="margin:0;">Aún no hay tareas especiales completadas hoy.</p>`;
                return;
            }
            alertsContainer.innerHTML = items
                .map((task) => {
                    const title = escapeHtml(task.title || 'Tarea sin título');
                    const restaurant = escapeHtml(task.restaurant_name || 'Sitio');
                    const completedBy = escapeHtml(task.completed_by || 'Contratista');
                    const completedAt = task.completed_at
                        ? escapeHtml(formatDateTime(task.completed_at))
                        : '';
                    const taskId = escapeHtml(String(task.task_id || task.id || ''));
                    const notes = task.notes ? escapeHtml(String(task.notes)) : '';
                    const evidenceCount = Number(task.evidence_count || 0);
                    const evidenceLabel = evidenceCount > 0
                        ? `<i class="fas fa-images"></i> Ver evidencias (${evidenceCount})`
                        : '<i class="fas fa-images"></i> Ver detalle';
                    return `
                        <div class="alert alert-success" style="margin-bottom:8px;">
                            <i class="fas fa-check-circle"></i>
                            <div style="flex:1;min-width:0;">
                                <strong>${title}</strong><br>
                                <small>${restaurant} · ${completedBy}${completedAt ? ` · ${completedAt}` : ''}</small>
                                ${notes ? `<p class="muted-copy" style="margin:4px 0 0;font-size:12px;">${notes}</p>` : ''}
                                ${taskId ? `<div style="margin-top:6px;">
                                    <button type="button" class="btn btn-secondary btn-inline" data-action="openTaskEvidencesModal" data-args="${taskId}" style="padding:4px 10px;font-size:12px;">
                                        ${evidenceLabel}
                                    </button>
                                </div>` : ''}
                            </div>
                        </div>
                    `;
                })
                .join('');
        } catch (error) {
            const status = error?.status || error?.payload?.error?.code;
            console.warn('[supervisor-alerts] no se pudo cargar tareas completadas', {
                status,
                error_code: error?.payload?.error_code,
            });
            // Solo dejamos el placeholder del HTML; no mostramos toast para no ser ruidosos.
        }
    },

    // ==========================================================================
    // SECCIÓN: Gestión de Sitios (tarjetas, tareas pendientes, eliminar)
    // --------------------------------------------------------------------------
    // Pinta una tarjeta por sitio. El conteo de pendientes viene de
    // operational_tasks_manage 'list_pending' (el backend acepta limit <= 200;
    // con más responde 422). Si hay pendientes, la línea es tocable y abre la
    // lista del sitio. Si la carga falla, la tarjeta dice "No se pudieron
    // cargar" en lugar de "Sin tareas".
    // ==========================================================================

    async loadSupervisorRestaurants(force = false) {
        if (force) {
            this.invalidateCache('supervisorRestaurants', 'supervisorShifts', 'supervisorEmployees');
            this.invalidateScopedCache('supervisorRestaurantStaff');
            this.invalidateScopedCache('supervisorAssignableEmployees');
        }

        const container = document.getElementById('supervisor-restaurants-list');
        if (container) {
            container.innerHTML = '<div class="empty-state">Cargando sitios...</div>';
        }

        let restaurants = [];
        let shifts = [];
        let openTasks = [];
        // Cache simple del listado de tareas open para no re-fetchear en
        // cada render de sitios. TTL corto porque el badge por sitio
        // puede volverse rancio rápido (crear/completar tarea invalida).
        const OPEN_TASKS_TTL_MS = 60 * 1000;
        const openTasksCache = this._openTasksBadgeCache;
        const shouldFetchTasks =
            force ||
            !openTasksCache?.data ||
            Date.now() - (openTasksCache?.ts || 0) > OPEN_TASKS_TTL_MS;
        // Si la carga de tareas falla y no hay cache, NO podemos decir
        // "Sin tareas especiales pendientes": sería mentir. Antes pasaba
        // exactamente eso — el catch devolvía [] y todos los sitios
        // mostraban "Sin tareas" aunque hubiera pendientes.
        let openTasksUnavailable = false;

        try {
            const tasksPromise = shouldFetchTasks
                ? apiClient
                      // list_pending trae items con restaurant_id +
                      // restaurant_name ya resueltos. El backend valida
                      // limit <= 200: con 500 respondía 422 y el catch lo
                      // convertía en lista vacía en silencio.
                      .operationalTasksManage('list_pending', { limit: 200 })
                      .then((res) => asArray(res?.items || res?.data?.items || res))
                      .catch((taskErr) => {
                          console.warn('No fue posible cargar tareas especiales para el render de sitios.', taskErr);
                          if (!openTasksCache?.data) openTasksUnavailable = true;
                          return openTasksCache?.data || [];
                      })
                : Promise.resolve(openTasksCache.data);
            const [r, s, tasks] = await Promise.all([
                this.getSupervisorRestaurants(force),
                this.getSupervisorShiftList({ forceRestaurants: force }).catch((shiftErr) => {
                    console.warn('No fue posible cargar servicios para el render de sitios.', shiftErr);
                    return [];
                }),
                tasksPromise,
            ]);
            restaurants = r;
            shifts = s;
            openTasks = tasks;
            if (shouldFetchTasks && !openTasksUnavailable) {
                this._openTasksBadgeCache = { data: openTasks, ts: Date.now() };
            }
        } catch (error) {
            console.error('No fue posible cargar los sitios.', error);
            if (container) {
                container.innerHTML = `<div class="card"><p style="color: var(--gray);">No fue posible cargar los sitios. ${escapeHtml(this.getErrorMessage(error, 'Intenta nuevamente.'))}</p></div>`;
            }
            return;
        }

        if (!container) {
            return;
        }

        if (restaurants.length === 0) {
            const card = document.createElement('div');
            card.className = 'card';
            const copy = document.createElement('p');
            copy.style.color = 'var(--gray)';
            copy.textContent = 'No hay sitios disponibles.';
            card.appendChild(copy);
            container.replaceChildren(card);
            return;
        }

        const canUseEmployeeCache =
            this.data.supervisor.employees.length > 0 &&
            this.isCacheFresh('supervisorEmployees', CACHE_TTLS.supervisorEmployees);
        const shiftCountByRestaurant = shifts.reduce((accumulator, shift) => {
            const restaurantId = String(
                shift?.restaurant_id ||
                    shift?.restaurant?.restaurant_id ||
                    shift?.restaurant?.id ||
                    shift?.location_id ||
                    shift?.location?.id ||
                    shift?.site_id ||
                    shift?.site?.id ||
                    ''
            );
            if (!restaurantId) {
                return accumulator;
            }

            accumulator[restaurantId] = (accumulator[restaurantId] || 0) + 1;
            return accumulator;
        }, {});
        const availableEmployeeCount = canUseEmployeeCache
            ? this.data.supervisor.employees.filter((employee) => employee?.id && employee.is_active !== false).length
            : null;
        // Contar tareas especiales OPEN por sitio (petición cliente:
        // reemplazar el aviso irrelevante del card por el estado de
        // tarea especial).
        const openTasksByRestaurant = openTasks.reduce((acc, task) => {
            const rid = String(
                task?.restaurant_id ||
                    task?.restaurant?.restaurant_id ||
                    task?.restaurant?.id ||
                    ''
            );
            if (!rid) return acc;
            acc[rid] = (acc[rid] || 0) + 1;
            return acc;
        }, {});
        const canManageRestaurantLifecycle = this.isAdminRole() || this.currentUser?.role === 'supervisora';
        const canCreateRestaurantTasks =
            this.isAdminRole() ||
            ['supervisora', 'supervisor'].includes(String(this.currentUser?.role || '').toLowerCase());

        const fragment = document.createDocumentFragment();
        restaurants.forEach((restaurant) => {
            const restaurantId = getRestaurantRecordId(restaurant);
            const restaurantIdKey = String(restaurantId || '');
            const shiftsForRestaurantCount = shiftCountByRestaurant[restaurantIdKey] || 0;

            const card = document.createElement('div');
            card.className = 'restaurant-card';

            const title = document.createElement('h4');
            title.textContent = getRestaurantDisplayName(restaurant);

            const address = document.createElement('p');
            const addressIcon = document.createElement('i');
            addressIcon.className = 'fas fa-map-marker-alt';
            address.append(
                addressIcon,
                document.createTextNode(
                    ` ${restaurant.address_line || `${restaurant.city || ''} ${restaurant.state || ''}`.trim() || 'Sin dirección'}`
                )
            );

            const employeesLine = document.createElement('p');
            const employeesIcon = document.createElement('i');
            employeesIcon.className = 'fas fa-user';
            employeesLine.append(
                employeesIcon,
                document.createTextNode(
                    ` ${availableEmployeeCount != null ? `${availableEmployeeCount} ${t('site.card.contractors.available')}` : t('site.card.contractors.to.assign')}`
                )
            );

            // El PDF pidió sustituir el "aviso" del card por el estado
            // de tarea especial. Mostramos badge activo si hay al menos
            // una tarea open; si no, indicamos "sin tareas".
            const openTaskCount = openTasksByRestaurant[restaurantIdKey] || 0;
            // Con pendientes la línea es un botón: al tocarla abre la lista
            // de pendientes de ESE sitio. Sin pendientes (o si la carga
            // falló) queda como texto plano.
            const taskLine = document.createElement(openTaskCount > 0 && !openTasksUnavailable ? 'button' : 'p');
            const taskIcon = document.createElement('i');
            let taskLabel;
            if (openTasksUnavailable) {
                taskLine.className = 'restaurant-card-task-empty';
                taskIcon.className = 'fas fa-triangle-exclamation';
                taskLabel = ' No se pudieron cargar las tareas especiales';
            } else if (openTaskCount > 0) {
                taskLine.type = 'button';
                taskLine.className = 'restaurant-card-task-alert restaurant-card-task-link';
                taskLine.dataset.action = 'open-restaurant-pending-tasks';
                taskLine.dataset.restaurantId = restaurantIdKey;
                taskLine.dataset.restaurantName = getRestaurantDisplayName(restaurant);
                taskIcon.className = 'fas fa-star';
                taskLabel = ` ${openTaskCount} tarea${openTaskCount === 1 ? '' : 's'} especial${openTaskCount === 1 ? '' : 'es'} pendiente${openTaskCount === 1 ? '' : 's'}`;
            } else {
                taskLine.className = 'restaurant-card-task-empty';
                // Solo set 'solid' cargado; usamos star-half-stroke como sin-tareas.
                taskIcon.className = 'fas fa-star-half-stroke';
                taskLabel = ' Sin tareas especiales pendientes';
            }
            taskLine.append(taskIcon, document.createTextNode(taskLabel));
            if (taskLine.tagName === 'BUTTON') {
                const chevron = document.createElement('i');
                chevron.className = 'fas fa-chevron-right restaurant-card-task-chevron';
                taskLine.appendChild(chevron);
            }

            card.append(title, address, employeesLine, taskLine);

            if (canManageRestaurantLifecycle || canCreateRestaurantTasks) {
                const actions = document.createElement('div');
                actions.className = 'toolbar-actions restaurant-card-actions';
                if (canCreateRestaurantTasks) {
                    const taskBtn = document.createElement('button');
                    taskBtn.type = 'button';
                    taskBtn.className = 'btn btn-secondary btn-inline';
                    taskBtn.dataset.action = 'open-restaurant-special-task';
                    taskBtn.dataset.restaurantId = String(restaurantId || '');
                    taskBtn.innerHTML = `<i class="fas fa-star"></i> ${escapeHtml(t('site.card.special.task'))}`;
                    actions.appendChild(taskBtn);
                }

                const removeBtn = document.createElement('button');
                if (canManageRestaurantLifecycle) {
                    removeBtn.type = 'button';
                    removeBtn.className = 'btn btn-danger btn-inline';
                    removeBtn.dataset.action = 'confirm-deactivate-restaurant';
                    removeBtn.dataset.restaurantId = String(restaurantId || '');
                    removeBtn.textContent = t('site.card.delete');
                    actions.appendChild(removeBtn);
                }
                card.appendChild(actions);
            }

            fragment.appendChild(card);
        });

        container.replaceChildren(fragment);
    },

    confirmDeactivateRestaurant(restaurantId) {
        const normalizedRestaurantId = normalizeRestaurantId(restaurantId);
        if (normalizedRestaurantId == null) {
            this.showToast(t('sup.toast.site.invalid'), {
                tone: 'warning',
                title: t('sup.toast.site.invalid.title'),
            });
            return;
        }

        void this.deactivateRestaurant(normalizedRestaurantId);
    },

    closeDeactivateRestaurantModal() {
        this.pendingRestaurantDeactivateId = '';
        this.closeModal('modal-restaurant-deactivate');
    },

    async submitDeactivateRestaurantModal() {
        const restaurantId = normalizeRestaurantId(this.pendingRestaurantDeactivateId);
        if (restaurantId == null) {
            this.showToast(t('sup.toast.site.invalid'), {
                tone: 'warning',
                title: t('sup.toast.site.invalid.title'),
            });
            this.closeDeactivateRestaurantModal();
            return;
        }

        this.closeModal('modal-restaurant-deactivate');
        this.pendingRestaurantDeactivateId = '';
        await this.deactivateRestaurant(restaurantId);
    },

    async deactivateRestaurant(restaurantId) {
        const normalizedRestaurantId = normalizeRestaurantId(restaurantId);
        if (normalizedRestaurantId == null) {
            this.showToast(t('sup.toast.site.invalid'), {
                tone: 'warning',
                title: t('sup.toast.site.invalid.title'),
            });
            return;
        }

        this.showLoading(t('sup.toast.deleting.site'), t('sup.toast.deleting.site.desc'));

        try {
            await apiClient.adminRestaurantsManage('deactivate', {
                restaurant_id: normalizedRestaurantId,
            });

            this.invalidateCache('adminRestaurants', 'adminMetrics', 'supervisorRestaurants', 'supervisorShifts');
            this.invalidateScopedCache('supervisorRestaurantStaff');
            this.invalidateScopedCache('supervisorAssignableEmployees');

            // loadSupervisorShifts se eliminó en la migración a Visitas
            // (0c31f0d, 2026-08-12) pero esta llamada quedó: el sitio se
            // borraba OK y después el refresh tiraba TypeError → toast de error.
            await Promise.all([
                this.loadSupervisorRestaurants(true),
                this.loadSupervisorDashboard(),
                this.isAdminRole() ? this.loadAdminDashboard() : Promise.resolve(),
            ]);

            this.showToast(t('sup.toast.site.deleted'), {
                tone: 'success',
                title: t('toast.common.deleted'),
            });
        } catch (error) {
            const title = error?.status === 403 ? 'Permiso insuficiente' : 'No fue posible eliminar el sitio';
            this.showToast(this.getErrorMessage(error, 'No fue posible eliminar el sitio.'), {
                tone: 'error',
                title,
            });
        } finally {
            this.hideLoading();
        }
    },

    // ==========================================================================
    // SECCIÓN: Gestión de contratistas (lista, filtros, eliminar)
    // --------------------------------------------------------------------------
    // Lista de contratistas con filtro por estado y baja (deactivate).
    // ==========================================================================

    async loadSupervisorEmployees(force = false) {
        if (force) {
            this.invalidateCache('supervisorEmployees', 'supervisorRestaurants');
        }

        this.data.supervisor.restaurants = await this.getSupervisorRestaurants(force);

        if (
            !force &&
            this.data.supervisor.employees.length > 0 &&
            this.isCacheFresh('supervisorEmployees', CACHE_TTLS.supervisorEmployees)
        ) {
            this.renderSupervisorEmployees();
            return;
        }

        const employees = await this.runPending(
            `supervisorEmployees:${this.currentUser?.role || 'unknown'}:${force ? 'force' : 'default'}`,
            async () => {
                // Post-corte "Sin asignacion de sitios": ya no filtramos por
                // asignaciones. Todos los roles con permiso admin cargan la
                // lista global de contratistas via admin_users_manage list.
                let result;
                try {
                    result = await apiClient.adminUsersManage('list', { role: 'empleado', limit: 200 });
                    console.info('[loadSupervisorEmployees] adminUsersManage list role=empleado ->', {
                        rol_usuario: this.currentUser?.role,
                        count: Array.isArray(result) ? result.length : 'not-array',
                    });
                } catch (error) {
                    const status = error?.status || error?.payload?.error?.code;
                    console.warn('[loadSupervisorEmployees] adminUsersManage list rechazado', {
                        rol_usuario: this.currentUser?.role,
                        status,
                        error_code: error?.payload?.error_code || error?.payload?.error?.error_code,
                    });
                    // 403 esperado si el rol no es super_admin/superuser. En ese
                    // caso mostramos mensaje amigable en la pantalla (via el
                    // renderer que ya maneja lista vacia) sin toast agresivo.
                    // Otros errores (500, network) si merecen aviso.
                    if (Number(status) !== 403) {
                        this.showToast(
                            `No fue posible cargar contratistas (${status || 'error'}).`,
                            { tone: 'error', title: 'Error al cargar contratistas' }
                        );
                    }
                    this._contractorsListForbidden = Number(status) === 403;
                    result = [];
                }
                return asArray(result)
                    .map((item) => ({
                        id: item.id || item.user_id,
                        full_name: getEmployeeDisplayName(item),
                        email: item.email || '-',
                        phone_e164: item.phone_e164 || item.phone_number || '-',
                        username: item.username || item.user_name || item.employee_username || '',
                        employee_code: item.employee_code || item.code || '',
                        is_active: item.is_active !== false,
                        assignments: [],
                        available_restaurants: [],
                        raw: item,
                    }))
                    .filter((employee) => employee.id)
                    .sort((left, right) => {
                        if ((left.is_active === false) !== (right.is_active === false)) {
                            return left.is_active === false ? 1 : -1;
                        }
                        return String(left.full_name || '').localeCompare(String(right.full_name || ''), 'es', {
                            sensitivity: 'base',
                        });
                    });
            }
        );

        const canViewInactiveEmployees =
            this.currentUser.role === 'super_admin' || this.currentUser.role === 'superuser';
        this.data.supervisor.employees = asArray(employees).filter((employee) => {
            if (!employee?.id) {
                return false;
            }

            return canViewInactiveEmployees || employee.is_active !== false;
        });
        this.touchCache('supervisorEmployees');

        this.renderSupervisorEmployees();
    },

    renderSupervisorEmployees() {
        const container = document.getElementById('supervisor-employees-list');
        if (!container) {
            return;
        }
        const canManagePhoneBinding = this.currentUser?.role === 'super_admin';
        const canViewInactiveEmployees = canManagePhoneBinding || this.currentUser?.role === 'superuser';
        const filtersContainer = document.getElementById('supervisor-employees-filters');
        const statusFilterSelect = document.getElementById('supervisor-employees-status-filter');

        if (filtersContainer) {
            filtersContainer.classList.toggle('hidden', !canViewInactiveEmployees);
        }

        // Siempre forzar filtro 'active' al cargar la gestión de empleados, salvo que el usuario cambie manualmente
        if (!this._supervisorEmployeesFilterInitialized) {
            this.supervisorEmployeesStatusFilter = 'active';
            this._supervisorEmployeesFilterInitialized = true;
        }

        if (statusFilterSelect) {
            statusFilterSelect.value = this.supervisorEmployeesStatusFilter;
        }

        const employees = (this.data.supervisor.employees || []).filter((employee) => {
            if (!employee?.id) {
                return false;
            }

            if (this.supervisorEmployeesStatusFilter === 'inactive') {
                return employee.is_active === false;
            }

            if (this.supervisorEmployeesStatusFilter === 'active') {
                return employee.is_active !== false;
            }

            return true;
        });

        if (employees.length === 0) {
            const card = document.createElement('div');
            card.className = 'card';
            const paragraph = document.createElement('p');
            paragraph.style.color = 'var(--gray)';
            if (this._contractorsListForbidden) {
                paragraph.textContent =
                    'Tu rol no tiene permiso para ver el listado global de contratistas. Coordina con un administrador para que te lo habilite.';
            } else {
                paragraph.textContent =
                    this.supervisorEmployeesStatusFilter === 'inactive'
                        ? 'No hay contratistas inactivos para mostrar.'
                        : this.supervisorEmployeesStatusFilter === 'active'
                          ? 'No hay contratistas activos disponibles para mostrar.'
                          : 'No hay contratistas disponibles para mostrar.';
            }
            card.appendChild(paragraph);
            container.replaceChildren(card);
            return;
        }

        const fragment = document.createDocumentFragment();
        employees.forEach((employee) => {
            const item = document.createElement('div');
            item.className = 'employee-list-item';

            const avatar = document.createElement('div');
            avatar.className = 'employee-avatar';
            avatar.textContent = initials(getEmployeeDisplayName(employee));

            const info = document.createElement('div');
            info.className = 'employee-info';

            const heading = document.createElement('h4');
            heading.textContent = getEmployeeDisplayName(employee);

            const contact = document.createElement('p');
            contact.textContent = `${employee.email || '-'} • ${employee.phone_e164 || '-'}`;

            const auditMeta = document.createElement('div');
            auditMeta.className = 'audit-meta';
            auditMeta.textContent =
                employee.is_active === false
                    ? 'Contratista inactivo. No puede iniciar visitas.'
                    : 'Disponible para visitar cualquier sitio.';

            info.append(heading, contact, auditMeta);

            const actions = document.createElement('div');
            actions.className = 'employee-list-actions';
            const badge = document.createElement('span');
            badge.className = `badge ${employee.is_active === false ? 'badge-danger' : 'badge-success'}`;
            badge.textContent =
                employee.is_active === false ? t('contractor.badge.inactive') : t('contractor.badge.active');
            actions.appendChild(badge);

            // "Desvincular Teléfono" para contratistas retirado por pedido
            // del cliente (consistencia con la vista de inspectores, donde
            // también se quitó). El handler clear-phone-user sigue en el
            // dispatcher por si vuelve a habilitarse desde otro flujo.

            if (employee.is_active !== false) {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'btn btn-secondary btn-inline';
                editBtn.dataset.action = 'beginEditAdminEmployee';
                editBtn.dataset.args = String(employee.id || '');
                editBtn.innerHTML = '<i class="fas fa-pen"></i> <span>Editar</span>';
                editBtn.title = 'Editar los datos del contratista.';
                actions.appendChild(editBtn);

                const revokeDeviceBtn = document.createElement('button');
                revokeDeviceBtn.type = 'button';
                revokeDeviceBtn.className = 'btn btn-outline-warning btn-inline';
                revokeDeviceBtn.dataset.action = 'revoke-device-user';
                revokeDeviceBtn.dataset.userId = String(employee.id || '');
                revokeDeviceBtn.dataset.userName = String(employee.full_name || employee.email || '');
                revokeDeviceBtn.innerHTML = `<i class="fas fa-mobile-screen"></i> <span>${escapeHtml(t('contractor.btn.revoke.device'))}</span>`;
                revokeDeviceBtn.title =
                    'Libera el dispositivo registrado para que el contratista pueda ingresar desde un dispositivo nuevo.';
                actions.appendChild(revokeDeviceBtn);

                const resetPinBtn = document.createElement('button');
                resetPinBtn.type = 'button';
                resetPinBtn.className = 'btn btn-secondary btn-inline';
                resetPinBtn.dataset.action = 'reset-pin-user';
                resetPinBtn.dataset.email = String(employee.email || '');
                resetPinBtn.dataset.userId = String(employee.id || '');
                resetPinBtn.textContent = t('contractor.btn.reset.pin');
                resetPinBtn.title = 'Genera un nuevo PIN y obliga al contratista a cambiarlo al ingresar.';
                actions.appendChild(resetPinBtn);

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn btn-danger btn-inline';
                removeBtn.dataset.action = 'confirm-deactivate-user';
                removeBtn.dataset.userId = String(employee.id || '');
                removeBtn.textContent = t('contractor.btn.delete');
                actions.appendChild(removeBtn);
            } else {
                const reportBtn = document.createElement('button');
                reportBtn.type = 'button';
                reportBtn.className = 'btn btn-primary btn-inline';
                reportBtn.dataset.action = 'generate-inactive-employee-report';
                reportBtn.dataset.userId = String(employee.id || '');
                reportBtn.textContent = 'Generar Informe';
                reportBtn.onclick = () => {
                    // Redirige a la página de informes y selecciona el empleado automáticamente
                    this.goToReportPageWithEmployee(employee);
                };
                actions.appendChild(reportBtn);
            }

            item.append(avatar, info, actions);
            fragment.appendChild(item);
        });

        container.replaceChildren(fragment);
    },

    setSupervisorEmployeesStatusFilter(value = 'all') {
        const normalizedValue = String(value || '').toLowerCase();
        // Por defecto, siempre mostrar solo activos si no se especifica
        this.supervisorEmployeesStatusFilter = ['all', 'active', 'inactive'].includes(normalizedValue)
            ? normalizedValue
            : 'active';
        this.renderSupervisorEmployees();
    },

    // Genera informe para un empleado inactivo desde la tarjeta
    // Redirige a la página de informes y selecciona el empleado automáticamente
    goToReportPageWithEmployee(employee) {
        if (!employee || !employee.id) {
            this.showToast(t('sup.toast.contractor.invalid.report'), {
                tone: 'warning',
                title: t('sup.toast.contractor.invalid'),
            });
            return;
        }
        // Navega correctamente a la página de informes
        this.navigate && this.navigate('supervisor-reports');
        // Espera a que el DOM de la página de informes esté listo y selecciona el empleado
        setTimeout(() => {
            const employeeSelect = document.getElementById('report-employee-select');
            if (employeeSelect) {
                employeeSelect.value = String(employee.id);
                employeeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                // Opcional: hacer scroll a la sección de informes
                const reportSection =
                    document.getElementById('reports-section') || document.getElementById('report-employee-select');
                if (reportSection && typeof reportSection.scrollIntoView === 'function') {
                    reportSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }, 200);
    },

    confirmDeactivateUser(userId) {
        const normalizedUserId = normalizeRestaurantId(userId);
        if (!normalizedUserId) {
            this.showToast(t('sup.toast.user.invalid'), {
                tone: 'warning',
                title: t('sup.toast.user.invalid.title'),
            });
            return;
        }

        void this.deactivateUser(normalizedUserId);
    },

    closeDeactivateUserModal() {
        this.pendingUserDeactivateId = '';
        const reasonInput = document.getElementById('user-deactivate-reason');
        if (reasonInput) {
            reasonInput.value = '';
        }
        this.closeModal('modal-user-deactivate');
    },

    async submitDeactivateUserModal() {
        const userId = normalizeRestaurantId(this.pendingUserDeactivateId);
        if (!userId) {
            this.showToast(t('sup.toast.user.invalid'), {
                tone: 'warning',
                title: t('sup.toast.user.invalid.title'),
            });
            this.closeDeactivateUserModal();
            return;
        }

        const reasonInput = document.getElementById('user-deactivate-reason');
        const reason = String(reasonInput?.value || '').trim();

        this.closeModal('modal-user-deactivate');
        this.pendingUserDeactivateId = '';
        if (reasonInput) {
            reasonInput.value = '';
        }

        await this.deactivateUser(userId, reason);
    },

    async deactivateUser(userId, reason = '') {
        const normalizedUserId = normalizeRestaurantId(userId);
        if (!normalizedUserId) {
            this.showToast(t('sup.toast.user.invalid'), {
                tone: 'warning',
                title: t('sup.toast.user.invalid.title'),
            });
            return;
        }

        this.showLoading(t('sup.toast.deleting.user'), t('sup.toast.deleting.user.desc'));

        try {
            await apiClient.adminUsersManage('deactivate', {
                user_id: normalizedUserId,
                reason: reason || undefined,
            });

            this.invalidateCache('supervisorEmployees', 'supervisorShifts');
            this.invalidateScopedCache('supervisorAssignableEmployees');

            // Ver deactivateRestaurant: loadSupervisorShifts ya no existe.
            await Promise.all([
                this.loadSupervisorEmployees(true),
                this.loadSupervisorDashboard(),
            ]);

            this.showToast(t('sup.toast.user.deleted'), {
                tone: 'success',
                title: t('toast.common.deleted'),
            });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible eliminar el usuario.'), {
                tone: 'error',
                title: error?.status === 403 ? 'Permiso insuficiente' : 'No fue posible eliminar el usuario',
            });
        } finally {
            this.hideLoading();
        }
    },

    // ==========================================================================
    // SECCIÓN: Informes: preparar las pantallas (visitas y auditorías)
    // --------------------------------------------------------------------------
    // Al entrar a informes se ponen las fechas de hoy (fecha LOCAL) y se
    // llenan los selects de sitio, contratista e inspector.
    // ==========================================================================


    async prepareSupervisorReportsPage() {
        const [restaurants] = await Promise.all([
            this.getSupervisorRestaurants(),
            this.data.supervisor.employees.length === 0 ? this.loadSupervisorEmployees() : Promise.resolve(),
        ]);

        // Fechas por defecto: HOY. Antes tenian value hardcoded en HTML.
        const startInput = document.getElementById('report-start-date');
        const endInput = document.getElementById('report-end-date');
        // Fecha actual como default cada vez que entra a la pantalla.
        // Antes solo si el input estaba vacio; el navegador puede restaurar
        // valores de sesion previa (autofill), asi que forzamos hoy siempre.
        // Si el usuario cambia la fecha manualmente ya generara con lo elegido.
        // Fecha LOCAL, no UTC (toISOString daba mañana después de las 7 p. m.).
        const todayIso = toLocalDateKey(new Date());
        if (startInput) startInput.value = todayIso;
        if (endInput) endInput.value = todayIso;

        const restaurantSelect = document.getElementById('report-restaurant-select');
        const employeeSelect = document.getElementById('report-employee-select');
        if (!restaurantSelect) return;

        const currentRestaurantValue = restaurantSelect.value;
        const currentEmployeeValue = employeeSelect?.value || '';

        if (restaurants.length === 0) {
            restaurantSelect.innerHTML = '<option value="">Todos los sitios</option>';
        } else {
            restaurantSelect.innerHTML = `
                <option value="">Todos los sitios</option>
                ${restaurants
                    .map((restaurant) => `
                    <option value="${escapeHtml(String(getRestaurantRecordId(restaurant)))}">
                        ${escapeHtml(getRestaurantDisplayName(restaurant))}
                    </option>
                `)
                    .join('')}
            `;
            const availableRestaurantIds = new Set(
                restaurants.map((restaurant) => String(getRestaurantRecordId(restaurant)))
            );
            restaurantSelect.value = availableRestaurantIds.has(String(currentRestaurantValue))
                ? String(currentRestaurantValue)
                : '';
        }

        if (employeeSelect) {
            employeeSelect.innerHTML = `
                <option value="">${escapeHtml(t('supervisor.shifts.all.employees'))}</option>
                ${asArray(this.data.supervisor?.employees)
                    .map((employee) => {
                        const id = String(employee.id);
                        return `<option value="${escapeHtml(id)}" ${id === currentEmployeeValue ? 'selected' : ''}>${escapeHtml(getEmployeeDisplayName(employee))}</option>`;
                    })
                    .join('')}
            `;
        }
        this.updateReportSupportCard();
    },

    async prepareAdminSupervisionMonitorReport() {
        const canLoadSupervisors = typeof this.loadAdminSupervisors === 'function' && this.isAdminRole && this.isAdminRole();
        await Promise.all([
            this.getSupervisorRestaurants().catch(() => []),
            canLoadSupervisors && asArray(this.data.admin?.supervisors).length === 0
                ? this.loadAdminSupervisors().catch(() => null)
                : Promise.resolve(),
        ]);

        const restaurantSelect = document.getElementById('audit-report-restaurant-select');
        const supervisorSelect = document.getElementById('audit-report-supervisor-select');
        const startInput = document.getElementById('audit-report-start-date');
        const endInput = document.getElementById('audit-report-end-date');

        // Fecha actual LOCAL como default (mismo criterio que el reporte de visitas).
        if (startInput) {
            startInput.value = toLocalDateKey(new Date());
        }
        if (endInput) {
            endInput.value = toLocalDateKey(new Date());
        }

        if (restaurantSelect) {
            const currentValue = restaurantSelect.value || '';
            const restaurants = asArray(this.data.supervisor?.restaurants);
            restaurantSelect.innerHTML = `
                <option value="">Todos los sitios</option>
                ${restaurants
                    .map((restaurant) => {
                        const id = String(getRestaurantRecordId(restaurant));
                        return `<option value="${escapeHtml(id)}" ${id === currentValue ? 'selected' : ''}>${escapeHtml(getRestaurantDisplayName(restaurant))}</option>`;
                    })
                    .join('')}
            `;
        }

        if (supervisorSelect) {
            const currentValue = supervisorSelect.value || '';
            const supervisors = asArray(this.data.admin?.supervisors);
            supervisorSelect.innerHTML = `
                <option value="">Todos los inspectores</option>
                ${supervisors
                    .map((sup) => {
                        const id = String(sup.id ?? sup.user_id ?? '');
                        const name = sup.full_name || sup.email || t('admin.supervisors.role.fallback');
                        if (!id) return '';
                        return `<option value="${escapeHtml(id)}" ${id === currentValue ? 'selected' : ''}>${escapeHtml(name)}</option>`;
                    })
                    .filter(Boolean)
                    .join('')}
            `;
        }
    },

    async generateAuditReportFromMonitor() {
        const startDate = document.getElementById('audit-report-start-date')?.value;
        const endDate = document.getElementById('audit-report-end-date')?.value;
        const restaurantId = document.getElementById('audit-report-restaurant-select')?.value;
        const supervisorId = document.getElementById('audit-report-supervisor-select')?.value;

        if (!startDate || !endDate) {
            this.showToast('Selecciona un rango de fechas.', {
                tone: 'warning',
                title: 'Faltan filtros',
            });
            return;
        }
        if (startDate > endDate) {
            this.showToast('La fecha de inicio no puede ser mayor que la fecha fin.', {
                tone: 'warning',
                title: 'Rango inválido',
            });
            return;
        }
        await this.generateAuditsReport({ startDate, endDate, restaurantId, supervisorId, showInline: true });
    },

    downloadAuditReport(type) {
        const report = this.data.lastGeneratedAuditReport;
        if (!report) {
            this.showToast('Genera primero el informe.', { tone: 'warning', title: 'Sin resultados' });
            return;
        }
        const url = type === 'pdf' ? report.url_pdf : report.url_excel;
        if (!url) {
            this.showToast(`No fue posible preparar la descarga en ${type.toUpperCase()}.`, {
                tone: 'error',
                title: 'Descarga no disponible',
            });
            return;
        }
        this.openInNewTab(url);
    },

    // ==========================================================================
    // SECCIÓN: Auditoría: entrar, detectar el sitio y verificar la geocerca
    // --------------------------------------------------------------------------
    // Al entrar se detecta el sitio más cercano por GPS
    // (autoDetectSupervisorSupervisionSite) y se verifica que el inspector
    // esté dentro (verifySupervisorSupervisionLocation).
    // getSupervisionEffectiveRadius es la ÚNICA fuente de tolerancia GPS de la
    // auditoría (radio mínimo 50 m + precisión del GPS, con tope de 150 m): la
    // usan el auto-detect y el botón "Verificar". No crear un segundo cálculo,
    // porque si difieren el sitio aparece detectado y después "fuera de rango".
    // ==========================================================================

    async prepareSupervisorSupervisionPage() {
        // Bug reportado: al reabrir "Auditoría" quedaban fotos y notas
        // de la sesión anterior. Se resetea vía updateSupervisorSupervisionLocationLabel
        // más abajo, que ya invoca resetSupervisorSupervisionState internamente.
        if (this.data.supervisor.restaurants.length === 0) {
            this.data.supervisor.restaurants = await this.getSupervisorRestaurants();
        }

        if (
            this.data.supervisor.shifts.length === 0 ||
            !this.isCacheFresh('supervisorShifts', CACHE_TTLS.supervisorShifts)
        ) {
            this.data.supervisor.shifts = await this.getSupervisorShiftList({ forceRestaurants: false });
        }

        // Placeholder true para NO pre-seleccionar el primer sitio de la
        // lista (Bug reportado: al entrar se veía "Burbank" seleccionado
        // aunque el inspector estuviera en otro sitio, y el auto-detect
        // no corría porque el select ya tenía value).
        this.populateSupervisorRestaurantOptions('supervision-restaurant-select', true);
        this.selectedSupervisorShiftId = '';
        this.updateSupervisorSupervisionLocationLabel();
        this.updateSupervisionSupportCard();

        // Adjuntos de observaciones: bind del input (una vez) y render
        // del listado. El buffer _supervisionObservationsAttachments se
        // limpia en resetSupervisorSupervisionState al entrar/salir.
        this._supervisionObservationsAttachments = this._supervisionObservationsAttachments || [];
        this.bindSupervisionObservationsAttachmentsOnce();
        this.renderSupervisionObservationsAttachments();

        // Auto-detección del sitio por geofence. Corre SIEMPRE al entrar y
        // pisa cualquier value residual (el populate deja el placeholder
        // vacío, pero por seguridad el propio auto-detect no respeta
        // valores previos).
        void this.autoDetectSupervisorSupervisionSite();
    },

    async autoDetectSupervisorSupervisionSite() {
        const select = document.getElementById('supervision-restaurant-select');
        if (!select) return;
        // El auto-detect corre SIEMPRE al entrar y pisa cualquier valor
        // preexistente. Antes se abortaba si select.value existía, pero
        // populateSupervisorRestaurantOptions con includePlaceholder=false
        // seleccionaba el primer sitio de la lista y este check bloqueaba
        // la detección — el inspector veía "Burbank" aunque estuviera en
        // otro sitio.

        const restaurants = asArray(this.data.supervisor.restaurants);
        console.info('[auditoria-autodetect] entrada', {
            totalRestaurants: restaurants.length,
            firstRestaurantKeys: restaurants[0] ? Object.keys(restaurants[0]) : null,
        });
        if (restaurants.length === 0) return;

        // SIEMPRE capturamos ubicación fresca al entrar. Reusar this.location
        // vieja (de un flujo anterior en otro sitio) era la causa principal
        // por la que no detectaba: el inspector podía haber cerrado sesión
        // en otro sitio y las coords en memoria eran esas.
        let location = null;
        try {
            location = await this.captureLocation({ updateUi: false, highAccuracy: true });
        } catch (err) {
            console.info('[auditoria-autodetect] GPS no disponible', err?.message || err);
            this.showToast(
                'No pudimos leer tu ubicación. Elige el sitio manualmente y toca "Verificar ubicación".',
                { tone: 'info', title: 'Ubicación no disponible' }
            );
            return;
        }
        if (!location || !Number.isFinite(Number(location.lat))) {
            this.showToast(
                'No pudimos leer tu ubicación. Elige el sitio manualmente y toca "Verificar ubicación".',
                { tone: 'info', title: 'Ubicación no disponible' }
            );
            return;
        }

        const accuracyMeters = Math.max(0, Number(location.accuracy || 0));

        // Log por sitio con datos crudos — permite diagnosticar en dispositivo
        // por qué no matcheó (falta de coords, radio muy chico, distancia grande).
        const evaluated = restaurants.map((restaurant) => {
            const geofence = this.getSupervisorRestaurantGeofence(restaurant);
            const distance = geofence.hasCoordinates
                ? calculateDistanceMeters(location, { lat: geofence.lat, lng: geofence.lng })
                : null;
            const effectiveRadius = this.getSupervisionEffectiveRadius(geofence.radiusMeters, accuracyMeters);
            return {
                name: getRestaurantDisplayName(restaurant),
                hasCoords: geofence.hasCoordinates,
                lat: geofence.lat,
                lng: geofence.lng,
                radius: geofence.radiusMeters,
                distance: distance != null ? Math.round(distance) : null,
                effectiveRadius: Math.round(effectiveRadius),
                within: distance != null && distance <= effectiveRadius,
                restaurant,
            };
        });
        console.info('[auditoria-autodetect] evaluación por sitio', {
            miUbicacion: { lat: location.lat, lng: location.lng, accuracy: Math.round(accuracyMeters) },
            sitios: evaluated.map(({ restaurant, ...rest }) => rest),
        });

        const nearby = evaluated
            .filter((e) => e.within)
            .sort((a, b) => a.distance - b.distance);

        // Fallback: si el inspector solo tiene 1 sitio en su lista completa,
        // lo pre-seleccionamos aunque no matchee (radio mal configurado, GPS
        // impreciso en interior). El inspector aún tiene que tocar "Verificar
        // ubicación" antes de auditar, pero le ahorra el paso de elegirlo.
        const singleSiteFallback = restaurants.length === 1 ? evaluated[0] : null;

        if (nearby.length === 0 && !singleSiteFallback) {
            this.showToast(
                'No estás dentro del radio de ningún sitio. Elige el sitio manualmente y acércate para auditar.',
                { tone: 'info', title: 'Sin sitios cercanos' }
            );
            return;
        }
        // Si no hubo match pero hay UN solo sitio, lo usamos como fallback.
        if (nearby.length === 0 && singleSiteFallback) {
            nearby.push(singleSiteFallback);
        }

        // Preferimos el más cercano. Si hay varios, igual el más cercano
        // suele ser el correcto (radios rara vez se superponen).
        const chosen = nearby[0].restaurant;
        const chosenId = String(getRestaurantRecordId(chosen) || '');
        if (!chosenId) return;

        select.value = chosenId;
        select.dispatchEvent(new Event('change', { bubbles: true }));

        // Validación silenciosa (sin toast propio). El toast final se
        // decide según el resultado real de la verificación para no
        // mentir sobre la validación.
        let verifyResult = null;
        try {
            verifyResult = await this.verifySupervisorSupervisionLocation({ forceCapture: false, notify: false });
        } catch (err) {
            console.info('[auditoria-autodetect] verify falló', err?.message || err);
        }

        const chosenName = getRestaurantDisplayName(chosen);

        // UX: si solo hay UN candidato dentro del radio, ocultamos el
        // picker y mostramos un chip con el nombre + link "Elegir otro
        // sitio" (por si el auto-detect se equivocó). Si hay múltiples
        // candidatos o el fallback single-site no matcheó, dejamos el
        // picker visible para que el inspector elija.
        const strictNearbyCount = evaluated.filter((e) => e.within).length;
        if (strictNearbyCount === 1) {
            this.setSupervisionRestaurantAutoLock(chosenName);
        } else {
            this.setSupervisionRestaurantAutoLock(null);
        }

        if (verifyResult?.ok && this.supervisionLocationVerified) {
            this.showToast(
                `Sitio detectado automáticamente: ${chosenName}. Ya puedes auditar.`,
                { tone: 'success', title: 'Ubicación validada' }
            );
        } else {
            this.showToast(
                `Sitio detectado: ${chosenName}. Toca "Verificar ubicación" para confirmar antes de auditar.`,
                { tone: 'info', title: 'Sitio pre-seleccionado' }
            );
        }
    },

    /**
     * Alterna la visibilidad del select "Sitio / Cliente" en la vista
     * de auditoría. Si name != null, oculta el picker y muestra el chip
     * "Auditando en <name>". Si name == null, revierte a picker visible.
     */
    setSupervisionRestaurantAutoLock(name) {
        const picker = document.getElementById('supervision-restaurant-picker');
        const chip = document.getElementById('supervision-restaurant-chip');
        const chipName = document.getElementById('supervision-restaurant-chip-name');
        if (!picker || !chip) return;
        if (name) {
            picker.classList.add('hidden');
            chip.classList.remove('hidden');
            if (chipName) chipName.textContent = String(name);
        } else {
            picker.classList.remove('hidden');
            chip.classList.add('hidden');
            if (chipName) chipName.textContent = '';
        }
    },

    /**
     * Handler del "Elegir otro sitio" del chip. Desbloquea el picker
     * para que el inspector elija manualmente aunque el auto-detect
     * haya matcheado un sitio.
     */
    supervisorPickAnotherSite() {
        this.setSupervisionRestaurantAutoLock(null);
    },

    /**
     * Tolerancia GPS ÚNICA para la geocerca de auditoría.
     *
     * Antes había dos cálculos distintos: el auto-detect usaba buffer de 60 m
     * y `verifySupervisorSupervisionLocation` usaba 35 m. Resultado: el sitio
     * se pre-seleccionaba ("Ubicación lista para verificar en Burbank") pero
     * al tocar Verificar decía "fuera de rango" — el bug que reportó Henry.
     *
     * Reglas (mismas que el guard de tarea especial, PR #33):
     * - piso de radio de 50 m (hay sitios cargados con radios de 20-30 m).
     * - buffer = accuracy real, con tope de 150 m (GPS indoor pierde fácil
     *   50-120 m; sin tope cualquiera validaría desde cualquier lado).
     */
    getSupervisionEffectiveRadius(radiusMeters, accuracyMeters) {
        const rawRadius = Math.max(Number(radiusMeters) || 0, 0);
        const accuracy = Math.max(Number(accuracyMeters) || 0, 0);
        const MIN_RADIUS_METERS = 50;
        const MAX_ACCURACY_BUFFER_METERS = 150;
        const accuracyBuffer = Math.min(accuracy, MAX_ACCURACY_BUFFER_METERS);
        return Math.max(rawRadius, MIN_RADIUS_METERS) + accuracyBuffer;
    },

    getSupervisorRestaurantGeofence(restaurant = null) {
        const source = restaurant && typeof restaurant === 'object' ? restaurant : {};
        const lat = resolveRecordNumber(source, [
            'lat',
            'latitude',
            'restaurant_lat',
            'restaurant_latitude',
            'location_lat',
            'location.latitude',
            'restaurant.lat',
            'restaurant.latitude',
            'raw.lat',
            'raw.latitude',
            'raw.restaurant_lat',
            'raw.restaurant.latitude',
            'raw.restaurant.lat',
        ]);
        const lng = resolveRecordNumber(source, [
            'lng',
            'lon',
            'longitude',
            'restaurant_lng',
            'restaurant_longitude',
            'location_lng',
            'location.longitude',
            'restaurant.lng',
            'restaurant.longitude',
            'raw.lng',
            'raw.lon',
            'raw.longitude',
            'raw.restaurant_lng',
            'raw.restaurant.longitude',
            'raw.restaurant.lng',
        ]);
        const radiusMeters = resolveRecordNumber(source, [
            'radius',
            'radius_meters',
            'verification_radius',
            'verification_radius_meters',
            'restaurant_radius',
            'restaurant_verification_radius',
            'geofence_radius',
            'location_radius',
            'raw.radius',
            'raw.radius_meters',
            'raw.verification_radius',
            'raw.restaurant.radius',
            'raw.restaurant.verification_radius',
        ]);

        return {
            lat,
            lng,
            radiusMeters: radiusMeters != null && radiusMeters > 0 ? radiusMeters : 100,
            hasCoordinates: lat != null && lng != null,
            hasConfiguredRadius: radiusMeters != null && radiusMeters > 0,
            isReady: lat != null && lng != null,
        };
    },

    getSupervisorSupervisionReference() {
        const restaurant = this.getSupervisorSelectedRestaurant();
        const restaurantId = restaurant ? String(getRestaurantRecordId(restaurant) || '') : '';
        const shifts = this.getSupervisorRestaurantShifts();
        const geofence = this.getSupervisorRestaurantGeofence(restaurant);
        const locationCheck =
            this.supervisionLocationCheck && String(this.supervisionLocationCheck.restaurantId || '') === restaurantId
                ? this.supervisionLocationCheck
                : null;

        if (!restaurantId) {
            return {
                restaurant,
                restaurantName: '',
                shifts: [],
                geofence,
                locationCheck,
            };
        }

        const restaurantName = this.getResolvedShiftRestaurantName(
            { restaurant_id: restaurantId, restaurant },
            getRestaurantDisplayName(restaurant)
        );
        const addressParts = [
            restaurant?.address_line,
            [restaurant?.city, restaurant?.state].filter(Boolean).join(', '),
            restaurant?.country,
        ]
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        return {
            restaurant,
            restaurantName,
            shifts,
            geofence,
            locationCheck,
            addressText: addressParts.join(' • '),
        };
    },

    renderSupervisorSupervisionSummary() {
        const container = document.getElementById('supervision-target-summary');
        if (!container) {
            return;
        }

        const { restaurantName, shifts, geofence, locationCheck, addressText } =
            this.getSupervisorSupervisionReference();

        if (!restaurantName) {
            container.innerHTML = '<div class="empty-state">Selecciona un sitio para preparar la auditoría.</div>';
            return;
        }

        const availableAreas = this.getSupervisorAvailableAreas();
        const checkedDistanceMeters = Number(locationCheck?.distanceMeters);
        const hasCheckedDistance = Number.isFinite(checkedDistanceMeters);
        const checkedRadiusMeters = Number(locationCheck?.radiusMeters);
        const checkedEffectiveRadiusMeters = Number(locationCheck?.effectiveRadiusMeters);
        const checkedAllowedRadiusMeters = Number.isFinite(checkedEffectiveRadiusMeters)
            ? checkedEffectiveRadiusMeters
            : checkedRadiusMeters;
        const isCheckedOutsideRange =
            hasCheckedDistance &&
            Number.isFinite(checkedAllowedRadiusMeters) &&
            checkedDistanceMeters > checkedAllowedRadiusMeters;
        const hasLocationError = Boolean(locationCheck?.errorMessage);
        let locationStatusLabel = 'Pendiente';
        let locationStatusClass = 'badge-warning';
        let locationSummary = 'Verifica tu ubicación para validar presencia en sitio';

        if (!geofence?.isReady) {
            locationStatusLabel = 'Geocerca pendiente';
            locationSummary = 'Este sitio todavía no tiene coordenadas verificables.';
        } else if (locationCheck?.ok) {
            locationStatusLabel = 'En sitio';
            locationStatusClass = 'badge-success';
            locationSummary = `${Math.round(checkedDistanceMeters)} m del punto de control`;
        } else if (locationCheck?.blockedByPermission) {
            locationStatusLabel = 'GPS bloqueado';
            locationSummary = 'Permiso GPS bloqueado en el navegador.';
        } else if (hasLocationError) {
            locationStatusLabel = 'GPS no verificado';
            locationSummary = locationCheck.errorMessage;
        } else if (locationCheck?.attemptedAt && isCheckedOutsideRange) {
            locationStatusLabel = 'Fuera de rango';
            locationStatusClass = 'badge-danger';
            locationSummary = `${Math.round(checkedDistanceMeters)} m del punto de control`;
        } else if (locationCheck?.attemptedAt && hasCheckedDistance) {
            locationStatusLabel = 'Verificación fallida';
            locationSummary = `${Math.round(checkedDistanceMeters)} m detectados dentro del radio; reintenta la verificación.`;
        } else if (locationCheck?.attemptedAt) {
            locationStatusLabel = 'Verificación fallida';
            locationSummary = 'No fue posible calcular la distancia al sitio.';
        }

        container.innerHTML = `
            <div class="supervision-target-top">
                <div>
                    <strong>${escapeHtml(restaurantName)}</strong>
                    <p class="muted-copy">${escapeHtml(addressText || 'Ubicación del sitio pendiente de detalle')}</p>
                </div>
                <span class="badge ${locationStatusClass}">${escapeHtml(locationStatusLabel)}</span>
            </div>
            <div class="supervision-target-grid">
                <div class="supervision-target-item">
                    <span class="supervision-target-label">Restaurante</span>
                    <span class="supervision-target-value">${escapeHtml(restaurantName)}</span>
                </div>
                <div class="supervision-target-item">
                    <span class="supervision-target-label">Turnos hoy</span>
                    <span class="supervision-target-value">${escapeHtml(String(shifts.length))}</span>
                </div>
                <div class="supervision-target-item">
                    <span class="supervision-target-label">Radio permitido</span>
                    <span class="supervision-target-value">${escapeHtml(geofence?.isReady ? `${Math.round(geofence.radiusMeters || 0)} m` : 'Sin geocerca')}</span>
                </div>
                <div class="supervision-target-item">
                    <span class="supervision-target-label">Ubicación actual</span>
                    <span class="supervision-target-value">${escapeHtml(locationSummary)}</span>
                </div>
                <div class="supervision-target-item">
                    <span class="supervision-target-label">Áreas disponibles</span>
                    <span class="supervision-target-value">${escapeHtml(String(availableAreas.length || 0))}</span>
                </div>
                <div class="supervision-target-item">
                    <span class="supervision-target-label">Observación</span>
                    <span class="supervision-target-value">${escapeHtml(shifts.length > 0 ? 'La auditoría se guarda sobre el sitio, no sobre un servicio puntual.' : 'Puedes auditar aunque hoy no haya servicios cargados en el resumen.')}</span>
                </div>
            </div>
        `;
    },

    clearSupervisorSupervisionLocationState() {
        this.supervisionLocationVerified = false;
        this.supervisionLocationCheck = null;
    },

    updateSupervisorSupervisionLocationUi(result = null) {
        const shell = document.getElementById('supervision-location-status-shell');
        const icon = document.getElementById('supervision-location-status-icon');
        const label = document.getElementById('supervision-location-status');
        const button = document.getElementById('supervision-verify-location-btn');
        const restaurantTaskButton = document.getElementById('supervision-create-restaurant-task-btn');
        const { restaurant, restaurantName, geofence } = this.getSupervisorSupervisionReference();
        const activeResult = result || this.supervisionLocationCheck || null;

        if (restaurantTaskButton) {
            restaurantTaskButton.disabled = !restaurant;
        }

        if (!shell || !label) {
            this.renderSupervisorSupervisionSummary();
            return;
        }

        shell.classList.remove('valid', 'invalid', 'warning');
        if (icon) {
            icon.className = 'fas fa-location-crosshairs';
        }

        if (!restaurant) {
            shell.classList.add('warning');
            label.textContent = 'Selecciona un sitio para verificar la ubicación.';
            if (button) {
                button.disabled = true;
                button.innerHTML = '<i class="fas fa-location-crosshairs"></i> Verificar en sitio';
            }
            this.renderSupervisorSupervisionSummary();
            return;
        }

        if (!geofence?.isReady) {
            shell.classList.add('warning');
            label.textContent = `El sitio ${restaurantName} todavía no tiene geocerca configurada.`;
            if (button) {
                button.disabled = true;
                button.innerHTML = '<i class="fas fa-location-crosshairs"></i> Geocerca pendiente';
            }
            this.renderSupervisorSupervisionSummary();
            return;
        }

        if (activeResult?.ok) {
            shell.classList.add('valid');
            if (icon) {
                icon.className = 'fas fa-check-circle';
            }
            const distanceMeters = Number(activeResult.distanceMeters);
            const distanceText = Number.isFinite(distanceMeters)
                ? `${Math.round(distanceMeters)} m`
                : 'distancia validada';
            label.textContent = `Ubicación validada en ${restaurantName}: ${distanceText} del punto de control.`;
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-check"></i> Revalidar ubicación';
            }
        } else if (activeResult?.errorMessage || activeResult?.blockedByPermission) {
            const blocked = Boolean(activeResult?.blockedByPermission);
            shell.classList.add(blocked ? 'warning' : 'invalid');
            if (icon) {
                icon.className = blocked ? 'fas fa-triangle-exclamation' : 'fas fa-times-circle';
            }
            label.textContent = blocked
                ? 'Permiso de ubicación bloqueado. Habilita el GPS en Ajustes › Safari/Chrome › Ubicación, luego reintenta.'
                : activeResult.errorMessage || 'No fue posible obtener tu ubicación. Reintenta.';
            if (button) {
                button.disabled = false;
                button.innerHTML = blocked
                    ? '<i class="fas fa-location-crosshairs"></i> Reintentar con GPS activo'
                    : '<i class="fas fa-rotate-right"></i> Reintentar GPS';
            }
        } else if (activeResult?.attemptedAt) {
            const distanceMeters = Number(activeResult.distanceMeters);
            const radiusMeters = Number(activeResult.radiusMeters);
            const hasValidDistance = Number.isFinite(distanceMeters) && distanceMeters > 0;
            const hasRangeDetails = hasValidDistance && Number.isFinite(radiusMeters);
            const effectiveRadiusMeters = Number(activeResult.effectiveRadiusMeters);
            const allowedRadiusMeters = Number.isFinite(effectiveRadiusMeters) ? effectiveRadiusMeters : radiusMeters;
            const isOutsideRange =
                hasRangeDetails && Number.isFinite(allowedRadiusMeters) && distanceMeters > allowedRadiusMeters;
            shell.classList.add(isOutsideRange ? 'invalid' : 'warning');
            if (icon) {
                icon.className = isOutsideRange ? 'fas fa-times-circle' : 'fas fa-triangle-exclamation';
            }
            label.textContent = !hasValidDistance
                ? `No pudimos leer tu ubicación para ${restaurantName}. Verifica que el GPS esté activo y reintenta.`
                : isOutsideRange
                  ? `Fuera de rango para ${restaurantName}: ${Math.round(distanceMeters)} m de distancia, se permiten hasta ${Math.round(allowedRadiusMeters)} m.`
                  : `La ubicación detectada para ${restaurantName} está dentro del radio configurado (${Math.round(distanceMeters)} m de ${Math.round(radiusMeters)} m), pero la validación no se completó. Reintenta la verificación GPS.`;
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-rotate-right"></i> Reintentar verificación';
            }
        } else {
            shell.classList.add('warning');
            label.textContent = `${t('audit.location.ready')} ${restaurantName}.`;
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-location-crosshairs"></i> Verificar en sitio';
            }
        }

        this.renderSupervisorSupervisionSummary();
    },

    async verifySupervisorSupervisionLocation({ forceCapture = true, notify = true } = {}) {
        const { restaurant, restaurantName, geofence } = this.getSupervisorSupervisionReference();
        const button = document.getElementById('supervision-verify-location-btn');
        if (!restaurant) {
            this.showToast(t('sup.toast.select.site.location'), {
                tone: 'warning',
                title: t('sup.toast.site.missing'),
            });
            return null;
        }

        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando';
        }

        try {
            if (!geofence?.isReady) {
                this.updateSupervisorSupervisionLocationUi({
                    restaurantId: String(getRestaurantRecordId(restaurant) || ''),
                    attemptedAt: new Date().toISOString(),
                    ok: false,
                    distanceMeters: null,
                    radiusMeters: geofence?.radiusMeters || 0,
                });
                this.showToast(
                    `El sitio ${restaurantName} aún no tiene ubicación o radio configurados para validar presencia.`,
                    {
                        tone: 'warning',
                        title: t('sup.toast.geofence.pending'),
                    }
                );
                return null;
            }

            let location = this.location;
            if (forceCapture || !location) {
                // Auditoría: forzamos GPS fresco de alta precisión para no
                // recibir GPS_OUT_OF_RANGE por coords WiFi/celular stale.
                location = await this.captureLocation({ updateUi: false, highAccuracy: true });
            }

            const distanceMeters = calculateDistanceMeters(location, {
                lat: geofence.lat,
                lng: geofence.lng,
            });
            const hasDistanceMeters = Number.isFinite(Number(distanceMeters));
            const accuracyMeters = Math.max(0, Number(location?.accuracy || 0));
            const effectiveRadiusMeters = this.getSupervisionEffectiveRadius(geofence.radiusMeters, accuracyMeters);
            const result = {
                restaurantId: String(getRestaurantRecordId(restaurant) || ''),
                restaurantName,
                attemptedAt: new Date().toISOString(),
                ok: hasDistanceMeters && distanceMeters <= effectiveRadiusMeters,
                location,
                distanceMeters,
                radiusMeters: geofence.radiusMeters || 0,
                effectiveRadiusMeters,
                accuracyMeters,
            };

            // Log diagnóstico: mismo formato que [rtask-file-geofence] para
            // poder comparar ambos guards desde el device del inspector.
            console.info('[auditoria-verify] calc', {
                sitio: restaurantName,
                distancia: Number.isFinite(Number(distanceMeters)) ? Math.round(distanceMeters) : null,
                radioConfigurado: Math.round(geofence.radiusMeters || 0),
                radioEfectivo: Math.round(effectiveRadiusMeters),
                accuracy: Math.round(accuracyMeters),
                ok: result.ok,
            });

            this.supervisionLocationVerified = result.ok;
            this.supervisionLocationCheck = result;
            this.updateSupervisorSupervisionLocationUi(result);

            if (notify) {
                this.showToast(
                    result.ok
                        ? `Ubicación validada para ${restaurantName}. Ya puedes registrar la auditoría.`
                        : `No estás dentro del radio permitido de ${restaurantName} (${Math.round(Number(distanceMeters) || 0)} m de distancia, máximo ${Math.round(effectiveRadiusMeters)} m). Acércate al sitio para registrar la auditoría.`,
                    {
                        tone: result.ok ? 'success' : 'warning',
                        title: result.ok ? 'Ubicación validada' : 'Fuera de rango',
                    }
                );
            }

            // Progresivo: apenas la ubicación es OK, disparamos el 'start' en
            // background para tener presence_id listo cuando el inspector tome
            // la primera foto (así el primer upload no espera round-trip extra).
            // Fire-and-forget: si falla, el próximo enqueueSupervisionSlotUpload
            // lo reintenta vía ensureSupervisionDraft. Antes chequeamos reanudación.
            if (result.ok) {
                (async () => {
                    try {
                        const resumed = await this.resumeSupervisionDraftIfAny();
                        if (!resumed) {
                            await this.ensureSupervisionDraft();
                        }
                    } catch (err) {
                        console.warn('[supervision] no se pudo preparar el draft:', err?.message || err);
                    }
                })();
            }

            return result;
        } catch (error) {
            const blockedByPermission = this.isGeolocationPermissionDenied(error);
            const errorMessage = this.getGeolocationMessage(error);
            this.supervisionLocationVerified = false;
            this.supervisionLocationCheck = {
                restaurantId: String(getRestaurantRecordId(restaurant) || ''),
                restaurantName,
                attemptedAt: new Date().toISOString(),
                ok: false,
                distanceMeters: null,
                radiusMeters: geofence?.radiusMeters || 0,
                errorMessage,
                blockedByPermission,
            };
            this.updateSupervisorSupervisionLocationUi(this.supervisionLocationCheck);

            if (notify) {
                this.showToast(errorMessage, {
                    tone: blockedByPermission ? 'warning' : 'error',
                    title: blockedByPermission ? 'Permiso GPS bloqueado' : t('sup.toast.location.verify.fail'),
                });
                return null;
            }

            const locationError = new Error(errorMessage);
            locationError.code = error?.code;
            locationError.cause = error;
            throw locationError;
        } finally {
            this.updateSupervisorSupervisionLocationUi();
        }
    },

    updateSupervisorSupervisionLocationLabel() {
        this.clearSupervisionRegisterRetryState();
        this.clearSupervisorSupervisionLocationState();
        this.resetSupervisorSupervisionState();
        this.updateSupervisorSupervisionLocationUi();
    },

    // ==========================================================================
    // SECCIÓN: Tareas especiales: crear, archivo de instrucciones y pendientes por sitio
    // --------------------------------------------------------------------------
    // El modal de crear tarea acepta una foto o un video de instrucciones
    // (el video, máx. 1 minuto). validateRestaurantTaskFileByGeofence: si el
    // inspector está FUERA del sitio, rechaza fotos recién tomadas con la
    // cámara (heurística lastModified < 60 s); las de galería se aceptan. El
    // chequeo de GPS tiene tope de 8 s para no dejar colgada la pantalla.
    // openSupervisorRestaurantPendingTasksModal muestra las pendientes de un
    // sitio (list_pending filtrado por restaurant_id).
    // ==========================================================================

    async openSupervisorRestaurantTaskModal(restaurantId = '', source = 'restaurants') {
        this.restaurantTaskDraftRestaurantId = String(restaurantId || '').trim();
        this.restaurantTaskDraftSource = String(source || '').trim() || 'restaurants';
        await this.openModal('modal-supervisor-restaurant-task');
    },

    // Lista de tareas especiales pendientes de UN sitio. Se abre al tocar
    // la línea "N tareas especiales pendientes" de la tarjeta del sitio.
    // Pide list_pending filtrado por restaurant_id (fresco, no usa el cache
    // del badge) y filtra también en cliente por si el backend devolviera
    // tareas de otros sitios.
    async openSupervisorRestaurantPendingTasksModal(restaurantId, restaurantName = '') {
        const rid = String(restaurantId || '').trim();
        if (!rid) return;

        const body = document.getElementById('restaurant-pending-tasks-body');
        const titleNode = document.getElementById('restaurant-pending-tasks-title');
        if (titleNode) {
            titleNode.textContent = restaurantName ? `Pendientes · ${restaurantName}` : 'Tareas especiales pendientes';
        }
        if (body) {
            body.innerHTML = `
                <div style="padding: 40px 20px; text-align: center;">
                    <i class="fas fa-spinner fa-spin" style="font-size: 32px; color: var(--primary);"></i>
                    <p class="muted-copy" style="margin-top: 12px;">Cargando tareas pendientes…</p>
                </div>
            `;
        }
        await this.openModal('modal-restaurant-pending-tasks');

        try {
            // Backend valida limit <= 200 (con más responde 422).
            const res = await apiClient.operationalTasksManage('list_pending', {
                limit: 200,
                restaurant_id: this.normalizeTaskCreatePayloadValue(rid),
            });
            const items = asArray(res?.items || res?.data?.items || res).filter(
                (task) => String(task?.restaurant_id ?? task?.restaurant?.id ?? '') === rid
            );
            this.renderSupervisorRestaurantPendingTasks(items);
        } catch (error) {
            console.warn('[restaurant-pending-tasks] fallo la carga', error);
            if (body) {
                body.innerHTML = `
                    <div class="alert alert-warning">
                        <i class="fas fa-triangle-exclamation"></i>
                        <div>
                            <strong>No fue posible cargar las tareas pendientes.</strong><br>
                            <small>${escapeHtml(this.getErrorMessage(error, 'Intenta de nuevo en unos segundos.'))}</small>
                        </div>
                    </div>
                `;
            }
        }
    },

    renderSupervisorRestaurantPendingTasks(items) {
        const body = document.getElementById('restaurant-pending-tasks-body');
        if (!body) return;

        const tasks = asArray(items)
            .slice()
            .sort((a, b) => new Date(b?.created_at || 0) - new Date(a?.created_at || 0));

        if (tasks.length === 0) {
            body.innerHTML = '<p class="muted-copy" style="text-align:center;padding:24px 0;margin:0;">Este sitio no tiene tareas especiales pendientes.</p>';
            return;
        }

        const countText = `${tasks.length} tarea${tasks.length === 1 ? '' : 's'} especial${tasks.length === 1 ? '' : 'es'} pendiente${tasks.length === 1 ? '' : 's'}`;
        body.innerHTML = `
            <p class="muted-copy" style="margin:0 0 12px;">${escapeHtml(countText)}</p>
            <div class="pending-task-list">
                ${tasks
                    .map((task) => {
                        const meta = [
                            task?.created_by_name ? `Creada por ${escapeHtml(task.created_by_name)}` : '',
                            task?.created_at ? escapeHtml(formatDateTime(task.created_at)) : '',
                        ].filter(Boolean).join(' · ');
                        return `
                        <div class="pending-task-item">
                            <div class="pending-task-head">
                                <strong>${escapeHtml(task?.title || 'Tarea sin título')}</strong>
                                <span class="badge badge-warning">Pendiente</span>
                            </div>
                            ${meta ? `<p class="pending-task-meta">${meta}</p>` : ''}
                            ${task?.due_at ? `<p class="pending-task-meta"><i class="fas fa-clock"></i> Vence: ${escapeHtml(formatDateTime(task.due_at))}</p>` : ''}
                            ${task?.assigned_to_name ? `<p class="pending-task-meta"><i class="fas fa-user"></i> Asignada a ${escapeHtml(task.assigned_to_name)}</p>` : ''}
                            ${task?.requires_evidence ? '<p class="pending-task-meta"><i class="fas fa-camera"></i> Requiere foto de evidencia</p>' : ''}
                        </div>`;
                    })
                    .join('')}
            </div>
        `;
    },

    updateSupervisorRestaurantTaskContextCopy() {},

    async prepareSupervisorRestaurantTaskModal() {
        if (this.data.supervisor.restaurants.length === 0) {
            this.data.supervisor.restaurants = await this.getSupervisorRestaurants();
        }

        const form = document.getElementById('supervisor-restaurant-task-form');
        form?.reset();

        this.resetSupervisorRestaurantTaskVideoUi();
        this.bindSupervisorRestaurantTaskVideoOnce();

        const select = document.getElementById('supervisor-restaurant-task-restaurant');
        if (select) {
            this.populateSupervisorRestaurantOptions('supervisor-restaurant-task-restaurant', true);
            const fallbackRestaurantId =
                this.restaurantTaskDraftRestaurantId ||
                String(getRestaurantRecordId(this.getSupervisorSelectedRestaurant()) || '').trim();
            if (fallbackRestaurantId) {
                select.value = fallbackRestaurantId;
            }
        }

        // Select de prioridad fue removido; getSupervisorRestaurantTaskDraft
        // devuelve 'high' hardcoded.
        this.restaurantTaskSubmitPending = false;
        this.updateSupervisorRestaurantTaskContextCopy();
    },

    getSupervisorRestaurantTaskDraft() {
        return {
            restaurantId: String(document.getElementById('supervisor-restaurant-task-restaurant')?.value || '').trim(),
            title: document.getElementById('supervisor-restaurant-task-title')?.value?.trim() || '',
            description: document.getElementById('supervisor-restaurant-task-description')?.value?.trim() || '',
            // Toda tarea especial ahora requiere evidencia SIEMPRE (el checkbox
            // fue removido del modal por pedido del usuario: era un paso extra
            // innecesario porque la evidencia siempre se solicitaba).
            requiresEvidence: true,
            // Prioridad fija en Alta (el select fue removido por la misma razon).
            priority: 'high',
            videoFile:
                document.getElementById('supervisor-restaurant-task-video')?.files?.[0] || null,
            source: this.restaurantTaskDraftSource || 'restaurants',
        };
    },

    resetSupervisorRestaurantTaskVideoUi() {
        const input = document.getElementById('supervisor-restaurant-task-video');
        if (input) input.value = '';

        const preview = document.getElementById('supervisor-restaurant-task-video-preview');
        if (preview) {
            preview.pause?.();
            if (preview.src) URL.revokeObjectURL?.(preview.src);
            preview.removeAttribute('src');
            preview.load?.();
            preview.classList.add('hidden');
        }

        const label = document.getElementById('supervisor-restaurant-task-video-label');
        const text = label?.querySelector('.rtask-file-label-text');
        if (text) text.textContent = 'Subir evidencia';
        label?.classList.remove('rtask-file-label-has-file');
    },

    bindSupervisorRestaurantTaskVideoOnce() {
        const input = document.getElementById('supervisor-restaurant-task-video');
        if (!input || input.dataset.videoBound === '1') return;
        input.dataset.videoBound = '1';
        input.addEventListener('change', () => this._handleSupervisorRestaurantTaskFile(input));
    },

    // Handler común para los 2 inputs (cámara/galería). Antes vivía inline
    // en bindSupervisorRestaurantTaskVideoOnce cuando había un solo input.
    async _handleSupervisorRestaurantTaskFile(input) {
        if (!input) return;
        const MAX_VIDEO_SECONDS = 60;

        const rejectFile = ({ preview, label, text, objectUrl, toastMsg, toastTitle }) => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            input.value = '';
            if (preview) {
                preview.removeAttribute('src');
                preview.classList.add('hidden');
            }
            if (text) text.textContent = t('rtask.video.placeholder');
            label?.classList.remove('rtask-file-label-has-file');
            if (toastMsg) {
                this.showToast(toastMsg, {
                    tone: 'warning',
                    title: toastTitle || t('rtask.video.error.unreadable.title'),
                    duration: 6000,
                });
            }
        };

        const preview = document.getElementById('supervisor-restaurant-task-video-preview');
        const label = document.getElementById('supervisor-restaurant-task-video-label');
        const text = label?.querySelector('.rtask-file-label-text');
        const file = input.files?.[0];

        const token = (Number(this._videoProbeToken) || 0) + 1;
        this._videoProbeToken = token;

        const previousPreviewSrc = preview?.src;
        if (previousPreviewSrc && previousPreviewSrc.startsWith('blob:')) {
            URL.revokeObjectURL(previousPreviewSrc);
        }

        if (!file) {
            if (preview) {
                preview.removeAttribute('src');
                preview.classList.add('hidden');
            }
            if (text) text.textContent = t('rtask.video.placeholder');
            label?.classList.remove('rtask-file-label-has-file');
            return;
        }

        // Feedback INMEDIATO: el chequeo de geofence hace un captureLocation
        // de alta precisión que puede tardar varios segundos. Sin esto el
        // label seguía diciendo "Subir evidencia" después de elegir el
        // archivo y parecía que el archivo no había quedado cargado.
        const labelIcon = label?.querySelector('i');
        const labelIconClass = labelIcon?.className || 'fas fa-cloud-arrow-up';
        if (text) text.textContent = 'Verificando ubicación…';
        if (labelIcon) labelIcon.className = 'fas fa-spinner fa-spin';
        label?.classList.remove('rtask-file-label-has-file');
        label?.classList.add('rtask-file-label-checking');

        const geofenceCheck = await this.validateRestaurantTaskFileByGeofence(file);
        label?.classList.remove('rtask-file-label-checking');
        if (labelIcon) labelIcon.className = labelIconClass;
        if (!geofenceCheck.ok) {
            this.showToast(geofenceCheck.reason, {
                tone: 'warning',
                title: 'Foto/video con cámara solo en sitio',
                duration: 7000,
            });
            input.value = '';
            if (preview) {
                preview.removeAttribute('src');
                preview.classList.add('hidden');
            }
            if (text) text.textContent = t('rtask.video.placeholder');
            label?.classList.remove('rtask-file-label-has-file');
            return;
        }

        const objectUrl = URL.createObjectURL(file);
        const isImage = String(file.type || '').startsWith('image/');
        let durationSeconds = 0;
        let probeFailed = false;

        if (!isImage) {
            try {
                durationSeconds = await this.probeVideoDurationSeconds(objectUrl);
            } catch (probeError) {
                probeFailed = true;
                console.warn('No fue posible medir la duración del video de instrucciones.', probeError);
            }
        }

        if (token !== this._videoProbeToken) {
            URL.revokeObjectURL(objectUrl);
            return;
        }

        if (!isImage && probeFailed) {
            rejectFile({
                preview, label, text, objectUrl,
                toastMsg: t('rtask.video.error.unreadable'),
                toastTitle: t('rtask.video.error.unreadable.title'),
            });
            return;
        }

        if (!isImage && durationSeconds > MAX_VIDEO_SECONDS) {
            const mmss = this.formatSecondsAsMmSs(durationSeconds);
            rejectFile({
                preview, label, text, objectUrl,
                toastMsg: t('rtask.video.error.toolong', { duration: mmss }),
                toastTitle: t('rtask.video.error.toolong.title'),
            });
            return;
        }

        if (preview) {
            if (isImage) {
                preview.removeAttribute('src');
                preview.classList.add('hidden');
            } else {
                preview.src = objectUrl;
                preview.classList.remove('hidden');
            }
        }
        if (text) {
            const shortName = file.name.length > 24 ? `${file.name.slice(0, 24)}…` : file.name;
            const durationText = !isImage && durationSeconds > 0
                ? ` · ${this.formatSecondsAsMmSs(durationSeconds)}`
                : '';
            const kindPrefix = isImage ? 'Foto' : t('rtask.video.ready');
            text.textContent = `${kindPrefix}: ${shortName}${durationText}`;
        }
        label?.classList.add('rtask-file-label-has-file');
    },

    /**
     * Regla al elegir archivo de instrucciones de tarea especial:
     * - DENTRO del radio del sitio → cualquier origen (cámara o galería).
     * - FUERA del sitio → solo galería/archivos (NO cámara reciente).
     *
     * Tolerancia GPS: indoor (dentro de locales) el GPS suele reportar
     * accuracy 100-200m. Antes limitábamos el buffer a 60m — con radio de
     * sitio pequeño (20-30m) y GPS indoor, effectiveRadius quedaba <100m y
     * el inspector adentro del sitio quedaba "fuera". Ahora usamos toda la
     * accuracy (cap 250m para no volver global) + radio mínimo 50m.
     *
     * Además: si location.accuracy > 200m (GPS muy pobre), dejamos pasar
     * SIEMPRE (no podemos concluir nada de la posición).
     *
     * Console.info del cálculo para diagnóstico si vuelve a fallar.
     */
    async validateRestaurantTaskFileByGeofence(file) {
        try {
            const restaurantId = String(
                document.getElementById('supervisor-restaurant-task-restaurant')?.value || ''
            ).trim();
            if (!restaurantId) return { ok: true };

            const restaurant = asArray(this.data.supervisor.restaurants).find(
                (r) => String(getRestaurantRecordId(r)) === restaurantId
            );
            if (!restaurant) return { ok: true };

            const geofence = this.getSupervisorRestaurantGeofence(restaurant);
            if (!geofence.hasCoordinates) return { ok: true };

            // captureLocation con highAccuracy tiene timeout interno de 15s.
            // Es demasiado para un handler de <input type=file>: el inspector
            // queda mirando un label que no cambia. Le ponemos un techo propio
            // de 8s y, si vence, dejamos pasar el archivo (mismo criterio que
            // cuando el GPS falla: sin ubicación no podemos concluir nada).
            const GEOFENCE_GPS_TIMEOUT_MS = 8000;
            // El .catch va DENTRO del race: si el GPS rechaza después de que
            // ganó el timeout, el race ya resolvió y el rechazo tardío sería
            // un unhandled rejection.
            const location = await Promise.race([
                this.captureLocation({ updateUi: false, highAccuracy: true }).catch(() => null),
                new Promise((resolve) => setTimeout(() => resolve(null), GEOFENCE_GPS_TIMEOUT_MS)),
            ]);
            if (!location || !Number.isFinite(Number(location.lat))) {
                console.info('[rtask-file-geofence] sin ubicación a tiempo — dejamos pasar');
                return { ok: true };
            }

            const distance = calculateDistanceMeters(location, { lat: geofence.lat, lng: geofence.lng });
            if (distance == null) return { ok: true };

            const accuracy = Number(location.accuracy || 0);
            // GPS demasiado pobre → no podemos concluir posición, dejamos pasar.
            if (accuracy > 200) {
                console.info('[rtask-file-geofence] GPS accuracy >200m — bypass', { accuracy });
                return { ok: true };
            }

            const accuracyBuffer = Math.min(accuracy, 250);
            const rawRadius = Math.max(geofence.radiusMeters || 0, 0);
            const minRadius = 50; // Ningún sitio debería tener geocerca efectiva <50m para este chequeo.
            const effectiveRadius = Math.max(rawRadius, minRadius) + accuracyBuffer;
            const insideSite = distance <= effectiveRadius;

            console.info('[rtask-file-geofence] calc', {
                distance: Math.round(distance),
                rawRadius,
                effectiveRadius: Math.round(effectiveRadius),
                accuracy: Math.round(accuracy),
                insideSite,
            });

            if (insideSite) return { ok: true };

            // Fuera del sitio: rechazar cámara reciente (últimos 60s).
            const fileAge = Date.now() - Number(file.lastModified || 0);
            const isFreshCamera = Number.isFinite(fileAge) && fileAge < 60 * 1000;
            if (isFreshCamera) {
                const siteName = getRestaurantDisplayName(restaurant);
                const distanceKm = distance > 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`;
                return {
                    ok: false,
                    reason: `GPS te ubica a ${distanceKm} de ${siteName}. Si estás en el sitio, elegí un archivo de tu galería que no sea de los últimos segundos.`,
                };
            }
            return { ok: true };
        } catch (err) {
            console.info('[rtask-file-geofence] validación falló, dejamos pasar', err?.message || err);
            return { ok: true };
        }
    },

    async uploadRestaurantTaskInstructionsVideo(videoFile, restaurantId) {
        // A pesar del nombre "Video", el input acepta también imágenes como
        // instrucción (label UI es "Foto o video de instrucciones"). El content_type
        // se detecta del archivo real y se envía al backend; si backend rechaza
        // imágenes, dejamos que la respuesta HTTP lo diga en vez de bloquear en
        // cliente (con toast claro al user).
        const rawType = String(videoFile.type || '').toLowerCase();
        const isImage = rawType.startsWith('image/');
        const contentType = rawType || (isImage ? 'image/jpeg' : 'video/mp4');
        const filename = videoFile.name || (isImage ? 'instructions.jpg' : 'instructions.mp4');

        const requestUpload = await apiClient.operationalTasksManage('request_instructions_upload', {
            restaurant_id: this.normalizeTaskCreatePayloadValue(restaurantId),
            content_type: contentType,
            filename,
        });

        const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
        const path = requestUpload?.path || requestUpload?.upload?.path;
        if (!signedUrl || !path) {
            throw new Error(t('rtask.video.error.upload'));
        }

        const maxBytes = Number(requestUpload?.max_bytes || requestUpload?.upload?.max_bytes || 0);
        if (maxBytes > 0 && videoFile.size > maxBytes) {
            const maxMb = Math.floor(maxBytes / (1024 * 1024));
            const fileMb = Math.round((videoFile.size / (1024 * 1024)) * 10) / 10;
            throw new Error(t('rtask.video.error.toobig', { fileMb, maxMb }));
        }

        // Guard MIME local: SOLO rechaza si el backend declaró allowed_mime Y
        // el tipo del archivo no está. Antes esto bloqueaba imágenes cuando el
        // backend solo declaraba videos — reportado por Miguel (2026-09). Si
        // backend acepta imágenes ahora, ampliará su allowed_mime y este guard
        // no dispara. Si aún no las acepta, dejamos que el PUT/backend responda
        // con un error específico en vez de un mensaje MIME poco claro.
        const allowedMime = asArray(requestUpload?.allowed_mime || requestUpload?.upload?.allowed_mime);
        if (allowedMime.length > 0 && !allowedMime.includes(contentType) && !isImage) {
            throw new Error(
                t('rtask.video.error.mime', {
                    mime: contentType || 'desconocido',
                    allowed: allowedMime.join(', '),
                })
            );
        }

        await apiClient.uploadToSignedUrl(signedUrl, videoFile, contentType);
        return path;
    },

    setSupervisorRestaurantTaskSubmitState(isSubmitting = false) {
        this.restaurantTaskSubmitPending = Boolean(isSubmitting);
        const button = document.getElementById('supervisor-restaurant-task-submit-btn');
        if (!button) {
            return;
        }

        button.disabled = this.restaurantTaskSubmitPending;
        button.setAttribute('aria-busy', this.restaurantTaskSubmitPending ? 'true' : 'false');
    },

    getRestaurantTaskErrorCode(error) {
        return error?.payload?.error?.details?.diagnostic_code || '';
    },

    getRestaurantTaskErrorMessage(error, fallback) {
        const code = this.getRestaurantTaskErrorCode(error);
        if (code === 'RESTAURANT_NOT_FOUND')
            return 'El restaurante no fue encontrado. Verifica que sigue activo e intenta de nuevo.';
        if (code === 'RESTAURANT_FORBIDDEN') return 'No tienes permiso para crear tareas en este restaurante.';
        if (code === 'TASK_SCOPE_NOT_SUPPORTED')
            return 'Falta información requerida para crear la tarea. Verifica que el restaurante esté seleccionado correctamente.';
        if (code === 'NO_ACTIVE_SHIFT')
            return 'El contratista no tiene un servicio activo en este sitio. Debe iniciar el servicio primero.';
        return this.getErrorMessage(error, fallback);
    },

    async submitSupervisorRestaurantTaskForm() {
        if (this.restaurantTaskSubmitPending) {
            return;
        }

        const draft = this.getSupervisorRestaurantTaskDraft();
        if (!draft.restaurantId) {
            this.showToast(t('sup.toast.select.site.task'), {
                tone: 'warning',
                title: t('sup.toast.site.missing'),
            });
            return;
        }

        if (draft.title.length < 3) {
            this.showToast(t('sup.toast.task.title.missing'), {
                tone: 'warning',
                title: t('sup.toast.task.title.missing.title'),
            });
            return;
        }

        if (draft.description.length < 5) {
            this.showToast(t('sup.toast.task.desc.missing'), {
                tone: 'warning',
                title: t('sup.toast.task.desc.missing.title'),
            });
            return;
        }

        const restaurant =
            asArray(this.data.supervisor.restaurants).find(
                (item) => String(getRestaurantRecordId(item) || '').trim() === draft.restaurantId
            ) || null;
        const restaurantName = restaurant ? getRestaurantDisplayName(restaurant) : 'el restaurante seleccionado';

        this.setSupervisorRestaurantTaskSubmitState(true);
        this.showLoading(t('sup.toast.creating.task'), t('sup.toast.creating.task.desc'));

        let instructionsVideoPath = null;
        if (draft.videoFile) {
            try {
                instructionsVideoPath = await this.uploadRestaurantTaskInstructionsVideo(
                    draft.videoFile,
                    draft.restaurantId
                );
            } catch (uploadError) {
                console.error('[rtask.create] instructions video upload failed', uploadError);
                this.hideLoading();
                this.setSupervisorRestaurantTaskSubmitState(false);
                this.showToast(this.getErrorMessage(uploadError, t('rtask.video.error.uploadfailed')), {
                    tone: 'error',
                    title: t('rtask.video.error.uploadfailed.title'),
                });
                return;
            }
        }

        const payloadBase = {
            restaurant_id: this.normalizeTaskCreatePayloadValue(draft.restaurantId),
            task_scope: 'restaurant',
            scope: 'restaurant',
            title: draft.title,
            description: draft.description,
            requires_evidence: draft.requiresEvidence,
            priority: draft.priority || undefined,
            origin_page: draft.source,
            // Backend acepta ambos nombres (compat): mandamos el nuevo
            // instructions_media_path como primario. La misma clave sirve
            // para imagen o video — el backend decide por extensión.
            instructions_media_path: instructionsVideoPath || undefined,
            instructions_video_path: instructionsVideoPath || undefined,
        };
        const payloadVariants = payloadBase.priority
            ? [payloadBase, { ...payloadBase, priority: undefined }]
            : [payloadBase];

        try {
            let created = false;
            let lastError = null;

            for (const payload of payloadVariants) {
                try {
                    await this.createOperationalTaskWithFreshToken(payload);
                    created = true;
                    break;
                } catch (error) {
                    lastError = error;
                }
            }

            if (!created) {
                throw lastError || new Error('No fue posible crear la tarea especial del restaurante.');
            }

            this.closeModal('modal-supervisor-restaurant-task');
            this.showToast(`La tarea especial quedó abierta para ${restaurantName}.`, {
                tone: 'success',
                title: t('sup.toast.task.created'),
            });
        } catch (error) {
            this.registerTaskCreateDebug(payloadVariants[payloadVariants.length - 1], error, {
                restaurant_id: draft.restaurantId,
                scope: 'restaurant',
                source: draft.source,
            });
            this.showToast(
                this.getRestaurantTaskErrorMessage(error, 'No fue posible crear la tarea especial del restaurante.'),
                {
                    tone: 'error',
                    title: t('sup.toast.task.create.fail'),
                }
            );
        } finally {
            this.hideLoading();
            this.setSupervisorRestaurantTaskSubmitState(false);
        }
    },

    // ==========================================================================
    // SECCIÓN: Informes: tarjetas por visita / por auditoría y descarga individual
    // --------------------------------------------------------------------------
    // Cada visita y cada auditoría del período tiene su tarjeta con PDF/Excel
    // propio (reports_generate con shift_id o audit_id). Para que Safari en
    // iPhone no bloquee la pestaña, se abre SINCRÓNICAMENTE con
    // window.open('about:blank') ANTES de cualquier await, y cuando llega la URL
    // se asigna a esa pestaña. El inspector solo puede bajar el informe
    // individual de SUS auditorías (el backend responde 403 en las ajenas).
    // ==========================================================================

    renderReportDayEvidence(shiftItems, { isSingleDay = false } = {}) {
        const wrapper = document.getElementById('report-day-evidence');
        const list = document.getElementById('report-day-evidence-list');
        const copy = document.getElementById('report-day-evidence-copy');

        if (!wrapper || !list || !copy) {
            return;
        }

        const items = Array.isArray(shiftItems) ? shiftItems : [];
        wrapper.classList.remove('hidden');

        if (items.length === 0) {
            copy.textContent = isSingleDay
                ? 'Ese día no tuvo servicios registrados para los filtros seleccionados.'
                : 'No hay servicios en el período seleccionado.';
            list.innerHTML = '<div class="report-day-phase-empty">No hay servicios que mostrar.</div>';
            return;
        }

        // Diseño post-migracion Visitas: SIEMPRE lista compacta. No pintamos
        // fotos inline nunca -- viven en el PDF/Excel. Cada tarjeta representa
        // una visita con: numero, contratista, sitio, hora, duracion, y sus
        // botones de descarga individual. Antes intentabamos mostrar todos los
        // pares antes/despues inline, pero con 3-4 visitas por dia (mismo
        // sitio) la pagina se volvia infinita.
        copy.textContent =
            items.length === 1
                ? '1 visita en el período. Descarga el detalle con evidencias en PDF o Excel.'
                : `${items.length} visitas en el período. Cada una tiene su propio informe con evidencias.`;

        list.innerHTML = items
            .map((shift, index) => {
                const employeeName = this.getResolvedShiftEmployeeName(shift, 'Contratista sin nombre visible');
                const restaurantName = this.getResolvedShiftRestaurantName(shift, 'Sitio sin nombre visible');
                const dateText = formatShiftLocalDate(shift);
                const scheduleText = formatShiftLocalRange(shift);
                const workedHours = formatHours(getWorkedHours(shift));
                const shiftId = shift?.id
                    || shift?.shift_id
                    || shift?.scheduled_shift_id
                    || shift?.raw?.id
                    || shift?.raw?.shift_id
                    || shift?.raw?.scheduled_shift_id
                    || '';

                const statusLabel = getShiftStatusLabel(shift);
                // Card rediseniada: FECHA como titulo principal (grande), sitio/contratista/horas
                // como meta secundaria, y botones PDF/Excel apilados con flex-wrap para no
                // desbordar en mobile.
                return `<article class="report-day-shift-card">
                <div class="report-day-shift-top">
                    <div style="flex:1; min-width:0;">
                        <div class="report-visit-date">${escapeHtml(dateText)}</div>
                        <div class="report-visit-meta">
                            <span><i class="fas fa-store"></i> ${escapeHtml(restaurantName)}</span>
                            <span><i class="fas fa-user"></i> ${escapeHtml(employeeName)}</span>
                            <span><i class="fas fa-clock"></i> ${escapeHtml(scheduleText)} · ${escapeHtml(workedHours)}</span>
                        </div>
                    </div>
                    <div class="report-day-shift-statuses">
                        <span class="badge ${getBadgeClass(statusLabel)}">${escapeHtml(statusLabel)}</span>
                    </div>
                </div>
                ${shiftId ? `
                <div class="report-visit-actions">
                    <button type="button" class="btn btn-secondary btn-inline" data-action="downloadIndividualShiftReport" data-args="${escapeHtml(String(shiftId))}|pdf">
                        <i class="fas fa-file-pdf"></i> PDF
                    </button>
                    <button type="button" class="btn btn-secondary btn-inline" data-action="downloadIndividualShiftReport" data-args="${escapeHtml(String(shiftId))}|excel">
                        <i class="fas fa-file-excel"></i> Excel
                    </button>
                    <span class="report-visit-index">Visita #${index + 1}</span>
                </div>
                ` : ''}
            </article>`;
            })
            .join('');
    },

    async downloadIndividualShiftReport(shiftIdArg, formatArg = 'pdf') {
        console.info('[individual-report] click', { shiftIdArg, formatArg, typeShift: typeof shiftIdArg });
        const shiftId = String(shiftIdArg ?? '').trim();
        const format = formatArg === 'excel' ? 'excel' : 'pdf';
        if (!shiftId) {
            this.showToast('No se pudo identificar el turno. El backend no envió su id.', {
                tone: 'error',
                title: 'Turno no válido',
            });
            return;
        }

        // Popup blocker de Safari iOS: `<a target="_blank">.click()` después de
        // un await pierde el "user gesture" y bloquea. Truco: abrimos la
        // pestaña YA en modo about:blank (sí es user gesture) y después del
        // await le seteamos el URL. Si la abertura fue bloqueada igual,
        // fallback a toast con instrucciones.
        //
        // OJO: NO usar `noopener,noreferrer` acá — en Safari eso retorna null
        // aunque la pestaña sí se abra, y perdemos la referencia para
        // asignar el URL después. Neutralizamos opener manualmente al final.
        const previewWindow = window.open('about:blank', '_blank');

        // Placeholder mientras el backend genera el reporte (5-30s). Antes
        // el user veia "about:blank" y no sabia que estaba pasando.
        if (previewWindow && !previewWindow.closed) {
            try {
                previewWindow.document.open();
                previewWindow.document.write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Generando informe...</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
    :root { color-scheme: dark light; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #0f172a; color: #e2e8f0; text-align: center; padding: 24px; }
    .box { max-width: 320px; }
    .spinner { width: 48px; height: 48px; border-radius: 50%;
        border: 4px solid rgba(148,163,184,0.25); border-top-color: #38bdf8;
        margin: 0 auto 20px; animation: spin 0.9s linear infinite; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 14px; color: #94a3b8; margin: 0; line-height: 1.4; }
    @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
    <div class="box">
        <div class="spinner"></div>
        <h1>Generando el informe...</h1>
        <p>El PDF se abrirá aquí automáticamente en unos segundos. No cierres esta pestaña.</p>
    </div>
</body>
</html>`);
                previewWindow.document.close();
            } catch (writeError) {
                console.warn('[individual-report] no se pudo pintar placeholder en preview', writeError);
            }
        }

        this.showLoading('Generando informe', 'Preparando el informe del turno.');
        try {
            const accessToken = await this.getValidAccessToken();
            apiClient.setAccessToken(accessToken);
            const numericShiftId = Number(shiftId);
            const shiftIdValue = Number.isFinite(numericShiftId) && String(numericShiftId) === shiftId
                ? numericShiftId
                : shiftId;
            const payload = { report_type: 'shifts', shift_id: shiftIdValue, export_format: 'both' };
            console.info('[individual-report] payload', payload);
            const result = await apiClient.reportsGenerate(payload, {
                accessToken,
                requiresIdempotency: false,
                headers: { 'Idempotency-Key': buildIdempotencyKey() },
                timeoutMs: 45000,
            });
            console.info('[individual-report] response', result);
            const url = format === 'pdf' ? result?.url_pdf : result?.url_excel;
            if (!url) {
                console.warn('[individual-report] backend sin URL', { format, keys: result ? Object.keys(result) : null });
                if (previewWindow && !previewWindow.closed) {
                    try { previewWindow.close(); } catch {}
                }
                this.showToast(`El backend no devolvió una URL de ${format.toUpperCase()}. Revisa la consola para detalle.`, {
                    tone: 'error',
                    title: 'Descarga no disponible',
                });
                return;
            }

            if (previewWindow && !previewWindow.closed) {
                try {
                    previewWindow.location.href = url;
                    // Neutralizar opener para bloquear tabnabbing (equivalente a rel=noopener).
                    try { previewWindow.opener = null; } catch {}
                } catch (assignError) {
                    console.warn('[individual-report] no se pudo asignar url al popup, usando fallback', assignError);
                    this.openInNewTab(url);
                }
            } else {
                // Popup bloqueado: fallback al patrón <a target="_blank">.click()
                this.openInNewTab(url);
            }
        } catch (error) {
            console.error('[individual-report] error', error, error?.payload);
            if (previewWindow && !previewWindow.closed) {
                try { previewWindow.close(); } catch {}
            }
            this.showToast(this.getErrorMessage(error, 'No fue posible generar el informe del turno.'), {
                tone: 'error',
                title: 'Error',
            });
        } finally {
            this.hideLoading();
        }
    },

    // Informe de auditoría: una tarjeta por auditoría del rango, cada una con
    // su PDF/Excel individual. Mismo diseño que "Visitas del período".
    renderAuditReportList(rows) {
        const wrap = document.getElementById('audit-report-list-wrap');
        const list = document.getElementById('audit-report-list');
        if (!wrap || !list) return;

        const audits = asArray(rows)
            .slice()
            .sort((a, b) => new Date(b?.recorded_at || 0) - new Date(a?.recorded_at || 0));
        if (audits.length === 0) {
            wrap.classList.add('hidden');
            list.innerHTML = '';
            return;
        }
        wrap.classList.remove('hidden');

        // La supervisora solo puede bajar el informe individual de SUS
        // auditorías (backend: 403 FORBIDDEN si es ajena); super_admin, todas.
        // rows[].supervisor_id es el mismo id del usuario de sesión. Si no
        // viniera (o no hay sesión), mostramos los botones y el 403 lo maneja
        // downloadIndividualAuditReport.
        const isAdmin = this.isAdminRole?.() === true;
        const myIds = new Set([this.currentUser?.id, this.session?.user?.id].filter(Boolean).map(String));
        const canDownloadAudit = (audit) => {
            const ownerId = String(audit?.supervisor_id || '').trim();
            return isAdmin || !ownerId || myIds.size === 0 || myIds.has(ownerId);
        };

        const parseCivilDate = (value) => {
            const [y, m, d] = String(value || '').split('-').map(Number);
            return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? new Date(y, m - 1, d, 12, 0) : null;
        };

        list.innerHTML = audits
            .map((audit, index) => {
                const auditId = String(audit?.audit_id ?? '').trim();
                const civilDate = parseCivilDate(audit?.local_date);
                const dateText =
                    [
                        civilDate
                            ? formatDate(civilDate, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
                            : '',
                        String(audit?.local_time || '').trim(),
                    ]
                        .filter(Boolean)
                        .join(' · ') || 'Fecha no disponible';
                const evidenceCount = Number(audit?.evidence_count ?? asArray(audit?.evidences).length) || 0;
                const evidenceText = evidenceCount === 1 ? '1 evidencia' : `${evidenceCount} evidencias`;
                const observations = String(audit?.observations || '').trim();
                const shortObservations = observations.length > 140 ? `${observations.slice(0, 140)}…` : observations;
                return `<article class="report-day-shift-card">
                <div class="report-day-shift-top">
                    <div style="flex:1; min-width:0;">
                        <div class="report-visit-date">${escapeHtml(dateText)}</div>
                        <div class="report-visit-meta">
                            <span><i class="fas fa-store"></i> ${escapeHtml(audit?.restaurant_name || 'Sitio sin nombre visible')}</span>
                            <span><i class="fas fa-user"></i> ${escapeHtml(audit?.supervisor_name || 'Inspector sin nombre visible')}</span>
                            <span><i class="fas fa-camera"></i> ${escapeHtml(evidenceText)}</span>
                        </div>
                        ${shortObservations ? `<p class="muted-copy" style="margin:6px 0 0;font-size:13px;">“${escapeHtml(shortObservations)}”</p>` : ''}
                    </div>
                </div>
                ${auditId && !canDownloadAudit(audit) ? `
                <div class="report-visit-actions">
                    <span class="muted-copy" style="font-size:12px;"><i class="fas fa-lock"></i> Solo el inspector que la hizo puede descargar su informe</span>
                    <span class="report-visit-index">Auditoría #${index + 1}</span>
                </div>
                ` : ''}
                ${auditId && canDownloadAudit(audit) ? `
                <div class="report-visit-actions">
                    <button type="button" class="btn btn-secondary btn-inline" data-action="downloadIndividualAuditReport" data-args="${escapeHtml(auditId)}|pdf">
                        <i class="fas fa-file-pdf"></i> PDF
                    </button>
                    <button type="button" class="btn btn-secondary btn-inline" data-action="downloadIndividualAuditReport" data-args="${escapeHtml(auditId)}|excel">
                        <i class="fas fa-file-excel"></i> Excel
                    </button>
                    <span class="report-visit-index">Auditoría #${index + 1}</span>
                </div>
                ` : ''}
            </article>`;
            })
            .join('');
    },

    // Informe individual de UNA auditoría. Contrato backend (2026-09):
    // reports_generate { report_type: 'audits', audit_id, export_format }.
    // Con audit_id el período se deriva de la auditoría. La supervisora solo
    // puede las suyas (403 FORBIDDEN); inexistente → 404 AUDIT_NOT_FOUND.
    // Mismo manejo de popup que downloadIndividualShiftReport (Safari iOS).
    async downloadIndividualAuditReport(auditIdArg, formatArg = 'pdf') {
        const auditId = String(auditIdArg ?? '').trim();
        const format = formatArg === 'excel' ? 'excel' : 'pdf';
        if (!auditId) {
            this.showToast('No se pudo identificar la auditoría.', { tone: 'error', title: 'Auditoría no válida' });
            return;
        }

        // Abrir la pestaña SINCRÓNICO, antes de cualquier await: después
        // Safari iOS ya no lo considera gesto del usuario y lo bloquea.
        const previewWindow = window.open('about:blank', '_blank');
        if (previewWindow && !previewWindow.closed) {
            try {
                previewWindow.document.open();
                previewWindow.document.write(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Generando informe...</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #0f172a; color: #e2e8f0; text-align: center; padding: 24px; }
    .spinner { width: 48px; height: 48px; border-radius: 50%; border: 4px solid rgba(148,163,184,0.25);
        border-top-color: #38bdf8; margin: 0 auto 20px; animation: spin 0.9s linear infinite; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 14px; color: #94a3b8; margin: 0; line-height: 1.4; }
    @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body><div style="max-width:320px"><div class="spinner"></div>
<h1>Generando el informe de la auditoría...</h1>
<p>Se abrirá aquí automáticamente en unos segundos. No cierres esta pestaña.</p></div></body></html>`);
                previewWindow.document.close();
            } catch (writeError) {
                console.warn('[audit-individual-report] no se pudo pintar placeholder', writeError);
            }
        }
        const closePreview = () => {
            if (previewWindow && !previewWindow.closed) {
                try {
                    previewWindow.close();
                } catch (_) {
                    /* ignore */
                }
            }
        };

        this.showLoading('Generando informe', 'Preparando el informe de la auditoría.');
        try {
            const accessToken = await this.getValidAccessToken();
            apiClient.setAccessToken(accessToken);
            const numericId = Number(auditId);
            const payload = {
                report_type: 'audits',
                audit_id: Number.isFinite(numericId) && String(numericId) === auditId ? numericId : auditId,
                export_format: 'both',
            };
            const result = await apiClient.reportsGenerate(payload, {
                accessToken,
                requiresIdempotency: false,
                headers: { 'Idempotency-Key': buildIdempotencyKey() },
                timeoutMs: 45000,
            });
            const url = format === 'pdf' ? result?.url_pdf : result?.url_excel;
            if (!url) {
                closePreview();
                this.showToast(`El backend no devolvió el ${format.toUpperCase()} de esta auditoría.`, {
                    tone: 'error',
                    title: 'Descarga no disponible',
                });
                return;
            }
            if (previewWindow && !previewWindow.closed) {
                try {
                    previewWindow.location.href = url;
                    try {
                        previewWindow.opener = null;
                    } catch (_) {
                        /* ignore */
                    }
                } catch (assignError) {
                    console.warn('[audit-individual-report] no se pudo asignar url al popup', assignError);
                    this.openInNewTab(url);
                }
            } else {
                this.openInNewTab(url);
            }
        } catch (error) {
            closePreview();
            const status = Number(error?.status);
            const code = String(this.getErrorCode?.(error) || '').toUpperCase();
            if (status === 403 || code === 'FORBIDDEN') {
                this.showToast('Solo puedes descargar el informe individual de tus propias auditorías.', {
                    tone: 'warning',
                    title: 'Auditoría de otro inspector',
                });
            } else if (status === 404 || code === 'AUDIT_NOT_FOUND') {
                this.showToast('Esta auditoría ya no existe.', { tone: 'warning', title: 'Auditoría no encontrada' });
            } else {
                this.showToast(this.getErrorMessage(error, 'No fue posible generar el informe de la auditoría.'), {
                    tone: 'error',
                    title: 'Error',
                });
            }
        } finally {
            this.hideLoading();
        }
    },

    // ==========================================================================
    // SECCIÓN: Informes: generar el informe del período
    // --------------------------------------------------------------------------
    // generateReport (visitas) y generateAuditsReport (auditorías) llaman a
    // reports_generate con el rango y los filtros. El backend devuelve url_pdf,
    // url_excel y las filas (rows) que se muestran como tarjetas.
    // ==========================================================================

    normalizeReportFilterValue(rawValue, { numeric = false } = {}) {
        const normalized = String(rawValue || '').trim();
        if (!normalized) return undefined;
        if (normalized.toLowerCase() === 'all') return 'all';
        if (!numeric) return normalized;
        const asNumber = Number(normalized);
        return Number.isFinite(asNumber) ? asNumber : normalized;
    },

    async generateReport() {
        // Guard doble-click: si el usuario toca "Generar Informe" mientras el
        // request anterior aun corre, se disparaban 2 requests concurrentes.
        // Con el fix del retry (nueva idempotency-key por intento) esto ya
        // no rompe con 409, pero igual es desperdicio.
        if (this._reportGenerating) {
            this.showToast('Ya se está generando un informe. Espera unos segundos.', {
                tone: 'info',
                title: 'Informe en proceso',
            });
            return;
        }

        const startDate = document.getElementById('report-start-date')?.value;
        const endDate = document.getElementById('report-end-date')?.value;
        const restaurantId = document.getElementById('report-restaurant-select')?.value;
        const employeeId = document.getElementById('report-employee-select')?.value;

        if (!startDate || !endDate) {
            this.showToast(t('sup.toast.report.range.missing'), {
                tone: 'warning',
                title: t('sup.toast.report.filters.incomplete'),
            });
            return;
        }

        if (startDate > endDate) {
            this.showToast(t('sup.toast.report.range.invalid'), {
                tone: 'warning',
                title: t('sup.toast.report.range.invalid.title'),
            });
            return;
        }

        this._reportGenerating = true;
        this.showLoading(t('sup.toast.report.generating'), t('sup.toast.report.generating.desc'));
        let reportRequestContext = null;

        try {
            const accessToken = await this.getValidAccessToken();
            apiClient.setAccessToken(accessToken);
            const isSingleDay = startDate === endDate;

            const normalizedRestaurantFilter = this.normalizeReportFilterValue(restaurantId, { numeric: true });
            const normalizedEmployeeFilter = this.normalizeReportFilterValue(employeeId, { numeric: false });

            const payload = {
                restaurant_id: normalizedRestaurantFilter,
                employee_id: normalizedEmployeeFilter,
                period_start: startDate,
                period_end: endDate,
                export_format: 'both',
                columns: REPORT_COLUMNS,
            };
            const initialIdempotencyKey = buildIdempotencyKey();
            // Cada intento usa SU PROPIA Idempotency-Key. Antes, el retry por
            // timeout reusaba la misma key; si el primer request aun estaba en
            // procesamiento del lado del backend, este respondia 409
            // "Request idempotente en procesamiento".
            const runReportGenerate = async (timeoutMs, idempotencyKey) =>
                apiClient.reportsGenerate(payload, {
                    accessToken,
                    requiresIdempotency: false,
                    headers: { 'Idempotency-Key': idempotencyKey },
                    timeoutMs,
                });
            reportRequestContext = {
                endpoint: '/reports_generate',
                headers_sent: {
                    Authorization: accessToken ? 'Bearer <access_token>' : '',
                    apikey: apiClient.getConfig().anonKey || '',
                    'Idempotency-Key': initialIdempotencyKey,
                },
                timeout_ms: 45000,
                retry_on_timeout: true,
                jwt_decoded: buildJwtFullDebugSummary(accessToken),
            };

            const reportGeneratePromise = runReportGenerate(45000, initialIdempotencyKey).catch(async (error) => {
                if (String(error?.code || '').toUpperCase() !== 'TIMEOUT') {
                    throw error;
                }
                // Nueva key para no chocar con el request en curso del backend.
                return runReportGenerate(60000, buildIdempotencyKey());
            });

            const [reportResult, shiftSummaryResult] = await Promise.all([
                reportGeneratePromise,
                apiClient
                    .reportsManage('list_shifts', {
                        restaurant_id: payload.restaurant_id,
                        employee_id: payload.employee_id,
                        from: startDate,
                        to: endDate,
                        limit: 500,
                    })
                    .catch(() => null),
            ]);

            const shiftItems = asArray(shiftSummaryResult);
            const generatedTotals = reportResult?.totals || {};
            const totalWorkedHours = Number(
                shiftSummaryResult?.total_worked_hours ??
                    shiftSummaryResult?.totals?.total_worked_hours ??
                    generatedTotals?.total_worked_hours ??
                    generatedTotals?.worked_hours_total
            );
            const totalScheduledHours = Number(
                shiftSummaryResult?.total_scheduled_hours ??
                    shiftSummaryResult?.totals?.total_scheduled_hours ??
                    generatedTotals?.total_scheduled_hours ??
                    generatedTotals?.scheduled_hours_total
            );
            const restaurantWorkedHours = Number(
                shiftSummaryResult?.restaurant_worked_hours_total ??
                    shiftSummaryResult?.totals?.restaurant_worked_hours_total ??
                    generatedTotals?.restaurant_worked_hours_total
            );
            const restaurantScheduledHours = Number(
                shiftSummaryResult?.restaurant_scheduled_hours_total ??
                    shiftSummaryResult?.totals?.restaurant_scheduled_hours_total ??
                    generatedTotals?.restaurant_scheduled_hours_total
            );
            const endedEarlyCount = countEndedEarlyShifts(shiftItems);
            const statusSummary = summarizeShiftStatuses(shiftItems);
            this.data.lastGeneratedReport = {
                ...(reportResult || {}),
                shift_items: shiftItems,
                is_single_day: isSingleDay,
                resolved_totals: {
                    total_worked_hours:
                        Number.isFinite(totalWorkedHours) && totalWorkedHours > 0
                            ? totalWorkedHours
                            : sumWorkedHours(shiftItems),
                    total_scheduled_hours:
                        Number.isFinite(totalScheduledHours) && totalScheduledHours > 0
                            ? totalScheduledHours
                            : sumHours(shiftItems),
                    restaurant_worked_hours_total:
                        Number.isFinite(restaurantWorkedHours) && restaurantWorkedHours > 0
                            ? restaurantWorkedHours
                            : null,
                    restaurant_scheduled_hours_total:
                        Number.isFinite(restaurantScheduledHours) && restaurantScheduledHours > 0
                            ? restaurantScheduledHours
                            : null,
                    ended_early_count: endedEarlyCount,
                },
                status_summary: statusSummary,
                filters: {
                    start_date: startDate,
                    end_date: endDate,
                    restaurant_id: payload.restaurant_id ?? '',
                    employee_id: payload.employee_id ?? '',
                },
            };

            // Helper defensivo: los stats scheduled/ended-early se removieron
            // post-migracion Visitas (no hay agenda), este helper evita
            // getElementById(null).textContent en versiones donde se limpiaron.
            const setStatText = (id, value) => {
                const node = document.getElementById(id);
                if (node) node.textContent = value;
            };
            setStatText(
                'report-summary-worked-hours',
                formatHours(this.data.lastGeneratedReport.resolved_totals.total_worked_hours)
            );
            setStatText('report-summary-shifts', String(shiftItems.length));
            // Legacy: si estos aun existen en algun HTML viejo, se pintan igual.
            setStatText(
                'report-summary-scheduled-hours',
                formatHours(this.data.lastGeneratedReport.resolved_totals.total_scheduled_hours)
            );
            setStatText('report-summary-ended-early', String(endedEarlyCount));
            // Backend v3: cada shift_item trae site_tasks[] con tareas del sitio
            // resueltas dentro de la ventana del turno.
            const siteTasksCount = shiftItems.reduce(
                (total, item) => total + asArray(item?.site_tasks).length,
                0
            );
            const siteTasksNode = document.getElementById('report-summary-site-tasks');
            if (siteTasksNode) {
                siteTasksNode.textContent = String(siteTasksCount);
            }
            const description = document.getElementById('report-result-description');
            if (description) {
                description.textContent = isSingleDay
                    ? 'Resumen completo del día seleccionado, con estado del servicio, horas y evidencias de antes y después.'
                    : 'Resumen consolidado del período seleccionado, incluyendo horas de servicio, horas asignadas y estado operativo de los servicios.';
            }

            const restaurantTotalsCopy = document.getElementById('report-restaurant-totals-copy');
            if (restaurantTotalsCopy) {
                const restaurantWorkedText = Number.isFinite(
                    this.data.lastGeneratedReport.resolved_totals.restaurant_worked_hours_total
                )
                    ? formatHours(this.data.lastGeneratedReport.resolved_totals.restaurant_worked_hours_total)
                    : formatHours(this.data.lastGeneratedReport.resolved_totals.total_worked_hours);
                const restaurantScheduledText = Number.isFinite(
                    this.data.lastGeneratedReport.resolved_totals.restaurant_scheduled_hours_total
                )
                    ? formatHours(this.data.lastGeneratedReport.resolved_totals.restaurant_scheduled_hours_total)
                    : formatHours(this.data.lastGeneratedReport.resolved_totals.total_scheduled_hours);
                restaurantTotalsCopy.textContent = `En este rango el sitio acumula ${restaurantWorkedText} ejecutadas y ${restaurantScheduledText} programadas.`;
            }

            const statusBreakdown = document.getElementById('report-status-breakdown');
            if (statusBreakdown) {
                statusBreakdown.innerHTML =
                    statusSummary.length > 0
                        ? statusSummary
                              .map(
                                  ({ label, count }) => `
                        <span class="report-pill ${getBadgeClass(label)}">
                            <span>${escapeHtml(label)}</span>
                            <strong>${escapeHtml(String(count))}</strong>
                        </span>
                    `
                              )
                              .join('')
                        : '<span class="report-pill report-pill-empty">Aún no hay estados para mostrar.</span>';
            }
            this.renderReportDayEvidence(shiftItems, { isSingleDay });
            document.getElementById('report-result')?.classList.remove('hidden');
            this.updateReportSupportCard(null);
        } catch (error) {
            this.registerReportGenerateDebug(
                {
                    restaurant_id: this.normalizeReportFilterValue(restaurantId, { numeric: true }),
                    employee_id: this.normalizeReportFilterValue(employeeId, { numeric: false }),
                    period_start: startDate,
                    period_end: endDate,
                    export_format: 'both',
                    columns: REPORT_COLUMNS,
                },
                error,
                reportRequestContext || {
                    endpoint: '/reports_generate',
                    headers_sent: {
                        Authorization: apiClient.hasAccessToken() ? 'Bearer <access_token>' : '',
                        apikey: apiClient.getConfig().anonKey || '',
                        'Idempotency-Key': null,
                    },
                    jwt_decoded: buildJwtFullDebugSummary(apiClient.getConfig().accessToken || ''),
                }
            );
            this.updateReportSupportCard(
                Array.isArray(window.__worktraceReportDebug) ? window.__worktraceReportDebug[0] : null
            );
            this.showToast(this.getErrorMessage(error, 'No fue posible generar el informe.'), {
                tone: 'error',
                title: t('sup.toast.report.fail'),
            });
        } finally {
            this._reportGenerating = false;
            this.hideLoading();
        }
    },

    async generateAuditsReport({ startDate, endDate, restaurantId, supervisorId, exportFormat = 'both' }) {
        this.showLoading(t('sup.toast.report.generating'), t('sup.toast.report.generating.desc'));
        try {
            const accessToken = await this.getValidAccessToken();
            apiClient.setAccessToken(accessToken);

            const payload = {
                report_type: 'audits',
                period_start: startDate,
                period_end: endDate,
                restaurant_id: this.normalizeReportFilterValue(restaurantId, { numeric: true }),
                supervisor_id: this.normalizeReportFilterValue(supervisorId, { numeric: false }),
                export_format: exportFormat,
            };

            const result = await apiClient.reportsGenerate(payload, {
                accessToken,
                requiresIdempotency: false,
                headers: { 'Idempotency-Key': buildIdempotencyKey() },
                timeoutMs: 45000,
            });

            const rows = asArray(result?.rows);
            const totals = result?.totals || {};
            const totalAudits = Number(totals.audits ?? rows.length) || 0;
            const totalEvidences = Number(
                totals.evidences ??
                    rows.reduce((acc, row) => acc + (Number(row?.evidence_count) || asArray(row?.evidences).length), 0)
            ) || 0;

            this.data.lastGeneratedAuditReport = { ...(result || {}) };

            const resultCard = document.getElementById('audit-report-result');
            const summaryCopy = document.getElementById('audit-report-summary-copy');
            if (resultCard) resultCard.classList.remove('hidden');
            if (summaryCopy) {
                summaryCopy.textContent = totalAudits === 0
                    ? 'Sin auditorías en el rango seleccionado.'
                    : `${totalAudits} auditoría(s) con ${totalEvidences} evidencia(s). Descarga el informe del período completo o el de cada auditoría abajo.`;
            }
            this.renderAuditReportList(rows);
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible generar el informe de auditorías.'), {
                tone: 'error',
                title: t('sup.toast.report.fail'),
            });
        } finally {
            this.hideLoading();
        }
    },

    downloadGeneratedReport(type) {
        const report = this.data.lastGeneratedReport;
        if (!report) {
            this.showToast(t('sup.toast.report.first'), {
                tone: 'warning',
                title: t('sup.toast.report.no.results'),
            });
            return;
        }

        const url = type === 'pdf' ? report.url_pdf : report.url_excel;
        if (!url) {
            this.showToast(`No fue posible preparar la descarga en ${type.toUpperCase()}.`, {
                tone: 'error',
                title: t('sup.toast.download.unavailable'),
            });
            return;
        }

        this.closeReportDownloadMenu();
        this.openInNewTab(url);
    },

    /**
     * Abre un URL en una pestaña nueva usando un <a target="_blank">
     * creado y click-eado programáticamente. Este patrón sobrevive al
     * popup blocker de Safari iOS (que sí bloquea window.open desde
     * handlers indirectos como el delegador global) porque el navegador
     * lo interpreta como una navegación de link natural, no como script.
     */
    openInNewTab(url) {
        if (!url) return;
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        // requestAnimationFrame para asegurar que el click completa antes de remover.
        requestAnimationFrame(() => {
            anchor.remove();
        });
    },

    toggleReportDownloadMenu() {
        const menu = document.getElementById('report-download-options');
        if (!menu) {
            return;
        }

        menu.classList.toggle('hidden');
    },

    closeReportDownloadMenu() {
        document.getElementById('report-download-options')?.classList.add('hidden');
    },


    // ==========================================================================
    // SECCIÓN: Formularios de crear/editar sitio y contratista
    // --------------------------------------------------------------------------
    // Los usa el inspector desde "Nuevo Sitio" / "Nuevo Contratista" (y el
    // admin). El teléfono se normaliza con normalizePhoneToE164 (utils.js)
    // antes de validarlo: acepta el número sin "+" y limpia los caracteres
    // invisibles que iOS mete al autocompletar.
    // ==========================================================================

    async submitAdminRestaurantForm() {
        const name = document.getElementById('admin-restaurant-name')?.value?.trim();
        const addressLine = document.getElementById('admin-restaurant-address')?.value?.trim();
        const city = document.getElementById('admin-restaurant-city')?.value?.trim();
        const state = document.getElementById('admin-restaurant-state')?.value?.trim();
        const country = document.getElementById('admin-restaurant-country')?.value?.trim();
        const lat = Number(document.getElementById('admin-restaurant-lat')?.value);
        const lng = Number(document.getElementById('admin-restaurant-lng')?.value);
        const radius = Number(document.getElementById('admin-restaurant-radius')?.value || 100);
        const isActive = true;

        if (!name) {
            this.showToast(t('sup.toast.site.name.req'), {
                tone: 'warning',
                title: t('sup.toast.site.name.missing'),
            });
            return;
        }

        if (!addressLine || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            this.showToast(t('sup.toast.address.req'), {
                tone: 'warning',
                title: t('sup.toast.address.pending'),
            });
            return;
        }

        if (!Number.isFinite(radius)) {
            this.showToast(t('sup.toast.radius.req'), {
                tone: 'warning',
                title: t('sup.toast.radius.missing'),
            });
            return;
        }

        this.showLoading(t('sup.toast.creating.site'), t('toast.common.loading.wait'));

        try {
            await apiClient.adminRestaurantsManage('create', {
                name,
                lat,
                lng,
                radius,
                address_line: addressLine || undefined,
                city: city || undefined,
                state: state || undefined,
                country: country || undefined,
                is_active: isActive,
            });

            this.invalidateCache('adminRestaurants', 'adminMetrics', 'supervisorRestaurants');
            this.invalidateScopedCache('supervisorRestaurantStaff');
            this.invalidateScopedCache('supervisorAssignableEmployees');
            this.closeModal('modal-admin-restaurant');
            await Promise.all([
                this.loadSupervisorRestaurants(true),
                this.isAdminRole() ? this.loadAdminDashboard() : Promise.resolve(),
            ]);
            this.showToast(t('sup.toast.site.created'), {
                tone: 'success',
                title: t('toast.common.created'),
            });
        } catch (error) {
            if (!this.isAdminRole() && error?.status === 403) {
                this.showToast(this.getErrorMessage(error, t('supervisor.error.create.restaurant')), {
                    tone: 'error',
                    title: t('toast.common.no.permission'),
                });
                return;
            }
            this.showToast(this.getErrorMessage(error, 'No fue posible crear el restaurante.'), {
                tone: 'error',
                title: t('sup.toast.site.create.fail'),
            });
        } finally {
            this.hideLoading();
        }
    },

    async submitAdminEmployeeForm() {
        const editId = document.getElementById('admin-employee-edit-id')?.value?.trim();
        const fullName = document.getElementById('admin-employee-name')?.value?.trim();
        const email = document.getElementById('admin-employee-email')?.value?.trim();
        // Normaliza antes de validar: el input puede traer caracteres
        // invisibles de iOS, espacios o venir sin "+" (ver normalizePhoneToE164).
        const phoneInput = document.getElementById('admin-employee-phone');
        const phoneCheck = normalizePhoneToE164(phoneInput?.value);
        const phone = phoneCheck.phone;
        const isActive = true;

        if (!fullName || !email || !phone) {
            this.showToast(t('sup.toast.fill.contractor'), {
                tone: 'warning',
                title: t('toast.common.missing.data'),
            });
            return;
        }

        if (!phoneCheck.ok) {
            this.showToast(
                t(phoneCheck.needsCountryCode ? 'toast.common.phone.country' : 'toast.common.phone.format'),
                {
                    tone: 'warning',
                    title: t('toast.common.invalid.phone'),
                }
            );
            return;
        }
        // Que el input muestre exactamente lo que se va a guardar.
        if (phoneInput) phoneInput.value = phone;

        const isEditing = Boolean(editId);
        this.showLoading(
            isEditing ? 'Actualizando contratista...' : t('sup.toast.creating.contractor'),
            isEditing ? 'Guardando cambios.' : t('sup.toast.creating.contractor.desc')
        );

        try {
            const payload = isEditing
                ? {
                      user_id: editId,
                      full_name: fullName,
                      email,
                      phone_number: phone,
                      is_active: isActive,
                  }
                : {
                      role: 'empleado',
                      full_name: fullName,
                      email,
                      phone_number: phone,
                      is_active: isActive,
                  };
            const result = await apiClient.adminUsersManage(isEditing ? 'update' : 'create', payload);

            this.invalidateCache('supervisorEmployees');
            this.invalidateScopedCache('supervisorAssignableEmployees');
            this.closeAdminEmployeeModal();
            await this.loadSupervisorEmployees(true);

            if (isEditing) {
                this.showToast('Contratista actualizado.', {
                    tone: 'success',
                    title: t('toast.common.updated'),
                });
                return;
            }
            const initialPin = result?.initial_pin;
            if (initialPin) {
                this.showInitialPinModal({
                    pin: initialPin,
                    email,
                    emailSent: Boolean(result?.pin_email_sent),
                });
            } else {
                this.showToast(t('sup.toast.contractor.created'), {
                    tone: 'success',
                    title: t('toast.common.created'),
                });
            }
        } catch (error) {
            if (!this.isAdminRole() && error?.status === 403) {
                this.showToast(this.getErrorMessage(error, 'Tu cuenta no pudo guardar el contratista.'), {
                    tone: 'error',
                    title: t('toast.common.no.permission'),
                });
                return;
            }
            this.showToast(this.getErrorMessage(error, 'No fue posible guardar el contratista.'), {
                tone: 'error',
                title: t('sup.toast.contractor.create.fail'),
            });
        } finally {
            this.hideLoading();
        }
    },

    resetAdminEmployeeForm() {
        const form = document.getElementById('admin-employee-form');
        form?.reset();
        const editId = document.getElementById('admin-employee-edit-id');
        if (editId) editId.value = '';
        const title = document.getElementById('modal-admin-employee-title');
        if (title) title.textContent = 'Nuevo Contratista';
        const submitBtn = document.getElementById('admin-employee-submit-btn');
        if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-save"></i> <span>Guardar Contratista</span>';
        const credentialNote = document.getElementById('admin-employee-credential-note');
        if (credentialNote) credentialNote.classList.remove('hidden');
    },

    closeAdminEmployeeModal() {
        this.closeModal('modal-admin-employee');
        this.resetAdminEmployeeForm();
    },

    beginEditAdminEmployee(userId) {
        const employees = asArray(this.data.supervisor.employees);
        const employee = employees.find((item) => String(item?.id) === String(userId));
        if (!employee) {
            this.showToast('No fue posible cargar el contratista.', {
                tone: 'error',
                title: t('toast.common.cannot.continue'),
            });
            return;
        }
        this.resetAdminEmployeeForm();
        document.getElementById('admin-employee-edit-id').value = employee.id;
        document.getElementById('admin-employee-name').value = employee.full_name || '';
        document.getElementById('admin-employee-email').value = employee.email || '';
        document.getElementById('admin-employee-phone').value = employee.phone_e164 || employee.phone_number || '';
        const title = document.getElementById('modal-admin-employee-title');
        if (title) title.textContent = 'Editar Contratista';
        const submitBtn = document.getElementById('admin-employee-submit-btn');
        if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-save"></i> <span>Actualizar Contratista</span>';
        const credentialNote = document.getElementById('admin-employee-credential-note');
        if (credentialNote) credentialNote.classList.add('hidden');
        this.openModal('modal-admin-employee');
    },

    // ==========================================================================
    // SECCIÓN: Auditoría: guardar
    // --------------------------------------------------------------------------
    // Exige que la ubicación ya esté verificada (no vuelve a pedir el GPS; si
    // no se verificó, avisa y corta). Espera las subidas pendientes y cierra el
    // borrador ('finalize') con las observaciones. Toast final: "Auditoría
    // registrada correctamente."
    // ==========================================================================

    async saveSupervision() {
        if (this.supervisionSavePending) {
            return;
        }

        this.setSupervisionSubmitState(true);
        try {
            const restaurants =
                this.data.supervisor.restaurants.length > 0
                    ? this.data.supervisor.restaurants
                    : await this.getSupervisorRestaurants();
            const selectedRestaurantId = document.getElementById('supervision-restaurant-select')?.value;
            const targetRestaurant = selectedRestaurantId
                ? restaurants.find(
                      (restaurant) => String(getRestaurantRecordId(restaurant)) === String(selectedRestaurantId)
                  )
                : restaurants[0];

            if (!targetRestaurant) {
                this.showToast(t('sup.toast.no.sites.audit'), {
                    tone: 'warning',
                    title: t('sup.toast.no.sites.audit.title'),
                });
                return;
            }

            // Bloqueo obligatorio: no permitir enviar la auditoría si el
            // inspector no verificó su ubicación en el sitio. Antes se podía
            // registrar auditoría sin haber tocado "Verificar ubicación".
            if (!this.supervisionLocationVerified) {
                this.showToast(
                    'Debes verificar tu ubicación en el sitio antes de registrar la auditoría. Toca "Verificar ubicación".',
                    { tone: 'warning', title: 'Ubicación sin verificar' }
                );
                return;
            }

            const requireSupervisionPhotos = this.getSystemSetting(
                'evidence.require_supervision_photos',
                DEFAULT_SYSTEM_SETTINGS.evidence.require_supervision_photos
            );
            if (requireSupervisionPhotos && Object.keys(this.supervisionPhotoFiles).length === 0) {
                this.showToast(t('sup.toast.audit.photo.req'), {
                    tone: 'warning',
                    title: t('sup.toast.audit.evidence.missing'),
                });
                return;
            }

            this.showLoading('Finalizando auditoría…', t('toast.wait.short'));

            let supervisionPayload = null;

            try {
                // La ubicación ya fue verificada arriba. Ya NO forzamos una
                // nueva captura — el draft se creó al 'start' con la geocerca
                // validada; el finalize NO revalida geocerca (el inspector
                // puede estar escribiendo notas ya fuera del sitio, acordado
                // con backend). Solo leemos notes.
                const notes = document.getElementById('supervision-observations')?.value?.trim();

                // Guards del backend (supervisor_presence_manage):
                //   - evidences <= 50 total
                //   - imágenes hasta 8 MB
                //   - videos hasta 50 MB (mp4, quicktime, webm)
                // Chequeamos igual porque el user pudo llegar acá sin haber
                // disparado uploads (ej. red offline durante todo el recorrido).
                const MAX_EVIDENCES_PER_AUDIT = 50;
                const MAX_BYTES_IMAGE = 8 * 1024 * 1024;
                const MAX_BYTES_VIDEO = 50 * 1024 * 1024;

                const areaBufferCount = Object.keys(this.supervisionPhotoFiles || {}).length;
                const observationAttachments = this._supervisionObservationsAttachments || [];
                const totalCount = areaBufferCount + observationAttachments.length;

                if (totalCount > MAX_EVIDENCES_PER_AUDIT) {
                    const excess = totalCount - MAX_EVIDENCES_PER_AUDIT;
                    this.showToast(
                        `Tenés ${totalCount} evidencias (fotos + observaciones). Máximo ${MAX_EVIDENCES_PER_AUDIT} por auditoría. Quitá al menos ${excess}.`,
                        { tone: 'warning', title: 'Demasiadas evidencias', duration: 7000 }
                    );
                    return;
                }

                const oversized = observationAttachments.find((f) => {
                    const isVideo = String(f?.type || '').toLowerCase().startsWith('video/');
                    const limit = isVideo ? MAX_BYTES_VIDEO : MAX_BYTES_IMAGE;
                    return Number(f?.size || 0) > limit;
                });
                if (oversized) {
                    const isVideo = String(oversized.type || '').toLowerCase().startsWith('video/');
                    const mb = Math.round((oversized.size / (1024 * 1024)) * 10) / 10;
                    const limitMb = isVideo ? 50 : 8;
                    const kindLabel = isVideo ? 'video' : 'foto';
                    this.showToast(
                        `El archivo "${oversized.name}" pesa ${mb} MB. Máximo ${limitMb} MB por ${kindLabel}.`,
                        { tone: 'warning', title: 'Archivo muy pesado', duration: 7000 }
                    );
                    return;
                }

                // Flujo progresivo: las fotos ya se subieron en background durante
                // el recorrido vía enqueueSupervisionSlotUpload/ObservationUpload.
                // Acá solo esperamos las que aún estén en vuelo y llamamos finalize.
                //
                // Fallback: si por alguna razón NO hay draft (ubicación no verificada,
                // red caída al arrancar, etc.) creamos uno ahora y forzamos los
                // uploads en el momento. Cubre el edge case del inspector que
                // llegó hasta acá sin haber tocado "Verificar ubicación" — aunque
                // hay guard arriba, este safety net evita perder trabajo.
                if (!this.supervisionDraftId) {
                    try {
                        await this.ensureSupervisionDraft();
                    } catch (draftErr) {
                        // Si tampoco podemos crear el draft (ej. sin ubicación) mostramos
                        // el mismo error y salimos.
                        this.showToast(draftErr?.message || 'No fue posible iniciar la auditoría.', {
                            tone: 'error',
                            title: 'No se pudo abrir la auditoría',
                        });
                        return;
                    }
                    // Enqueue lo que haya en buffer que no tenga upload iniciado
                    // (usualmente estará vacío si el user siguió el flow normal).
                    Object.entries(this.supervisionPhotoFiles || {}).forEach(([slotKey, file]) => {
                        if (file && !this._supervisionSlotUploads?.get(slotKey)) {
                            this.enqueueSupervisionSlotUpload(slotKey, file);
                        }
                    });
                    (this._supervisionObservationsAttachments || []).forEach((file, idx) => {
                        if (file && !this._supervisionObsUploads?.get(idx)) {
                            this.enqueueSupervisionObservationUpload(idx, file);
                        }
                    });
                }

                const uploadSummary = await this.awaitAllSupervisionUploads();

                if (uploadSummary.failed > 0) {
                    // Warning informativo — backend permite finalize aunque falten
                    // evidencias (acordado en el diseño). No bloqueamos.
                    this.showToast(
                        `${uploadSummary.failed} evidencia${uploadSummary.failed === 1 ? '' : 's'} no se pudo${uploadSummary.failed === 1 ? '' : 'n'} subir. Se guarda la auditoría con las ${uploadSummary.done} que sí llegaron.`,
                        { tone: 'warning', title: 'Evidencias parciales', duration: 8000 }
                    );
                }

                const presenceId = this.supervisionDraftId;
                supervisionPayload = { presence_id: presenceId, notes };

                const registerResult = await apiClient.supervisorPresenceManage(
                    'finalize',
                    supervisionPayload,
                    {
                        requiresIdempotency: false,
                        headers: { 'Idempotency-Key': buildIdempotencyKey() },
                    }
                );
                const alreadyExists =
                    registerResult?.already_completed === true ||
                    registerResult?.data?.already_completed === true;

                this.invalidateCache('supervisorShifts');
                this.showToast(
                    alreadyExists
                        ? 'La auditoría ya existía y se tomó como registrada.'
                        : 'Auditoría registrada correctamente.',
                    {
                        tone: 'success',
                        title: t('sup.toast.audit.success'),
                    }
                );
                this.clearSupervisionRegisterRetryState();
                this.hideSupervisionSupportCard();
                this.resetSupervisorSupervisionState();
                this.clearSupervisorSupervisionLocationState();
                this.updateSupervisorSupervisionLocationUi();
                const observations = document.getElementById('supervision-observations');
                if (observations) {
                    observations.value = '';
                }
                this.navigate('supervisor-dashboard');
            } catch (error) {
                const debugEntry = this.registerSupervisionDebug(supervisionPayload, error, {
                    restaurant_id: targetRestaurant?.restaurant_id || targetRestaurant?.id || null,
                    idempotency_key: this.supervisionRegisterIdempotencyKey || null,
                    retry_signature: this.supervisionRegisterRetrySignature || null,
                });
                this.updateSupervisionSupportCard(debugEntry);
                const supervisionErrorMessage = String(
                    error?.payload?.error?.message ||
                        error?.payload?.message ||
                        error?.message ||
                        'No fue posible registrar la auditoría.'
                ).trim();
                this.showToast(supervisionErrorMessage || 'No fue posible registrar la auditoría.', {
                    tone: 'error',
                    title: t('sup.toast.audit.fail'),
                });
            } finally {
                this.hideLoading();
            }
        } finally {
            this.setSupervisionSubmitState(false);
        }
    },

};
