// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import '@fortawesome/fontawesome-free/css/all.min.css';
import { apiClient, buildIdempotencyKey } from './api.js';
import {
    STORAGE_KEYS, ROLE_ROUTES, ROLE_LABELS, REPORT_COLUMNS,
    AREA_META, AREA_SUBAREAS, AREA_GROUP_ALIASES,
    DEFAULT_SYSTEM_SETTINGS, CACHE_TTLS, SHIFT_NOT_STARTED_ALERT_GRACE_MINUTES,
    createScopedConsole
} from './constants.js';
import {
    getMonthStart, getTodayStart, getTodayEnd, getDaysAgo,
    toInputDate, toLocalDateKey, toIsoDate,
    decodeJwtPart, decodeJwtHeader, decodeJwtPayload,
    buildJwtFullDebugSummary, buildJwtDebugSummary,
    toDateTimeLocalInput, formatDate, formatTime, formatDateTime,
    formatShiftRange, formatHours, isHttpUrl, collectEvidenceUrls,
    escapeHtml, normalizeAreaToken, extractCleaningAreas,
    extractCleaningAreaSubareas, extractCleaningAreaGroups, uniqueCleaningAreas,
    buildAreaMeta, formatEntityReference, getDisplayTextCandidate,
    normalizeComparableText, pickMeaningfulDisplayValue,
    getRestaurantAddressFallback, collectRestaurantAddressCandidates,
    isLikelyAddressDisplayValue, isLikelyIdentifierDisplayValue,
    pickMeaningfulRestaurantName, getEmployeeDisplayName, getRestaurantDisplayName,
    isRestaurantReferenceLabel, getShiftEmployeeName, getShiftRestaurantName,
    normalizeAreaGroupLabel, buildPhotoSlotKey, areaDomId,
    getRestaurantRecordId, normalizeRestaurantId, deepMergeSettings,
    initials, delay, isGenericNamedPlaceholder, getBadgeClass, asArray,
    normalizeLinkedPhoneValue, getHoursFromRange, getScheduledHours, getWorkedHours,
    getShiftStatusLabel, isShiftEndedEarly, sumHours, sumWorkedHours,
    countEndedEarlyShifts, summarizeShiftStatuses
} from './utils.js';

const console = createScopedConsole();

if (typeof window !== 'undefined') {
    window.__worktraceBulkAssignDebug = Array.isArray(window.__worktraceBulkAssignDebug) ? window.__worktraceBulkAssignDebug : [];
    window.__worktraceReportDebug = Array.isArray(window.__worktraceReportDebug) ? window.__worktraceReportDebug : [];
    window.__worktraceTaskCreateDebug = Array.isArray(window.__worktraceTaskCreateDebug) ? window.__worktraceTaskCreateDebug : [];
    window.__worktraceTaskAuthDebug = Array.isArray(window.__worktraceTaskAuthDebug) ? window.__worktraceTaskAuthDebug : [];
    window.__worktraceShiftAssignDebug = Array.isArray(window.__worktraceShiftAssignDebug) ? window.__worktraceShiftAssignDebug : [];
    window.__worktraceSupervisionDebug = Array.isArray(window.__worktraceSupervisionDebug) ? window.__worktraceSupervisionDebug : [];
}

