// @ts-nocheck
const DEFAULT_TIMEOUT_MS = 15000;

export const DEFAULT_FUNCTIONS_BASE_URL = 'https://<SUPABASE_PROJECT>.supabase.co/functions/v1';

export const STORAGE_KEYS = Object.freeze({
    accessToken: 'worktrace_access_token',
    shiftOtpToken: 'worktrace_shift_otp_token',
    deviceFingerprint: 'worktrace_device_fingerprint',
});

function createScopedConsole() {
    const baseConsole = globalThis.console || {};
    const host = globalThis.location?.hostname || '';
    const debugEnabled = Boolean(globalThis.WORKTRACE_CONFIG?.debugConsole) || /^(localhost|127\.0\.0\.1)$/i.test(host);

    const noop = () => {};
    const bindMethod = (method) =>
        typeof baseConsole?.[method] === 'function' ? baseConsole[method].bind(baseConsole) : noop;

    return {
        ...baseConsole,
        log: debugEnabled ? bindMethod('log') : noop,
        info: debugEnabled ? bindMethod('info') : noop,
        warn: debugEnabled ? bindMethod('warn') : noop,
        debug: debugEnabled ? bindMethod('debug') : noop,
        error: bindMethod('error'),
    };
}

const console = createScopedConsole();

function getStorage() {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        return window.localStorage;
    } catch (error) {
        console.warn('No fue posible acceder a localStorage.', error);
        return null;
    }
}

function readStoredValue(key) {
    const storage = getStorage();
    return storage ? storage.getItem(key) || '' : '';
}

function writeStoredValue(key, value) {
    const storage = getStorage();
    if (!storage) {
        return;
    }

    if (!value) {
        storage.removeItem(key);
        return;
    }

    storage.setItem(key, value);
}

function stripTrailingSlash(value = '') {
    return String(value || '').replace(/\/+$/, '');
}

function normalizeFunctionsBaseUrl(value = '') {
    const normalized = stripTrailingSlash(value);

    if (!normalized) {
        return normalized;
    }

    if (normalized.endsWith('/functions/v1')) {
        return normalized;
    }

    if (/^https:\/\/[^/]+\.supabase\.co$/i.test(normalized)) {
        return `${normalized}/functions/v1`;
    }

    return normalized;
}

function normalizePath(path) {
    return path.startsWith('/') ? path : `/${path}`;
}

function deriveSupabaseOriginFromFunctionsBaseUrl(baseUrl = '') {
    const normalized = normalizeFunctionsBaseUrl(baseUrl);
    if (!normalized) {
        return '';
    }

    return normalized.replace(/\/functions\/v1$/i, '');
}

function buildUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `wt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function hashString(value) {
    let hash = 0;

    for (let index = 0; index < value.length; index += 1) {
        hash = (hash << 5) - hash + value.charCodeAt(index);
        hash |= 0;
    }

    return Math.abs(hash).toString(16);
}

function isConfiguredBaseUrl(value) {
    return Boolean(value) && !String(value).includes('<SUPABASE_PROJECT>');
}

function isConfiguredAnonKey(value) {
    return Boolean(value) && !String(value).includes('<SUPABASE_ANON_KEY>');
}

function buildRequestError(message, details = {}) {
    const error = new Error(message);
    Object.assign(error, details);
    return error;
}

function normalizeRoleToken(value = '') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');

    if (normalized === 'superuser') {
        return 'super_admin';
    }

    return normalized;
}

function payloadMessage(payload) {
    return payload?.error?.message || payload?.message || '';
}

export function buildIdempotencyKey() {
    return `wt-${buildUuid()}`;
}

export function getOrCreateDeviceFingerprint() {
    const storedFingerprint = readStoredValue(STORAGE_KEYS.deviceFingerprint);
    if (storedFingerprint) {
        return storedFingerprint;
    }

    const browserSeed =
        typeof window === 'undefined'
            ? 'server'
            : [
                  window.navigator.userAgent,
                  window.navigator.language,
                  window.navigator.platform,
                  window.screen.width,
                  window.screen.height,
                  Intl.DateTimeFormat().resolvedOptions().timeZone,
              ].join('|');

    const fingerprint = `web-${hashString(browserSeed)}-${buildUuid()}`;
    writeStoredValue(STORAGE_KEYS.deviceFingerprint, fingerprint);
    return fingerprint;
}

export class WorkTraceApiClient {
    constructor(config = {}) {
        this.config = {
            baseUrl: DEFAULT_FUNCTIONS_BASE_URL,
            anonKey: '',
            accessToken: readStoredValue(STORAGE_KEYS.accessToken),
            shiftOtpToken: readStoredValue(STORAGE_KEYS.shiftOtpToken),
            currentRole: '',
            deviceFingerprint: readStoredValue(STORAGE_KEYS.deviceFingerprint) || getOrCreateDeviceFingerprint(),
            timeoutMs: DEFAULT_TIMEOUT_MS,
        };
        this.lastResponseMeta = null;
        this.accessTokenResolver = null;
        this.configure(config);
    }

    configure(config = {}) {
        if ('baseUrl' in config && config.baseUrl) {
            this.config.baseUrl = normalizeFunctionsBaseUrl(config.baseUrl);
        }

        if ('anonKey' in config && config.anonKey) {
            this.config.anonKey = config.anonKey;
        }

        if ('accessToken' in config) {
            this.setAccessToken(config.accessToken || '');
        }

        if ('shiftOtpToken' in config) {
            this.setShiftOtpToken(config.shiftOtpToken || '');
        }

        if ('timeoutMs' in config && Number.isFinite(Number(config.timeoutMs))) {
            this.config.timeoutMs = Number(config.timeoutMs);
        }

        if ('currentRole' in config) {
            this.setCurrentRole(config.currentRole || '');
        }

        if ('deviceFingerprint' in config && config.deviceFingerprint) {
            this.setDeviceFingerprint(config.deviceFingerprint);
        } else if (!this.config.deviceFingerprint) {
            this.config.deviceFingerprint = getOrCreateDeviceFingerprint();
        }

        return this.getConfig();
    }

    getConfig() {
        return { ...this.config };
    }

    getDebugSnapshot() {
        return {
            baseUrl: this.config.baseUrl,
            anonKeyConfigured: isConfiguredAnonKey(this.config.anonKey),
            accessTokenConfigured: Boolean(this.config.accessToken),
            shiftOtpConfigured: Boolean(this.config.shiftOtpToken),
            currentRole: this.config.currentRole,
            deviceFingerprint: this.config.deviceFingerprint,
            timeoutMs: this.config.timeoutMs,
            lastResponseMeta: this.lastResponseMeta,
        };
    }

    hasBackendConfig() {
        return isConfiguredBaseUrl(this.config.baseUrl) && isConfiguredAnonKey(this.config.anonKey);
    }

    hasAccessToken() {
        return Boolean(this.config.accessToken);
    }

    setAccessTokenResolver(resolver) {
        this.accessTokenResolver = typeof resolver === 'function' ? resolver : null;
    }

    setAccessToken(token = '') {
        this.config.accessToken = token;
        writeStoredValue(STORAGE_KEYS.accessToken, token);
        return this.config.accessToken;
    }

    setShiftOtpToken(token = '') {
        this.config.shiftOtpToken = token;
        writeStoredValue(STORAGE_KEYS.shiftOtpToken, token);
        return this.config.shiftOtpToken;
    }

    setCurrentRole(role = '') {
        this.config.currentRole = normalizeRoleToken(role);
        return this.config.currentRole;
    }

    setDeviceFingerprint(deviceFingerprint = '') {
        const nextFingerprint = deviceFingerprint || getOrCreateDeviceFingerprint();
        this.config.deviceFingerprint = nextFingerprint;
        writeStoredValue(STORAGE_KEYS.deviceFingerprint, nextFingerprint);
        return this.config.deviceFingerprint;
    }

    clearSession() {
        this.setAccessToken('');
        this.setShiftOtpToken('');
        this.setCurrentRole('');
    }

    async resolveAccessToken(options = {}) {
        if (this.accessTokenResolver) {
            const token = await this.accessTokenResolver(options);
            if (typeof token === 'string') {
                this.setAccessToken(token);
            }
        }

        return this.config.accessToken;
    }

    buildHeaders({
        accessToken = this.config.accessToken,
        requiresAuth = true,
        requiresOtp = false,
        requiresIdempotency = true,
        extraHeaders = {},
    } = {}) {
        const headers = {
            'Content-Type': 'application/json',
        };

        if (this.config.anonKey) {
            headers.apikey = this.config.anonKey;
        }

        if (requiresAuth) {
            if (!accessToken) {
                throw buildRequestError('Falta accessToken para llamar a un endpoint protegido.', {
                    code: 'AUTH_MISSING',
                });
            }

            headers.Authorization = `Bearer ${accessToken}`;
        }

        if (requiresIdempotency) {
            headers['Idempotency-Key'] = buildIdempotencyKey();
        }

        if (this.config.deviceFingerprint) {
            headers['x-device-fingerprint'] = this.config.deviceFingerprint;
        }

        if (requiresOtp) {
            if (!this.config.shiftOtpToken) {
                throw buildRequestError('Falta shiftOtpToken para esta operación protegida por OTP.', {
                    code: 'OTP_MISSING',
                });
            }

            headers['x-shift-otp-token'] = this.config.shiftOtpToken;
        }

        return {
            ...headers,
            ...extraHeaders,
        };
    }

    async request(path, options = {}) {
        const {
            method = 'POST',
            body,
            accessToken: explicitAccessToken,
            requiresAuth = true,
            requiresOtp = false,
            requiresIdempotency = method !== 'GET',
            headers = {},
            timeoutMs = this.config.timeoutMs,
            signal,
            retryOnInvalidJwt = true,
        } = options;

        if (!this.hasBackendConfig()) {
            throw buildRequestError(
                'Configura apiBaseUrl y supabaseAnonKey en window.WORKTRACE_CONFIG antes de usar la API.',
                { code: 'CONFIG_MISSING', endpoint: normalizePath(path), method }
            );
        }

        const controller = new AbortController();
        let didTimeout = false;
        const endpoint = normalizePath(path);

        if (signal) {
            if (signal.aborted) {
                controller.abort();
            } else {
                signal.addEventListener('abort', () => controller.abort(), { once: true });
            }
        }

        const timeoutId = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeoutMs);

        try {
            const accessToken = requiresAuth
                ? typeof explicitAccessToken === 'string'
                    ? explicitAccessToken
                    : await this.resolveAccessToken()
                : this.config.accessToken;
            const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
                method,
                headers: this.buildHeaders({
                    accessToken,
                    requiresAuth,
                    requiresOtp,
                    requiresIdempotency,
                    extraHeaders: headers,
                }),
                body: method === 'GET' || body == null ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });

            const text = await response.text();
            let payload = null;

            if (text) {
                try {
                    payload = JSON.parse(text);
                } catch (error) {
                    payload = { raw: text };
                }
            }

            this.lastResponseMeta = {
                status: response.status,
                requestId: response.headers.get('X-Request-Id') || payload?.request_id || null,
            };

            const topLevelCode = payload?.code || payload?.error?.code || null;
            const topLevelErrorCode = payload?.error?.error_code || payload?.error_code || null;
            const topLevelMessage = payloadMessage(payload);
            const shouldRetryInvalidJwt =
                requiresAuth &&
                retryOnInvalidJwt &&
                response.status === 401 &&
                /invalid jwt/i.test(topLevelMessage || '');

            if (shouldRetryInvalidJwt) {
                const refreshedToken = await this.resolveAccessToken({ forceRefresh: true });

                if (refreshedToken && refreshedToken !== accessToken) {
                    return this.request(path, {
                        ...options,
                        retryOnInvalidJwt: false,
                    });
                }
            }

            if (!response.ok || payload?.success === false) {
                const errorPayload = payload?.error || payload || {};
                throw buildRequestError(
                    errorPayload.message || topLevelMessage || `La solicitud falló con estado ${response.status}.`,
                    {
                        status: response.status,
                        code: errorPayload.code || topLevelCode || null,
                        error_code: errorPayload.error_code || topLevelErrorCode || null,
                        category: errorPayload.category || null,
                        requestId: errorPayload.request_id || this.lastResponseMeta.requestId,
                        endpoint,
                        method,
                        payload,
                    }
                );
            }

            return payload?.data ?? payload;
        } catch (error) {
            if (didTimeout || error.name === 'AbortError') {
                throw buildRequestError('Tiempo de espera agotado al contactar el backend.', {
                    code: 'TIMEOUT',
                    endpoint,
                    method,
                    cause: error,
                });
            }

            if (error instanceof Error && (error.status || error.code)) {
                throw error;
            }

            throw buildRequestError('No fue posible contactar el backend.', {
                code: 'NETWORK_ERROR',
                endpoint,
                method,
                cause: error,
            });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    get(path, options = {}) {
        return this.request(path, {
            ...options,
            method: 'GET',
            requiresIdempotency: false,
        });
    }

    post(path, body, options = {}) {
        return this.request(path, {
            ...options,
            method: 'POST',
            body,
        });
    }

    callAction(endpoint, action, payload = {}, options = {}) {
        return this.post(
            endpoint,
            {
                action,
                ...payload,
            },
            options
        );
    }

    healthPing() {
        return this.get('/health_ping', { requiresAuth: false });
    }

    legalConsentStatus() {
        return this.callAction(
            '/legal_consent',
            'status',
            {},
            {
                requiresIdempotency: false,
            }
        );
    }

    acceptLegalConsent(termInfo = null) {
        const payload = {};

        if (termInfo && typeof termInfo === 'object') {
            const legalTermsId = termInfo.legal_terms_id ?? termInfo.id ?? null;
            const termsCode = termInfo.terms_code ?? termInfo.code ?? null;
            const version = termInfo.version ?? null;

            if (legalTermsId != null) {
                payload.legal_terms_id = legalTermsId;
            }

            if (termsCode) {
                payload.terms_code = termsCode;
            }

            if (version != null && version !== '') {
                payload.version = version;
            }
        } else if (termInfo != null) {
            payload.legal_terms_id = termInfo;
        }

        return this.callAction('/legal_consent', 'accept', payload);
    }

    trustedDeviceValidate(deviceFingerprint = this.config.deviceFingerprint) {
        return this.post('/trusted_device_validate', {
            device_fingerprint: deviceFingerprint,
        });
    }

    trustedDeviceRegister({
        deviceFingerprint = this.config.deviceFingerprint,
        deviceName = 'Web Browser',
        platform = 'web',
    } = {}) {
        return this.post('/trusted_device_register', {
            device_fingerprint: deviceFingerprint,
            device_name: deviceName,
            platform,
        });
    }

    trustedDeviceRevoke(payload) {
        return this.post('/trusted_device_revoke', payload);
    }

    phoneOtpSend(deviceFingerprint = this.config.deviceFingerprint) {
        return this.post('/phone_otp_send', {
            device_fingerprint: deviceFingerprint,
        });
    }

    async phoneOtpVerify(code, deviceFingerprint = this.config.deviceFingerprint) {
        const data = await this.post('/phone_otp_verify', {
            code,
            device_fingerprint: deviceFingerprint,
        });

        if (data?.verification_token) {
            this.setShiftOtpToken(data.verification_token);
        }

        return data;
    }

    employeeSelfService(action, payload = {}) {
        return this.callAction('/employee_self_service', action, payload);
    }

    usersManage(action, payload = {}, options = {}) {
        return this.callAction('/users_manage', action, payload, options);
    }

    getCurrentUserProfile() {
        return this.usersManage('me');
    }

    changeMyPin(newPin, options = {}) {
        return this.usersManage(
            'change_my_pin',
            {
                new_pin: newPin,
            },
            options
        );
    }

    async probeSupabaseAuthUser(accessToken = this.config.accessToken) {
        const supabaseOrigin = deriveSupabaseOriginFromFunctionsBaseUrl(this.config.baseUrl);

        if (!supabaseOrigin || !accessToken) {
            return {
                ok: false,
                status: 0,
                payload: {
                    message: 'No hay base URL o access token para probar auth/v1/user.',
                },
            };
        }

        const response = await fetch(`${supabaseOrigin}/auth/v1/user`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                apikey: this.config.anonKey || '',
            },
        });

        const text = await response.text();
        let payload = null;

        if (text) {
            try {
                payload = JSON.parse(text);
            } catch (error) {
                payload = { raw: text };
            }
        }

        return {
            ok: response.ok,
            status: response.status,
            payload,
        };
    }

    getEmployeeDashboard(options = {}) {
        return this.employeeSelfService('my_dashboard', options);
    }

    getEmployeeActiveShift(options = {}) {
        return this.employeeSelfService('my_active_shift', options);
    }

    getEmployeeHoursHistory(payload) {
        return this.employeeSelfService('my_hours_history', payload);
    }

    createEmployeeObservation(payload) {
        return this.employeeSelfService('create_observation', payload);
    }

    startShift(payload) {
        return this.post('/shifts_start', payload, { requiresOtp: true });
    }

    endShift(payload) {
        return this.post('/shifts_end', payload, { requiresOtp: true });
    }

    shouldRequireSupervisorOtp(options = {}) {
        if (typeof options?.requiresOtp === 'boolean') {
            return options.requiresOtp;
        }

        return normalizeRoleToken(this.config.currentRole) !== 'super_admin';
    }

    approveShift(shiftId, options = {}) {
        return this.post(
            '/shifts_approve',
            { shift_id: shiftId },
            {
                ...options,
                requiresOtp: this.shouldRequireSupervisorOtp(options),
            }
        );
    }

    rejectShift(shiftId, options = {}) {
        return this.post(
            '/shifts_reject',
            { shift_id: shiftId },
            {
                ...options,
                requiresOtp: this.shouldRequireSupervisorOtp(options),
            }
        );
    }

    requestShiftEvidenceUpload(shiftId, type) {
        return this.callAction(
            '/evidence_upload',
            'request_upload',
            {
                shift_id: shiftId,
                type,
            },
            {
                requiresOtp: true,
            }
        );
    }

    finalizeShiftEvidenceUpload(payload) {
        return this.callAction('/evidence_upload', 'finalize_upload', payload, {
            requiresOtp: true,
        });
    }

    evidenceUploadWarm() {
        // Best-effort cold-start warm-up. Server returns an error for 'warm' action — that's expected and fine.
        return this.callAction('/evidence_upload', 'warm', {}).catch(() => {});
    }

    async uploadToSignedUrl(signedUrl, file, contentType = file?.type, timeoutMs = 60000) {
        const headers = contentType ? { 'Content-Type': contentType } : {};
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(signedUrl, {
                method: 'PUT',
                headers,
                body: file,
                signal: controller.signal,
            });

            if (!response.ok) {
                throw buildRequestError('No fue posible subir el archivo a la URL firmada.', {
                    status: response.status,
                    code: 'SIGNED_UPLOAD_FAILED',
                });
            }

            return true;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw buildRequestError('Tiempo de espera agotado al subir la foto.', {
                    code: 'UPLOAD_TIMEOUT',
                });
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    createIncident(payload, options = {}) {
        return this.post('/incidents_create', payload, {
            ...options,
            requiresOtp: this.shouldRequireSupervisorOtp(options),
        });
    }

    scheduledShiftsManage(action, payload = {}) {
        return this.callAction('/scheduled_shifts_manage', action, payload);
    }

    operationalTasksManage(action, payload = {}, options = {}) {
        return this.callAction('/operational_tasks_manage', action, payload, options);
    }

    supervisorPresenceManage(action, payload = {}, options = {}) {
        return this.callAction('/supervisor_presence_manage', action, payload, options);
    }

    shiftEvidenceManage(action, payload = {}, options = {}) {
        return this.callAction('/shift_evidence_manage', action, payload, options);
    }

    getShiftEvidenceSummary(shiftId) {
        return this.shiftEvidenceManage(
            'summary_by_shift',
            {
                shift_id: shiftId,
            },
            {
                requiresIdempotency: false,
            }
        );
    }

    suppliesDeliver(action, payload = {}) {
        return this.callAction('/supplies_deliver', action, payload);
    }

    adminUsersManage(action, payload = {}) {
        return this.callAction('/admin_users_manage', action, payload);
    }

    adminUserPhoneRemove(userId, options = {}) {
        return this.post(
            '/admin_user_phone_remove',
            {
                user_id: userId,
            },
            {
                ...options,
                requiresIdempotency: false,
            }
        );
    }

    adminRestaurantsManage(action, payload = {}) {
        return this.callAction('/admin_restaurants_manage', action, payload);
    }

    adminSupervisorsManage(action, payload = {}) {
        return this.callAction('/admin_supervisors_manage', action, payload);
    }

    adminDashboardMetrics(payload, options = {}) {
        return this.callAction('/admin_dashboard_metrics', 'summary', payload, options);
    }

    restaurantStaffManage(action, payload = {}) {
        return this.callAction('/restaurant_staff_manage', action, payload);
    }

    reportsManage(action, payload = {}) {
        return this.callAction('/reports_manage', action, payload);
    }

    reportsGenerate(payload, options = {}) {
        return this.post('/reports_generate', payload, options);
    }

    systemSettingsManage(action, payload = {}) {
        return this.callAction('/system_settings_manage', action, payload);
    }

    emailNotificationsDispatch(payload) {
        return this.post('/email_notifications_dispatch', payload);
    }
}

export const apiClient = new WorkTraceApiClient();

if (typeof window !== 'undefined') {
    window.WorkTraceApi = {
        WorkTraceApiClient,
        apiClient,
        buildIdempotencyKey,
        getOrCreateDeviceFingerprint,
        STORAGE_KEYS,
    };
}