const app = {
    supabase: null,
    session: null,
    currentUser: null,
    currentPage: 'login',
    authBootstrapPromise: null,
    photos: {},
    endPhotos: {},
    photoFiles: {},
    endPhotoFiles: {},
    specialTaskEvidenceFile: null,
    specialTaskEvidencePreview: '',
    supervisionPhotos: {},
    supervisionPhotoFiles: {},
    uploadedStartAreas: {},
    uploadedEndAreas: {},
    gpsVerified: false,
    healthCertified: false,
    location: null,
    locationTimestamp: 0,
    locationAddress: '',
    locationAddressKey: '',
    locationAddressPromise: null,
    timerInterval: null,
    timerSeconds: 0,
    timerStartTimeMs: Number.NaN,
    currentPhotoArea: null,
    currentPhotoContext: null,
    currentPhotoType: 'start',
    cameraStream: null,
    cameraCaptureState: null,
    bodyScrollLockTop: 0,
    restaurantMap: null,
    restaurantMapMarker: null,
    googleMapsPromise: null,
    restaurantGeocoder: null,
    restaurantAutocompleteService: null,
    restaurantSearchResults: [],
    restaurantSelectedResultIndex: -1,
    restaurantLocationDraft: null,
    restaurantGeocodeAbortController: null,
    areas: Object.keys(AREA_META),
    cleaningAreaGroups: {},
    selectedEmployeeAreas: [],
    activeEmployeeArea: '',
    supervisorShiftMode: 'single',
    supervisorBatchSelectedEmployees: [],
    supervisorShiftPlanRows: [],
    supervisorShiftPlanRowCounter: 0,
    supervisorShiftPlanWeekStart: '',
    supervisorCurrentWeekStart: null,
    supervisorShiftFilters: {
        employeeId: '',
        date: '',
        restaurantId: '',
        search: ''
    },
    supervisorEmployeesStatusFilter: 'all',
    selectedSupervisorArea: '',
    selectedSupervisorShiftId: '',
    supervisionLocationVerified: false,
    supervisionLocationCheck: null,
    restaurantTaskDraftRestaurantId: '',
    restaurantTaskDraftSource: '',
    restaurantTaskSubmitPending: false,
    pendingUserDeactivateId: '',
    pendingShiftCancellationId: '',
    pendingShiftCancellationRequest: false,
    supervisorShiftSubmitPending: false,
    pendingRestaurantDeactivateId: '',
    supervisionRegisterIdempotencyKey: '',
    supervisionRegisterRetrySignature: '',
    supervisionSavePending: false,
    pinChangeGate: null,
    pinChangeSubmitPromise: null,
    tokenRefreshPromise: null,
    otpGate: null,
    otpChallengeState: null,
    employeePhotoSlots: [],
    supervisionPhotoSlots: [],
    supervisionPhotoCatalog: [],
    employeePermissionsRequested: false,
    employeePermissionsPromise: null,
    toastCounter: 0,
    toastTimers: new Map(),
    store: {
        ui: {
            pending: Object.create(null),
            scheduled: false,
            frameId: 0,
            signatures: Object.create(null),
            pageNodes: null,
            legacyUiArtifactsRemoved: false
        }
    },
    services: {
        images: {
            createObjectUrl(file) {
                if (!file || typeof URL?.createObjectURL !== 'function') {
                    return '';
                }

                return URL.createObjectURL(file);
            },
            revokeObjectUrl(url) {
                if (!url || typeof url !== 'string' || !url.startsWith('blob:') || typeof URL?.revokeObjectURL !== 'function') {
                    return;
                }

                URL.revokeObjectURL(url);
            },
            replaceInMap(targetMap, key, nextUrl) {
                if (!targetMap || !key) {
                    return;
                }

                const currentUrl = String(targetMap[key] || '');
                if (currentUrl && currentUrl !== nextUrl) {
                    this.revokeObjectUrl(currentUrl);
                }

                if (nextUrl) {
                    targetMap[key] = nextUrl;
                    return;
                }

                delete targetMap[key];
            },
            removeFromMap(targetMap, key) {
                if (!targetMap || !key) {
                    return;
                }

                const currentUrl = String(targetMap[key] || '');
                if (currentUrl) {
                    this.revokeObjectUrl(currentUrl);
                }
                delete targetMap[key];
            },
            clearMap(targetMap) {
                if (!targetMap || typeof targetMap !== 'object') {
                    return;
                }

                Object.keys(targetMap).forEach((key) => {
                    const value = String(targetMap[key] || '');
                    if (value) {
                        this.revokeObjectUrl(value);
                    }
                    delete targetMap[key];
                });
            }
        }
    },
    data: {
        employee: {
            dashboard: null,
            hoursHistory: null,
            openTasks: [],
            lastCompletedShift: null
        },
        supervisor: {
            restaurants: [],
            employees: [],
            shifts: [],
            report: null,
            assignableEmployees: []
        },
        admin: {
            restaurants: [],
            metrics: null,
            supervisors: [],
            supervisions: [],
            supervisionSupervisorOptions: []
        },
        systemSettings: deepMergeSettings(DEFAULT_SYSTEM_SETTINGS, {}),
        currentShift: null,
        currentScheduledShift: null,
        lastGeneratedReport: null
    },
    cache: {
        timestamps: {},
        pending: {},
        supervisorRestaurantStaff: {},
        supervisorAssignableEmployees: {},
        adminMetricsUnavailable: false,
        adminSupervisionsUnavailable: false,
        adminSupervisionsQuery: '',
        adminSupervisionsRateLimitedUntil: 0,
        adminSupervisorsQuery: ''
    },
    backend: {
        configured: false,
        connected: false,
        statusText: 'Pendiente',
        health: null,
        lastError: null
    },
    loadingState: {
        visible: false,
        title: 'Procesando...',
        message: 'Un momento por favor.'
    },

    getUiSignature(key) {
        return String(this.store.ui.signatures[key] || '');
    },

    setUiSignature(key, value) {
        this.store.ui.signatures[key] = String(value || '');
    },

    clearUiSignature(key) {
        delete this.store.ui.signatures[key];
    },

    queueUiRender(componentKey) {
        if (!componentKey) {
            return;
        }

        this.store.ui.pending[componentKey] = true;

        if (this.store.ui.scheduled) {
            return;
        }

        this.store.ui.scheduled = true;
        const schedule = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame.bind(window)
            : (callback) => globalThis.setTimeout(callback, 16);

        this.store.ui.frameId = schedule(() => {
            this.flushUiRenderQueue();
        });
    },

    flushUiRenderQueue() {
        const pending = { ...this.store.ui.pending };
        this.store.ui.pending = Object.create(null);
        this.store.ui.scheduled = false;
        this.store.ui.frameId = 0;

        if (pending['employee-area-selectors']) {
            this.renderEmployeeAreaSelectorsNow();
        }

        if (pending['employee-photo-grids']) {
            this.renderPhotoGridsNow();
            delete pending['supervisor-photo-grid'];
        }

        if (pending['employee-photo-progress']) {
            this.updateProgressNow();
        }

        if (pending['supervisor-photo-grid']) {
            this.renderSupervisorPhotoGridNow();
        }
    },

    getPageNodes() {
        if (Array.isArray(this.store.ui.pageNodes) && this.store.ui.pageNodes.length > 0) {
            return this.store.ui.pageNodes;
        }

        this.store.ui.pageNodes = Array.from(document.querySelectorAll('[id^="page-"]'));
        return this.store.ui.pageNodes;
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

        const normalized = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(:\d{2})?$/.test(raw)
            ? raw.replace(' ', 'T')
            : raw;

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
        const reasonableMaxHours = Number.isFinite(configuredMaxHours) && configuredMaxHours > 0
            ? Math.max(configuredMaxHours + 6, 18)
            : 18;
        const maxElapsedMs = reasonableMaxHours * 60 * 60 * 1000;

        const startMs = this.parseShiftTimestamp(shift?.start_time || shift?.started_at);
        const scheduledStartMs = this.parseShiftTimestamp(shift?.scheduled_start);

        if (Number.isFinite(startMs) && startMs > 0 && startMs <= (now + futureToleranceMs)) {
            if (!Number.isFinite(scheduledStartMs) || scheduledStartMs <= 0) {
                return startMs;
            }

            const elapsedFromStart = now - startMs;
            const scheduleLooksCurrent = Math.abs(now - scheduledStartMs) <= recentWindowMs;
            const startIsFarBeforeSchedule = startMs < (scheduledStartMs - scheduleAlignmentToleranceMs);

            if (scheduleLooksCurrent && (elapsedFromStart > maxElapsedMs || startIsFarBeforeSchedule)) {
                return scheduledStartMs;
            }

            return startMs;
        }

        if (Number.isFinite(scheduledStartMs) && scheduledStartMs > 0 && scheduledStartMs <= (now + futureToleranceMs)) {
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

    async init() {
        console.log('WorkTrace App Initializing...');
        this.showLoading('Iniciando sesión...', 'Espera un momento.');
        this.configureBackend();
        this.initSupabase();
        this.bindEvents();
        this.removeLegacyUiArtifacts();
        this.updateDate();
        this.setDefaultReportDates();
        this.renderPhotoGrids();
        this.updateDebugInfo();
        const backendConnectionPromise = this.checkBackendConnection();
        const restoreSessionPromise = this.restoreAuthSession();
        await backendConnectionPromise;
        const restoredSession = await restoreSessionPromise;

        if (!restoredSession && !this.currentUser) {
            this.navigate('login');
        }

        document.body.classList.remove('app-booting');
        this.hideLoading();
    },

    configureBackend() {
        const config = window.WORKTRACE_CONFIG || {};

        apiClient.configure({
            baseUrl: config.apiBaseUrl || config.supabaseUrl,
            anonKey: config.supabaseAnonKey,
            accessToken: config.accessToken,
            shiftOtpToken: config.shiftOtpToken,
            timeoutMs: config.timeoutMs,
            deviceFingerprint: config.deviceFingerprint
        });

        this.backend.configured = apiClient.hasBackendConfig();
        this.backend.statusText = this.backend.configured ? 'Configurado' : 'Sin configurar';
    },

    initSupabase() {
        const config = window.WORKTRACE_CONFIG || {};

        if (!config.supabaseUrl || !config.supabaseAnonKey) {
            console.warn('Faltan supabaseUrl o supabaseAnonKey en WORKTRACE_CONFIG.');
            return;
        }

        this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: false,
                detectSessionInUrl: true
            }
        });

        apiClient.setAccessTokenResolver(async (options = {}) => this.getValidAccessToken(options));

        this.supabase.auth.onAuthStateChange(async (event, session) => {
            this.session = session;
            apiClient.setAccessToken(session?.access_token || '');

            if (event === 'SIGNED_OUT') {
                this.handleSignedOut();
            }
        });
    },

    bindEvents() {
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.handleLogin();
            });
        }

        const passwordInput = document.getElementById('login-password');
        if (passwordInput) {
            passwordInput.addEventListener('input', () => {
                passwordInput.value = passwordInput.value.replace(/\D/g, '').slice(0, 6);
            });
        }

        const changePinForm = document.getElementById('change-pin-form');
        if (changePinForm) {
            changePinForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.submitChangePinForm();
            });
        }

        ['change-pin-new', 'change-pin-confirm'].forEach((id) => {
            const input = document.getElementById(id);
            if (input) {
                input.addEventListener('input', () => {
                    input.value = input.value.replace(/\D/g, '').slice(0, 12);
                });
            }
        });

        const otpForm = document.getElementById('otp-form');
        if (otpForm) {
            otpForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.submitOtpForm();
            });
        }

        const otpInput = document.getElementById('otp-code');
        if (otpInput) {
            otpInput.addEventListener('input', () => {
                otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 8);
            });
        }

        document.getElementById('camera-capture-btn')?.addEventListener('click', async () => {
            await this.captureCameraPhoto();
        });

        document.getElementById('camera-cancel-btn')?.addEventListener('click', () => {
            this.closeCameraCapture();
        });

        document.getElementById('camera-close-btn')?.addEventListener('click', () => {
            this.closeCameraCapture();
        });

        document.getElementById('otp-resend-btn')?.addEventListener('click', async () => {
            await this.resendOtpChallenge();
        });

        document.getElementById('otp-cancel-btn')?.addEventListener('click', () => {
            this.cancelOtpChallenge();
        });

        const shiftForm = document.getElementById('supervisor-shift-form');
        if (shiftForm) {
            shiftForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.submitSchedShiftForm();
            });
        }

        const adminRestaurantForm = document.getElementById('admin-restaurant-form');
        if (adminRestaurantForm) {
            adminRestaurantForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.submitAdminRestaurantForm();
            });
        }

        document.getElementById('admin-restaurant-search-btn')?.addEventListener('click', async () => {
            await this.searchAdminRestaurantLocation();
        });

        document.getElementById('admin-restaurant-current-location-btn')?.addEventListener('click', async () => {
            await this.useCurrentAdminRestaurantLocation();
        });

        document.getElementById('admin-restaurant-address-query')?.addEventListener('keydown', async (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                await this.searchAdminRestaurantLocation();
            }
        });

        const adminEmployeeForm = document.getElementById('admin-employee-form');
        if (adminEmployeeForm) {
            adminEmployeeForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.submitAdminEmployeeForm();
            });
        }

        const supervisorRestaurantTaskForm = document.getElementById('supervisor-restaurant-task-form');
        if (supervisorRestaurantTaskForm) {
            supervisorRestaurantTaskForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.submitSupervisorRestaurantTaskForm();
            });
        }

        const schedShiftRestaurant = document.getElementById('sched-shift-restaurant');
        if (schedShiftRestaurant) {
            schedShiftRestaurant.addEventListener('change', async () => {
                await this.renderSchedShiftEmployeePicker(schedShiftRestaurant.value);
            });
        }

        const schedShiftStartDate = document.getElementById('sched-shift-start-date');
        const schedShiftEndDate = document.getElementById('sched-shift-end-date');
        if (schedShiftStartDate) schedShiftStartDate.addEventListener('change', () => this.onSchedShiftDatesChange());
        if (schedShiftEndDate) schedShiftEndDate.addEventListener('change', () => this.onSchedShiftDatesChange());

        const schedShiftDefaultStart = document.getElementById('sched-shift-default-start');
        const schedShiftDefaultEnd = document.getElementById('sched-shift-default-end');
        if (schedShiftDefaultStart) schedShiftDefaultStart.addEventListener('change', () => this.onSchedShiftDefaultTimeChange());
        if (schedShiftDefaultEnd) schedShiftDefaultEnd.addEventListener('change', () => this.onSchedShiftDefaultTimeChange());

        const supervisorShiftEmployeeFilter = document.getElementById('supervisor-shifts-filter-employee');
        if (supervisorShiftEmployeeFilter) {
            supervisorShiftEmployeeFilter.addEventListener('change', () => {
                this.supervisorShiftFilters.employeeId = supervisorShiftEmployeeFilter.value || '';
                this.applySupervisorShiftFilters();
            });
        }

        const supervisorShiftRestaurantFilter = document.getElementById('supervisor-shifts-filter-restaurant');
        if (supervisorShiftRestaurantFilter) {
            supervisorShiftRestaurantFilter.addEventListener('change', () => {
                this.supervisorShiftFilters.restaurantId = supervisorShiftRestaurantFilter.value || '';
                this.applySupervisorShiftFilters();
            });
        }

        const supervisorShiftSearchFilter = document.getElementById('supervisor-shifts-filter-search');
        if (supervisorShiftSearchFilter) {
            supervisorShiftSearchFilter.addEventListener('input', () => {
                this.supervisorShiftFilters.search = supervisorShiftSearchFilter.value || '';
                this.applySupervisorShiftFilters();
            });
        }

        const supervisionRestaurantSelect = document.getElementById('supervision-restaurant-select');
        if (supervisionRestaurantSelect) {
            supervisionRestaurantSelect.addEventListener('change', () => {
                this.clearSupervisionRegisterRetryState();
                this.updateSupervisorSupervisionLocationLabel();
            });
        }

        const supervisionAreaSelect = document.getElementById('supervision-area-select');
        if (supervisionAreaSelect) {
            supervisionAreaSelect.addEventListener('change', () => {
                this.setSupervisorSelectedArea(supervisionAreaSelect.value);
            });
        }

        const supervisionPhotoInput = document.getElementById('supervision-photo-input');
        if (supervisionPhotoInput) {
            supervisionPhotoInput.addEventListener('change', (event) => {
                this.handleSupervisionPhotoUpload(event);
            });
        }

        const supervisionObservations = document.getElementById('supervision-observations');
        if (supervisionObservations) {
            supervisionObservations.addEventListener('input', () => {
                this.clearSupervisionRegisterRetryState();
            });
        }

        const supervisorRestaurantTaskRestaurant = document.getElementById('supervisor-restaurant-task-restaurant');
        if (supervisorRestaurantTaskRestaurant) {
            supervisorRestaurantTaskRestaurant.addEventListener('change', () => {
                this.updateSupervisorRestaurantTaskContextCopy();
            });
        }

        document.querySelectorAll('.modal').forEach((modal) => {
            modal.addEventListener('click', (event) => {
                if (event.target === modal && modal.dataset.locked !== 'true') {
                    this.closeModal(modal.id);
                }
            });
        });

        const adminSupervisorForm = document.getElementById('admin-supervisor-form');
        if (adminSupervisorForm) {
            adminSupervisorForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.submitAdminSupervisorForm();
            });
        }

        const adminSupervisorFiltersForm = document.getElementById('admin-supervisor-filters-form');
        if (adminSupervisorFiltersForm) {
            adminSupervisorFiltersForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                await this.loadAdminSupervisors(true);
            });
        }

        document.addEventListener('click', (event) => {
            void this.handleDelegatedClick(event);
        });

        document.addEventListener('change', (event) => {
            this.handleDelegatedChange(event);
        });

        document.addEventListener('input', (event) => {
            this.handleDelegatedInput(event);
        });

    },

    async handleDelegatedClick(event) {
        const source = event.target instanceof Element ? event.target.closest('[data-action]') : null;
        if (!source) {
            return;
        }

        const action = String(source.dataset.action || '').trim();
        if (!action) {
            return;
        }

        switch (action) {
            case 'toggle-employee-area': {
                const areaLabel = String(source.dataset.areaLabel || '');
                if (!areaLabel) {
                    return;
                }
                event.preventDefault();
                this.toggleEmployeeAreaSelection(areaLabel);
                return;
            }
            case 'set-employee-active-area': {
                const areaLabel = String(source.dataset.areaLabel || '');
                if (!areaLabel) {
                    return;
                }
                event.preventDefault();
                this.setEmployeeActiveArea(areaLabel);
                return;
            }
            case 'select-photo-area': {
                const slotKey = String(source.dataset.slotKey || '').trim();
                const photoType = String(source.dataset.photoType || 'start').trim() || 'start';
                if (!slotKey) {
                    return;
                }

                const slot = this.getPhotoSlotDefinition(slotKey, photoType);
                if (!slot) {
                    return;
                }

                event.preventDefault();
                await this.selectPhotoArea(slot, photoType);
                return;
            }
            case 'shift-plan-remove': {
                const rowId = String(source.dataset.rowId || '').trim();
                if (!rowId) {
                    return;
                }
                event.preventDefault();
                this.removeSupervisorShiftPlanRow(rowId);
                return;
            }
            case 'shift-plan-add':
                event.preventDefault();
                this.addSupervisorShiftPlanRow();
                return;
            case 'shift-week-clear': {
                const rowId = String(source.dataset.rowId || '').trim();
                if (!rowId) {
                    return;
                }
                event.preventDefault();
                this.clearSupervisorShiftPlanWeekRow(rowId);
                return;
            }
            case 'shift-week-replicate':
                event.preventDefault();
                this.replicateSupervisorShiftTemplate();
                return;
            case 'shift-week-import':
                event.preventDefault();
                this.openSupervisorShiftPlanExcelPicker();
                return;
            case 'select-admin-restaurant-search-result': {
                const index = Number(source.dataset.resultIndex);
                if (!Number.isFinite(index)) {
                    return;
                }
                event.preventDefault();
                this.selectAdminRestaurantSearchResult(index);
                return;
            }
            case 'confirm-deactivate-user': {
                const userId = String(source.dataset.userId || '').trim();
                if (!userId) {
                    return;
                }
                event.preventDefault();
                this.confirmDeactivateUser(userId);
                return;
            }
            case 'clear-phone-user': {
                const userId = String(source.dataset.userId || '').trim();
                if (!userId) {
                    return;
                }
                event.preventDefault();
                void this.handleClearPhoneUser(userId);
                return;
            }
            case 'confirm-cancel-scheduled-shift': {
                const shiftId = String(source.dataset.shiftId || '').trim();
                if (!shiftId) {
                    return;
                }
                event.preventDefault();
                this.confirmCancelScheduledShift(shiftId);
                return;
            }
            case 'confirm-deactivate-restaurant': {
                const restaurantId = String(source.dataset.restaurantId || '').trim();
                if (!restaurantId) {
                    return;
                }
                event.preventDefault();
                this.confirmDeactivateRestaurant(restaurantId);
                return;
            }
            case 'open-restaurant-special-task': {
                const restaurantId = String(source.dataset.restaurantId || '').trim();
                event.preventDefault();
                await this.openSupervisorRestaurantTaskModal(restaurantId, 'restaurants');
                return;
            }
            case 'admin-unassign-restaurant': {
                const supervisorId = String(source.dataset.supervisorId || '').trim();
                const restaurantId = String(source.dataset.restaurantId || '').trim();
                if (!supervisorId || !restaurantId) {
                    return;
                }
                event.preventDefault();
                void this.unassignRestaurantFromSupervisor(supervisorId, restaurantId);
                return;
            }
            case 'admin-assign-restaurant': {
                const supervisorId = String(source.dataset.supervisorId || '').trim();
                if (!supervisorId) {
                    return;
                }
                event.preventDefault();
                void this.assignRestaurantToSupervisor(supervisorId);
                return;
            }
            case 'admin-edit-supervisor': {
                const supervisorId = String(source.dataset.supervisorId || '').trim();
                if (!supervisorId) {
                    return;
                }
                event.preventDefault();
                this.beginEditAdminSupervisor(supervisorId);
                return;
            }
            case 'clear-phone-supervisor': {
                const supervisorId = String(source.dataset.supervisorId || '').trim();
                if (!supervisorId) {
                    return;
                }
                event.preventDefault();
                void this.handleClearPhoneSupervisor(supervisorId);
                return;
            }
            case 'admin-toggle-supervisor-status': {
                const supervisorId = String(source.dataset.supervisorId || '').trim();
                const currentlyActive = String(source.dataset.currentlyActive || '').trim().toLowerCase() === 'true';
                if (!supervisorId) {
                    return;
                }
                event.preventDefault();
                void this.toggleAdminSupervisorStatus(supervisorId, currentlyActive);
                return;
            }
            default:
                return;
        }
    },

    handleDelegatedChange(event) {
        const source = event.target instanceof Element ? event.target.closest('[data-action]') : null;
        if (!source) {
            return;
        }

        const action = String(source.dataset.action || '').trim();
        if (!action) {
            return;
        }

        switch (action) {
            case 'shift-batch-toggle': {
                const employeeId = String(source.dataset.employeeId || '').trim();
                if (!employeeId) {
                    return;
                }
                this.toggleSupervisorBatchEmployee(employeeId, { rerender: false });
                source.closest('.shift-batch-option')?.classList.toggle('active', source.checked === true);
                return;
            }
            case 'shift-plan-field': {
                const rowId = String(source.dataset.rowId || '').trim();
                const field = String(source.dataset.field || '').trim();
                if (!rowId || !field) {
                    return;
                }
                this.updateSupervisorShiftPlanRow(rowId, field, source.value || '');
                return;
            }
            case 'shift-week-field': {
                const rowId = String(source.dataset.rowId || '').trim();
                const field = String(source.dataset.field || '').trim();
                if (!rowId || !field) {
                    return;
                }

                const value = field === 'enabled'
                    ? source.checked === true
                    : source.value || '';
                this.updateSupervisorShiftPlanWeekRow(rowId, field, value);
                return;
            }
            default:
                return;
        }
    },

    handleDelegatedInput(event) {
        const source = event.target instanceof Element ? event.target.closest('[data-action]') : null;
        if (!source) {
            return;
        }

        const action = String(source.dataset.action || '').trim();
        if (!['shift-plan-field', 'shift-week-field'].includes(action)) {
            return;
        }

        const rowId = String(source.dataset.rowId || '').trim();
        const field = String(source.dataset.field || '').trim();
        if (!rowId || !field) {
            return;
        }

        if (action === 'shift-plan-field') {
            this.updateSupervisorShiftPlanRow(rowId, field, source.value || '');
            return;
        }

        this.updateSupervisorShiftPlanWeekRow(rowId, field, source.value || '');
    },

    async restoreAuthSession() {
        if (!this.supabase) {
            return false;
        }

        try {
            const { data } = await this.supabase.auth.getSession();
            if (!data.session) {
                this.session = null;
                apiClient.setAccessToken('');
                apiClient.setCurrentRole('');
                return false;
            }

            console.info('Se encontró una sesión persistida. Restaurando acceso.', buildJwtDebugSummary(data.session.access_token || ''));
            this.session = data.session;
            apiClient.setAccessToken(data.session.access_token || '');
            await this.bootstrapAuthenticatedUser({ silent: true, session: data.session, restoredSession: true });
            return true;
        } catch (error) {
            console.warn('No fue posible restaurar la sesión existente.', error);
            return false;
        }
    },

    async getValidAccessToken({ forceRefresh = false, session: incomingSession = null } = {}) {
        if (!this.supabase) {
            return '';
        }

        let session = incomingSession || this.session || null;

        if (!session) {
            const sessionResult = await this.supabase.auth.getSession();
            session = sessionResult.data.session || null;
        }

        if (!session) {
            this.session = null;
            apiClient.setAccessToken('');
            apiClient.setCurrentRole('');
            return '';
        }

        if (forceRefresh || (session?.expires_at && session.expires_at * 1000 < Date.now() + 60_000)) {
            if (!session?.refresh_token) {
                console.warn('Se omitió refreshSession porque la sesión actual no expone refresh_token. Se reutiliza access_token vigente.');
            } else {
                if (!this.tokenRefreshPromise) {
                    this.tokenRefreshPromise = (async () => {
                        try {
                            const refreshResult = await this.supabase.auth.refreshSession();
                            return refreshResult.data.session || null;
                        } catch (error) {
                            console.warn('Falló refreshSession. Se mantiene access_token actual.', error);
                            return null;
                        }
                    })();
                }

                try {
                    const refreshedSession = await this.tokenRefreshPromise;
                    if (refreshedSession?.access_token) {
                        session = refreshedSession;
                    }
                } finally {
                    this.tokenRefreshPromise = null;
                }
            }
        }

        if (!session?.access_token) {
            this.session = null;
            apiClient.setAccessToken('');
            apiClient.setCurrentRole('');
            return '';
        }

        this.session = session;
        apiClient.setAccessToken(session.access_token);
        return session.access_token;
    },

    async checkBackendConnection() {
        if (!this.backend.configured) {
            this.updateDebugInfo();
            return;
        }

        this.backend.statusText = 'Conectando...';
        this.updateDebugInfo();

        try {
            this.backend.health = await apiClient.healthPing();
            this.backend.connected = true;
            this.backend.lastError = null;
            this.backend.statusText = 'Conectado';
        } catch (error) {
            this.backend.connected = false;
            this.backend.health = null;
            this.backend.lastError = error;
            this.backend.statusText = 'Error';
            console.warn('No fue posible validar /health_ping.', error);
        }

        this.updateDebugInfo();
    },

    showLoading(title = 'Procesando...', message = 'Un momento por favor.') {
        const overlay = document.getElementById('loading-overlay');
        const titleElement = document.getElementById('loading-title');
        const messageElement = document.getElementById('loading-message');

        this.loadingState = {
            visible: true,
            title,
            message
        };

        if (titleElement) {
            titleElement.textContent = title;
        }

        if (messageElement) {
            messageElement.textContent = message;
        }

        overlay?.classList.remove('hidden');
    },

    hideLoading() {
        this.loadingState = {
            ...this.loadingState,
            visible: false
        };
        document.getElementById('loading-overlay')?.classList.add('hidden');
    },

    suspendLoadingOverlay() {
        const snapshot = { ...this.loadingState };
        if (snapshot.visible) {
            this.hideLoading();
        }
        return snapshot;
    },

    restoreLoadingOverlay(snapshot) {
        if (snapshot?.visible) {
            this.showLoading(snapshot.title, snapshot.message);
        }
    },

    async openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) {
            return;
        }

        if (modalId === 'modal-supervisor-schedule-shift') {
            await this.prepareSupervisorShiftModal();
        }

        if (modalId === 'modal-admin-restaurant') {
            this.prepareAdminRestaurantModal();
        }

        if (modalId === 'modal-admin-employee') {
            this.prepareAdminEmployeeModal();
        }

        if (modalId === 'modal-supervisor-restaurant-task') {
            await this.prepareSupervisorRestaurantTaskModal();
        }

        modal.classList.add('active');
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) {
            modalContent.scrollTop = 0;
            modalContent.scrollLeft = 0;
        }
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) {
            modalBody.scrollTop = 0;
            modalBody.scrollLeft = 0;
        }

        if (modalId === 'modal-supervisor-schedule-shift') {
            window.requestAnimationFrame(() => {
                this.resetSupervisorShiftModalScroll({ mode: this.supervisorShiftMode, forceTop: true });
            });
        }

        if (modalId === 'modal-admin-restaurant') {
            await this.ensureAdminRestaurantMapReady();
        }
    },

    closeModal(modalId) {
        if (modalId === 'modal-admin-restaurant' && this.restaurantGeocodeAbortController) {
            this.restaurantGeocodeAbortController.abort();
            this.restaurantGeocodeAbortController = null;
        }

        document.getElementById(modalId)?.classList.remove('active');
    },

    setLoginError(message = '') {
        const errorDiv = document.getElementById('login-error');
        if (!errorDiv) {
            return;
        }

        errorDiv.textContent = message;
        errorDiv.classList.toggle('hidden', !message);
    },

    setLoginNotice(message = '') {
        const noticeDiv = document.getElementById('login-notice');
        if (!noticeDiv) {
            return;
        }

        noticeDiv.textContent = message;
        noticeDiv.classList.toggle('hidden', !message);
    },

    showToast(message, {
        tone = 'info',
        title = '',
        duration,
        keepLoginMessages = false,
        action = null
    } = {}) {
        const toastStack = document.getElementById('app-toast-stack');
        if (!toastStack || !message) {
            return;
        }

        if (!keepLoginMessages) {
            this.setLoginError('');
            this.setLoginNotice('');
        }

        const normalizedTone = ['success', 'error', 'warning', 'info'].includes(tone) ? tone : 'info';
        const iconMap = {
            success: 'fa-circle-check',
            error: 'fa-circle-xmark',
            warning: 'fa-triangle-exclamation',
            info: 'fa-circle-info'
        };
        const toastId = `toast-${++this.toastCounter}`;
        const hasAction = typeof action?.onClick === 'function' && String(action?.label || '').trim().length > 0;
        const timeoutMs = Number.isFinite(duration)
            ? duration
            : ({
                success: 4200,
                info: 5000,
                warning: 5600,
                error: 6800
            }[normalizedTone] || 5000);

        const toast = document.createElement('div');
        toast.className = `app-toast app-toast-${normalizedTone}`;
        toast.dataset.toastId = toastId;
        toast.innerHTML = `
            <div class="app-toast-icon" aria-hidden="true">
                <i class="fas ${iconMap[normalizedTone]}"></i>
            </div>
            <div class="app-toast-body">
                ${title ? `<div class="app-toast-title">${escapeHtml(title)}</div>` : ''}
                <div class="app-toast-message">${escapeHtml(message)}</div>
                ${hasAction ? `<button type="button" class="app-toast-action">${escapeHtml(String(action.label).trim())}</button>` : ''}
            </div>
            <button type="button" class="app-toast-close" aria-label="Cerrar aviso">
                <i class="fas fa-times"></i>
            </button>
        `;

        toast.querySelector('.app-toast-close')?.addEventListener('click', () => {
            this.dismissToast(toastId);
        });

        if (hasAction) {
            toast.querySelector('.app-toast-action')?.addEventListener('click', async () => {
                try {
                    await action.onClick();
                } catch (actionError) {
                    console.warn('No fue posible ejecutar la acción del aviso.', actionError);
                }

                if (action?.dismissOnClick) {
                    this.dismissToast(toastId);
                }
            });
        }

        toastStack.appendChild(toast);

        const timerId = window.setTimeout(() => {
            this.dismissToast(toastId);
        }, timeoutMs);

        this.toastTimers.set(toastId, timerId);
    },

    dismissToast(toastId) {
        const toast = document.querySelector(`[data-toast-id="${toastId}"]`);
        if (!toast) {
            return;
        }

        const timerId = this.toastTimers.get(toastId);
        if (timerId) {
            window.clearTimeout(timerId);
            this.toastTimers.delete(toastId);
        }

        toast.classList.add('app-toast-leaving');
        window.setTimeout(() => {
            toast.remove();
        }, 180);
    },

    async copyTextToClipboard(text = '') {
        const payload = String(text || '').trim();
        if (!payload) {
            return false;
        }

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
                return true;
            }

            const tempInput = document.createElement('textarea');
            tempInput.value = payload;
            tempInput.setAttribute('readonly', 'readonly');
            tempInput.style.position = 'fixed';
            tempInput.style.opacity = '0';
            document.body.appendChild(tempInput);
            tempInput.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(tempInput);
            return Boolean(copied);
        } catch (error) {
            console.warn('No fue posible copiar al portapapeles.', error);
            return false;
        }
    },

    extractRequestId(...sources) {
        const candidates = [];

        sources.forEach((source) => {
            if (!source) {
                return;
            }

            if (typeof source === 'string') {
                candidates.push(source);
                return;
            }

            candidates.push(
                source?.requestId,
                source?.request_id,
                source?.payload?.request_id,
                source?.error?.request_id,
                source?.payload?.error?.request_id,
                source?.lastResponseMeta?.requestId
            );
        });

        for (const candidate of candidates) {
            const normalized = String(candidate || '').trim();
            if (normalized) {
                return normalized;
            }
        }

        return '';
    },

    getErrorMessage(error, fallback = 'Ocurrió un error inesperado.') {
        if (!error) {
            return fallback;
        }

        const status = Number(error?.status);
        const payloadMessage = String(error?.payload?.error?.message || error?.payload?.message || '').trim();
        const rawMessage = String(error?.message || payloadMessage || fallback).trim();
        const normalizedMessage = rawMessage.toLowerCase();

        const trustedDeviceConflict = status === 409
            && (normalizedMessage.includes('dispositivo')
                || normalizedMessage.includes('device')
                || normalizedMessage.includes('vinculad')
                || normalizedMessage.includes('linked')
                || normalizedMessage.includes('trusted'));

        if (trustedDeviceConflict) {
            return 'Esta cuenta ya está vinculada a otro dispositivo. Revoca el dispositivo actual para poder registrar este equipo.';
        }

        if (normalizedMessage.includes('rate limit') || status === 429) {
            return 'Se detectaron demasiados intentos en poco tiempo. Espera unos segundos y vuelve a intentarlo.';
        }

        if (normalizedMessage.includes('invalid jwt') || normalizedMessage.includes('jwt') || status === 401) {
            return 'Tu sesión ya no es válida o expiró. Inicia sesión nuevamente.';
        }

        if (normalizedMessage.includes('timeout') || normalizedMessage.includes('tiempo de espera')) {
            return 'La operación tardó demasiado. Verifica tu conexión e inténtalo de nuevo.';
        }

        if (normalizedMessage.includes('network_error') || normalizedMessage.includes('no fue posible contactar')) {
            return 'No se pudo conectar con el servicio. Verifica tu conexión e inténtalo de nuevo.';
        }

        if (status === 403) {
            return 'No tienes permisos para realizar esta acción.';
        }

        if (status === 404) {
            return 'No encontramos el registro solicitado. Puede que ya no exista.';
        }

        if (status === 409) {
            return 'No se pudo completar la operación por una regla de negocio o conflicto de datos.';
        }

        if (status === 422) {
            return 'Los datos enviados no son válidos. Revisa la información e inténtalo de nuevo.';
        }

        if (status >= 500) {
            return 'Ocurrió un problema interno del servicio. Inténtalo de nuevo en unos minutos.';
        }

        const looksTechnical = /endpoint|request_id|payload|stack|trace|\/|http|https|\bcode\b|\bstatus\b/i.test(rawMessage)
            || rawMessage.length > 220;

        if (looksTechnical) {
            return fallback;
        }

        return rawMessage || fallback;
    },

    getShiftFinalizeDetailedErrorMessage(error) {
        if (!error) {
            return '';
        }

        const status = Number(error?.status || 0);
        const rawCandidates = [
            error?.payload?.error?.details?.message,
            error?.payload?.details?.message,
            error?.payload?.error?.message,
            error?.payload?.message,
            error?.message
        ]
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        const genericMessages = new Set([
            'los datos enviados no son válidos.',
            'los datos enviados no son validos.',
            'invalid request body',
            'validation error'
        ]);

        const detailedMessage = rawCandidates.find((message) => !genericMessages.has(message.toLowerCase())) || '';
        const requestId = String(
            error?.requestId
            || error?.payload?.request_id
            || error?.payload?.error?.request_id
            || ''
        ).trim();

        if (status === 422 && detailedMessage) {
            return requestId ? `${detailedMessage} (request_id: ${requestId})` : detailedMessage;
        }

        if (status === 422 && requestId) {
            return `El backend rechazó el cierre del turno. request_id: ${requestId}`;
        }

        return '';
    },

    isEarlyEndReasonRequiredError(error) {
        if (!error) {
            return false;
        }

        const status = Number(error?.status || 0);
        if (status !== 422) {
            return false;
        }

        const message = String(
            error?.payload?.error?.details?.message
            || error?.payload?.details?.message
            || error?.payload?.error?.message
            || error?.payload?.message
            || error?.message
            || ''
        ).toLowerCase();

        return message.includes('salida anticipada') && message.includes('motivo');
    },

    isEmployeeUnavailableInSchedule(error) {
        const explicitCodes = [
            error?.code,
            error?.payload?.error?.code,
            error?.payload?.code,
            error?.payload?.error?.details?.code,
            error?.payload?.details?.code,
            error?.payload?.diagnostic_code,
            error?.payload?.error?.diagnostic_code
        ]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase());

        const hasExplicitEmployeeAvailabilityCode = explicitCodes.some((code) => (
            code.includes('employee_not_available')
            || code.includes('employee_unavailable')
            || code.includes('employee_schedule_conflict')
            || code.includes('shift_overlap')
            || code.includes('employee_shift_overlap')
        ));

        if (hasExplicitEmployeeAvailabilityCode) {
            return true;
        }

        const source = [
            error?.message,
            error?.payload?.error?.message,
            error?.payload?.message,
            error?.payload?.error?.details?.message,
            error?.payload?.details?.message,
            error?.code,
            error?.payload?.error?.code,
            error?.payload?.code
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        if (!source) {
            return false;
        }

        const hasEmployeeReference = [
            'empleado',
            'employee',
            'assigned_employee',
            'asignado'
        ].some((token) => source.includes(token));

        const hasAvailabilityConflictReference = [
            'no disponible',
            'not available',
            'ocupado',
            'occupied',
            'overlap',
            'schedule conflict',
            'conflicto de horario',
            'ya tiene un turno programado',
            'tiene un turno programado',
            'turno programado en ese rango',
            'already assigned',
            'already has a scheduled shift',
            'employee not available'
        ].some((token) => source.includes(token));

        return hasEmployeeReference && hasAvailabilityConflictReference;
    },

    isShiftStartOutsideWindow(error) {
        const explicitCodes = [
            error?.error_code,
            error?.payload?.error?.error_code,
            error?.payload?.error_code,
            error?.payload?.error?.details?.error_code,
            error?.payload?.details?.error_code,
            error?.payload?.error?.code,
            error?.payload?.code,
            error?.code
        ]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase());

        if (explicitCodes.some((code) => code.includes('shift_start_outside_window'))) {
            return true;
        }

        const source = [
            error?.message,
            error?.payload?.error?.message,
            error?.payload?.message,
            error?.payload?.error?.details?.message,
            error?.payload?.details?.message
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        return source.includes('fuera de la ventana permitida para iniciar el turno');
    },

    getShiftStartWindowErrorDetails(error) {
        const details = error?.payload?.error?.details || error?.payload?.details || {};
        const earliest = String(details?.earliest || '').trim();
        const latest = String(details?.latest || '').trim();
        return { earliest, latest };
    },

    getShiftStartWindowOutsideMessage(error) {
        const { earliest, latest } = this.getShiftStartWindowErrorDetails(error);
        if (!earliest || !latest) {
            return 'El turno está fuera de la ventana permitida para iniciar.';
        }

        const earliestLabel = formatDateTime(earliest);
        const latestLabel = formatDateTime(latest);
        if (earliestLabel === '-' || latestLabel === '-') {
            return 'El turno está fuera de la ventana permitida para iniciar.';
        }

        return `Puedes iniciar este turno entre ${earliestLabel} y ${latestLabel}.`;
    },

    isOutsideAllowedShiftArea(error) {
        const source = [
            error?.message,
            error?.payload?.error?.message,
            error?.payload?.message,
            error?.payload?.error?.details?.message,
            error?.payload?.details?.message,
            error?.payload?.error?.details?.code,
            error?.payload?.details?.code,
            error?.code,
            error?.payload?.error?.code,
            error?.payload?.code
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        if (!source) {
            return false;
        }

        return [
            'geofence',
            'geo_fence',
            'out_of_bounds',
            'outside radius',
            'outside_allowed_area',
            'outside_assigned_area',
            'outside allowed area',
            'outside assigned area',
            'outside geofence',
            'radius exceeded',
            'distance to restaurant',
            'radio permitido',
            'fuera del radio',
            'fuera del radio permitido',
            'fuera de la zona',
            'fuera de la zona permitida',
            'fuera del area',
            'fuera del área',
            'fuera del area permitida',
            'fuera del área permitida',
            'fuera del area asignada',
            'fuera del área asignada',
            'ubicacion invalida',
            'ubicación inválida',
            'ubicacion fuera de rango',
            'ubicación fuera de rango',
            'location mismatch'
        ].some((token) => source.includes(token));
    },

    async handleLogin() {
        if (!this.supabase) {
            this.setLoginError('Supabase no está configurado correctamente.');
            return;
        }

        const email = document.getElementById('login-email').value.trim();
        const passwordInput = document.getElementById('login-password');
        const password = passwordInput.value.trim();
        const consent = document.getElementById('login-consent').checked;

        this.setLoginError('');
        this.setLoginNotice('');

        if (!consent) {
            this.setLoginError('Debe aceptar el consentimiento informado.');
            return;
        }

        if (!/^\d{6}$/.test(password)) {
            this.setLoginError('El PIN debe tener exactamente 6 dígitos numéricos.');
            passwordInput.focus();
            return;
        }

        this.showLoading('Iniciando sesión...', 'Espera un momento.');

        try {
            try {
                await this.supabase.auth.signOut({ scope: 'local' });
            } catch (cleanupError) {
                console.warn('No fue posible limpiar la sesión local previa antes del nuevo login.', cleanupError);
            }

            this.session = null;
            this.currentUser = null;
            this.otpChallengeState = null;
            apiClient.clearSession();
            localStorage.removeItem(STORAGE_KEYS.user);
            localStorage.removeItem(STORAGE_KEYS.shiftOtpExpiresAt);

            const result = await this.supabase.auth.signInWithPassword({ email, password });

            if (result.error) {
                throw result.error;
            }

            this.session = result.data.session || null;
            apiClient.setAccessToken(this.session?.access_token || '');
            console.info('Login con sesión fresca.', buildJwtDebugSummary(this.session?.access_token || ''));
            await this.bootstrapAuthenticatedUser({ session: this.session });
        } catch (error) {
            this.setLoginError(this.getErrorMessage(error, 'No fue posible iniciar sesión.'));
        } finally {
            this.hideLoading();
        }
    },

    async loadRoleModule(role) {
        if (this._roleModuleLoaded) return;
        try {
            const route = ROLE_ROUTES[role] || '';
            if (route.startsWith('employee')) {
                const { employeeMethods } = await import('./modules/employee.js');
                Object.assign(this, employeeMethods);
            } else if (route.startsWith('supervisor')) {
                const { supervisorMethods } = await import('./modules/supervisor.js');
                Object.assign(this, supervisorMethods);
            } else if (route.startsWith('admin')) {
                const [{ adminMethods }, { adminModalMethods }] = await Promise.all([
                    import('./modules/admin.js'),
                    import('./modules/adminModals.js')
                ]);
                Object.assign(this, adminMethods, adminModalMethods);
            }
            this._roleModuleLoaded = true;
        } catch (error) {
            console.error('No fue posible cargar el módulo del rol.', error);
            throw error;
        }
    },

    async bootstrapAuthenticatedUser({ silent = false, session: incomingSession = null, restoredSession = false } = {}) {
        if (this.authBootstrapPromise) {
            return this.authBootstrapPromise;
        }

        this.authBootstrapPromise = (async () => {
            if (!silent) {
                this.showLoading('Iniciando sesión...', 'Espera un momento.');
            }

            try {
                if (incomingSession) {
                    this.session = incomingSession;
                    apiClient.setAccessToken(incomingSession.access_token || '');
                }

                const accessToken = await this.getValidAccessToken({ session: incomingSession });
                if (!accessToken) {
                    throw new Error('No hay una sesión válida para continuar.');
                }

                const me = await apiClient.getCurrentUserProfile();
                this.currentUser = this.normalizeCurrentUser(me);
                apiClient.setCurrentRole(this.currentUser?.role || '');
                localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(this.currentUser));

                await this.loadRoleModule(this.currentUser?.role || '');

                if (this.currentUser.isActive === false) {
                    throw new Error('Tu usuario está inactivo. Contacta al administrador.');
                }

                if (this.currentUser.must_change_pin) {
                    if (!silent) {
                        this.hideLoading();
                    }

                    await this.ensurePinChangeIfRequired();

                    if (!silent) {
                        this.showLoading('Iniciando sesión...', 'Espera un momento.');
                    }
                }

                if (!restoredSession) {
                    await this.ensureLegalConsent();
                    await this.ensureTrustedDevice();
                    await this.ensureOtpVerification({ purpose: 'login' });
                }

                if (this.isAdminRole()) {
                    void this.loadSystemSettingsIfAvailable().catch((settingsError) => {
                        console.warn('No fue posible precargar los ajustes globales para admin.', settingsError);
                    });
                }

                if (ROLE_ROUTES[this.currentUser.role]?.startsWith('employee')) {
                    if (!restoredSession) {
                        try {
                            await this.requestLocationPermissionOnly();
                        } catch (locationError) {
                            console.warn('No fue posible obtener el permiso de ubicación durante el login.', locationError);
                            this.showToast('Activa la ubicación para ver tu posición actual y poder iniciar turnos sin fricción.', {
                                tone: 'warning',
                                title: 'Permiso de ubicación recomendado'
                            });
                        }
                    }

                    void this.primeEmployeeWorkspacePermissions();
                }

                this.updateUserUI();
                this.navigateToRoleDashboard();
            } catch (error) {
                if (error?.code === 'PIN_CHANGE_RELOGIN_REQUIRED') {
                    await this.performLogout({ silent: true, scope: 'local' });
                    this.setLoginNotice(error.message || 'PIN actualizado. Inicia sesión nuevamente con tu nuevo PIN.');
                    return;
                }

                console.error('Bootstrap autenticado falló.', error);
                if (!silent) {
                    this.setLoginError(this.getErrorMessage(error, 'No fue posible completar la configuración inicial.'));
                } else {
                    this.showToast(this.getErrorMessage(error, 'No fue posible completar la configuración inicial.'), {
                        tone: 'error',
                        title: 'No fue posible continuar'
                    });
                }
                await this.performLogout({ silent: true });
                throw error;
            } finally {
                if (!silent) {
                    this.hideLoading();
                }
            }
        })();

        try {
            return await this.authBootstrapPromise;
        } finally {
            this.authBootstrapPromise = null;
        }
    },

    normalizeCurrentUser(me) {
        const role = this.normalizeRoleToken(me?.role || me?.app_metadata?.role || 'empleado');
        const fullName = me?.full_name || [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || 'Usuario';

        return {
            id: me?.id || this.session?.user?.id || null,
            email: me?.email || this.session?.user?.email || '',
            role,
            full_name: fullName,
            phone_e164: me?.phone_e164 || me?.phone_number || '',
            isActive: me?.is_active ?? true,
            must_change_pin: me?.must_change_pin === true,
            pin_updated_at: me?.pin_updated_at || null
        };
    },

    normalizeRoleToken(role = '') {
        const normalized = String(role || '')
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_');

        if (normalized === 'superuser') {
            return 'super_admin';
        }

        return normalized;
    },

    isTrustedDeviceValidationExemptRole(role = this.currentUser?.role) {
        return this.normalizeRoleToken(role) === 'super_admin';
    },

    isShiftOtpExemptRole(role = this.currentUser?.role) {
        return this.normalizeRoleToken(role) === 'super_admin';
    },

    async ensurePinChangeIfRequired() {
        if (!this.currentUser?.must_change_pin) {
            return;
        }

        const modal = document.getElementById('modal-pin-change');
        const form = document.getElementById('change-pin-form');
        const errorBox = document.getElementById('change-pin-error');
        const helper = document.getElementById('change-pin-helper');
        const submitButton = document.getElementById('change-pin-submit-btn');

        if (!modal || !form) {
            throw new Error('La interfaz de cambio de PIN no está disponible.');
        }

        form?.reset();

        if (errorBox) {
            errorBox.textContent = '';
            errorBox.classList.add('hidden');
        }

        if (helper) {
            helper.textContent = 'Por seguridad, debe cambiar su contraseña temporal en el primer ingreso.';
        }

        if (submitButton) {
            submitButton.disabled = false;
        }

        modal.classList.add('active');

        await new Promise((resolve, reject) => {
            this.pinChangeGate = { resolve, reject };
        });
    },

    async submitChangePinForm() {
        if (this.pinChangeSubmitPromise) {
            return this.pinChangeSubmitPromise;
        }

        const newPinInput = document.getElementById('change-pin-new');
        const confirmPinInput = document.getElementById('change-pin-confirm');
        const submitButton = document.getElementById('change-pin-submit-btn');
        const errorBox = document.getElementById('change-pin-error');
        const newPin = newPinInput?.value?.trim() || '';
        const confirmPin = confirmPinInput?.value?.trim() || '';
        let accessToken = '';

        const setError = (message) => {
            if (!errorBox) {
                return;
            }

            errorBox.textContent = message;
            errorBox.classList.toggle('hidden', !message);
        };

        setError('');

        if (!/^\d{4,12}$/.test(newPin)) {
            setError('El nuevo PIN debe contener solo números y tener entre 4 y 12 dígitos.');
            newPinInput?.focus();
            return;
        }

        if (newPin !== confirmPin) {
            setError('La confirmación del PIN no coincide.');
            confirmPinInput?.focus();
            return;
        }

        this.showLoading('Cambiando contraseña', 'Espera');
        if (submitButton) {
            submitButton.disabled = true;
        }

        this.pinChangeSubmitPromise = (async () => {
            try {
                accessToken = await this.getValidAccessToken();
                const jwtSummary = buildJwtDebugSummary(accessToken);
                window.__worktracePinChangeDebug = {
                    email: this.currentUser?.email || '',
                    timestamp: new Date().toISOString(),
                    jwt: jwtSummary,
                    request_id: null,
                    auth_user_probe: null
                };
                console.info('Preparando change_my_pin con JWT validado.', jwtSummary);

                await apiClient.changeMyPin(newPin, {
                    accessToken,
                    retryOnInvalidJwt: false
                });

                apiClient.setAccessToken(accessToken);
                if (window.__worktracePinChangeDebug) {
                    window.__worktracePinChangeDebug.jwt_after_change = buildJwtDebugSummary(accessToken);
                }

                this.currentUser = {
                    ...this.currentUser,
                    must_change_pin: false,
                    pin_updated_at: new Date().toISOString()
                };
                localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(this.currentUser));
                setError('');
                document.getElementById('modal-pin-change')?.classList.remove('active');

                const gate = this.pinChangeGate;
                this.pinChangeGate = null;
                this.pinChangeSubmitPromise = null;

                const reloginRequiredError = new Error('PIN actualizado. Inicia sesión nuevamente con tu nuevo PIN.');
                reloginRequiredError.code = 'PIN_CHANGE_RELOGIN_REQUIRED';

                if (gate?.reject) {
                    gate.reject(reloginRequiredError);
                }
            } catch (error) {
                const requestId = error?.requestId || error?.payload?.request_id || null;
                if (window.__worktracePinChangeDebug) {
                    window.__worktracePinChangeDebug.request_id = requestId;
                }

                if (error?.status === 401 && accessToken) {
                    try {
                        const authProbe = await apiClient.probeSupabaseAuthUser(accessToken);
                        if (window.__worktracePinChangeDebug) {
                            window.__worktracePinChangeDebug.auth_user_probe = authProbe;
                        }
                    } catch (probeError) {
                        if (window.__worktracePinChangeDebug) {
                            window.__worktracePinChangeDebug.auth_user_probe = {
                                ok: false,
                                status: 0,
                                payload: {
                                    message: 'No fue posible ejecutar la prueba contra /auth/v1/user.',
                                    detail: probeError?.message || String(probeError)
                                }
                            };
                        }
                    }
                }

                console.warn('Falló change_my_pin.', {
                    error: this.getErrorMessage(error, 'No fue posible actualizar el PIN.'),
                    debug: window.__worktracePinChangeDebug || null
                });
                setError(this.getErrorMessage(error, 'No fue posible actualizar el PIN.'));
            } finally {
                this.pinChangeSubmitPromise = null;
                if (submitButton) {
                    submitButton.disabled = false;
                }
                this.hideLoading();
            }
        })();

        return this.pinChangeSubmitPromise;
    },

    async ensureLegalConsent() {
        try {
            const status = await apiClient.legalConsentStatus();

            if (status?.accepted) {
                return;
            }

            const activeTerm = status?.active_term || status || null;
            const activeTermId = activeTerm?.id || status?.term_id || status?.id || null;
            const activeTermCode = activeTerm?.terms_code || activeTerm?.code || '';
            const activeTermVersion = activeTerm?.version || status?.version || '';

            if (!activeTermId && !activeTermCode) {
                return;
            }

            await apiClient.acceptLegalConsent({
                legal_terms_id: activeTermId,
                terms_code: activeTermCode,
                version: activeTermVersion
            });
        } catch (error) {
            const topMessage = String(error?.message || '').toLowerCase();
            const payloadMessage = String(error?.payload?.error?.message || error?.payload?.message || '').toLowerCase();
            const detailMessage = String(error?.payload?.error?.details?.message || error?.payload?.details?.message || '').toLowerCase();
            const detailCode = String(error?.payload?.error?.details?.code || error?.payload?.details?.code || '').toUpperCase();
            const missingActiveVersion = topMessage.includes('no hay version legal activa configurada')
                || payloadMessage.includes('no hay version legal activa configurada')
                || detailMessage.includes('cannot coerce the result to a single json object')
                || detailCode === 'PGRST116';

            if (error?.status === 503 && missingActiveVersion) {
                console.warn('legal_consent no tiene una versión activa configurada. Se omite el paso de consentimiento.', error);
                return;
            }

            throw error;
        }
    },

    async ensureTrustedDevice() {
        if (this.isTrustedDeviceValidationExemptRole()) {
            return;
        }

        const validation = await apiClient.trustedDeviceValidate();

        if (validation?.trusted && !validation?.registration_required) {
            return;
        }

        const platform = 'web';
        const deviceName = `${navigator.platform || 'Browser'} - ${navigator.userAgent.includes('Chrome') ? 'Chrome' : 'Web'}`;

        try {
            await apiClient.trustedDeviceRegister({
                deviceName,
                platform
            });
        } catch (error) {
            const status = Number(error?.status);
            const payloadMessage = String(error?.payload?.error?.message || error?.payload?.message || '').toLowerCase();
            const detailMessage = String(error?.payload?.error?.details?.message || error?.payload?.details?.message || '').toLowerCase();
            const topMessage = String(error?.message || '').toLowerCase();
            const fullMessage = `${payloadMessage} ${detailMessage} ${topMessage}`;
            const devicePolicyConflict = status === 409
                && (fullMessage.includes('dispositivo')
                    || fullMessage.includes('device')
                    || fullMessage.includes('vinculad')
                    || fullMessage.includes('linked')
                    || fullMessage.includes('trusted'));

            if (devicePolicyConflict) {
                throw new Error('Esta cuenta ya está vinculada a otro dispositivo. Debes revocar el dispositivo actual antes de registrar uno nuevo.');
            }

            throw error;
        }
    },

    hasValidOtpSession() {
        const otpToken = apiClient.getConfig().shiftOtpToken;
        const expiresAt = localStorage.getItem(STORAGE_KEYS.shiftOtpExpiresAt);

        if (!otpToken) {
            return false;
        }

        if (!expiresAt) {
            return true;
        }

        return new Date(expiresAt).getTime() > Date.now() + 60_000;
    },

    setOtpError(message = '') {
        const errorBox = document.getElementById('otp-error');
        if (!errorBox) {
            return;
        }

        errorBox.textContent = message;
        errorBox.classList.toggle('hidden', !message);
    },

    setOtpBusy(mode = '') {
        const submitButton = document.getElementById('otp-submit-btn');
        const resendButton = document.getElementById('otp-resend-btn');
        const cancelButton = document.getElementById('otp-cancel-btn');
        const input = document.getElementById('otp-code');

        const isVerifying = mode === 'verify';
        const isResending = mode === 'resend';
        const isBusy = isVerifying || isResending;

        if (submitButton) {
            submitButton.disabled = isBusy;
            submitButton.innerHTML = isVerifying
                ? '<i class="fas fa-spinner fa-spin"></i> Verificando...'
                : '<i class="fas fa-key"></i> Verificar código';
        }

        if (resendButton) {
            resendButton.disabled = isBusy;
            resendButton.innerHTML = isResending
                ? '<i class="fas fa-spinner fa-spin"></i> Reenviando...'
                : '<i class="fas fa-rotate-right"></i> Reenviar';
        }

        if (cancelButton) {
            cancelButton.disabled = isBusy;
        }

        if (input) {
            input.disabled = isBusy;
        }
    },

    populateOtpModal(sendResult = {}, purpose = 'action', loadingSnapshot = null) {
        const modal = document.getElementById('modal-otp');
        const form = document.getElementById('otp-form');
        const input = document.getElementById('otp-code');
        const contextMessage = document.getElementById('otp-context-message');
        const debugBox = document.getElementById('otp-debug-box');
        const debugCode = document.getElementById('otp-debug-code');
        const cancelButton = document.getElementById('otp-cancel-btn');

        if (!modal || !form || !input) {
            throw new Error('La interfaz de verificación OTP no está disponible.');
        }

        const screenMode = Boolean(sendResult?.debug_code);
        const loginFlow = purpose === 'login';

        form.reset();
        input.value = '';
        this.setOtpError('');
        this.setOtpBusy('');

        if (contextMessage) {
            contextMessage.textContent = loginFlow
                ? 'Ingresa el código OTP para continuar.'
                : 'Ingresa el código OTP para continuar con esta operación.';
        }

        if (debugBox) {
            debugBox.classList.toggle('hidden', !screenMode);
        }

        if (debugCode) {
            debugCode.textContent = screenMode ? String(sendResult.debug_code) : '------';
        }

        if (cancelButton) {
            cancelButton.innerHTML = loginFlow
                ? '<i class="fas fa-arrow-left"></i> Volver al login'
                : '<i class="fas fa-arrow-left"></i> Cancelar';
        }

        this.otpChallengeState = {
            purpose,
            sendResult,
            loadingSnapshot
        };

        modal.classList.add('active');
        window.setTimeout(() => input.focus(), 0);
    },

    closeOtpModal() {
        document.getElementById('modal-otp')?.classList.remove('active');
    },

    resolveOtpGate(result = null) {
        const gate = this.otpGate;
        const snapshot = this.otpChallengeState?.loadingSnapshot || null;

        this.otpGate = null;
        this.otpChallengeState = null;
        this.closeOtpModal();
        this.restoreLoadingOverlay(snapshot);

        if (gate?.resolve) {
            gate.resolve(result);
        }
    },

    rejectOtpGate(message = 'Se canceló la verificación OTP.') {
        const gate = this.otpGate;

        this.otpGate = null;
        this.otpChallengeState = null;
        this.closeOtpModal();
        this.hideLoading();

        if (gate?.reject) {
            gate.reject(new Error(message));
        }
    },

    async ensureOtpVerification({ force = false, purpose = 'action' } = {}) {
        if (this.isShiftOtpExemptRole()) {
            apiClient.setShiftOtpToken('');
            localStorage.removeItem(STORAGE_KEYS.shiftOtpExpiresAt);
            return;
        }

        if (!force && this.hasValidOtpSession()) {
            return;
        }

        apiClient.setShiftOtpToken('');
        localStorage.removeItem(STORAGE_KEYS.shiftOtpExpiresAt);

        const sendResult = await apiClient.phoneOtpSend();
        const loadingSnapshot = this.suspendLoadingOverlay();

        this.populateOtpModal(sendResult, purpose, loadingSnapshot);

        await new Promise((resolve, reject) => {
            this.otpGate = { resolve, reject };
        });
    },

    async submitOtpForm() {
        const input = document.getElementById('otp-code');
        const code = input?.value?.trim() || '';

        this.setOtpError('');

        if (!/^\d{4,8}$/.test(code)) {
            this.setOtpError('Ingresa un código OTP numérico válido.');
            input?.focus();
            return;
        }

        this.setOtpBusy('verify');

        try {
            const verifyResult = await apiClient.phoneOtpVerify(code);
            if (verifyResult?.expires_at) {
                localStorage.setItem(STORAGE_KEYS.shiftOtpExpiresAt, verifyResult.expires_at);
            }

            this.resolveOtpGate(verifyResult);
        } catch (error) {
            this.setOtpError(this.getErrorMessage(error, 'No fue posible validar el código OTP.'));
            input?.focus();
            input?.select?.();
        } finally {
            this.setOtpBusy('');
        }
    },

    async resendOtpChallenge() {
        if (!this.otpChallengeState) {
            return;
        }

        this.setOtpError('');
        this.setOtpBusy('resend');

        try {
            apiClient.setShiftOtpToken('');
            localStorage.removeItem(STORAGE_KEYS.shiftOtpExpiresAt);

            const sendResult = await apiClient.phoneOtpSend();
            this.populateOtpModal(
                sendResult,
                this.otpChallengeState.purpose,
                this.otpChallengeState.loadingSnapshot
            );
        } catch (error) {
            this.setOtpError(this.getErrorMessage(error, 'No fue posible reenviar el código OTP.'));
        } finally {
            this.setOtpBusy('');
        }
    },

    cancelOtpChallenge() {
        const loginFlow = this.otpChallengeState?.purpose === 'login';
        this.rejectOtpGate(
            loginFlow
                ? 'Cancelaste la verificación OTP antes de completar el acceso.'
                : 'Se canceló la verificación OTP.'
        );
    },

    async logout() {
        await this.performLogout();
    },

    async performLogout({ silent = false, scope = 'local' } = {}) {
        if (!silent) {
            this.showLoading('Cerrando sesión', '');
        }

        try {
            if (this.supabase) {
                await this.supabase.auth.signOut({ scope });
            }
        } catch (error) {
            console.warn('No fue posible cerrar la sesión remota.', error);
        } finally {
            this.handleSignedOut();
            if (!silent) {
                this.hideLoading();
            }
        }
    },

    handleSignedOut() {
        if (this.pinChangeSubmitPromise) {
            console.warn('Se ignoró un SIGNED_OUT transitorio mientras se completaba el cambio de PIN.');
            this.session = null;
            apiClient.setAccessToken('');
            apiClient.setCurrentRole('');
            return;
        }

        if (this.pinChangeGate?.reject) {
            this.pinChangeGate.reject(new Error('La sesión se cerró antes de completar el cambio de PIN.'));
        }

        if (this.otpGate?.reject) {
            this.otpGate.reject(new Error('La sesión se cerró antes de completar la verificación OTP.'));
        }

        this.pinChangeGate = null;
        this.pinChangeSubmitPromise = null;
        this.tokenRefreshPromise = null;
        this.otpGate = null;
        this.otpChallengeState = null;
        this.cache.adminMetricsUnavailable = false;
        this.cache.adminSupervisionsUnavailable = false;
        this.cache.adminSupervisionsQuery = '';
        this.cache.adminSupervisionsRateLimitedUntil = 0;
        this.session = null;
        this.currentUser = null;
        this.closeCameraCapture({ silent: true });
        this.data.employee.dashboard = null;
        this.data.employee.hoursHistory = null;
        this.data.employee.openTasks = [];
        this.data.employee.lastCompletedShift = null;
        this.data.supervisor.restaurants = [];
        this.data.supervisor.employees = [];
        this.data.supervisor.shifts = [];
        this.data.admin.restaurants = [];
        this.data.admin.metrics = null;
        this.data.admin.supervisors = [];
        this.data.admin.supervisions = [];
        this.data.admin.supervisionSupervisorOptions = [];
        this.data.systemSettings = deepMergeSettings(DEFAULT_SYSTEM_SETTINGS, {});
        this.data.currentShift = null;
        this.data.currentScheduledShift = null;
        this.data.lastGeneratedReport = null;
        this.cache.timestamps = {};
        this.cache.pending = {};
        this.cache.supervisorRestaurantStaff = {};
        this.cache.supervisorAssignableEmployees = {};
        this.cache.adminSupervisorsQuery = '';
        localStorage.removeItem(STORAGE_KEYS.user);
        localStorage.removeItem(STORAGE_KEYS.shiftOtpExpiresAt);
        apiClient.clearSession();
        document.getElementById('login-form')?.reset();
        document.querySelectorAll('.modal.active').forEach((modal) => modal.classList.remove('active'));
        this.stopTimer();
        this.resetShiftState();
        this.setLoginError('');
        this.setLoginNotice('');
        this.navigate('login');
        this.updateDebugInfo();
    },

    navigate(page) {
        this.getPageNodes().forEach((element) => {
            element.classList.add('hidden');
        });

        const targetPage = document.getElementById(`page-${page}`);
        if (!targetPage) {
            console.error('Page not found:', page);
            return;
        }

        targetPage.classList.remove('hidden');
        this.currentPage = page;
        this.removeLegacyUiArtifacts();

        if (page === 'employee-shift-cleaning') {
            this.startTimerFromCurrentShift();
        } else {
            this.stopTimer();
        }

        if (page === 'employee-shift-summary') {
            const summaryDate = document.getElementById('summary-date');
            if (summaryDate) {
                summaryDate.textContent = formatDate(new Date(), {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
            }
        }

        this.updateDebugInfo();
        void this.loadPageData(page);
    },

    removeLegacyUiArtifacts() {
        if (this.store.ui.legacyUiArtifactsRemoved) {
            return;
        }

        this.store.ui.legacyUiArtifactsRemoved = true;
        document.querySelectorAll('button, a').forEach((element) => {
            const label = (element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (
                label === 'actualizar restaurantes'
                || label === 'actualizar empleados'
                || label === 'actualizar turnos'
            ) {
                element.remove();
            }
        });
    },

    navigateToRoleDashboard() {
        if (!this.currentUser) {
            this.navigate('login');
            return;
        }

        const page = ROLE_ROUTES[this.currentUser.role] || 'login';
        this.navigate(page);
    },

    async loadPageData(page) {
        if (!this.currentUser) {
            return;
        }

        try {
            switch (page) {
                case 'employee-dashboard':
                    await this.loadEmployeeDashboard();
                    break;
                case 'employee-profile':
                    await this.loadEmployeeProfile();
                    break;
                case 'employee-shift-start':
                    await this.prepareEmployeeShiftStart();
                    break;
                case 'employee-shift-cleaning':
                    this.updateCleaningUI();
                    break;
                case 'supervisor-dashboard':
                    await this.loadSupervisorDashboard();
                    break;
                case 'supervisor-restaurants':
                    await this.loadSupervisorRestaurants();
                    break;
                case 'supervisor-employees':
                    await this.loadSupervisorEmployees();
                    break;
                case 'supervisor-shifts':
                    await this.loadSupervisorShifts();
                    break;
                case 'supervisor-reports':
                    await this.prepareSupervisorReportsPage();
                    break;
                case 'supervisor-supervision':
                    await this.prepareSupervisorSupervisionPage();
                    break;
                case 'admin-dashboard':
                    await this.loadAdminDashboard();
                    break;
                case 'admin-supervision-monitor':
                    await this.loadAdminSupervisionMonitor();
                    break;
                case 'admin-supervisors':
                    await this.loadAdminSupervisors();
                    break;
                default:
                    break;
            }
        } catch (error) {
            console.error(`No fue posible cargar datos para ${page}.`, error);
        }
    },

    updateUserUI() {
        if (!this.currentUser) {
            return;
        }

        const fullName = this.currentUser.full_name || this.currentUser.email;
        const roleLabel = ROLE_LABELS[this.currentUser.role] || 'Usuario';
        const firstName = fullName.split(' ')[0];

        const userInitial = document.getElementById('user-initial');
        if (userInitial) {
            userInitial.textContent = initials(fullName);
        }

        const welcome = document.getElementById('employee-welcome');
        if (welcome) {
            welcome.textContent = `¡Hola, ${firstName}! 👋`;
        }

        const profileName = document.getElementById('profile-name');
        if (profileName) {
            profileName.textContent = fullName;
        }

        const profileRoleLabel = document.getElementById('profile-role-label');
        if (profileRoleLabel) {
            profileRoleLabel.textContent = roleLabel;
        }

        const profileEmail = document.getElementById('profile-email');
        if (profileEmail) {
            profileEmail.textContent = this.currentUser.email || '-';
        }

        const profilePhone = document.getElementById('profile-phone');
        if (profilePhone) {
            profilePhone.textContent = this.currentUser.phone_e164 || '-';
        }

        this.updateRoleBasedActions();

        const supervisorTitle = document.getElementById('supervisor-welcome-title');
        const supervisorSubtitle = document.getElementById('supervisor-welcome-subtitle');
        if (supervisorTitle) {
            supervisorTitle.textContent = `Bienvenida, ${firstName}`;
        }
        if (supervisorSubtitle) {
            supervisorSubtitle.textContent = roleLabel === 'Super Admin'
                ? 'Vista operativa con permisos ampliados'
                : 'Gestión de equipos y operación diaria';
        }
    },

    isAdminRole(role = this.currentUser?.role) {
        return this.normalizeRoleToken(role) === 'super_admin';
    },

    isSupervisorRole(role = this.currentUser?.role) {
        const normalizedRole = this.normalizeRoleToken(role);
        return normalizedRole === 'supervisora' || normalizedRole === 'supervisor';
    },

    updateRoleBasedActions() {
        const isAdmin = this.isAdminRole();
        const canShowSupervisorCreation = isAdmin || this.isSupervisorRole();
        const createRestaurantButton = document.getElementById('supervisor-create-restaurant-btn');
        const createEmployeeButton = document.getElementById('supervisor-create-employee-btn');

        createRestaurantButton?.classList.toggle('hidden', !canShowSupervisorCreation);
        createEmployeeButton?.classList.toggle('hidden', !canShowSupervisorCreation);
        document.querySelectorAll('.admin-return-btn').forEach((button) => {
            button.classList.toggle('hidden', !isAdmin);
        });
    },

    getCacheAge(key) {
        const timestamp = this.cache.timestamps[key];
        return timestamp ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
    },

    async runPending(key, factory) {
        if (this.cache.pending[key]) {
            return this.cache.pending[key];
        }

        const promise = Promise.resolve().then(factory);
        this.cache.pending[key] = promise;

        try {
            return await promise;
        } finally {
            delete this.cache.pending[key];
        }
    },

    getScopedCacheEntry(mapName, key, ttl) {
        const entry = this.cache[mapName]?.[key];
        if (!entry) {
            return null;
        }

        if ((Date.now() - entry.timestamp) > ttl) {
            delete this.cache[mapName][key];
            return null;
        }

        return entry.value;
    },

    setScopedCacheEntry(mapName, key, value) {
        if (!this.cache[mapName]) {
            this.cache[mapName] = {};
        }

        this.cache[mapName][key] = {
            value,
            timestamp: Date.now()
        };

        return value;
    },

    invalidateScopedCache(mapName, ...keys) {
        if (!this.cache[mapName]) {
            return;
        }

        if (keys.length === 0) {
            this.cache[mapName] = {};
            return;
        }

        keys.forEach((key) => {
            delete this.cache[mapName][key];
        });
    },

    warmEmployeeWorkspace() {
        if (!this.currentUser || !ROLE_ROUTES[this.currentUser.role]?.startsWith('employee')) {
            return;
        }

        if (!this.isCacheFresh('employeeHoursHistory', CACHE_TTLS.employeeHoursHistory)) {
            void this.loadEmployeeProfile().catch((error) => {
                console.warn('No fue posible precargar el perfil del empleado.', error);
            });
        }

        void apiClient.evidenceUploadWarm();
    },

    warmSupervisorWorkspace() {
        if (!this.isSupervisorRole() && !this.isAdminRole()) {
            return;
        }

        if (!this.isCacheFresh('supervisorEmployees', CACHE_TTLS.supervisorEmployees)) {
            void this.loadSupervisorEmployees().catch((error) => {
                console.warn('No fue posible precargar empleados de supervisión.', error);
            });
        }
    },

    warmAdminWorkspace() {
        if (!this.isAdminRole()) {
            return;
        }

        if (!this.isCacheFresh('adminSupervisors', CACHE_TTLS.adminSupervisors)) {
            void this.loadAdminSupervisors().catch((error) => {
                console.warn('No fue posible precargar la gestión de supervisoras.', error);
            });
        }
    },

    isCacheFresh(key, ttl) {
        return this.getCacheAge(key) <= ttl;
    },

    touchCache(key) {
        this.cache.timestamps[key] = Date.now();
    },

    invalidateCache(...keys) {
        keys.forEach((key) => {
            delete this.cache.timestamps[key];
        });
    },

    getSystemSetting(path, fallback) {
        const keys = Array.isArray(path) ? path : String(path || '').split('.');
        let cursor = this.data.systemSettings;

        for (const key of keys) {
            if (!cursor || typeof cursor !== 'object' || !(key in cursor)) {
                return fallback;
            }

            cursor = cursor[key];
        }

        return cursor ?? fallback;
    },

    async loadSystemSettings(force = false) {
        if (
            !force
            && this.data.systemSettings
            && this.isCacheFresh('adminSettings', CACHE_TTLS.adminSettings)
        ) {
            return this.data.systemSettings;
        }

        return this.runPending(`adminSettings:${force ? 'force' : 'default'}`, async () => {
            const result = await apiClient.systemSettingsManage('get');
            const merged = deepMergeSettings(DEFAULT_SYSTEM_SETTINGS, result?.settings || result || {});
            this.data.systemSettings = merged;
            this.touchCache('adminSettings');
            return merged;
        });
    },

    async loadSystemSettingsIfAvailable(force = false) {
        if (!this.isAdminRole()) {
            return this.data.systemSettings;
        }

        try {
            return await this.loadSystemSettings(force);
        } catch (error) {
            console.warn('system_settings_manage no está disponible para este rol o sesión.', error);
            return this.data.systemSettings;
        }
    },

    resolveCleaningAreas(...sources) {
        const candidates = [];

        sources.forEach((source) => {
            if (!source) {
                return;
            }

            candidates.push(...extractCleaningAreas(source.effective_cleaning_areas));
            candidates.push(...extractCleaningAreas(source.cleaning_areas));
        });

        if (candidates.length > 0) {
            return uniqueCleaningAreas(candidates);
        }

        return uniqueCleaningAreas(
            this.getSystemSetting('evidence.default_cleaning_areas', DEFAULT_SYSTEM_SETTINGS.evidence.default_cleaning_areas)
        );
    },

    resolveCleaningAreaGroups(...sources) {
        const mergedGroups = {};

        sources.forEach((source) => {
            if (!source) {
                return;
            }

            [source.effective_cleaning_areas, source.cleaning_areas].forEach((value) => {
                const groups = extractCleaningAreaGroups(value);
                Object.entries(groups).forEach(([groupKey, groupValue]) => {
                    if (!mergedGroups[groupKey]) {
                        mergedGroups[groupKey] = {
                            label: groupValue.label,
                            subareas: []
                        };
                    }

                    mergedGroups[groupKey].subareas = uniqueCleaningAreas([
                        ...mergedGroups[groupKey].subareas,
                        ...asArray(groupValue.subareas)
                    ]);
                });
            });
        });

        return mergedGroups;
    },

    getSupervisorSelectedRestaurant() {
        const selectedRestaurantId = document.getElementById('supervision-restaurant-select')?.value;
        const restaurants = this.data.supervisor.restaurants || [];
        return restaurants.find((restaurant) => String(getRestaurantRecordId(restaurant)) === String(selectedRestaurantId))
            || restaurants[0]
            || null;
    },

    getSupervisorCleaningAreaGroups() {
        const restaurant = this.getSupervisorSelectedRestaurant();
        return this.resolveCleaningAreaGroups(
            restaurant,
            restaurant?.raw?.restaurant,
            restaurant?.raw
        );
    },

    getSupervisorAvailableAreas() {
        const restaurant = this.getSupervisorSelectedRestaurant();
        this.cleaningAreaGroups = this.getSupervisorCleaningAreaGroups();
        return this.resolveCleaningAreas(
            restaurant,
            restaurant?.raw?.restaurant,
            restaurant?.raw
        );
    },

    getSupervisorSelectedAreas() {
        return this.getSupervisorAvailableAreas();
    },

    populateSupervisorAreaOptions() {
        const select = document.getElementById('supervision-area-select');
        if (!select) {
            return;
        }

        const availableAreas = this.getSupervisorAvailableAreas();
        const hasCurrentSelection = availableAreas.some((areaLabel) => normalizeAreaToken(areaLabel) === normalizeAreaToken(this.selectedSupervisorArea));
        if (!hasCurrentSelection) {
            this.selectedSupervisorArea = availableAreas[0] || '';
        }

        const selectedKey = normalizeAreaToken(this.selectedSupervisorArea);
        select.innerHTML = `
            <option value="">Selecciona un área</option>
            ${availableAreas.map((areaLabel) => {
                const optionKey = normalizeAreaToken(areaLabel);
                return `
                    <option value="${escapeHtml(areaLabel)}" ${optionKey === selectedKey ? 'selected' : ''}>
                        ${escapeHtml(areaLabel)}
                    </option>
                `;
            }).join('')}
        `;
    },

    setSupervisorSelectedArea(areaLabel = '') {
        this.selectedSupervisorArea = areaLabel || '';
        const select = document.getElementById('supervision-area-select');
        if (select && select.value !== this.selectedSupervisorArea) {
            select.value = this.selectedSupervisorArea;
        }
        this.renderSupervisorPhotoGrid();
    },

    setCleaningAreas(areas = [], areaGroups = null) {
        const nextAreas = uniqueCleaningAreas(areas).filter(Boolean);
        const fallbackAreas = uniqueCleaningAreas(DEFAULT_SYSTEM_SETTINGS.evidence.default_cleaning_areas);
        const normalizedNext = nextAreas.length > 0 ? nextAreas : fallbackAreas;
        const previousAreas = JSON.stringify(this.areas || []);
        const previousSelection = JSON.stringify(this.selectedEmployeeAreas || []);
        const selectedAreas = uniqueCleaningAreas((this.selectedEmployeeAreas || []).filter((areaLabel) => (
            normalizedNext.some((candidate) => normalizeAreaToken(candidate) === normalizeAreaToken(areaLabel))
        )));
        const nextSelection = JSON.stringify(selectedAreas);
        const selectionChanged = nextSelection !== previousSelection;
        const normalizedGroups = areaGroups && typeof areaGroups === 'object'
            ? areaGroups
            : extractCleaningAreaGroups(normalizedNext);

        this.areas = normalizedNext;
        this.cleaningAreaGroups = normalizedGroups;
        this.selectedEmployeeAreas = selectedAreas;
        this.activeEmployeeArea = selectedAreas.some((areaLabel) => normalizeAreaToken(areaLabel) === normalizeAreaToken(this.activeEmployeeArea))
            ? this.activeEmployeeArea
            : (selectedAreas[0] || '');
        this.queueUiRender('employee-area-selectors');

        if (previousAreas === JSON.stringify(normalizedNext) && !selectionChanged) {
            return;
        }

        this.queueUiRender('employee-photo-grids');
        this.queueUiRender('employee-photo-progress');
    },

    getEmployeeAvailableAreas() {
        return uniqueCleaningAreas((this.areas || []).filter(Boolean));
    },

    getEmployeeSelectedAreas() {
        const availableKeys = new Set(this.getEmployeeAvailableAreas().map((areaLabel) => normalizeAreaToken(areaLabel)));
        return uniqueCleaningAreas((this.selectedEmployeeAreas || []).filter((areaLabel) => availableKeys.has(normalizeAreaToken(areaLabel))));
    },

    getEmployeeActiveArea() {
        const selectedAreas = this.getEmployeeSelectedAreas();
        if (selectedAreas.length === 0) {
            return '';
        }

        const currentActive = this.activeEmployeeArea || '';
        const activeExists = selectedAreas.some((areaLabel) => normalizeAreaToken(areaLabel) === normalizeAreaToken(currentActive));
        return activeExists ? currentActive : selectedAreas[0];
    },

    setEmployeeSelectedAreas(nextAreas = []) {
        const availableKeys = new Set(this.getEmployeeAvailableAreas().map((areaLabel) => normalizeAreaToken(areaLabel)));
        const normalizedSelection = uniqueCleaningAreas(asArray(nextAreas).filter((areaLabel) => availableKeys.has(normalizeAreaToken(areaLabel))));
        const selectionUnchanged = JSON.stringify(normalizedSelection) === JSON.stringify(this.selectedEmployeeAreas || []);

        if (!selectionUnchanged) {
            this.selectedEmployeeAreas = normalizedSelection;
        }
        this.activeEmployeeArea = normalizedSelection.some((areaLabel) => normalizeAreaToken(areaLabel) === normalizeAreaToken(this.activeEmployeeArea))
            ? this.activeEmployeeArea
            : (normalizedSelection[0] || '');

        this.queueUiRender('employee-area-selectors');
        this.queueUiRender('employee-photo-grids');
        this.queueUiRender('employee-photo-progress');

        if (!selectionUnchanged) {
            this.persistCurrentShiftAreaSelection();
        }
    },

    getCurrentShiftPersistenceKeys() {
        const candidates = [
            this.data.currentShift?.id,
            this.data.currentShift?.shift_id,
            this.data.currentShift?.scheduled_shift_id,
            this.data.currentShift?.scheduledShiftId,
            this.data.employee.dashboard?.active_shift?.id,
            this.data.employee.dashboard?.active_shift?.shift_id,
            this.data.employee.dashboard?.active_shift?.scheduled_shift_id,
            this.data.employee.dashboard?.active_shift?.scheduledShiftId,
            this.data.currentScheduledShift?.id,
            this.data.currentScheduledShift?.shift_id,
            this.data.currentScheduledShift?.scheduled_shift_id,
            this.data.currentScheduledShift?.scheduledShiftId
        ];

        const uniqueKeys = [];
        candidates.forEach((candidate) => {
            const normalized = String(candidate || '').trim();
            if (!normalized || uniqueKeys.includes(normalized)) {
                return;
            }

            uniqueKeys.push(normalized);
        });

        return uniqueKeys;
    },

    readShiftRestaurantNameStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.shiftRestaurantNames);
            if (!raw) {
                return {};
            }

            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.warn('No fue posible leer la persistencia local de nombres de restaurante por turno.', error);
            return {};
        }
    },

    writeShiftRestaurantNameStore(store = {}) {
        try {
            localStorage.setItem(STORAGE_KEYS.shiftRestaurantNames, JSON.stringify(store));
        } catch (error) {
            console.warn('No fue posible guardar la persistencia local de nombres de restaurante por turno.', error);
        }
    },

    getShiftRestaurantPersistenceKeys(shift = this.data.currentShift || this.data.currentScheduledShift) {
        if (!shift || typeof shift !== 'object') {
            return this.getCurrentShiftPersistenceKeys();
        }

        const candidates = [
            shift?.id,
            shift?.shift_id,
            shift?.scheduled_shift_id,
            shift?.scheduledShiftId,
            shift?.restaurant_id,
            shift?.restaurant?.restaurant_id,
            shift?.restaurant?.id,
            shift?.location_id,
            shift?.location?.id,
            shift?.site_id,
            shift?.site?.id,
            shift?.raw?.id,
            shift?.raw?.shift_id,
            shift?.raw?.scheduled_shift_id,
            shift?.raw?.restaurant_id,
            shift?.raw?.restaurant?.id
        ];

        const uniqueKeys = [];
        candidates.forEach((candidate) => {
            const normalized = String(candidate || '').trim();
            if (!normalized || uniqueKeys.includes(normalized)) {
                return;
            }

            uniqueKeys.push(normalized);
        });

        return uniqueKeys;
    },

    readShiftRequestTraceStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.shiftRequestTrace);
            if (!raw) {
                return {};
            }

            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.warn('No fue posible leer la traza local de request_id por turno.', error);
            return {};
        }
    },

    writeShiftRequestTraceStore(store = {}) {
        try {
            localStorage.setItem(STORAGE_KEYS.shiftRequestTrace, JSON.stringify(store));
        } catch (error) {
            console.warn('No fue posible guardar la traza local de request_id por turno.', error);
        }
    },

    recordShiftRequestTrace(traceType, requestId, shift = this.data.currentShift || this.data.currentScheduledShift) {
        const normalizedType = String(traceType || '').trim().toLowerCase();
        const normalizedRequestId = String(requestId || '').trim();
        if (!normalizedRequestId || !['finalize_upload', 'summary_by_shift', 'shifts_end'].includes(normalizedType)) {
            return;
        }

        const shiftKeys = this.getShiftRestaurantPersistenceKeys(shift);
        if (shiftKeys.length === 0) {
            return;
        }

        const store = this.readShiftRequestTraceStore();
        const updatedAt = new Date().toISOString();

        shiftKeys.forEach((shiftKey) => {
            const currentEntry = store?.[shiftKey] && typeof store[shiftKey] === 'object' ? store[shiftKey] : {};
            const currentList = Array.isArray(currentEntry[normalizedType]) ? currentEntry[normalizedType] : [];
            const nextList = currentList.includes(normalizedRequestId)
                ? currentList
                : [...currentList, normalizedRequestId].slice(-10);

            store[shiftKey] = {
                ...currentEntry,
                [normalizedType]: nextList,
                updated_at: updatedAt
            };
        });

        this.writeShiftRequestTraceStore(store);
    },

    getShiftRequestTraceSnapshot(shift = this.data.currentShift || this.data.currentScheduledShift) {
        const shiftKeys = this.getShiftRestaurantPersistenceKeys(shift);
        if (shiftKeys.length === 0) {
            return {
                finalize_upload: [],
                summary_by_shift: [],
                shifts_end: []
            };
        }

        const store = this.readShiftRequestTraceStore();
        const merged = {
            finalize_upload: [],
            summary_by_shift: [],
            shifts_end: []
        };

        shiftKeys.forEach((shiftKey) => {
            const entry = store?.[shiftKey] && typeof store[shiftKey] === 'object' ? store[shiftKey] : null;
            if (!entry) {
                return;
            }

            ['finalize_upload', 'summary_by_shift', 'shifts_end'].forEach((traceType) => {
                const ids = Array.isArray(entry?.[traceType]) ? entry[traceType] : [];
                ids.forEach((id) => {
                    const normalized = String(id || '').trim();
                    if (!normalized || merged[traceType].includes(normalized)) {
                        return;
                    }

                    merged[traceType].push(normalized);
                });
            });
        });

        return merged;
    },

    persistShiftRestaurantName(shift, restaurantName = '') {
        const normalizedName = String(restaurantName || '').trim();
        if (!normalizedName || isGenericNamedPlaceholder(normalizedName, 'restaurant') || normalizedName === 'Restaurante sin nombre visible') {
            return;
        }

        const shiftKeys = this.getShiftRestaurantPersistenceKeys(shift);
        if (shiftKeys.length === 0) {
            return;
        }

        const store = this.readShiftRestaurantNameStore();
        shiftKeys.forEach((shiftKey) => {
            store[shiftKey] = {
                name: normalizedName,
                updated_at: new Date().toISOString()
            };
        });
        this.writeShiftRestaurantNameStore(store);
    },

    getPersistedShiftRestaurantName(shift) {
        const shiftKeys = this.getShiftRestaurantPersistenceKeys(shift);
        if (shiftKeys.length === 0) {
            return '';
        }

        const store = this.readShiftRestaurantNameStore();
        for (const shiftKey of shiftKeys) {
            const candidate = String(store?.[shiftKey]?.name || '').trim();
            if (candidate && !isGenericNamedPlaceholder(candidate, 'restaurant') && candidate !== 'Restaurante sin nombre visible') {
                return candidate;
            }
        }

        return '';
    },

    readShiftAreaSelectionStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.shiftSelectedAreas);
            if (!raw) {
                return {};
            }

            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.warn('No fue posible leer la persistencia local de áreas por turno.', error);
            return {};
        }
    },

    writeShiftAreaSelectionStore(store = {}) {
        try {
            localStorage.setItem(STORAGE_KEYS.shiftSelectedAreas, JSON.stringify(store));
        } catch (error) {
            console.warn('No fue posible guardar la persistencia local de áreas por turno.', error);
        }
    },

    persistCurrentShiftAreaSelection() {
        const shiftKeys = this.getCurrentShiftPersistenceKeys();
        if (shiftKeys.length === 0) {
            return;
        }

        const selectedAreas = this.getEmployeeSelectedAreas();
        if (selectedAreas.length === 0) {
            return;
        }

        const store = this.readShiftAreaSelectionStore();
        shiftKeys.forEach((shiftKey) => {
            store[shiftKey] = {
                areas: selectedAreas,
                active_area: this.getEmployeeActiveArea() || selectedAreas[0] || '',
                updated_at: new Date().toISOString()
            };
        });
        this.writeShiftAreaSelectionStore(store);
    },

    inferSelectedAreasFromStartEvidence(shift = this.data.currentShift, availableAreas = this.getEmployeeAvailableAreas()) {
        const items = this.extractShiftEvidenceItems(shift, 'start');
        if (!Array.isArray(items) || items.length === 0) {
            return [];
        }

        const availableKeys = new Map(
            availableAreas.map((areaLabel) => [normalizeAreaToken(areaLabel), areaLabel])
        );

        const inferred = items
            .map((item) => String(item?.area_label || '').trim())
            .filter(Boolean)
            .map((areaLabel) => {
                const direct = availableKeys.get(normalizeAreaToken(areaLabel));
                if (direct) {
                    return direct;
                }

                const canonical = normalizeAreaGroupLabel(areaLabel);
                return availableKeys.get(normalizeAreaToken(canonical)) || '';
            })
            .filter(Boolean);

        return uniqueCleaningAreas(inferred);
    },

    restoreCurrentShiftAreaSelection({ fallbackToAllAvailable = false } = {}) {
        if (this.getEmployeeSelectedAreas().length > 0) {
            return;
        }

        const shiftKeys = this.getCurrentShiftPersistenceKeys();
        const availableAreas = this.getEmployeeAvailableAreas();
        if (availableAreas.length === 0) {
            return;
        }

        const store = this.readShiftAreaSelectionStore();
        for (const shiftKey of shiftKeys) {
            const snapshot = store?.[shiftKey] || null;
            const snapshotAreas = uniqueCleaningAreas(asArray(snapshot?.areas));
            if (snapshotAreas.length > 0) {
                this.setEmployeeSelectedAreas(snapshotAreas);
                return;
            }
        }

        const inferredAreas = this.inferSelectedAreasFromStartEvidence(this.data.currentShift, availableAreas);
        if (inferredAreas.length > 0) {
            this.setEmployeeSelectedAreas(inferredAreas);
            return;
        }

        if (fallbackToAllAvailable) {
            this.setEmployeeSelectedAreas(availableAreas);
        }
    },

    setEmployeeActiveArea(areaLabel) {
        const selectedAreas = this.getEmployeeSelectedAreas();
        const normalizedArea = normalizeAreaToken(areaLabel);

        if (!selectedAreas.some((candidate) => normalizeAreaToken(candidate) === normalizedArea)) {
            return;
        }

        if (normalizeAreaToken(this.activeEmployeeArea) === normalizedArea) {
            return;
        }

        this.activeEmployeeArea = selectedAreas.find((candidate) => normalizeAreaToken(candidate) === normalizedArea) || areaLabel;
        this.queueUiRender('employee-area-selectors');
        this.queueUiRender('employee-photo-grids');
    },

    toggleEmployeeAreaSelection(areaLabel) {
        const nextSelection = [...this.getEmployeeSelectedAreas()];
        const areaKey = normalizeAreaToken(areaLabel);
        const existingIndex = nextSelection.findIndex((candidate) => normalizeAreaToken(candidate) === areaKey);

        if (existingIndex >= 0) {
            nextSelection.splice(existingIndex, 1);
        } else {
            nextSelection.push(areaLabel);
        }

        this.setEmployeeSelectedAreas(nextSelection);
    },

    renderEmployeeAreaSelectors() {
        this.queueUiRender('employee-area-selectors');
    },

    setContainerEmptyState(container, message) {
        if (!container) {
            return;
        }

        const currentEmpty = container.firstElementChild;
        if (
            container.childElementCount === 1
            && currentEmpty?.classList.contains('photo-grid-empty')
            && String(currentEmpty.textContent || '') === message
        ) {
            return;
        }

        const emptyNode = document.createElement('div');
        emptyNode.className = 'photo-grid-empty';
        emptyNode.textContent = message;
        container.replaceChildren(emptyNode);
    },

    syncAreaChipCollection(container, labels = [], options = {}) {
        if (!container) {
            return;
        }

        const {
            asButtons = true,
            action = '',
            selectedKeys = null,
            activeKey = '',
            readonly = false,
            alwaysActive = false,
            emptyMessage = ''
        } = options;

        if (!labels.length) {
            if (emptyMessage) {
                this.setContainerEmptyState(container, emptyMessage);
            } else {
                container.replaceChildren();
            }
            return;
        }

        const expectedKeys = new Set(labels.map((label) => normalizeAreaToken(label)));
        const existingByKey = new Map();

        Array.from(container.children).forEach((node) => {
            const nodeKey = node instanceof HTMLElement ? String(node.dataset.areaKey || '') : '';
            if (nodeKey && expectedKeys.has(nodeKey)) {
                existingByKey.set(nodeKey, node);
                return;
            }
            node.remove();
        });

        labels.forEach((label, index) => {
            const areaKey = normalizeAreaToken(label);
            const tagName = asButtons ? 'BUTTON' : 'SPAN';
            let node = existingByKey.get(areaKey) || null;

            if (!node || node.tagName !== tagName) {
                node = document.createElement(asButtons ? 'button' : 'span');
                if (asButtons) {
                    node.type = 'button';
                }
                node.dataset.areaKey = areaKey;
            }

            const isActive = alwaysActive
                ? true
                : selectedKeys instanceof Set
                    ? selectedKeys.has(areaKey)
                    : activeKey
                        ? normalizeAreaToken(activeKey) === areaKey
                        : false;

            node.className = readonly
                ? `area-chip area-chip-readonly${isActive ? ' active' : ''}`
                : `area-chip${isActive ? ' active' : ''}`;

            if (node.textContent !== label) {
                node.textContent = label;
            }

            if (action && !readonly) {
                node.dataset.action = action;
                node.dataset.areaLabel = label;
            } else {
                delete node.dataset.action;
                delete node.dataset.areaLabel;
            }

            const currentAtIndex = container.children[index];
            if (currentAtIndex !== node) {
                container.insertBefore(node, currentAtIndex || null);
            }
        });
    },

    renderEmployeeAreaSelectorsNow() {
        const availableAreas = this.getEmployeeAvailableAreas();
        const selectedAreas = this.getEmployeeSelectedAreas();
        const activeArea = this.getEmployeeActiveArea();
        const selectedAreaKeys = new Set(selectedAreas.map((areaLabel) => normalizeAreaToken(areaLabel)));
        const startContainer = document.getElementById('employee-area-selector');
        const endContainer = document.getElementById('employee-end-area-summary');
        const startFocusContainer = document.getElementById('employee-area-focus');
        const startFocusPanel = document.getElementById('employee-area-focus-panel');
        const endFocusContainer = document.getElementById('employee-end-area-focus');
        const endFocusPanel = document.getElementById('employee-end-area-focus-panel');

        this.syncAreaChipCollection(startContainer, availableAreas, {
            asButtons: true,
            action: 'toggle-employee-area',
            selectedKeys: selectedAreaKeys,
            emptyMessage: 'No hay áreas disponibles para este turno.'
        });

        if (startFocusPanel) {
            startFocusPanel.classList.toggle('hidden', selectedAreas.length === 0);
        }

        this.syncAreaChipCollection(startFocusContainer, selectedAreas, {
            asButtons: true,
            action: 'set-employee-active-area',
            activeKey: activeArea,
            emptyMessage: 'Selecciona al menos una zona para enfocarte en sus subáreas.'
        });

        this.syncAreaChipCollection(endContainer, selectedAreas, {
            asButtons: false,
            readonly: true,
            alwaysActive: true,
            emptyMessage: 'Las áreas seleccionadas al inicio aparecerán aquí automáticamente.'
        });

        if (endFocusPanel) {
            endFocusPanel.classList.toggle('hidden', selectedAreas.length === 0);
        }

        this.syncAreaChipCollection(endFocusContainer, selectedAreas, {
            asButtons: true,
            action: 'set-employee-active-area',
            activeKey: activeArea,
            emptyMessage: 'Selecciona al menos una zona para enfocarte en sus subáreas.'
        });
    },

    updateDate() {
        const dateElement = document.getElementById('current-date');
        if (!dateElement) {
            return;
        }

        dateElement.textContent = new Date().toLocaleDateString('es-CO', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    },

    setDefaultReportDates() {
        const startInput = document.getElementById('report-start-date');
        const endInput = document.getElementById('report-end-date');

        if (startInput && !startInput.value) {
            startInput.value = toInputDate(getMonthStart());
        }

        if (endInput && !endInput.value) {
            endInput.value = toInputDate(new Date());
        }
    },

    openDateControlPicker(inputId = '') {
        const input = document.getElementById(String(inputId || '').trim());
        if (!input) {
            return;
        }

        try {
            if (typeof input.showPicker === 'function') {
                input.showPicker();
                return;
            }
        } catch (error) {
            console.warn('No fue posible abrir showPicker; se usará focus.', error);
        }

        input.focus();
        input.click?.();
    },

    async primeEmployeeWorkspacePermissions() {
        if (!this.currentUser || !ROLE_ROUTES[this.currentUser.role]?.startsWith('employee')) {
            return;
        }

        if (this.employeePermissionsRequested) {
            return this.employeePermissionsPromise || Promise.resolve();
        }

        this.employeePermissionsRequested = true;
        this.employeePermissionsPromise = (async () => {
            const deniedPermissions = [];

            try {
                await this.requestLocationPermissionOnly();
            } catch (error) {
                console.warn('No fue posible obtener el permiso de ubicación al ingresar.', error);
                deniedPermissions.push('ubicación');
            }

            try {
                await this.requestCameraPermissionOnly();
            } catch (error) {
                console.warn('No fue posible obtener el permiso de cámara al ingresar.', error);
                deniedPermissions.push('cámara');
            }

            if (deniedPermissions.length > 0) {
                this.showToast(
                    `Permite ${deniedPermissions.join(' y ')} para iniciar turnos y registrar evidencias desde la app.`,
                    {
                        tone: 'warning',
                        title: 'Permisos recomendados'
                    }
                );
            }
        })().finally(() => {
            this.employeePermissionsPromise = null;
        });

        return this.employeePermissionsPromise;
    },

    async requestLocationPermissionOnly() {
        if (!navigator.geolocation) {
            throw new Error('El navegador no permite geolocalización.');
        }

        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            });
        });

        this.location = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy
        };
        void this.refreshCurrentLocationAddress(this.location);
        this.gpsVerified = false;
        return this.location;
    },

    async requestCameraPermissionOnly() {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Este navegador no permite acceder a la cámara.');
        }

        const stream = await this.requestCameraStream();
        stream.getTracks().forEach((track) => track.stop());
    },

    async captureLocation({ updateUi = true } = {}) {
        const button = document.getElementById('gps-btn');
        const status = document.getElementById('gps-status');

        if (!navigator.geolocation) {
            if (status && updateUi) {
                status.className = 'gps-status invalid';
                status.innerHTML = '<i class="fas fa-location-crosshairs"></i><span>Geolocalización no disponible</span>';
            }
            throw new Error('El navegador no permite geolocalización.');
        }

        if (button && updateUi) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
        }

        if (status && updateUi) {
            status.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Verificando...</span>';
        }

        try {
            const isBackgroundCapture = !updateUi;
            const locationAge = isBackgroundCapture ? 300000 : 0;
            const position = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: !isBackgroundCapture,
                    timeout: isBackgroundCapture ? 5000 : 10000,
                    maximumAge: locationAge
                });
            });

            this.location = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy
            };
            this.locationTimestamp = Date.now();
            void this.refreshCurrentLocationAddress(this.location);
            this.gpsVerified = true;

            if (status && updateUi) {
                status.className = 'gps-status valid';
                status.innerHTML = '<i class="fas fa-check-circle"></i><span>Ubicación verificada</span>';
            }

            if (button && updateUi) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-check"></i> Verificada';
            }

            this.checkCanContinue();
            return this.location;
        } catch (error) {
            this.location = null;
            this.locationAddress = '';
            this.locationAddressKey = '';
            this.gpsVerified = false;

            if (status && updateUi) {
                status.className = 'gps-status invalid';
                status.innerHTML = `<i class="fas fa-location-crosshairs"></i><span>${this.getGeolocationMessage(error)}</span>`;
            }

            if (button && updateUi) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-location-crosshairs"></i> Reintentar';
            }

            this.checkCanContinue();
            throw error;
        }
    },

    async reverseGeocodeWithGoogle(lat, lng) {
        if (!window.google?.maps?.Geocoder) {
            return '';
        }

        const geocoder = this.restaurantGeocoder || new window.google.maps.Geocoder();
        this.restaurantGeocoder = geocoder;

        const results = await new Promise((resolve, reject) => {
            geocoder.geocode({ location: { lat, lng } }, (items, status) => {
                if (status === 'OK' && Array.isArray(items)) {
                    resolve(items);
                    return;
                }

                if (status === 'ZERO_RESULTS') {
                    resolve([]);
                    return;
                }

                reject(new Error(`Google geocoder status: ${status}`));
            });
        });

        const top = Array.isArray(results) ? results[0] : null;
        return String(top?.formatted_address || '').trim();
    },

    async reverseGeocodeWithNominatim(lat, lng) {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=es`,
            {
                headers: {
                    Accept: 'application/json'
                }
            }
        );

        if (!response.ok) {
            throw new Error(`Reverse geocode failed with ${response.status}`);
        }

        const payload = await response.json();
        const displayName = String(payload?.display_name || '').trim();
        if (!displayName) {
            return '';
        }

        return displayName;
    },

    async refreshCurrentLocationAddress(location = this.location) {
        const lat = Number(location?.lat);
        const lng = Number(location?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return '';
        }

        const nextKey = `${lat.toFixed(5)}|${lng.toFixed(5)}`;
        if (this.locationAddressKey === nextKey && this.locationAddress) {
            return this.locationAddress;
        }

        if (this.locationAddressPromise) {
            return this.locationAddressPromise;
        }

        this.locationAddressPromise = (async () => {
            let resolvedAddress = '';

            try {
                resolvedAddress = await this.reverseGeocodeWithGoogle(lat, lng);
            } catch (error) {
                console.warn('No fue posible resolver la dirección con Google Geocoder.', error);
            }

            if (!resolvedAddress) {
                try {
                    resolvedAddress = await this.reverseGeocodeWithNominatim(lat, lng);
                } catch (error) {
                    console.warn('No fue posible resolver la dirección con Nominatim.', error);
                }
            }

            this.locationAddress = resolvedAddress || '';
            this.locationAddressKey = nextKey;

            if (this.currentPage === 'employee-dashboard') {
                this.renderEmployeeDashboard();
            }

            return this.locationAddress;
        })();

        try {
            return await this.locationAddressPromise;
        } finally {
            this.locationAddressPromise = null;
        }
    },

    async verifyGPS() {
        try {
            await this.captureLocation();
        } catch (error) {
            console.warn('No fue posible obtener ubicación.', error);
        }
    },

    getGeolocationMessage(error) {
        switch (error.code) {
            case error.PERMISSION_DENIED:
                return 'Permiso de ubicación denegado';
            case error.POSITION_UNAVAILABLE:
                return 'Ubicación no disponible';
            case error.TIMEOUT:
                return 'Tiempo de espera agotado';
            default:
                return 'No fue posible verificar la ubicación';
        }
    },

    getEmployeeCurrentLocationText() {
        if (this.locationAddress) {
            return this.locationAddress;
        }

        const lat = Number(this.location?.lat);
        const lng = Number(this.location?.lng);
        const accuracy = Number(this.location?.accuracy);

        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
            if (Number.isFinite(accuracy) && accuracy > 0) {
                return `Actual: ${coords} (±${Math.round(accuracy)} m)`;
            }
            return `Actual: ${coords}`;
        }

        return 'Ubicación actual pendiente de verificar';
    },

    toggleHealthCert() {
        setTimeout(() => {
            const checkbox = document.getElementById('health-cert');
            this.healthCertified = checkbox?.checked || false;
            this.checkCanContinue();
        }, 0);
    },

    checkCanContinue() {
        const button = document.getElementById('continue-btn');
        if (button) {
            const hasActiveShift = Boolean(this.data.currentShift?.id);
            const canStartShift = !hasActiveShift
                && this.canEmployeeStartScheduledShift(this.data.currentScheduledShift, this.data.employee.dashboard);
            button.disabled = !(this.gpsVerified && (hasActiveShift || canStartShift));
        }
    },

    getAreaSubareas(areaLabel) {
        const normalizedLabel = normalizeAreaGroupLabel(areaLabel);
        const groupKey = normalizeAreaToken(normalizedLabel || areaLabel);
        const customSubareas = uniqueCleaningAreas(extractCleaningAreaSubareas(
            this.cleaningAreaGroups?.[groupKey]?.subareas || this.cleaningAreaGroups?.[groupKey]
        ));

        if (customSubareas.length > 0) {
            return customSubareas;
        }

        return AREA_SUBAREAS[normalizedLabel] || AREA_SUBAREAS[areaLabel] || ['General'];
    },

    buildPhotoSlotDefinitions(areas = []) {
        return uniqueCleaningAreas(areas).flatMap((areaLabel) => {
            const groupLabel = normalizeAreaGroupLabel(areaLabel);
            const subareas = this.getAreaSubareas(groupLabel);
            return subareas.map((subareaLabel) => ({
                key: buildPhotoSlotKey(groupLabel, subareaLabel),
                areaLabel,
                groupLabel,
                subareaLabel,
                title: `${groupLabel} • ${subareaLabel}`
            }));
        });
    },

    getPhotoSlotDefinition(slotKey, type = 'start') {
        const catalog = type === 'supervision' ? this.supervisionPhotoCatalog : this.employeePhotoSlots;
        return catalog.find((slot) => slot.key === slotKey) || null;
    },

    renderPhotoGridForType(containerId, type, slots, emptyMessage = 'No hay áreas configuradas para fotografiar.') {
        this.renderPhotoGridForTypeNow(containerId, type, slots, emptyMessage);
    },

    ensurePhotoSlotPlaceholder(slotNode, slot, type) {
        if (!slotNode || !slot) {
            return;
        }

        if (slotNode.classList.contains('has-image')) {
            return;
        }

        let icon = slotNode.querySelector('i');
        if (!icon) {
            icon = document.createElement('i');
            icon.className = 'fas fa-camera';
            icon.style.fontSize = '32px';
            icon.style.color = 'var(--gray)';
            slotNode.prepend(icon);
        }

        let label = slotNode.querySelector('.photo-slot-label');
        if (!label) {
            label = document.createElement('span');
            label.className = 'photo-slot-label';
            slotNode.appendChild(label);
        }

        if (label.textContent !== slot.subareaLabel) {
            label.textContent = slot.subareaLabel;
        }

        slotNode.id = `slot-${type}-${areaDomId(slot.key)}`;
        slotNode.dataset.slotKey = slot.key;
        slotNode.dataset.photoType = type;
        slotNode.dataset.action = 'select-photo-area';
    },

    syncPhotoGroupSlots(gridNode, groupSlots = [], type = 'start') {
        if (!gridNode) {
            return;
        }

        const expectedKeys = new Set(groupSlots.map((slot) => slot.key));
        const existingByKey = new Map();

        Array.from(gridNode.children).forEach((child) => {
            const slotKey = child instanceof HTMLElement ? String(child.dataset.slotKey || '') : '';
            if (slotKey && expectedKeys.has(slotKey)) {
                existingByKey.set(slotKey, child);
                return;
            }
            child.remove();
        });

        groupSlots.forEach((slot, index) => {
            let slotNode = existingByKey.get(slot.key) || null;

            if (!slotNode) {
                slotNode = document.createElement('div');
                slotNode.className = 'photo-slot';
            }

            this.ensurePhotoSlotPlaceholder(slotNode, slot, type);

            const currentAtIndex = gridNode.children[index];
            if (currentAtIndex !== slotNode) {
                gridNode.insertBefore(slotNode, currentAtIndex || null);
            }
        });
    },

    renderPhotoGridForTypeNow(containerId, type, slots, emptyMessage = 'No hay áreas configuradas para fotografiar.') {
        const container = document.getElementById(containerId);
        if (!container) {
            return;
        }

        if (!slots.length) {
            this.setContainerEmptyState(container, emptyMessage);
            return;
        }

        const groupedSlots = slots.reduce((accumulator, slot) => {
            if (!accumulator.has(slot.groupLabel)) {
                accumulator.set(slot.groupLabel, []);
            }
            accumulator.get(slot.groupLabel).push(slot);
            return accumulator;
        }, new Map());

        const expectedGroups = new Set(Array.from(groupedSlots.keys()));
        const existingSections = new Map();

        Array.from(container.children).forEach((child) => {
            const groupLabel = child instanceof HTMLElement ? String(child.dataset.groupLabel || '') : '';
            if (groupLabel && expectedGroups.has(groupLabel)) {
                existingSections.set(groupLabel, child);
                return;
            }
            child.remove();
        });

        Array.from(groupedSlots.entries()).forEach(([groupLabel, groupSlots], index) => {
            let section = existingSections.get(groupLabel) || null;
            if (!section) {
                section = document.createElement('section');
                section.className = 'photo-group-card';
                section.dataset.groupLabel = groupLabel;

                const header = document.createElement('div');
                header.className = 'photo-group-header';

                const title = document.createElement('h4');
                const summary = document.createElement('p');
                header.append(title, summary);

                const grid = document.createElement('div');
                grid.className = 'photo-grid photo-grid-subareas';

                section.append(header, grid);
            }

            const title = section.querySelector('h4');
            if (title && title.textContent !== groupLabel) {
                title.textContent = groupLabel;
            }

            const summary = section.querySelector('.photo-group-header p');
            if (summary) {
                const requiredText = `${groupSlots.length} evidencia${groupSlots.length === 1 ? '' : 's'} requerida${groupSlots.length === 1 ? '' : 's'}`;
                if (summary.textContent !== requiredText) {
                    summary.textContent = requiredText;
                }
            }

            const grid = section.querySelector('.photo-grid-subareas');
            this.syncPhotoGroupSlots(grid, groupSlots, type);

            const currentAtIndex = container.children[index];
            if (currentAtIndex !== section) {
                container.insertBefore(section, currentAtIndex || null);
            }
        });
    },

    pruneEmployeeEvidenceCollections(validSlotKeys) {
        Object.keys(this.photos || {}).forEach((slotKey) => {
            if (!validSlotKeys.has(slotKey)) {
                this.services.images.removeFromMap(this.photos, slotKey);
            }
        });

        Object.keys(this.endPhotos || {}).forEach((slotKey) => {
            if (!validSlotKeys.has(slotKey)) {
                this.services.images.removeFromMap(this.endPhotos, slotKey);
            }
        });

        [
            this.photoFiles,
            this.endPhotoFiles,
            this.uploadedStartAreas,
            this.uploadedEndAreas
        ].forEach((collection) => {
            Object.keys(collection || {}).forEach((slotKey) => {
                if (!validSlotKeys.has(slotKey)) {
                    delete collection[slotKey];
                }
            });
        });
    },

    renderPhotoGrids() {
        this.queueUiRender('employee-photo-grids');
    },

    renderPhotoGridsNow() {
        const selectedAreas = this.getEmployeeSelectedAreas();
        const activeArea = this.getEmployeeActiveArea();
        const visibleAreas = activeArea ? [activeArea] : [];
        this.employeePhotoSlots = this.buildPhotoSlotDefinitions(selectedAreas);
        const visibleEmployeeSlots = this.buildPhotoSlotDefinitions(visibleAreas);

        const validSlotKeys = new Set(this.employeePhotoSlots.map((slot) => slot.key));
        this.pruneEmployeeEvidenceCollections(validSlotKeys);

        this.renderPhotoGridForTypeNow(
            'photo-grid',
            'start',
            visibleEmployeeSlots,
            selectedAreas.length > 0
                ? 'Selecciona un área para ver sus subáreas.'
                : 'Selecciona una o varias áreas para ver las subáreas requeridas.'
        );
        this.renderPhotoGridForTypeNow(
            'end-photo-grid',
            'end',
            visibleEmployeeSlots,
            selectedAreas.length > 0
                ? 'Selecciona un área para ver sus subáreas finales.'
                : 'Las mismas áreas seleccionadas al inicio aparecerán aquí.'
        );

        Object.entries(this.photos).forEach(([area, source]) => {
            this.updatePhotoSlot(area, 'start', source);
        });

        Object.entries(this.endPhotos).forEach(([area, source]) => {
            this.updatePhotoSlot(area, 'end', source);
        });

        this.renderSupervisorPhotoGridNow();

        const totalPhotos = document.getElementById('total-photos');
        if (totalPhotos) {
            totalPhotos.textContent = String(this.employeePhotoSlots.length);
        }
    },

    async selectPhotoArea(slot, type) {
        this.currentPhotoArea = slot?.key || null;
        this.currentPhotoContext = slot || null;
        this.currentPhotoType = type;

        try {
            await this.openCameraCapture({ slot, type });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible abrir la cámara.'), {
                tone: 'error',
                title: 'Cámara no disponible'
            });
        }
    },

    async openCameraCapture({ slot, type }) {
        const modal = document.getElementById('modal-camera-capture');
        const video = document.getElementById('camera-capture-video');
        const title = document.getElementById('camera-capture-title');
        const helper = document.getElementById('camera-capture-helper');
        const error = document.getElementById('camera-capture-error');
        const button = document.getElementById('camera-capture-btn');

        if (!modal || !video || !button) {
            throw new Error('La interfaz de cámara no está disponible.');
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Este navegador no permite acceder a la cámara desde la aplicación.');
        }

        this.cameraCaptureState = { slot, type };

        if (title) {
            title.textContent = `Capturar ${slot?.title || 'evidencia'}`;
        }

        if (helper) {
            helper.textContent = type === 'supervision'
                ? 'Usa la cámara del dispositivo para registrar la evidencia de supervisión.'
                : 'Se abrirá la cámara del dispositivo. Toma la foto y confírmala desde aquí.';
        }

        if (error) {
            error.textContent = '';
            error.classList.add('hidden');
        }

        button.disabled = true;
        this.lockBodyScroll();
        modal.classList.add('active');

        try {
            const stream = await this.requestCameraStream();
            this.cameraStream = stream;
            video.srcObject = stream;
            await video.play();
            button.disabled = false;
        } catch (cameraError) {
            this.closeCameraCapture({ silent: true });
            throw cameraError;
        }
    },

    lockBodyScroll() {
        const body = document.body;
        const html = document.documentElement;
        if (!body || body.classList.contains('camera-capture-active')) {
            return;
        }

        this.bodyScrollLockTop = window.scrollY || window.pageYOffset || 0;
        body.style.top = `-${this.bodyScrollLockTop}px`;
        body.classList.add('camera-capture-active');
        html.classList.add('camera-capture-active');
    },

    unlockBodyScroll() {
        const body = document.body;
        const html = document.documentElement;
        if (!body || !body.classList.contains('camera-capture-active')) {
            return;
        }

        body.classList.remove('camera-capture-active');
        html.classList.remove('camera-capture-active');
        body.style.top = '';
        window.scrollTo(0, this.bodyScrollLockTop || 0);
        this.bodyScrollLockTop = 0;
    },

    async requestCameraStream() {
        const primaryConstraints = {
            audio: false,
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            }
        };

        try {
            return await navigator.mediaDevices.getUserMedia(primaryConstraints);
        } catch (error) {
            const fallbackAllowed = ['OverconstrainedError', 'NotFoundError', 'AbortError'].includes(error?.name);
            if (!fallbackAllowed) {
                throw error;
            }

            return navigator.mediaDevices.getUserMedia({
                audio: false,
                video: true
            });
        }
    },

    closeCameraCapture({ silent = false } = {}) {
        const modal = document.getElementById('modal-camera-capture');
        const video = document.getElementById('camera-capture-video');
        const button = document.getElementById('camera-capture-btn');
        const error = document.getElementById('camera-capture-error');

        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach((track) => track.stop());
        }

        this.cameraStream = null;
        this.cameraCaptureState = null;

        if (video) {
            video.pause?.();
            video.srcObject = null;
        }

        if (button) {
            button.disabled = true;
        }

        if (error && !silent) {
            error.textContent = '';
            error.classList.add('hidden');
        }

        modal?.classList.remove('active');
        this.unlockBodyScroll();
        this.currentPhotoArea = null;
        this.currentPhotoContext = null;
    },

    async captureCameraPhoto() {
        const video = document.getElementById('camera-capture-video');
        const canvas = document.getElementById('camera-capture-canvas');
        const error = document.getElementById('camera-capture-error');
        const button = document.getElementById('camera-capture-btn');
        const state = this.cameraCaptureState;
        const slot = state?.slot || null;

        if (!video || !canvas || !slot?.key || !state?.type) {
            return;
        }

        if (!video.videoWidth || !video.videoHeight) {
            if (error) {
                error.textContent = 'La cámara aún no está lista. Intenta de nuevo en un momento.';
                error.classList.remove('hidden');
            }
            return;
        }

        button.disabled = true;

        try {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');
            context.drawImage(video, 0, 0, canvas.width, canvas.height);

            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob((nextBlob) => {
                    if (nextBlob) {
                        resolve(nextBlob);
                        return;
                    }
                    reject(new Error('No fue posible capturar la imagen.'));
                }, 'image/jpeg', 0.92);
            });

            const file = new File(
                [blob],
                `${state.type}-${normalizeAreaToken(slot.groupLabel)}-${normalizeAreaToken(slot.subareaLabel)}-${Date.now()}.jpg`,
                { type: 'image/jpeg' }
            );

            if (state.type === 'task') {
                const attached = this.setSpecialTaskEvidenceFile(file);
                if (!attached) {
                    throw new Error('No fue posible adjuntar la evidencia de la tarea especial.');
                }
            } else {
                await this.processPhotoFile(file, state.type, slot.key);
            }
            this.closeCameraCapture();
        } catch (cameraError) {
            if (error) {
                error.textContent = this.getErrorMessage(cameraError, 'No fue posible capturar la foto.');
                error.classList.remove('hidden');
            }
            button.disabled = false;
        }
    },

    async compressImage(file, maxWidth = 1280, quality = 0.78) {
        if (!file || !file.type?.startsWith('image/')) return file;
        return new Promise((resolve) => {
            const img = new Image();
            const srcUrl = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(srcUrl);
                const scale = Math.min(1, maxWidth / Math.max(img.width, img.height));
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                canvas.toBlob(
                    (blob) => resolve(blob
                        ? new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })
                        : file),
                    'image/jpeg',
                    quality
                );
            };
            img.onerror = () => { URL.revokeObjectURL(srcUrl); resolve(file); };
            img.src = srcUrl;
        });
    },

    async processPhotoFile(file, type, area) {
        if (!file || !area) {
            return;
        }

        const fileCollections = {
            start: this.photoFiles,
            end: this.endPhotoFiles,
            supervision: this.supervisionPhotoFiles
        };

        const previewCollections = {
            start: this.photos,
            end: this.endPhotos,
            supervision: this.supervisionPhotos
        };

        const targetFiles = fileCollections[type];
        const targetPreviews = previewCollections[type];

        if (!targetFiles || !targetPreviews) {
            return;
        }

        if (type === 'supervision') {
            this.clearSupervisionRegisterRetryState();
        }

        targetFiles[area] = file;
        const previewUrl = this.services.images.createObjectUrl(file);
        if (!previewUrl) {
            throw new Error('No fue posible preparar la vista previa de la imagen.');
        }

        this.services.images.replaceInMap(targetPreviews, area, previewUrl);
        this.updatePhotoSlot(area, type, previewUrl);

        if (type === 'start') {
            this.queueUiRender('employee-photo-progress');
        }

        if (type === 'end') {
            this.syncShiftCompletionTaskCard();
        }
    },

    handlePhotoUpload(event) {
        const file = event.target.files?.[0];
        if (!file || !this.currentPhotoArea) {
            return;
        }

        void this.processPhotoFile(file, 'start', this.currentPhotoArea).catch((error) => {
            this.showToast(this.getErrorMessage(error, 'No fue posible procesar la imagen.'), {
                tone: 'error',
                title: 'Error de imagen'
            });
        });
        event.target.value = '';
    },

    handleEndPhotoUpload(event) {
        const file = event.target.files?.[0];
        if (!file || !this.currentPhotoArea) {
            return;
        }

        void this.processPhotoFile(file, 'end', this.currentPhotoArea).catch((error) => {
            this.showToast(this.getErrorMessage(error, 'No fue posible procesar la imagen final.'), {
                tone: 'error',
                title: 'Error de imagen'
            });
        });
        event.target.value = '';
    },

    handleSupervisionPhotoUpload(event) {
        const file = event.target.files?.[0];
        if (!file || !this.currentPhotoArea) {
            return;
        }

        void this.processPhotoFile(file, 'supervision', this.currentPhotoArea).catch((error) => {
            this.showToast(this.getErrorMessage(error, 'No fue posible procesar la evidencia de supervisión.'), {
                tone: 'error',
                title: 'Error de imagen'
            });
        });
        event.target.value = '';
    },

    triggerSpecialTaskEvidenceCapture() {
        const taskSlot = {
            key: 'special_task_evidence',
            title: 'evidencia de tarea especial',
            groupLabel: 'tarea_especial',
            subareaLabel: 'evidencia'
        };

        void this.openCameraCapture({ slot: taskSlot, type: 'task' }).catch((error) => {
            console.warn('No fue posible abrir la cámara para la tarea especial. Se usará selector de archivo.', error);
            const input = document.getElementById('special-task-evidence-input');
            if (input) {
                input.click();
                return;
            }

            this.showToast(this.getErrorMessage(error, 'No fue posible abrir la cámara para la tarea especial.'), {
                tone: 'error',
                title: 'Cámara no disponible'
            });
        });
    },

    setSpecialTaskEvidenceFile(file) {
        if (!file) {
            return false;
        }

        this.specialTaskEvidenceFile = file;
        this.services.images.revokeObjectUrl(this.specialTaskEvidencePreview);
        const previewUrl = this.services.images.createObjectUrl(file);
        if (!previewUrl) {
            this.showToast('No fue posible leer la foto seleccionada para la tarea especial.', {
                tone: 'error',
                title: 'Error de evidencia'
            });
            return false;
        }

        this.specialTaskEvidencePreview = previewUrl;
        this.updateSpecialTaskEvidenceUI();
        this.syncShiftCompletionTaskCard();
        return true;
    },

    handleSpecialTaskEvidenceUpload(event) {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        this.setSpecialTaskEvidenceFile(file);

        event.target.value = '';
    },

    updateSpecialTaskEvidenceUI() {
        const status = document.getElementById('special-task-evidence-status');
        const preview = document.getElementById('special-task-evidence-preview');
        const hasEvidence = Boolean(this.specialTaskEvidenceFile);

        if (status) {
            status.className = `badge ${hasEvidence ? 'badge-success' : 'badge-warning'}`;
            status.textContent = hasEvidence ? 'Foto adjunta' : 'Sin foto';
        }

        if (preview) {
            if (hasEvidence && this.specialTaskEvidencePreview) {
                preview.src = this.specialTaskEvidencePreview;
                preview.classList.remove('hidden');
            } else {
                preview.src = '';
                preview.classList.add('hidden');
            }
        }
    },

    updatePhotoSlot(area, type, source) {
        const slot = document.getElementById(`slot-${type}-${areaDomId(area)}`);
        if (!slot) {
            return;
        }

        slot.className = 'photo-slot has-image';
        const descriptor = this.getPhotoSlotDefinition(area, type);
        slot.dataset.action = 'select-photo-area';
        slot.dataset.slotKey = area;
        slot.dataset.photoType = type;

        slot.querySelectorAll('.photo-slot-label').forEach((node) => node.remove());
        const cameraIcon = slot.querySelector('i.fas.fa-camera');
        if (cameraIcon) {
            cameraIcon.remove();
        }

        let image = slot.querySelector('img');
        if (!image) {
            image = document.createElement('img');
            slot.prepend(image);
        }

        const altText = descriptor?.title || area;
        if (image.getAttribute('src') !== source) {
            image.src = source;
        }
        if (image.alt !== altText) {
            image.alt = altText;
        }

        let overlay = slot.querySelector('.photo-slot-overlay-label');
        if (!overlay) {
            overlay = document.createElement('span');
            overlay.className = 'photo-slot-overlay-label';
            slot.appendChild(overlay);
        }

        const overlayText = descriptor?.subareaLabel || area;
        if (overlay.textContent !== overlayText) {
            overlay.textContent = overlayText;
        }
    },

    renderSupervisorPhotoGrid() {
        this.queueUiRender('supervisor-photo-grid');
    },

    renderSupervisorPhotoGridNow() {
        const grid = document.getElementById('supervision-photo-grid');
        if (!grid) {
            return;
        }

        const availableAreas = this.getSupervisorAvailableAreas();
        const selectedArea = this.selectedSupervisorArea
            && availableAreas.some((areaLabel) => normalizeAreaToken(areaLabel) === normalizeAreaToken(this.selectedSupervisorArea))
            ? this.selectedSupervisorArea
            : '';
        const visibleAreas = selectedArea ? [selectedArea] : [];

        this.supervisionPhotoCatalog = this.buildPhotoSlotDefinitions(availableAreas);
        this.supervisionPhotoSlots = this.buildPhotoSlotDefinitions(visibleAreas);
        const validSlotKeys = new Set(this.supervisionPhotoCatalog.map((slot) => slot.key));
        Object.keys(this.supervisionPhotos || {}).forEach((slotKey) => {
            if (!validSlotKeys.has(slotKey)) {
                this.services.images.removeFromMap(this.supervisionPhotos, slotKey);
            }
        });
        Object.keys(this.supervisionPhotoFiles || {}).forEach((slotKey) => {
            if (!validSlotKeys.has(slotKey)) {
                delete this.supervisionPhotoFiles[slotKey];
            }
        });

        this.renderPhotoGridForTypeNow(
            'supervision-photo-grid',
            'supervision',
            this.supervisionPhotoSlots,
            availableAreas.length > 0
                ? 'Selecciona un área para ver las subáreas de supervisión requeridas.'
                : 'No hay áreas configuradas para este restaurante.'
        );

        Object.entries(this.supervisionPhotos).forEach(([area, source]) => {
            if (this.supervisionPhotoSlots.some((slot) => slot.key === area)) {
                this.updatePhotoSlot(area, 'supervision', source);
            }
        });
    },

    updateProgress() {
        this.queueUiRender('employee-photo-progress');
    },

    updateProgressNow() {
        const progress = this.getStartEvidenceProgressSnapshot();
        const count = progress.completedCount;
        const total = progress.requiredCount;
        const percentage = total === 0 ? 100 : (count / total) * 100;
        const requireStartPhotos = this.getSystemSetting('evidence.require_start_photos', DEFAULT_SYSTEM_SETTINGS.evidence.require_start_photos);

        const progressElement = document.getElementById('photo-progress');
        const countElement = document.getElementById('photos-count');
        const button = document.getElementById('start-cleaning-btn');

        if (progressElement) {
            progressElement.style.width = `${percentage}%`;
        }

        if (countElement) {
            countElement.textContent = String(count);
        }

        if (button) {
            button.disabled = total === 0 ? false : (requireStartPhotos ? count < total : false);
        }
    },

    resetShiftState() {
        this.services.images.clearMap(this.photos);
        this.services.images.clearMap(this.endPhotos);
        this.services.images.clearMap(this.supervisionPhotos);
        this.services.images.revokeObjectUrl(this.specialTaskEvidencePreview);

        this.photos = {};
        this.endPhotos = {};
        this.photoFiles = {};
        this.endPhotoFiles = {};
        this.specialTaskEvidenceFile = null;
        this.specialTaskEvidencePreview = '';
        this.supervisionPhotos = {};
        this.supervisionPhotoFiles = {};
        this.uploadedStartAreas = {};
        this.uploadedEndAreas = {};
        this.currentPhotoArea = null;
        this.currentPhotoContext = null;
        this.currentPhotoType = 'start';
        this.gpsVerified = false;
        this.healthCertified = false;
        this.location = null;
        this.locationAddress = '';
        this.locationAddressKey = '';
        this.timerSeconds = 0;
        this.timerStartTimeMs = Number.NaN;
        this.cleaningAreaGroups = {};
        this.selectedEmployeeAreas = [];
        this.activeEmployeeArea = '';

        const gpsStatus = document.getElementById('gps-status');
        const gpsButton = document.getElementById('gps-btn');
        const continueButton = document.getElementById('continue-btn');
        const healthCheckbox = document.getElementById('health-cert');
        const startCleaningButton = document.getElementById('start-cleaning-btn');
        const photoCount = document.getElementById('photos-count');
        const photoProgress = document.getElementById('photo-progress');
        const timer = document.getElementById('cleaning-timer');
        const specialTaskCheckbox = document.getElementById('special-task-done');
        const specialTaskNotes = document.getElementById('special-task-notes');
        const specialTaskEvidenceInput = document.getElementById('special-task-evidence-input');
        const earlyEndReason = document.getElementById('early-end-reason');
        const earlyEndCard = document.getElementById('shift-early-end-card');

        if (gpsStatus) {
            gpsStatus.className = 'gps-status invalid';
            gpsStatus.innerHTML = '<i class="fas fa-location-crosshairs"></i><span>Ubicación lista para verificar</span>';
        }

        if (gpsButton) {
            gpsButton.disabled = false;
            gpsButton.innerHTML = '<i class="fas fa-location-crosshairs"></i> Verificar ubicación';
        }

        if (continueButton) {
            continueButton.disabled = true;
        }

        if (healthCheckbox) {
            healthCheckbox.checked = false;
        }

        if (startCleaningButton) {
            startCleaningButton.disabled = true;
        }

        if (photoCount) {
            photoCount.textContent = '0';
        }

        if (photoProgress) {
            photoProgress.style.width = '0%';
        }

        if (timer) {
            timer.textContent = '00:00:00';
        }

        if (specialTaskCheckbox) {
            specialTaskCheckbox.checked = false;
        }

        if (specialTaskNotes) {
            specialTaskNotes.value = '';
        }

        if (specialTaskEvidenceInput) {
            specialTaskEvidenceInput.value = '';
        }

        if (earlyEndReason) {
            earlyEndReason.value = '';
        }

        if (earlyEndCard) {
            earlyEndCard.classList.add('hidden');
        }

        this.renderEmployeeAreaSelectors();
        this.renderPhotoGrids();
        this.updateProgress();
        this.updateSpecialTaskEvidenceUI();
    },

    getEmployeePendingScheduledShift(shifts = []) {
        const now = Date.now();
        const closedStates = new Set(['cancelado', 'cancelled', 'completed', 'completado', 'finalizado', 'finished', 'closed', 'done']);

        const candidates = asArray(shifts)
            .filter(Boolean)
            .map((shift) => {
                const status = String(shift?.status || shift?.state || '').toLowerCase();
                if (closedStates.has(status)) {
                    return null;
                }

                const startValue = shift?.scheduled_start || shift?.start_time;
                const endValue = shift?.scheduled_end || shift?.end_time;
                const startDate = startValue ? new Date(startValue) : null;
                const endDate = endValue ? new Date(endValue) : null;
                const startMs = startDate && !Number.isNaN(startDate.getTime()) ? startDate.getTime() : Number.NaN;
                const endMs = endDate && !Number.isNaN(endDate.getTime()) ? endDate.getTime() : Number.NaN;

                if (Number.isFinite(endMs) && endMs < now) {
                    return null;
                }

                if (!Number.isFinite(endMs) && Number.isFinite(startMs) && startMs < (now - (12 * 60 * 60 * 1000))) {
                    return null;
                }

                if (!Boolean(shift?.id || shift?.scheduled_shift_id || startValue || endValue)) {
                    return null;
                }

                return {
                    shift,
                    startMs,
                    endMs
                };
            })
            .filter(Boolean)
            .sort((left, right) => {
                const leftHasStart = Number.isFinite(left.startMs);
                const rightHasStart = Number.isFinite(right.startMs);

                if (leftHasStart && !rightHasStart) {
                    return -1;
                }

                if (!leftHasStart && rightHasStart) {
                    return 1;
                }

                const leftIsFuture = leftHasStart && left.startMs >= now;
                const rightIsFuture = rightHasStart && right.startMs >= now;

                if (leftIsFuture !== rightIsFuture) {
                    return leftIsFuture ? -1 : 1;
                }

                if (leftIsFuture && rightIsFuture) {
                    return left.startMs - right.startMs;
                }

                if (leftHasStart && rightHasStart) {
                    return right.startMs - left.startMs;
                }

                const leftEnd = Number.isFinite(left.endMs) ? left.endMs : Number.MAX_SAFE_INTEGER;
                const rightEnd = Number.isFinite(right.endMs) ? right.endMs : Number.MAX_SAFE_INTEGER;
                return leftEnd - rightEnd;
            });

        return candidates[0]?.shift || null;
    },

    getEmployeeShiftStartWindowState(shift, now = Date.now()) {
        const startWindow = shift?.start_window || shift?.startWindow || null;

        if (!startWindow || typeof startWindow !== 'object') {
            return {
                tooEarly: false,
                expired: false,
                withinWindow: true,
                hasWindowContract: false,
                earliest: '',
                latest: '',
                serverNow: ''
            };
        }

        const normalizeDateValue = (value) => {
            const candidate = value ? new Date(value) : null;
            return candidate && !Number.isNaN(candidate.getTime()) ? candidate.getTime() : Number.NaN;
        };

        const earliest = String(startWindow.earliest || startWindow.start || '').trim();
        const latest = String(startWindow.latest || startWindow.end || '').trim();
        const serverNow = String(startWindow.server_now || startWindow.serverNow || '').trim();
        const earliestMs = normalizeDateValue(earliest);
        const latestMs = normalizeDateValue(latest);
        const referenceNowMs = normalizeDateValue(serverNow);
        const nowMs = Number.isFinite(referenceNowMs) ? referenceNowMs : now;
        const rawCanStart = startWindow.can_start_now ?? startWindow.canStartNow;
        const hasExplicitCanStart = typeof rawCanStart === 'boolean';

        if (Number.isFinite(earliestMs) && Number.isFinite(latestMs)) {
            const tooEarly = nowMs < earliestMs;
            const expired = nowMs > latestMs;
            return {
                tooEarly,
                expired,
                withinWindow: !tooEarly && !expired,
                hasWindowContract: true,
                earliest,
                latest,
                serverNow
            };
        }

        if (hasExplicitCanStart) {
            return {
                tooEarly: false,
                expired: !rawCanStart,
                withinWindow: rawCanStart,
                hasWindowContract: true,
                earliest,
                latest,
                serverNow
            };
        }

        return {
            tooEarly: false,
            expired: false,
            withinWindow: true,
            hasWindowContract: false,
            earliest,
            latest,
            serverNow
        };
    },

    getShiftStartWindowCopy(shift) {
        const state = this.getEmployeeShiftStartWindowState(shift);
        const earliestLabel = formatDateTime(state?.earliest);
        const latestLabel = formatDateTime(state?.latest);

        if (earliestLabel !== '-' && latestLabel !== '-') {
            return `Tu turno se habilita entre ${earliestLabel} y ${latestLabel}.`;
        }

        return 'Tu turno se habilita solo dentro de la ventana configurada por operación.';
    },

    canEmployeeStartScheduledShift(scheduledShift = this.data.currentScheduledShift, dashboard = this.data.employee.dashboard || {}) {
        if (!scheduledShift?.id) {
            return false;
        }

        // Time window is the source of truth on the client to avoid stale can_start_shift flags.
        return this.getEmployeeShiftStartWindowState(scheduledShift).withinWindow;
    },

    normalizeShiftEvidenceSummary(summary = {}) {
        const source = summary?.summary && typeof summary.summary === 'object'
            ? summary.summary
            : summary;
        const counts = source?.counts && typeof source.counts === 'object'
            ? source.counts
            : {};

        const startCount = Number(
            source?.start_evidence_count
            ?? source?.startEvidenceCount
            ?? counts?.inicio
            ?? counts?.start
            ?? 0
        );
        const endCount = Number(
            source?.end_evidence_count
            ?? source?.endEvidenceCount
            ?? counts?.fin
            ?? counts?.end
            ?? 0
        );

        const hasStartEvidence = source?.has_start_evidence ?? source?.has_start ?? source?.hasStartEvidence;
        const hasEndEvidence = source?.has_end_evidence ?? source?.has_end ?? source?.hasEndEvidence;

        return {
            has_start_evidence: hasStartEvidence === true || (Number.isFinite(startCount) && startCount > 0),
            has_end_evidence: hasEndEvidence === true || (Number.isFinite(endCount) && endCount > 0),
            start_evidence_count: Number.isFinite(startCount) ? startCount : 0,
            end_evidence_count: Number.isFinite(endCount) ? endCount : 0
        };
    },

    mergeShiftEvidenceSummary(targetShift = {}, summary = {}) {
        return {
            ...targetShift,
            has_start_evidence: summary.has_start_evidence === true,
            has_end_evidence: summary.has_end_evidence === true,
            start_evidence_count: Number(summary.start_evidence_count || 0),
            end_evidence_count: Number(summary.end_evidence_count || 0)
        };
    },

    async refreshCurrentActiveShift() {
        const activeShiftId = normalizeRestaurantId(
            this.data.currentShift?.id
            || this.data.employee.dashboard?.active_shift?.id
        );
        if (activeShiftId == null) {
            return this.data.currentShift || null;
        }

        try {
            const activeShiftPayload = await apiClient.getEmployeeActiveShift();
            const activeShiftCandidate = activeShiftPayload?.active_shift
                || activeShiftPayload?.shift
                || activeShiftPayload?.data?.active_shift
                || activeShiftPayload?.data?.shift
                || activeShiftPayload;

            const activeShift = this.enrichEmployeeShiftRecord(activeShiftCandidate, this.data.employee.dashboard);
            if (activeShift?.id) {
                this.data.currentShift = activeShift;
                if (this.data.employee.dashboard && typeof this.data.employee.dashboard === 'object') {
                    this.data.employee.dashboard.active_shift = activeShift;
                }
            }
        } catch (error) {
            console.warn('No fue posible refrescar my_active_shift.', error);
        }

        return this.data.currentShift || null;
    },

    async hydrateShiftEvidenceSummary(shift = this.data.currentShift) {
        const shiftId = normalizeRestaurantId(shift?.id);
        if (shiftId == null) {
            return shift || null;
        }

        const hasDirectEvidenceFields = [
            shift?.has_start_evidence,
            shift?.has_end_evidence,
            shift?.start_evidence_count,
            shift?.end_evidence_count
        ].some((value) => value != null);

        if (hasDirectEvidenceFields) {
            return shift;
        }

        try {
            const summaryPayload = await apiClient.getShiftEvidenceSummary(shiftId);
            const summary = this.normalizeShiftEvidenceSummary(summaryPayload);
            const mergedShift = this.mergeShiftEvidenceSummary(shift, summary);
            this.data.currentShift = mergedShift;
            if (this.data.employee.dashboard && typeof this.data.employee.dashboard === 'object') {
                this.data.employee.dashboard.active_shift = mergedShift;
            }
            return mergedShift;
        } catch (error) {
            console.warn('No fue posible obtener summary_by_shift para el turno activo.', error);
            return shift;
        }
    },

    hasShiftEvidenceForPhase(shift, phase = 'start') {
        if (!shift || typeof shift !== 'object') {
            return false;
        }

        const normalizedPhase = phase === 'end' ? 'end' : 'start';
        const isStartPhase = normalizedPhase === 'start';
        const booleanCandidates = isStartPhase
            ? [
                shift.has_start_evidence,
                shift.hasStartEvidence,
                shift.start_photos_uploaded,
                shift.startPhotosUploaded,
                shift.has_initial_evidence,
                shift.hasInitialEvidence,
                shift?.evidence_summary?.has_start,
                shift?.evidence_summary?.hasStart
            ]
            : [
                shift.has_end_evidence,
                shift.hasEndEvidence,
                shift.end_photos_uploaded,
                shift.endPhotosUploaded,
                shift.has_final_evidence,
                shift.hasFinalEvidence,
                shift?.evidence_summary?.has_end,
                shift?.evidence_summary?.hasEnd
            ];

        if (booleanCandidates.some((value) => value === true)) {
            return true;
        }

        const numericCandidates = isStartPhase
            ? [
                shift.start_evidence_count,
                shift.startEvidenceCount,
                shift.start_photos_count,
                shift.startPhotosCount,
                shift.initial_evidence_count,
                shift.initialEvidenceCount,
                shift?.evidence_summary?.start_count,
                shift?.evidence_summary?.startCount,
                shift?.evidence_summary?.inicio_count
            ]
            : [
                shift.end_evidence_count,
                shift.endEvidenceCount,
                shift.end_photos_count,
                shift.endPhotosCount,
                shift.final_evidence_count,
                shift.finalEvidenceCount,
                shift?.evidence_summary?.end_count,
                shift?.evidence_summary?.endCount,
                shift?.evidence_summary?.fin_count
            ];

        if (numericCandidates.some((value) => Number.isFinite(Number(value)) && Number(value) > 0)) {
            return true;
        }

        return this.extractShiftEvidenceItems(shift, normalizedPhase).length > 0;
    },

    shouldResumeActiveShiftInCleaning(shift = this.data.currentShift) {
        if (!shift?.id) {
            return false;
        }

        const requireStartPhotos = this.getSystemSetting(
            'evidence.require_start_photos',
            DEFAULT_SYSTEM_SETTINGS.evidence.require_start_photos
        );

        if (!requireStartPhotos) {
            return true;
        }

        const requiredStartEvidenceCount = Number(
            shift?.required_start_evidence_count
            ?? shift?.requiredStartEvidenceCount
            ?? 0
        );

        const startEvidenceCount = Number(
            shift?.start_evidence_count
            ?? shift?.startEvidenceCount
            ?? 0
        );

        if (Number.isFinite(startEvidenceCount) && startEvidenceCount > 0) {
            if (Number.isFinite(requiredStartEvidenceCount) && requiredStartEvidenceCount > 0) {
                return startEvidenceCount >= requiredStartEvidenceCount;
            }

            return true;
        }

        if (shift?.has_start_evidence === true || shift?.hasStartEvidence === true) {
            return true;
        }

        if (
            Number.isFinite(requiredStartEvidenceCount)
            && requiredStartEvidenceCount > 0
            && (!Number.isFinite(startEvidenceCount) || startEvidenceCount <= 0)
        ) {
            return false;
        }

        if (Number.isFinite(requiredStartEvidenceCount) && requiredStartEvidenceCount > 0) {
            return false;
        }

        return this.hasShiftEvidenceForPhase(shift, 'start');
    },

    getStartEvidenceProgressSnapshot(shift = this.data.currentShift) {
        const requiredFromShift = Number(
            shift?.required_start_evidence_count
            ?? shift?.requiredStartEvidenceCount
            ?? Number.NaN
        );
        const requiredBySlots = this.employeePhotoSlots.length;
        const requiredCount = Number.isFinite(requiredFromShift) && requiredFromShift > 0
            ? Math.max(0, requiredFromShift)
            : Math.max(0, requiredBySlots);

        const existingCountRaw = Number(
            shift?.start_evidence_count
            ?? shift?.startEvidenceCount
            ?? 0
        );
        const existingCount = Number.isFinite(existingCountRaw) && existingCountRaw > 0
            ? existingCountRaw
            : 0;

        const newEvidenceCount = Object.keys(this.photoFiles || {}).length;
        const normalizedExisting = requiredCount > 0 ? Math.min(existingCount, requiredCount) : existingCount;
        const completedCount = requiredCount > 0
            ? Math.min(normalizedExisting + newEvidenceCount, requiredCount)
            : (normalizedExisting + newEvidenceCount);
        const remainingCount = Math.max(requiredCount - completedCount, 0);

        return {
            requiredCount,
            existingCount: normalizedExisting,
            newEvidenceCount,
            completedCount,
            remainingCount
        };
    },

    getEmployeeAssignedRestaurants(dashboard = this.data.employee.dashboard || {}) {
        return asArray(dashboard?.assigned_restaurants)
            .map((item) => item?.restaurant || item || null)
            .filter((restaurant) => getRestaurantRecordId(restaurant) != null);
    },

    resolveEmployeeRestaurantRecord(restaurantId, dashboard = this.data.employee.dashboard || {}) {
        const normalizedRestaurantId = normalizeRestaurantId(restaurantId);
        if (normalizedRestaurantId == null) {
            return null;
        }

        const scheduledRestaurant = asArray(dashboard?.scheduled_shifts)
            .map((item) => item?.restaurant || null)
            .find((restaurant) => String(getRestaurantRecordId(restaurant)) === String(normalizedRestaurantId));

        if (scheduledRestaurant) {
            return scheduledRestaurant;
        }

        return this.getEmployeeAssignedRestaurants(dashboard)
            .find((restaurant) => String(getRestaurantRecordId(restaurant)) === String(normalizedRestaurantId)) || null;
    },

    getEmployeeShiftRestaurantRecord(shift, dashboard = this.data.employee.dashboard || {}) {
        if (!shift) {
            return null;
        }

        if (shift?.restaurant && typeof shift.restaurant === 'object') {
            const directRestaurant = shift.restaurant;
            const hasRestaurantId = getRestaurantRecordId(directRestaurant) != null;
            const hasRestaurantName = Boolean(pickMeaningfulRestaurantName([
                directRestaurant?.restaurant_name,
                directRestaurant?.restaurant_visible_name,
                directRestaurant?.restaurant_label,
                directRestaurant?.name,
                directRestaurant?.display_name,
                directRestaurant?.label,
                directRestaurant?.title
            ], directRestaurant));

            if (hasRestaurantId || hasRestaurantName) {
                return directRestaurant;
            }
        }

        const shiftRestaurantId = normalizeRestaurantId(
            shift?.restaurant_id
            || shift?.restaurant?.restaurant_id
            || shift?.restaurant?.id
            || shift?.location_id
            || shift?.location?.id
            || shift?.site_id
            || shift?.site?.id
        );

        if (shiftRestaurantId != null) {
            const resolvedById = this.resolveEmployeeRestaurantRecord(shiftRestaurantId, dashboard)
                || this.getKnownRestaurantRecord(shiftRestaurantId);
            if (resolvedById) {
                return resolvedById;
            }
        }

        const scheduledShiftId = normalizeRestaurantId(shift?.scheduled_shift_id || shift?.id);
        if (scheduledShiftId != null) {
            const scheduledMatch = asArray(dashboard?.scheduled_shifts)
                .find((item) => String(normalizeRestaurantId(item?.id || item?.scheduled_shift_id)) === String(scheduledShiftId));

            if (scheduledMatch?.restaurant) {
                return scheduledMatch.restaurant;
            }

            const scheduledRestaurantId = normalizeRestaurantId(scheduledMatch?.restaurant_id || scheduledMatch?.restaurant?.id);
            if (scheduledRestaurantId != null) {
                const resolvedScheduledRestaurant = this.resolveEmployeeRestaurantRecord(scheduledRestaurantId, dashboard)
                    || this.getKnownRestaurantRecord(scheduledRestaurantId);
                if (resolvedScheduledRestaurant) {
                    return resolvedScheduledRestaurant;
                }
            }
        }

        const fallbackMatch = this.findEmployeeScheduledMatchForActiveShift(shift, dashboard);
        if (fallbackMatch?.restaurant) {
            return fallbackMatch.restaurant;
        }

        const fallbackRestaurantId = normalizeRestaurantId(fallbackMatch?.restaurant_id || fallbackMatch?.restaurant?.id);
        if (fallbackRestaurantId != null) {
            return this.resolveEmployeeRestaurantRecord(fallbackRestaurantId, dashboard)
                || this.getKnownRestaurantRecord(fallbackRestaurantId)
                || null;
        }

        return null;
    },

    getEmployeeResolvedShiftRestaurantName(shift, fallback = 'Restaurante asignado') {
        if (!shift) {
            return fallback;
        }

        const dashboard = this.data.employee.dashboard || {};
        const restaurant = this.getEmployeeShiftRestaurantRecord(shift, dashboard);
        const restaurantId = normalizeRestaurantId(
            shift?.restaurant_id
            || restaurant?.restaurant_id
            || restaurant?.id
            || shift?.location_id
            || shift?.site_id
        );

        const resolvedName = this.getResolvedShiftRestaurantName(
            {
                ...shift,
                restaurant,
                restaurant_id: restaurantId ?? shift?.restaurant_id ?? null
            },
            fallback
        );

        if (
            resolvedName
            && !isGenericNamedPlaceholder(resolvedName, 'restaurant')
            && resolvedName !== 'Restaurante sin nombre visible'
            && !isRestaurantReferenceLabel(resolvedName)
        ) {
            this.persistShiftRestaurantName(shift, resolvedName);
            return resolvedName;
        }

        const strictRestaurant = restaurantId != null
            ? (
                this.resolveEmployeeRestaurantRecord(restaurantId, dashboard)
                || this.getKnownRestaurantRecord(restaurantId)
            )
            : null;
        const strictRestaurantName = getRestaurantDisplayName(strictRestaurant, '').trim();
        if (strictRestaurantName && !isGenericNamedPlaceholder(strictRestaurantName, 'restaurant') && strictRestaurantName !== 'Restaurante sin nombre visible') {
            this.persistShiftRestaurantName(shift, strictRestaurantName);
            return strictRestaurantName;
        }

        const persistedName = this.getPersistedShiftRestaurantName(shift);
        if (persistedName) {
            return persistedName;
        }

        return isRestaurantReferenceLabel(resolvedName) ? 'Restaurante asignado' : resolvedName;
    },

    findEmployeeScheduledMatchForActiveShift(activeShift, dashboard = this.data.employee.dashboard || {}) {
        if (!activeShift) {
            return null;
        }

        const shifts = asArray(dashboard?.scheduled_shifts).filter(Boolean);
        if (shifts.length === 0) {
            return null;
        }

        const directScheduledId = normalizeRestaurantId(activeShift?.scheduled_shift_id);
        if (directScheduledId != null) {
            const directMatch = shifts.find((shift) => String(normalizeRestaurantId(shift?.id || shift?.scheduled_shift_id)) === String(directScheduledId));
            if (directMatch) {
                return directMatch;
            }
        }

        const activeRestaurantId = normalizeRestaurantId(activeShift?.restaurant_id || activeShift?.restaurant?.id);
        const activeStartAt = new Date(activeShift?.start_time || activeShift?.started_at || 0).getTime();

        const rankedMatches = shifts.map((shift) => {
            let score = 0;

            const candidateRestaurantId = normalizeRestaurantId(shift?.restaurant_id || shift?.restaurant?.id);
            const candidateStartAt = new Date(shift?.scheduled_start || shift?.start_time || 0).getTime();
            const candidateEndAt = new Date(shift?.scheduled_end || shift?.end_time || 0).getTime();

            if (activeRestaurantId != null && candidateRestaurantId != null && String(candidateRestaurantId) === String(activeRestaurantId)) {
                score += 100;
            }

            if (Number.isFinite(activeStartAt) && activeStartAt > 0) {
                if (
                    Number.isFinite(candidateStartAt)
                    && candidateStartAt > 0
                    && Number.isFinite(candidateEndAt)
                    && candidateEndAt > 0
                    && activeStartAt >= (candidateStartAt - (12 * 60 * 60 * 1000))
                    && activeStartAt <= (candidateEndAt + (12 * 60 * 60 * 1000))
                ) {
                    score += 80;
                }

                if (Number.isFinite(candidateStartAt) && candidateStartAt > 0) {
                    const distanceHours = Math.abs(activeStartAt - candidateStartAt) / 3600000;
                    score += Math.max(0, 24 - Math.floor(distanceHours));
                }
            }

            if (String(shift?.status || '').toLowerCase() === 'scheduled') {
                score += 5;
            }

            return { shift, score };
        });

        rankedMatches.sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }

            const leftDate = new Date(left.shift?.scheduled_start || left.shift?.start_time || 0).getTime();
            const rightDate = new Date(right.shift?.scheduled_start || right.shift?.start_time || 0).getTime();
            return leftDate - rightDate;
        });

        return rankedMatches[0]?.shift || null;
    },

    enrichEmployeeShiftRecord(shift, dashboard = this.data.employee.dashboard || {}) {
        if (!shift) {
            return null;
        }

        const scheduledMatch = shift?.scheduled_start || shift?.scheduled_end
            ? shift
            : this.findEmployeeScheduledMatchForActiveShift(shift, dashboard);
        const restaurant = shift?.restaurant
            || scheduledMatch?.restaurant
            || this.resolveEmployeeRestaurantRecord(shift?.restaurant_id || scheduledMatch?.restaurant_id, dashboard)
            || null;

        return {
            ...(scheduledMatch || {}),
            ...(shift || {}),
            restaurant,
            restaurant_id: normalizeRestaurantId(
                shift?.restaurant_id
                ?? scheduledMatch?.restaurant_id
                ?? getRestaurantRecordId(restaurant)
            ),
            restaurant_name: getRestaurantDisplayName(restaurant, shift?.restaurant_name || scheduledMatch?.restaurant_name || ''),
            scheduled_start: shift?.scheduled_start || scheduledMatch?.scheduled_start || null,
            scheduled_end: shift?.scheduled_end || scheduledMatch?.scheduled_end || null,
            scheduled_hours: getScheduledHours(shift) || getScheduledHours(scheduledMatch) || 0
        };
    },

    getEmployeeShiftScheduleText(shift, { hasActiveShift = false } = {}) {
        if (!shift) {
            return 'No hay horario pendiente';
        }

        const scheduledStart = shift?.scheduled_start || null;
        const scheduledEnd = shift?.scheduled_end || null;
        const actualStart = shift?.start_time || shift?.started_at || null;

        if (scheduledStart && scheduledEnd) {
            const rangeText = formatShiftRange(scheduledStart, scheduledEnd);
            const dateText = formatDate(scheduledStart, {
                weekday: 'long',
                day: '2-digit',
                month: 'long',
                year: 'numeric'
            });
            if (hasActiveShift && actualStart) {
                return `${dateText} • ${rangeText} • iniciado ${formatTime(actualStart)}`;
            }

            return `${dateText} • ${rangeText}`;
        }

        if (hasActiveShift && actualStart) {
            return `Turno iniciado a las ${formatTime(actualStart)}`;
        }

        if (scheduledStart) {
            return `Programado para ${formatDateTime(scheduledStart)}`;
        }

        return 'Horario pendiente de confirmar';
    },

    getEmployeeShiftDateText(shift) {
        if (!shift) {
            return 'No hay fecha pendiente';
        }

        const shiftDate = shift?.scheduled_start || shift?.start_time || shift?.started_at || null;
        if (!shiftDate) {
            return 'No hay fecha pendiente';
        }

        return formatDate(shiftDate, {
            weekday: 'long',
            day: '2-digit',
            month: 'long',
            year: 'numeric'
        });
    },

    renderEmployeeDashboard() {
        const dashboard = this.data.employee.dashboard || {};
        const shift = this.data.currentShift || this.data.currentScheduledShift;
        const hasActiveShift = Boolean(this.data.currentShift?.id);
        const hasPendingShift = Boolean(this.data.currentScheduledShift);
        const canStartShift = !hasActiveShift
            && this.canEmployeeStartScheduledShift(this.data.currentScheduledShift, dashboard);
        const justCompletedShift = !hasActiveShift && !hasPendingShift ? this.data.employee.lastCompletedShift : null;
        const restaurant = this.getEmployeeShiftRestaurantRecord(shift, dashboard);
        const shiftReferenceDate = shift?.scheduled_start || shift?.start_time || null;
        const isShiftToday = shiftReferenceDate
            ? (new Date(shiftReferenceDate)).toDateString() === (new Date()).toDateString()
            : false;
        const resolvedRestaurantName = shift
            ? this.getEmployeeResolvedShiftRestaurantName(shift, 'Restaurante programado')
            : '';

        if (hasActiveShift || hasPendingShift) {
            this.data.employee.lastCompletedShift = null;
        }

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

        this.restoreCurrentShiftAreaSelection({
            fallbackToAllAvailable: hasActiveShift
        });

        let shiftTitle = 'Turno de Hoy';
        let shiftHelper = 'Aquí verás el estado real de tu turno y cuándo puedes iniciarlo o continuarlo.';
        let shiftStatus = 'Programado';
        let restaurantName = 'No tienes turnos pendientes';
        let restaurantAddress = this.getEmployeeCurrentLocationText();
        let scheduleText = 'No hay horario pendiente';
        const activeStateLabel = dashboard?.active_shift?.state || this.data.currentShift?.state || 'Activo';

        if (hasActiveShift) {
            shiftTitle = 'Turno en Progreso';
            shiftHelper = 'Ya registraste el inicio de tu turno. Desde aquí puedes continuarlo y completar las evidencias pendientes.';
            shiftStatus = `Turno ${String(activeStateLabel).toLowerCase()}`;
            restaurantName = resolvedRestaurantName;
            scheduleText = this.getEmployeeShiftScheduleText(shift, { hasActiveShift: true });
        } else if (canStartShift) {
            shiftTitle = isShiftToday ? 'Turno de Hoy' : 'Próximo Turno';
            shiftHelper = 'Tienes un turno dentro del horario permitido para iniciar. Revisa la información y continúa cuando estés en el restaurante.';
            shiftStatus = 'Listo para iniciar';
            restaurantName = resolvedRestaurantName;
            scheduleText = this.getEmployeeShiftScheduleText(shift);
        } else if (hasPendingShift) {
            shiftTitle = isShiftToday ? 'Turno Programado' : 'Próximo Turno';
            shiftHelper = isShiftToday
                ? this.getShiftStartWindowCopy(shift)
                : 'Ya tienes un próximo turno asignado. Aquí verás sus datos cuando se acerque la hora de inicio.';
            shiftStatus = 'Programado';
            restaurantName = resolvedRestaurantName;
            scheduleText = this.getEmployeeShiftScheduleText(shift);
        } else if (justCompletedShift) {
            shiftTitle = 'Turno Finalizado';
            shiftHelper = 'No tienes más turnos pendientes por ahora. Cuando te asignen uno nuevo, aparecerá aquí.';
            shiftStatus = 'Finalizado';
            restaurantName = this.getResolvedShiftRestaurantName(justCompletedShift, 'Turno finalizado correctamente');
        } else {
            shiftTitle = 'Sin Turno Programado';
            shiftHelper = '';
            shiftStatus = 'Sin turno';
        }
        const task = this.getPrimaryEmployeeTask();

        const shiftTitleElement = document.getElementById('employee-shift-title');
        if (shiftTitleElement) {
            shiftTitleElement.textContent = shiftTitle;
        }

        const shiftStatusElement = document.getElementById('employee-shift-status');
        if (shiftStatusElement) {
            shiftStatusElement.textContent = shiftStatus;
            shiftStatusElement.className = `badge ${getBadgeClass(shiftStatus)}`;
        }

        const shiftHelperElement = document.getElementById('employee-shift-helper');
        if (shiftHelperElement) {
            shiftHelperElement.textContent = shiftHelper;
            shiftHelperElement.classList.toggle('hidden', !shiftHelper);
        }

        document.getElementById('employee-shift-restaurant').textContent = restaurantName;
        document.getElementById('employee-shift-date').textContent = this.getEmployeeShiftDateText(shift);
        document.getElementById('employee-shift-schedule').textContent = scheduleText;
        document.getElementById('employee-shift-location').textContent = restaurantAddress;
        document.getElementById('employee-task-title').textContent = task?.title || 'No hay tareas pendientes.';
        document.getElementById('employee-task-observations').textContent = task?.description || 'Sin observaciones.';
        document.getElementById('employee-task-heading').textContent = task ? 'Tarea Especial Asignada' : 'Sin tareas urgentes';
        document.getElementById('employee-task-card').style.display = task ? '' : 'none';

        const startButton = document.getElementById('employee-start-shift-btn');
        const startLabel = document.getElementById('employee-start-shift-label');
        if (startButton && startLabel) {
            if (hasActiveShift) {
                startLabel.textContent = 'Continuar Turno Activo';
                startButton.disabled = false;
            } else if (canStartShift) {
                startLabel.textContent = 'Iniciar Turno Programado';
                startButton.disabled = false;
            } else if (hasPendingShift) {
                startLabel.textContent = 'Aún No Disponible';
                startButton.disabled = true;
            } else {
                startLabel.textContent = 'Sin Turno Programado';
                startButton.disabled = true;
            }
        }

        this.renderEmployeeRestaurantTasks();
        this.updateUserUI();
    },




};


if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        void app.init();
    });
} else {
    void app.init();
}

window.app = app;
