// @ts-nocheck
import * as XLSX from 'xlsx';
import {
    CACHE_TTLS,
    DEFAULT_SYSTEM_SETTINGS,
    REPORT_COLUMNS,
    SHIFT_NOT_STARTED_ALERT_GRACE_MINUTES,
} from '../constants.js';
import { apiClient, buildIdempotencyKey } from '../api.js';
import {
    asArray,
    buildJwtFullDebugSummary,
    collectEvidenceUrls,
    countEndedEarlyShifts,
    decodeJwtHeader,
    decodeJwtPayload,
    delay,
    escapeHtml,
    isHttpUrl,
    formatDate,
    formatDateTime,
    formatHours,
    formatShiftRange,
    getBadgeClass,
    getEmployeeDisplayName,
    getRestaurantDisplayName,
    getRestaurantRecordId,
    getScheduledHours,
    getShiftEmployeeName,
    getShiftRestaurantName,
    getShiftStatusLabel,
    getWorkedHours,
    initials,
    isShiftEndedEarly,
    normalizeAreaToken,
    normalizeLinkedPhoneValue,
    normalizeRestaurantId,
    pickMeaningfulRestaurantName,
    sumHours,
    sumWorkedHours,
    summarizeShiftStatuses,
    toDateTimeLocalInput,
    toIsoDate,
    toLocalDateKey,
    getTodayStart,
    getTodayEnd,
} from '../utils.js';

const SUPERVISOR_SHIFT_WEEK_TEMPLATE_STORAGE_KEY = 'worktrace_supervisor_shift_week_template_v1';
const SUPERVISOR_SHIFT_WEEK_DAYS = Object.freeze([
    { index: 0, label: 'Lunes', aliases: ['lunes', 'lun', 'monday', 'mon'] },
    { index: 1, label: 'Martes', aliases: ['martes', 'mar', 'tuesday', 'tue', 'tues'] },
    { index: 2, label: 'Miércoles', aliases: ['miercoles', 'mié', 'mie', 'wed', 'wednesday'] },
    { index: 3, label: 'Jueves', aliases: ['jueves', 'jue', 'thursday', 'thu', 'thur', 'thurs'] },
    { index: 4, label: 'Viernes', aliases: ['viernes', 'vie', 'friday', 'fri'] },
    { index: 5, label: 'Sábado', aliases: ['sabado', 'sáb', 'sab', 'saturday', 'sat'] },
    { index: 6, label: 'Domingo', aliases: ['domingo', 'dom', 'sunday', 'sun'] },
]);

function normalizeSpreadsheetKey(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function padTimeSegment(value) {
    return String(Math.max(0, Number(value) || 0)).padStart(2, '0');
}

function getSupervisorWeekStart(value = new Date()) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    date.setHours(0, 0, 0, 0);
    const mondayOffset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - mondayOffset);
    return date;
}

function addDaysLocal(date, days) {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + Number(days || 0));
    return next;
}

function buildSupervisorWeekRowId(dayIndex) {
    return `weekday-${Number(dayIndex)}`;
}

function pickFirstObjectValue(record = {}, keys = []) {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
            continue;
        }

        const value = record[key];
        if (value == null) {
            continue;
        }

        if (typeof value === 'string' && value.trim() === '') {
            continue;
        }

        return value;
    }

    return '';
}

function parseExcelDateParts(value) {
    if (value == null || value === '') {
        return null;
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return {
            year: value.getFullYear(),
            month: value.getMonth() + 1,
            day: value.getDate(),
        };
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const parsed = XLSX.SSF.parse_date_code(value);
        if (
            parsed &&
            Number.isFinite(Number(parsed.y)) &&
            Number.isFinite(Number(parsed.m)) &&
            Number.isFinite(Number(parsed.d))
        ) {
            return {
                year: Number(parsed.y),
                month: Number(parsed.m),
                day: Number(parsed.d),
            };
        }
    }

    const source = String(value || '').trim();
    if (!source) {
        return null;
    }

    let match = source.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (match) {
        return {
            year: Number(match[1]),
            month: Number(match[2]),
            day: Number(match[3]),
        };
    }

    match = source.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) {
        return {
            year: Number(match[3]),
            month: Number(match[2]),
            day: Number(match[1]),
        };
    }

    const parsedDate = new Date(source);
    if (Number.isNaN(parsedDate.getTime())) {
        return null;
    }

    return {
        year: parsedDate.getFullYear(),
        month: parsedDate.getMonth() + 1,
        day: parsedDate.getDate(),
    };
}

function normalizeImportedDateKey(value) {
    const parts = parseExcelDateParts(value);
    if (!parts) {
        return '';
    }

    return `${parts.year}-${padTimeSegment(parts.month)}-${padTimeSegment(parts.day)}`;
}

function normalizeImportedTimeValue(value) {
    if (value == null || value === '') {
        return '';
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${padTimeSegment(value.getHours())}:${padTimeSegment(value.getMinutes())}`;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const parsed = XLSX.SSF.parse_date_code(value);
        const hour = Number(parsed?.H ?? parsed?.h);
        const minute = Number(parsed?.M ?? parsed?.m);
        if (Number.isFinite(hour) && Number.isFinite(minute)) {
            return `${padTimeSegment(hour)}:${padTimeSegment(minute)}`;
        }
    }

    const source = String(value || '').trim();
    if (!source) {
        return '';
    }

    let match = source.replace(/\./g, ':').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
            return `${padTimeSegment(hour)}:${padTimeSegment(minute)}`;
        }
    }

    match = source.match(/^(\d{3,4})$/);
    if (match) {
        const compact = match[1].padStart(4, '0');
        const hour = Number(compact.slice(0, 2));
        const minute = Number(compact.slice(2, 4));
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
            return `${padTimeSegment(hour)}:${padTimeSegment(minute)}`;
        }
    }

    match = source.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/i);
    if (match) {
        let hour = Number(match[1]);
        const minute = Number(match[2] || 0);
        const meridiem = String(match[3] || '').toLowerCase();
        if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
            if (meridiem === 'p' && hour < 12) {
                hour += 12;
            }
            if (meridiem === 'a' && hour === 12) {
                hour = 0;
            }
            return `${padTimeSegment(hour)}:${padTimeSegment(minute)}`;
        }
    }

    const parsedDate = new Date(source);
    if (!Number.isNaN(parsedDate.getTime())) {
        return `${padTimeSegment(parsedDate.getHours())}:${padTimeSegment(parsedDate.getMinutes())}`;
    }

    return '';
}

function normalizeImportedBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return value !== 0;
    }

    const normalized = normalizeSpreadsheetKey(value);
    if (!normalized) {
        return null;
    }

    if (['1', 'si', 'yes', 'true', 'activo', 'active', 'programar', 'programado', 'x'].includes(normalized)) {
        return true;
    }

    if (['0', 'no', 'false', 'inactivo', 'inactive', 'omitir'].includes(normalized)) {
        return false;
    }

    return null;
}

function getImportedDayIndex(value) {
    const normalized = normalizeSpreadsheetKey(value);
    if (!normalized) {
        return null;
    }

    const dayEntry = SUPERVISOR_SHIFT_WEEK_DAYS.find((item) =>
        item.aliases.some((alias) => normalizeSpreadsheetKey(alias) === normalized)
    );
    return dayEntry ? dayEntry.index : null;
}

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
    populateSupervisorRestaurantOptions(selectId, includePlaceholder = true) {
        const select = document.getElementById(selectId);
        if (!select) {
            return;
        }

        const currentValue = select.value;
        const placeholder = includePlaceholder ? '<option value="">Selecciona un restaurante</option>' : '';
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

    normalizeSupervisorEmployeeRecord(item) {
        const employee = item.employee || item.user || item;
        const restaurantId = item.restaurant_id || item.restaurant?.id;
        const restaurantName = getRestaurantDisplayName(item, getRestaurantDisplayName(item.restaurant || null, ''));
        const assignedRestaurantsCount = Number(
            item.assigned_restaurants_count ?? employee.assigned_restaurants_count ?? 0
        );

        return {
            id: employee.id || item.id || item.employee_id || item.user_id,
            full_name: getEmployeeDisplayName(
                {
                    ...item,
                    ...(employee && typeof employee === 'object' ? employee : {}),
                },
                'Empleado'
            ),
            email: employee.email || item.email || '-',
            phone_e164: employee.phone_e164 || employee.phone_number || item.phone_e164 || '-',
            is_active: employee.is_active ?? item.is_active ?? true,
            restaurant_id: restaurantId,
            restaurant_name: restaurantName,
            assigned_restaurants_count: Number.isFinite(assignedRestaurantsCount) ? assignedRestaurantsCount : 0,
            assigned_to_restaurant: item.assigned_to_restaurant === true,
        };
    },

    async getSupervisorRestaurantStaff(restaurantId) {
        const normalizedRestaurantId = normalizeRestaurantId(restaurantId);
        if (normalizedRestaurantId == null) {
            return [];
        }

        const cacheKey = String(normalizedRestaurantId);
        const cachedStaff = this.getScopedCacheEntry(
            'supervisorRestaurantStaff',
            cacheKey,
            CACHE_TTLS.supervisorRestaurantStaff
        );
        if (cachedStaff) {
            return cachedStaff;
        }

        return this.runPending(`supervisorRestaurantStaff:${cacheKey}`, async () => {
            const result = await apiClient.restaurantStaffManage('list_by_restaurant', {
                restaurant_id: normalizedRestaurantId,
            });

            return this.setScopedCacheEntry(
                'supervisorRestaurantStaff',
                cacheKey,
                asArray(result).map((item) => this.normalizeSupervisorEmployeeRecord(item))
            );
        });
    },

    async getAssignableEmployeesForRestaurant(restaurantId) {
        const normalizedRestaurantId = normalizeRestaurantId(restaurantId);
        if (normalizedRestaurantId == null) {
            return [];
        }

        const cacheKey = String(normalizedRestaurantId);
        const cachedEmployees = this.getScopedCacheEntry(
            'supervisorAssignableEmployees',
            cacheKey,
            CACHE_TTLS.supervisorAssignableEmployees
        );
        if (cachedEmployees) {
            return cachedEmployees;
        }

        return this.runPending(`supervisorAssignableEmployees:${cacheKey}:directory`, async () => {
            if (
                this.data.supervisor.employees.length === 0 ||
                !this.isCacheFresh('supervisorEmployees', CACHE_TTLS.supervisorEmployees)
            ) {
                await this.loadSupervisorEmployees();
            }

            return this.setScopedCacheEntry(
                'supervisorAssignableEmployees',
                cacheKey,
                asArray(this.data.supervisor.employees)
                    .filter((employee) => employee?.id)
                    .filter((employee) => employee.is_active !== false)
                    .map((employee) => ({
                        ...employee,
                        assigned_to_restaurant: true,
                    }))
            );
        });
    },

    async prepareSupervisorShiftModal() {
        if (this.data.supervisor.restaurants.length === 0) {
            this.data.supervisor.restaurants = await this.getSupervisorRestaurants();
        }

        if (this.data.supervisor.employees.length === 0) {
            await this.loadSupervisorEmployees();
        }

        const form = document.getElementById('supervisor-shift-form');
        form?.reset();
        this.setSupervisorShiftSubmitState(false);
        this.supervisorShiftMode = 'single';
        this.supervisorBatchSelectedEmployees = [];
        this.supervisorShiftPlanRows = [];
        this.supervisorShiftPlanWeekStart = '';
        const specialTaskToggle = document.getElementById('supervisor-task-enabled');
        if (specialTaskToggle) {
            specialTaskToggle.checked = false;
        }
        const specialTaskPriority = document.getElementById('supervisor-task-priority');
        if (specialTaskPriority) {
            specialTaskPriority.value = 'high';
        }
        this.toggleSupervisorSpecialTaskOptions(false);
        this.populateSupervisorRestaurantOptions('supervisor-shift-restaurant');
        this.populateSupervisorRestaurantOptions('supervisor-shift-single-restaurant');
        this.populateSupervisorRestaurantOptions('supervisor-shift-plan-restaurant');
        this.populateSupervisorShiftPlanEmployees();
        this.populateSupervisorShiftSingleEmployees();
        const planEmployeeSelect = document.getElementById('supervisor-shift-plan-employee');
        if (planEmployeeSelect && this.data.supervisor.employees[0]?.id) {
            planEmployeeSelect.value = String(this.data.supervisor.employees[0].id);
        }
        const singleEmployeeSelect = document.getElementById('supervisor-shift-single-employee');
        if (singleEmployeeSelect && this.data.supervisor.employees[0]?.id) {
            singleEmployeeSelect.value = String(this.data.supervisor.employees[0].id);
        }

        const defaultStart = new Date();
        defaultStart.setMinutes(0, 0, 0);
        defaultStart.setHours(defaultStart.getHours() + 1);
        const defaultEnd = new Date(defaultStart.getTime() + 6 * 60 * 60 * 1000);

        const startInput = document.getElementById('supervisor-shift-start');
        const endInput = document.getElementById('supervisor-shift-end');
        if (startInput) {
            startInput.value = toDateTimeLocalInput(defaultStart);
        }
        if (endInput) {
            endInput.value = toDateTimeLocalInput(defaultEnd);
        }
        const singleStartInput = document.getElementById('supervisor-shift-single-start');
        const singleEndInput = document.getElementById('supervisor-shift-single-end');
        if (singleStartInput) {
            singleStartInput.value = toDateTimeLocalInput(defaultStart);
        }
        if (singleEndInput) {
            singleEndInput.value = toDateTimeLocalInput(defaultEnd);
        }

        const defaultRestaurant = this.data.supervisor.restaurants[0];
        if (defaultRestaurant) {
            const select = document.getElementById('supervisor-shift-restaurant');
            if (select) {
                select.value = String(getRestaurantRecordId(defaultRestaurant));
                await this.renderSupervisorShiftEmployeePicker(select.value);
            }
            const singleRestaurantSelect = document.getElementById('supervisor-shift-single-restaurant');
            if (singleRestaurantSelect) {
                singleRestaurantSelect.value = String(getRestaurantRecordId(defaultRestaurant));
            }
            const planRestaurantSelect = document.getElementById('supervisor-shift-plan-restaurant');
            if (planRestaurantSelect) {
                planRestaurantSelect.value = String(getRestaurantRecordId(defaultRestaurant));
            }
        }

        const excelInput = document.getElementById('supervisor-shift-plan-excel');
        if (excelInput) {
            excelInput.value = '';
        }

        const currentWeekStart = getSupervisorWeekStart(new Date()) || new Date();
        this.setSupervisorShiftPlanWeek(currentWeekStart, { preserveValues: false });
        this.setSupervisorShiftMode('single');
        this.updateSupervisorSpecialTaskScopeCopy();
    },

    toggleSupervisorSpecialTaskOptions(enabled = false) {
        document.getElementById('supervisor-task-fields')?.classList.toggle('hidden', !enabled);
        this.updateSupervisorSpecialTaskScopeCopy();
    },

    resetSupervisorShiftModalScroll({ mode = this.supervisorShiftMode, forceTop = false } = {}) {
        const modal = document.getElementById('modal-supervisor-schedule-shift');
        const modalContent = modal?.querySelector('.shift-scheduler-modal-content');
        const modalBody = document.querySelector('#modal-supervisor-schedule-shift .modal-body');
        if (!modalBody) {
            return;
        }

        if (forceTop) {
            if (modal) {
                modal.scrollTop = 0;
                modal.scrollLeft = 0;
            }
            if (modalContent) {
                modalContent.scrollTop = 0;
                modalContent.scrollLeft = 0;
            }
            modalBody.scrollTop = 0;
            modalBody.scrollLeft = 0;
            return;
        }

        const activePanel = document.getElementById(`supervisor-shift-mode-${mode}`);
        if (!activePanel) {
            modalBody.scrollTop = 0;
            modalBody.scrollLeft = 0;
            return;
        }

        const targetTop = Math.max(0, activePanel.offsetTop - 8);
        modalBody.scrollTop = targetTop;
        modalBody.scrollLeft = 0;
    },

    updateSupervisorSpecialTaskScopeCopy() {
        const scopeCopy = document.getElementById('supervisor-task-scope-copy');

        const scopeText =
            this.supervisorShiftMode === 'plan'
                ? 'La misma tarea se repetirá en cada fecha que programes.'
                : this.supervisorShiftMode === 'team'
                  ? 'La misma tarea se repetirá para cada empleado incluido.'
                  : 'Se creará junto con este turno puntual.';

        if (scopeCopy) {
            scopeCopy.textContent = scopeText;
        }
    },

    syncSupervisorShiftModeFieldState() {
        const panelModes = ['single', 'team', 'plan'];
        panelModes.forEach((mode) => {
            const panel = document.getElementById(`supervisor-shift-mode-${mode}`);
            if (!panel) {
                return;
            }

            const isActive = this.supervisorShiftMode === mode;
            panel.querySelectorAll('input, select, textarea, button').forEach((element) => {
                if (element.closest('#supervisor-shift-mode-switch')) {
                    return;
                }

                element.disabled = !isActive;
            });
        });
    },

    setSupervisorShiftMode(mode = 'single') {
        this.supervisorShiftMode = ['single', 'team', 'plan'].includes(mode) ? mode : 'single';

        document.querySelectorAll('#supervisor-shift-mode-switch .shift-mode-btn').forEach((button) => {
            button.classList.toggle('active', button.dataset.mode === this.supervisorShiftMode);
        });

        document
            .getElementById('supervisor-shift-mode-single')
            ?.classList.toggle('hidden', this.supervisorShiftMode !== 'single');
        document
            .getElementById('supervisor-shift-mode-team')
            ?.classList.toggle('hidden', this.supervisorShiftMode !== 'team');
        document
            .getElementById('supervisor-shift-mode-plan')
            ?.classList.toggle('hidden', this.supervisorShiftMode !== 'plan');
        this.syncSupervisorShiftModeFieldState();
        this.updateSupervisorSpecialTaskScopeCopy();
        window.requestAnimationFrame(() => {
            this.resetSupervisorShiftModalScroll({ mode: this.supervisorShiftMode, forceTop: true });
        });
    },

    setSupervisorShiftSubmitState(isSubmitting = false) {
        this.supervisorShiftSubmitPending = Boolean(isSubmitting);

        const modal = document.getElementById('modal-supervisor-schedule-shift');
        if (modal) {
            modal.dataset.locked = this.supervisorShiftSubmitPending ? 'true' : 'false';
        }

        const form = document.getElementById('supervisor-shift-form');
        if (!form) {
            return;
        }

        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) {
            submitButton.disabled = this.supervisorShiftSubmitPending;
            submitButton.setAttribute('aria-busy', this.supervisorShiftSubmitPending ? 'true' : 'false');
        }

        const cancelButton = form.querySelector('.modal-footer .btn-secondary');
        if (cancelButton) {
            cancelButton.disabled = this.supervisorShiftSubmitPending;
        }
    },

    populateSupervisorShiftSingleEmployees() {
        const select = document.getElementById('supervisor-shift-single-employee');
        if (!select) {
            return;
        }

        const employees = (this.data.supervisor.employees || []).filter(
            (employee) => employee?.id && employee.is_active !== false
        );
        const fragment = document.createDocumentFragment();
        if (employees.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No hay empleados disponibles';
            fragment.appendChild(option);
            select.replaceChildren(fragment);
            return;
        }

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Selecciona un empleado';
        fragment.appendChild(placeholder);

        employees.forEach((employee) => {
            const option = document.createElement('option');
            option.value = String(employee.id);
            option.textContent = getEmployeeDisplayName(employee);
            fragment.appendChild(option);
        });

        select.replaceChildren(fragment);
    },

    populateSupervisorShiftPlanEmployees() {
        const select = document.getElementById('supervisor-shift-plan-employee');
        if (!select) {
            return;
        }

        const employees = (this.data.supervisor.employees || []).filter(
            (employee) => employee?.id && employee.is_active !== false
        );
        const fragment = document.createDocumentFragment();
        if (employees.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No hay empleados disponibles';
            fragment.appendChild(option);
            select.replaceChildren(fragment);
            return;
        }

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Selecciona un empleado';
        fragment.appendChild(placeholder);

        employees.forEach((employee) => {
            const option = document.createElement('option');
            option.value = String(employee.id);
            option.textContent = getEmployeeDisplayName(employee);
            fragment.appendChild(option);
        });

        select.replaceChildren(fragment);
    },

    setShiftBatchPickerEmpty(container, message) {
        if (!container) {
            return;
        }

        const empty = document.createElement('div');
        empty.className = 'shift-batch-picker-empty';
        empty.textContent = message;
        container.replaceChildren(empty);
    },

    buildSupervisorShiftBatchEmployeeOption(employee, isActive = false) {
        const employeeId = String(employee?.id || '');
        if (!employeeId) {
            return null;
        }

        const option = document.createElement('label');
        option.className = `shift-batch-option${isActive ? ' active' : ''}`;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = isActive;
        input.dataset.action = 'shift-batch-toggle';
        input.dataset.employeeId = employeeId;

        const copy = document.createElement('div');
        copy.className = 'shift-batch-copy';

        const name = document.createElement('strong');
        name.textContent = getEmployeeDisplayName(employee);

        const detail = document.createElement('span');
        detail.textContent = `${employee.email || ''}${employee.phone_e164 ? ` • ${employee.phone_e164}` : ''}`;

        copy.append(name, detail);

        const check = document.createElement('span');
        check.className = 'shift-batch-check';
        check.setAttribute('aria-hidden', 'true');

        const icon = document.createElement('i');
        icon.className = 'fas fa-check';
        check.appendChild(icon);

        option.append(input, copy, check);
        return option;
    },

    async renderSupervisorShiftEmployeePicker(restaurantId) {
        const container = document.getElementById('supervisor-shift-employee-picker');
        if (!container) {
            return [];
        }

        if (!restaurantId) {
            this.setShiftBatchPickerEmpty(container, 'Selecciona un restaurante para ver los empleados disponibles.');
            this.supervisorBatchSelectedEmployees = [];
            return [];
        }

        try {
            const employees = await this.getAssignableEmployeesForRestaurant(restaurantId);
            const validIds = new Set(employees.map((employee) => String(employee.id)));
            this.supervisorBatchSelectedEmployees = (this.supervisorBatchSelectedEmployees || []).filter((employeeId) =>
                validIds.has(String(employeeId))
            );

            if (employees.length === 0) {
                this.setShiftBatchPickerEmpty(
                    container,
                    'No hay empleados activos disponibles para programar en este restaurante.'
                );
                return [];
            }

            const fragment = document.createDocumentFragment();
            employees.forEach((employee) => {
                const employeeId = String(employee.id);
                const isActive = this.supervisorBatchSelectedEmployees.includes(employeeId);
                const option = this.buildSupervisorShiftBatchEmployeeOption(employee, isActive);
                if (option) {
                    fragment.appendChild(option);
                }
            });
            container.replaceChildren(fragment);

            return employees;
        } catch (error) {
            console.warn('No fue posible cargar empleados para programación masiva.', error);
            this.setShiftBatchPickerEmpty(
                container,
                'No fue posible cargar los empleados disponibles para este restaurante.'
            );
            this.supervisorBatchSelectedEmployees = [];
            return [];
        }
    },

    toggleSupervisorBatchEmployee(employeeId, { rerender = true } = {}) {
        const normalizedId = String(employeeId);
        const selected = new Set((this.supervisorBatchSelectedEmployees || []).map(String));

        if (selected.has(normalizedId)) {
            selected.delete(normalizedId);
        } else {
            selected.add(normalizedId);
        }

        this.supervisorBatchSelectedEmployees = Array.from(selected);
        if (rerender) {
            const restaurantId = document.getElementById('supervisor-shift-restaurant')?.value || '';
            void this.renderSupervisorShiftEmployeePicker(restaurantId);
        }
    },

    addSupervisorShiftPlanRow() {
        this.renderSupervisorShiftPlanRows();
    },

    removeSupervisorShiftPlanRow(rowId) {
        this.clearSupervisorShiftPlanWeekRow(rowId);
    },

    updateSupervisorShiftPlanRow(rowId, field, value) {
        this.updateSupervisorShiftPlanWeekRow(rowId, field, value);
    },

    buildSupervisorShiftPlanRows(weekStartValue = '', seedRows = []) {
        const weekStart =
            getSupervisorWeekStart(weekStartValue || this.supervisorShiftPlanWeekStart || new Date()) ||
            getSupervisorWeekStart(new Date()) ||
            new Date();
        const rowsByIndex = new Map(
            asArray(seedRows)
                .filter((row) => Number.isInteger(Number(row?.dayIndex)))
                .map((row) => [Number(row.dayIndex), row])
        );

        return SUPERVISOR_SHIFT_WEEK_DAYS.map((day) => {
            const seed = rowsByIndex.get(day.index) || {};
            const workDate = addDaysLocal(weekStart, day.index);
            return {
                id: buildSupervisorWeekRowId(day.index),
                dayIndex: day.index,
                dayLabel: day.label,
                dateKey: toLocalDateKey(workDate),
                enabled: seed.enabled === true,
                startTime: String(seed.startTime || '').trim(),
                endTime: String(seed.endTime || '').trim(),
                notes: String(seed.notes || '').trim(),
            };
        });
    },

    setSupervisorShiftPlanWeek(weekStartValue = '', { preserveValues = true } = {}) {
        const weekStart =
            getSupervisorWeekStart(weekStartValue || this.supervisorShiftPlanWeekStart || new Date()) ||
            getSupervisorWeekStart(new Date());
        if (!weekStart) {
            return;
        }

        const weekKey = toLocalDateKey(weekStart);
        const weekInput = document.getElementById('supervisor-shift-plan-week');
        if (weekInput) {
            weekInput.value = weekKey;
        }

        const seedRows = preserveValues ? this.supervisorShiftPlanRows || [] : [];
        this.supervisorShiftPlanWeekStart = weekKey;
        this.supervisorShiftPlanRows = this.buildSupervisorShiftPlanRows(weekKey, seedRows);
        this.renderSupervisorShiftPlanRows();
    },

    buildSupervisorShiftDateTime(dateKey = '', timeValue = '') {
        const dateMatch = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const timeMatch = String(timeValue || '').match(/^(\d{2}):(\d{2})$/);
        if (!dateMatch || !timeMatch) {
            return null;
        }

        const year = Number(dateMatch[1]);
        const month = Number(dateMatch[2]) - 1;
        const day = Number(dateMatch[3]);
        const hour = Number(timeMatch[1]);
        const minute = Number(timeMatch[2]);
        const date = new Date(year, month, day, hour, minute, 0, 0);

        return Number.isNaN(date.getTime()) ? null : date;
    },

    getSupervisorShiftPlanRowDurationMinutes(row = {}) {
        const startDate = this.buildSupervisorShiftDateTime(row.dateKey, row.startTime);
        const endDate = this.buildSupervisorShiftDateTime(row.dateKey, row.endTime);
        if (!startDate || !endDate) {
            return 0;
        }

        if (endDate <= startDate) {
            endDate.setDate(endDate.getDate() + 1);
        }

        return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
    },

    getSupervisorShiftPlanTemplate() {
        return {
            restaurantId: String(document.getElementById('supervisor-shift-plan-restaurant')?.value || '').trim(),
            rows: asArray(this.supervisorShiftPlanRows).map((row) => ({
                dayIndex: Number(row.dayIndex),
                enabled: row.enabled === true,
                startTime: String(row.startTime || '').trim(),
                endTime: String(row.endTime || '').trim(),
                notes: String(row.notes || '').trim(),
            })),
        };
    },

    persistSupervisorShiftTemplate(template = null) {
        try {
            if (!window?.localStorage) {
                return;
            }

            if (!template) {
                window.localStorage.removeItem(SUPERVISOR_SHIFT_WEEK_TEMPLATE_STORAGE_KEY);
                return;
            }

            window.localStorage.setItem(SUPERVISOR_SHIFT_WEEK_TEMPLATE_STORAGE_KEY, JSON.stringify(template));
        } catch (error) {
            console.warn('No fue posible guardar la plantilla semanal del supervisor.', error);
        }
    },

    readSupervisorShiftTemplate() {
        try {
            const raw = window?.localStorage?.getItem(SUPERVISOR_SHIFT_WEEK_TEMPLATE_STORAGE_KEY) || '';
            if (!raw) {
                return null;
            }

            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (error) {
            console.warn('No fue posible leer la plantilla semanal del supervisor.', error);
            return null;
        }
    },

    applySupervisorShiftTemplate(template = {}, { keepCurrentWeek = true } = {}) {
        const targetWeek = keepCurrentWeek
            ? this.supervisorShiftPlanWeekStart || new Date()
            : template.weekStart || this.supervisorShiftPlanWeekStart || new Date();
        const weekStart = getSupervisorWeekStart(targetWeek) || getSupervisorWeekStart(new Date());
        if (!weekStart) {
            return;
        }

        const weekKey = toLocalDateKey(weekStart);
        this.supervisorShiftPlanWeekStart = weekKey;
        const weekInput = document.getElementById('supervisor-shift-plan-week');
        if (weekInput) {
            weekInput.value = weekKey;
        }

        const restaurantId = String(template?.restaurantId || '').trim();
        const restaurantSelect = document.getElementById('supervisor-shift-plan-restaurant');
        if (
            restaurantSelect &&
            restaurantId &&
            Array.from(restaurantSelect.options).some((option) => option.value === restaurantId)
        ) {
            restaurantSelect.value = restaurantId;
        }

        this.supervisorShiftPlanRows = this.buildSupervisorShiftPlanRows(weekKey, template?.rows || []);
        this.renderSupervisorShiftPlanRows();
    },

    replicateSupervisorShiftTemplate() {
        const template = this.readSupervisorShiftTemplate();
        if (!template || !Array.isArray(template.rows) || template.rows.length === 0) {
            this.showToast('Todavía no hay una semana guardada para replicar.', {
                tone: 'info',
                title: 'Sin semana anterior',
            });
            return;
        }

        this.applySupervisorShiftTemplate(template, { keepCurrentWeek: true });
        this.showToast('Se replicó la última semana guardada en la semana que estás viendo.', {
            tone: 'success',
            title: 'Semana replicada',
        });
    },

    openSupervisorShiftPlanExcelPicker() {
        const input = document.getElementById('supervisor-shift-plan-excel');
        if (!input) {
            return;
        }

        input.value = '';
        input.click();
    },

    async handleSupervisorShiftPlanExcelImport(event) {
        const input = event?.target;
        const file = input?.files?.[0];
        if (!file) {
            return;
        }

        try {
            await this.importSupervisorShiftPlanWorkbook(file);
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible importar el Excel de turnos.'), {
                tone: 'error',
                title: 'No fue posible importar el Excel',
            });
        } finally {
            if (input) {
                input.value = '';
            }
        }
    },

    async importSupervisorShiftPlanWorkbook(file) {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, {
            type: 'array',
            cellDates: true,
        });
        const firstSheetName = workbook.SheetNames?.[0];
        const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
        if (!sheet) {
            throw new Error('El archivo no tiene hojas disponibles para importar.');
        }

        const rows = XLSX.utils.sheet_to_json(sheet, {
            defval: '',
            raw: false,
        });

        if (!Array.isArray(rows) || rows.length === 0) {
            throw new Error('El Excel está vacío o no contiene filas válidas.');
        }

        const templateRows = [];
        let importedWeekStart = '';

        rows.forEach((rawRow) => {
            const normalizedRow = Object.entries(rawRow || {}).reduce((acc, [key, value]) => {
                acc[normalizeSpreadsheetKey(key)] = value;
                return acc;
            }, {});

            const dateValue = pickFirstObjectValue(normalizedRow, ['fecha', 'date', 'diafecha', 'workdate']);
            const dateKey = normalizeImportedDateKey(dateValue);

            let dayIndex = null;
            if (dateKey) {
                const rowDate = new Date(`${dateKey}T00:00:00`);
                if (!Number.isNaN(rowDate.getTime())) {
                    dayIndex = (rowDate.getDay() + 6) % 7;
                    if (!importedWeekStart) {
                        importedWeekStart = toLocalDateKey(getSupervisorWeekStart(rowDate));
                    }
                }
            }

            if (dayIndex == null) {
                dayIndex = getImportedDayIndex(pickFirstObjectValue(normalizedRow, ['dia', 'day', 'weekday']));
            }

            if (dayIndex == null) {
                return;
            }

            const startTime = normalizeImportedTimeValue(
                pickFirstObjectValue(normalizedRow, [
                    'entrada',
                    'horadeentrada',
                    'horaentrada',
                    'inicio',
                    'horadeinicio',
                    'horainicio',
                    'start',
                    'starttime',
                ])
            );
            const endTime = normalizeImportedTimeValue(
                pickFirstObjectValue(normalizedRow, [
                    'salida',
                    'horadesalida',
                    'horasalida',
                    'fin',
                    'horadefin',
                    'horafin',
                    'end',
                    'endtime',
                ])
            );
            const notes = String(
                pickFirstObjectValue(normalizedRow, [
                    'notas',
                    'nota',
                    'observaciones',
                    'comentario',
                    'comentarios',
                    'notes',
                ]) || ''
            ).trim();
            const explicitEnabled = normalizeImportedBoolean(
                pickFirstObjectValue(normalizedRow, ['activo', 'active', 'habilitado', 'enabled', 'programar'])
            );

            templateRows.push({
                dayIndex,
                enabled: explicitEnabled ?? Boolean(startTime || endTime),
                startTime,
                endTime,
                notes,
            });
        });

        if (templateRows.length === 0) {
            throw new Error(
                'No encontramos columnas reconocibles. Usa Dia/Fecha, Entrada, Salida y opcionalmente Notas.'
            );
        }

        this.applySupervisorShiftTemplate(
            {
                restaurantId: document.getElementById('supervisor-shift-plan-restaurant')?.value || '',
                rows: templateRows,
                weekStart: importedWeekStart || undefined,
            },
            {
                keepCurrentWeek: !importedWeekStart,
            }
        );

        const loadedCount = templateRows.filter((row) => row.enabled && row.startTime && row.endTime).length;
        this.showToast(
            loadedCount > 0
                ? `Se cargaron ${loadedCount} día(s) desde el Excel.`
                : 'El Excel se importó, pero revisa los horarios antes de guardar.',
            {
                tone: 'success',
                title: 'Excel importado',
            }
        );
    },

    updateSupervisorShiftPlanWeekRow(rowId, field, value) {
        this.supervisorShiftPlanRows = asArray(this.supervisorShiftPlanRows).map((row) =>
            row.id === rowId
                ? {
                      ...row,
                      [field]: field === 'enabled' ? value === true : value,
                  }
                : row
        );

        if (field === 'enabled') {
            this.renderSupervisorShiftPlanRows();
            return;
        }

        this.updateSupervisorShiftPlanSummary();
    },

    clearSupervisorShiftPlanWeekRow(rowId) {
        this.supervisorShiftPlanRows = asArray(this.supervisorShiftPlanRows).map((row) =>
            row.id === rowId
                ? {
                      ...row,
                      enabled: false,
                      startTime: '',
                      endTime: '',
                      notes: '',
                  }
                : row
        );
        this.renderSupervisorShiftPlanRows();
    },

    buildSupervisorShiftPlanWeekRowNode(row = {}) {
        const article = document.createElement('article');
        article.className = `shift-week-row${row.enabled ? '' : ' inactive'}`;

        const dayWrap = document.createElement('div');
        dayWrap.className = 'shift-week-day';

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = row.enabled === true;
        toggle.dataset.action = 'shift-week-field';
        toggle.dataset.rowId = row.id;
        toggle.dataset.field = 'enabled';
        toggle.setAttribute('aria-label', `Activar ${row.dayLabel}`);

        const dayCopy = document.createElement('div');
        dayCopy.className = 'shift-week-day-copy';
        const dayName = document.createElement('strong');
        dayName.textContent = row.dayLabel || 'Día';
        const dayDate = document.createElement('span');
        dayDate.textContent = row.dateKey
            ? formatDate(`${row.dateKey}T00:00:00`, {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
              })
            : '-';
        dayCopy.append(dayName, dayDate);
        dayWrap.append(toggle, dayCopy);

        const startField = document.createElement('div');
        startField.className = 'shift-week-field';
        const startLabel = document.createElement('label');
        startLabel.textContent = 'Entrada';
        const startInput = document.createElement('input');
        startInput.type = 'time';
        startInput.value = row.startTime || '';
        startInput.disabled = row.enabled !== true;
        startInput.dataset.action = 'shift-week-field';
        startInput.dataset.rowId = row.id;
        startInput.dataset.field = 'startTime';
        startField.append(startLabel, startInput);

        const endField = document.createElement('div');
        endField.className = 'shift-week-field';
        const endLabel = document.createElement('label');
        endLabel.textContent = 'Salida';
        const endInput = document.createElement('input');
        endInput.type = 'time';
        endInput.value = row.endTime || '';
        endInput.disabled = row.enabled !== true;
        endInput.dataset.action = 'shift-week-field';
        endInput.dataset.rowId = row.id;
        endInput.dataset.field = 'endTime';
        endField.append(endLabel, endInput);

        const notesField = document.createElement('div');
        notesField.className = 'shift-week-field';
        const notesLabel = document.createElement('label');
        notesLabel.textContent = 'Notas';
        const notesInput = document.createElement('textarea');
        notesInput.placeholder = 'Observaciones opcionales...';
        notesInput.value = row.notes || '';
        notesInput.disabled = row.enabled !== true;
        notesInput.dataset.action = 'shift-week-field';
        notesInput.dataset.rowId = row.id;
        notesInput.dataset.field = 'notes';
        notesField.append(notesLabel, notesInput);

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'btn btn-danger btn-inline shift-plan-remove';
        clearBtn.dataset.action = 'shift-week-clear';
        clearBtn.dataset.rowId = row.id;
        clearBtn.disabled = row.enabled !== true && !row.startTime && !row.endTime && !row.notes;
        const clearIcon = document.createElement('i');
        clearIcon.className = 'fas fa-eraser';
        clearBtn.append(clearIcon, document.createTextNode(' Limpiar'));

        article.append(dayWrap, startField, endField, notesField, clearBtn);
        return article;
    },

    updateSupervisorShiftPlanSummary() {
        const container = document.getElementById('supervisor-shift-plan-summary');
        if (!container) {
            return;
        }

        const weekStart =
            getSupervisorWeekStart(this.supervisorShiftPlanWeekStart || new Date()) ||
            getSupervisorWeekStart(new Date());
        if (!weekStart) {
            container.innerHTML = '';
            return;
        }

        const weekEnd = addDaysLocal(weekStart, 6);
        const rows = asArray(this.supervisorShiftPlanRows);
        const selectedDays = rows.filter((row) => row.enabled === true);
        const readyDays = selectedDays.filter((row) => row.startTime && row.endTime);
        const totalMinutes = readyDays.reduce(
            (sum, row) => sum + this.getSupervisorShiftPlanRowDurationMinutes(row),
            0
        );

        const restaurantId = String(document.getElementById('supervisor-shift-plan-restaurant')?.value || '').trim();
        const restaurant =
            asArray(this.data.supervisor.restaurants).find(
                (item) => String(getRestaurantRecordId(item) || '') === restaurantId
            ) || null;
        const restaurantName = restaurant ? getRestaurantDisplayName(restaurant) : 'Sin restaurante seleccionado';

        container.innerHTML = `
            <span class="shift-week-summary-pill"><strong>Semana</strong> ${escapeHtml(formatDate(weekStart, { day: '2-digit', month: 'short' }))} - ${escapeHtml(formatDate(weekEnd, { day: '2-digit', month: 'short', year: 'numeric' }))}</span>
            <span class="shift-week-summary-pill"><strong>Restaurante</strong> ${escapeHtml(restaurantName)}</span>
            <span class="shift-week-summary-pill"><strong>Días activos</strong> ${escapeHtml(String(selectedDays.length))}</span>
            <span class="shift-week-summary-pill"><strong>Horas listas</strong> ${escapeHtml(formatHours(totalMinutes / 60))}</span>
        `;
    },

    renderSupervisorShiftPlanRows() {
        const container = document.getElementById('supervisor-shift-plan-rows');
        if (!container) {
            return;
        }

        if (
            !Array.isArray(this.supervisorShiftPlanRows) ||
            this.supervisorShiftPlanRows.length !== SUPERVISOR_SHIFT_WEEK_DAYS.length
        ) {
            this.supervisorShiftPlanRows = this.buildSupervisorShiftPlanRows(
                this.supervisorShiftPlanWeekStart || new Date(),
                this.supervisorShiftPlanRows || []
            );
        }

        const fragment = document.createDocumentFragment();
        this.supervisorShiftPlanRows.forEach((row) => {
            fragment.appendChild(this.buildSupervisorShiftPlanWeekRowNode(row));
        });

        container.replaceChildren(fragment);
        this.updateSupervisorShiftPlanSummary();
    },

    getSupervisorSpecialTaskTemplate() {
        const enabled = document.getElementById('supervisor-task-enabled')?.checked === true;
        const title = document.getElementById('supervisor-task-title')?.value?.trim() || '';
        const description = document.getElementById('supervisor-task-description')?.value?.trim() || '';
        const requiresEvidence = document.getElementById('supervisor-task-requires-evidence')?.checked === true;
        const priority = document.getElementById('supervisor-task-priority')?.value?.trim() || '';

        return {
            enabled,
            title,
            description,
            requires_evidence: requiresEvidence,
            priority,
        };
    },

    async validateSpecialTaskAssignments(assignments = []) {
        const normalizedAssignments = Array.isArray(assignments) ? assignments.filter(Boolean) : [];
        if (normalizedAssignments.length === 0) {
            return { ok: true };
        }

        const isSupervisorRole = ['supervisora', 'supervisor'].includes(
            String(this.currentUser?.role || '').toLowerCase()
        );
        const supervisorRestaurantIds = new Set(
            asArray(this.data.supervisor?.restaurants)
                .map((restaurant) => String(getRestaurantRecordId(restaurant) || '').trim())
                .filter(Boolean)
        );

        for (const assignment of normalizedAssignments) {
            const employeeId = String(assignment?.employee_id || '').trim();
            const restaurantId = String(assignment?.restaurant_id || '').trim();
            const employeeRecord = (this.data.supervisor.employees || []).find(
                (item) => String(item?.id || '') === employeeId
            );
            const employeeName = getEmployeeDisplayName(employeeRecord, 'el empleado seleccionado');
            const isEmployeeActive = employeeRecord?.is_active;
            if (isEmployeeActive === false) {
                return {
                    ok: false,
                    message: `${employeeName} debe estar activo para poder crear la tarea especial.`,
                };
            }

            if (
                isSupervisorRole &&
                restaurantId &&
                supervisorRestaurantIds.size > 0 &&
                !supervisorRestaurantIds.has(restaurantId)
            ) {
                return {
                    ok: false,
                    message: `No tienes acceso al restaurante seleccionado para crear tareas especiales en ese turno.`,
                };
            }
        }

        return { ok: true };
    },

    extractCreatedScheduledShiftItems(response) {
        const items = Array.isArray(response?.created_items)
            ? response.created_items
            : Array.isArray(response?.data?.created_items)
              ? response.data.created_items
              : [];

        return items
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
                index: Number(item.index),
                scheduled_shift_id: item.scheduled_shift_id,
                employee_id: item.employee_id,
                restaurant_id: item.restaurant_id,
                scheduled_start: item.scheduled_start,
                scheduled_end: item.scheduled_end,
                notes: item.notes,
            }));
    },

    extractScheduledShiftIdsFromResponse(response) {
        const directArray = Array.isArray(response?.created_ids)
            ? response.created_ids
            : Array.isArray(response?.data?.created_ids)
              ? response.data.created_ids
              : [];

        if (directArray.length > 0) {
            return directArray.filter((value) => value != null && String(value).trim() !== '');
        }

        const directCandidates = [
            response?.scheduled_shift_id,
            response?.scheduled_shift?.id,
            response?.scheduled_shift?.scheduled_shift_id,
            response?.created_id,
            response?.id,
            response?.data?.scheduled_shift_id,
            response?.data?.scheduled_shift?.id,
            response?.data?.scheduled_shift?.scheduled_shift_id,
            response?.data?.created_id,
            response?.data?.id,
        ].filter((value) => value != null && String(value).trim() !== '');

        return directCandidates;
    },

    normalizeTaskCreatePayloadValue(value) {
        if (value == null || value === '') {
            return undefined;
        }

        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : value;
    },

    normalizeTaskDueAtValue(value) {
        if (!value) {
            return undefined;
        }

        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) {
            return undefined;
        }

        return date.toISOString();
    },

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
            this.showToast('Todavía no hay un error reciente para copiar.', {
                tone: 'info',
                title: 'Sin detalle disponible',
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

            this.showToast('Detalle copiado. Ya lo puedes compartir.', {
                tone: 'success',
                title: 'Copia lista',
            });
        } catch (error) {
            this.showToast('No se pudo copiar el detalle. Inténtalo de nuevo.', {
                tone: 'error',
                title: 'No fue posible copiar',
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

    buildSupervisionRegisterSignature(payload = {}) {
        const observedAt = String(payload?.observed_at || '').trim();
        const observedDay = observedAt ? observedAt.slice(0, 10) : '';

        return JSON.stringify({
            restaurant_id: normalizeRestaurantId(payload?.restaurant_id),
            phase: String(payload?.phase || '')
                .trim()
                .toLowerCase(),
            observed_day: observedDay,
        });
    },

    async copyLatestSupervisionDebug() {
        const latestEntry = Array.isArray(window.__worktraceSupervisionDebug)
            ? window.__worktraceSupervisionDebug[0]
            : null;
        if (!latestEntry) {
            this.showToast('Todavía no hay un error reciente para copiar.', {
                tone: 'info',
                title: 'Sin detalle disponible',
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

            this.showToast('Detalle copiado. Ya lo puedes compartir.', {
                tone: 'success',
                title: 'Copia lista',
            });
        } catch (error) {
            this.showToast('No se pudo copiar el detalle. Inténtalo de nuevo.', {
                tone: 'error',
                title: 'No fue posible copiar',
            });
        }
    },

    registerBulkAssignDebug(createdItems = [], assignments = [], createdAssignments = []) {
        const debugEntry = {
            at: new Date().toISOString(),
            mapping_mode: 'created_items_index_1_based',
            created_items: createdItems,
            assignments_sent: assignments,
            created_assignments: createdAssignments,
        };

        if (!Array.isArray(window.__worktraceBulkAssignDebug)) {
            window.__worktraceBulkAssignDebug = [];
        }

        window.__worktraceBulkAssignDebug.unshift(debugEntry);
        window.__worktraceBulkAssignDebug = window.__worktraceBulkAssignDebug.slice(0, 20);
        return debugEntry;
    },

    getTaskCreateBackendFailure(error) {
        return {
            code: String(
                error?.payload?.error?.details?.code || error?.payload?.details?.code || error?.code || ''
            ).trim(),
            message: String(
                error?.payload?.error?.details?.message || error?.payload?.details?.message || error?.message || ''
            ).trim(),
        };
    },

    isScheduledShiftNotFoundOnTaskCreate(error) {
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

        if (status !== 404 || !source) {
            return false;
        }

        return [
            'turno programado no encontrado',
            'scheduled shift not found',
            'scheduled_shift_id',
            'turno no encontrado',
        ].some((token) => source.includes(token));
    },

    getTaskCreateDiagnosticCode(error) {
        return String(error?.payload?.error?.details?.diagnostic_code || error?.payload?.details?.diagnostic_code || '')
            .trim()
            .toUpperCase();
    },

    getTaskCreateDiagnosticMessage(error) {
        const diagnosticCode = this.getTaskCreateDiagnosticCode(error);

        switch (diagnosticCode) {
            case 'SCHEDULED_SHIFT_NOT_FOUND':
                return 'No se encontró el turno programado en este ambiente. Refresca turnos y vuelve a intentarlo.';
            case 'SCHEDULED_SHIFT_FORBIDDEN':
                return 'No tienes permisos para acceder al turno programado seleccionado.';
            case 'SCHEDULED_SHIFT_INVALID_STATUS': {
                const currentStatus = String(
                    error?.payload?.error?.details?.current_status || error?.payload?.details?.current_status || ''
                ).trim();
                return currentStatus
                    ? `El turno está en estado "${currentStatus}" y no permite crear tarea especial.`
                    : 'Solo se pueden crear tareas especiales para turnos en estado programado.';
            }
            case 'SCHEDULED_SHIFT_EMPLOYEE_MISMATCH':
                return 'El empleado enviado no coincide con el empleado del turno programado.';
            case 'EMPLOYEE_NOT_IN_RESTAURANT':
                return 'El empleado asignado no pertenece al restaurante del turno programado.';
            default:
                return '';
        }
    },

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

    registerShiftAssignDebug(response, assignment, createdAssignments = []) {
        const debugEntry = {
            at: new Date().toISOString(),
            mode: 'assign',
            assignment_sent: assignment,
            response,
            extracted_scheduled_shift_ids: this.extractScheduledShiftIdsFromResponse(response),
            created_assignments: createdAssignments,
        };

        if (!Array.isArray(window.__worktraceShiftAssignDebug)) {
            window.__worktraceShiftAssignDebug = [];
        }

        window.__worktraceShiftAssignDebug.unshift(debugEntry);
        window.__worktraceShiftAssignDebug = window.__worktraceShiftAssignDebug.slice(0, 20);
        return debugEntry;
    },

    async createSpecialTasksForScheduledShifts(createdAssignments, taskTemplate) {
        if (
            !taskTemplate?.enabled ||
            !taskTemplate?.title ||
            !Array.isArray(createdAssignments) ||
            createdAssignments.length === 0
        ) {
            return { created: 0, failed: 0, errors: [] };
        }

        let created = 0;
        let failed = 0;
        const errors = [];

        for (const entry of createdAssignments) {
            const scheduledShiftId = this.normalizeTaskCreatePayloadValue(entry?.scheduled_shift_id);
            const assignedEmployeeId = this.normalizeTaskCreatePayloadValue(
                entry?.employee_id ?? entry?.assigned_employee_id
            );
            if (!scheduledShiftId) {
                failed += 1;
                errors.push('No se pudo determinar el turno programado para crear la tarea especial.');
                continue;
            }

            if (!assignedEmployeeId) {
                failed += 1;
                errors.push(
                    'No se pudo determinar el empleado asignado del turno programado para crear la tarea especial.'
                );
                continue;
            }

            const basePayload = {
                scheduled_shift_id: scheduledShiftId,
                assigned_employee_id: assignedEmployeeId,
                title: taskTemplate.title,
                description: taskTemplate.description || undefined,
                requires_evidence: taskTemplate.requires_evidence,
                due_at: this.normalizeTaskDueAtValue(entry?.scheduled_end),
            };

            const payloadVariants = taskTemplate.priority
                ? [
                      {
                          ...basePayload,
                          priority: taskTemplate.priority,
                      },
                      basePayload,
                  ]
                : [basePayload];

            let taskCreated = false;
            let lastError = null;

            for (const payload of payloadVariants) {
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    try {
                        await this.createOperationalTaskWithFreshToken(payload);
                        created += 1;
                        taskCreated = true;
                        break;
                    } catch (error) {
                        lastError = error;
                        const status = Number(error?.status || 0);
                        const normalizedMessage = String(error?.message || '').toLowerCase();
                        const backendFailure = this.getTaskCreateBackendFailure(error);
                        const normalizedBackendMessage = backendFailure.message.toLowerCase();
                        const isInvalidShiftRace =
                            backendFailure.code === 'P0001' ||
                            normalizedBackendMessage.includes('turno invalido para crear tarea');
                        const isAlreadyExists =
                            normalizedMessage.includes('already exists') || normalizedMessage.includes('ya existe');

                        if (isAlreadyExists) {
                            created += 1;
                            taskCreated = true;
                            break;
                        }

                        if (status === 409 && isInvalidShiftRace) {
                            if (attempt < 3) {
                                await delay([700, 1600, 3200][attempt] || 3200);
                                continue;
                            }
                        }

                        if (attempt < 3) {
                            await delay(isInvalidShiftRace ? [700, 1600, 3200][attempt] || 3200 : 250 * (attempt + 1));
                        }
                    }
                }

                if (taskCreated) {
                    break;
                }
            }

            if (!taskCreated) {
                const debugEntry = this.registerTaskCreateDebug(
                    payloadVariants[payloadVariants.length - 1],
                    lastError,
                    {
                        scheduled_shift_id: scheduledShiftId,
                        assigned_employee_id: assignedEmployeeId,
                        source_index_1_based: entry?.source_index_1_based ?? null,
                        source_index_0_based: entry?.source_index_0_based ?? null,
                    }
                );
                failed += 1;
                const diagnosticMessage = this.getTaskCreateDiagnosticMessage(lastError);
                if (diagnosticMessage) {
                    errors.push(diagnosticMessage);
                } else if (this.isScheduledShiftNotFoundOnTaskCreate(lastError)) {
                    errors.push(
                        'No se encontró el turno programado en este ambiente o no está dentro del alcance del usuario actual. Refresca turnos y vuelve a intentarlo.'
                    );
                } else {
                    errors.push(this.getErrorMessage(lastError, 'No fue posible enlazar una tarea especial.'));
                }
                if (debugEntry?.request_id && !errors[errors.length - 1].includes('request_id')) {
                    errors[errors.length - 1] = `${errors[errors.length - 1]} (request_id: ${debugEntry.request_id})`;
                }
            }
        }

        return { created, failed, errors };
    },

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

    getKnownSupervisorRestaurantRecord(restaurantId) {
        const normalizedRestaurantId = String(restaurantId || '').trim();
        if (!normalizedRestaurantId) {
            return null;
        }
        return (
            asArray(this.data.supervisor.restaurants).find(
                (restaurant) => String(getRestaurantRecordId(restaurant) || '').trim() === normalizedRestaurantId
            ) || null
        );
    },

    getKnownAdminRestaurantRecord(restaurantId) {
        const normalizedRestaurantId = String(restaurantId || '').trim();
        if (!normalizedRestaurantId) {
            return null;
        }
        return (
            asArray(this.data.admin.restaurants).find(
                (restaurant) => String(getRestaurantRecordId(restaurant) || '').trim() === normalizedRestaurantId
            ) || null
        );
    },

    getKnownEmployeeRestaurantRecord(restaurantId) {
        const normalizedRestaurantId = String(restaurantId || '').trim();
        if (!normalizedRestaurantId) {
            return null;
        }
        return this.resolveEmployeeRestaurantRecord(normalizedRestaurantId, this.data.employee.dashboard || {});
    },

    getKnownRestaurantRecord(restaurantId) {
        return (
            this.getKnownEmployeeRestaurantRecord(restaurantId) ||
            this.getKnownSupervisorRestaurantRecord(restaurantId) ||
            this.getKnownAdminRestaurantRecord(restaurantId) ||
            null
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

    getResolvedShiftEmployeeName(shift, fallback = 'Empleado') {
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

    getResolvedShiftRestaurantName(shift, fallback = 'Restaurante') {
        const restaurantId =
            shift?.restaurant_id ||
            shift?.restaurant?.restaurant_id ||
            shift?.restaurant?.id ||
            shift?.location_id ||
            shift?.location?.id ||
            shift?.site_id ||
            shift?.site?.id ||
            '';
        return (
            getShiftRestaurantName(shift, {
                restaurantRecord: this.getKnownRestaurantRecord(restaurantId),
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

    getPhoneBindingActionState(record) {
        const userId = String(record?.id || record?.user_id || record?.raw?.id || record?.raw?.user_id || '').trim();
        const phoneNumber = normalizeLinkedPhoneValue(
            record?.phone_e164 ||
                record?.phone_number ||
                record?.raw?.phone_e164 ||
                record?.raw?.phone_number ||
                record?.raw?.phone
        );
        return {
            userId,
            phoneNumber,
            enabled: Boolean(userId && phoneNumber),
            visible: Boolean(userId && phoneNumber),
        };
    },

    resetSupervisorSupervisionState() {
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
        this.populateSupervisorAreaOptions();
        this.renderSupervisorPhotoGrid();
        this.hideSupervisionSupportCard();
    },

    getShiftReferenceDate(shift) {
        const value = shift?.scheduled_start || shift?.start_time || shift?.scheduled_end || shift?.end_time || null;
        if (!value) {
            return null;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    },

    isShiftFromToday(shift, baseDate = new Date()) {
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

                if (this.currentUser.role === 'super_admin' || this.currentUser.role === 'superuser') {
                    const result = await apiClient.adminRestaurantsManage('list', {
                        is_active: true,
                        limit: 200,
                    });
                    restaurants = mapRestaurantList(result);
                } else {
                    try {
                        const result = await apiClient.adminRestaurantsManage('list', {
                            is_active: true,
                            limit: 200,
                        });
                        restaurants = mapRestaurantList(result);
                    } catch (error) {
                        console.warn(
                            'No fue posible cargar todos los restaurantes para supervisora. Se usará el listado disponible como respaldo.',
                            error
                        );
                        const assignments = await apiClient.restaurantStaffManage('list_my_restaurants');
                        const items = asArray(assignments);
                        restaurants = items
                            .map((item) => ({
                                id: getRestaurantRecordId(item),
                                restaurant_id: getRestaurantRecordId(item),
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
                                address_line: item.restaurant?.address_line || item.address_line,
                                city: item.restaurant?.city || item.city,
                                state: item.restaurant?.state || item.state,
                                country: item.restaurant?.country || item.country,
                                is_active: item.is_active !== false && item.restaurant?.is_active !== false,
                                cleaning_areas: item.restaurant?.cleaning_areas || item.cleaning_areas,
                                effective_cleaning_areas:
                                    item.restaurant?.effective_cleaning_areas ||
                                    item.effective_cleaning_areas ||
                                    item.restaurant?.cleaning_areas ||
                                    item.cleaning_areas,
                                assigned_at: item.assigned_at,
                                raw: item,
                            }))
                            .filter((item) => item.is_active !== false && getRestaurantRecordId(item) != null);
                    }
                }

                this.data.supervisor.restaurants = restaurants;
                this.touchCache('supervisorRestaurants');
                return restaurants;
            }
        );
    },

    async getSupervisorShiftList(options = {}) {
        const todayStart = getTodayStart();
        const todayEnd = getTodayEnd();
        const defaultFrom = toIsoDate(new Date(todayStart.getTime() - 12 * 60 * 60 * 1000));
        const defaultTo = toIsoDate(new Date(todayEnd.getTime() + 12 * 60 * 60 * 1000));

        const {
            forceRestaurants = false,
            restaurantId,
            from = defaultFrom,
            to = defaultTo,
            status,
            employeeId,
            limit = 100,
        } = options;

        const usesDefaultQuery =
            !restaurantId && !status && !employeeId && from === defaultFrom && to === defaultTo && limit === 100;

        if (
            !forceRestaurants &&
            usesDefaultQuery &&
            this.data.supervisor.shifts.length > 0 &&
            this.isCacheFresh('supervisorShifts', CACHE_TTLS.supervisorShifts)
        ) {
            return this.data.supervisor.shifts;
        }

        if (forceRestaurants || this.data.supervisor.restaurants.length === 0) {
            this.data.supervisor.restaurants = await this.getSupervisorRestaurants(forceRestaurants);
        }

        const payload = { from, to, limit };

        if (status) {
            payload.status = status;
        }

        if (employeeId) {
            payload.employee_id = employeeId;
        }

        const requestKey = `supervisorShifts:${JSON.stringify({ restaurantId: restaurantId || '', from, to, status: status || '', employeeId: employeeId || '', limit, role: this.currentUser?.role || '' })}`;
        const fetchShiftList = async () => {
            const isAdminScope = this.currentUser.role === 'super_admin' || this.currentUser.role === 'superuser';
            if (restaurantId || isAdminScope) {
                if (restaurantId) {
                    payload.restaurant_id = Number.isFinite(Number(restaurantId)) ? Number(restaurantId) : restaurantId;
                }

                const result = await apiClient.scheduledShiftsManage('list', payload);
                const shifts = asArray(result).filter((shift) => {
                    const shiftStatus = String(shift?.status || shift?.state || '')
                        .trim()
                        .toLowerCase();
                    return !['cancelado', 'cancelled', 'anulado', 'deleted'].includes(shiftStatus);
                });

                const normalizedShifts = usesDefaultQuery ? this.getTodayShifts(shifts) : shifts;

                if (usesDefaultQuery) {
                    this.data.supervisor.shifts = normalizedShifts;
                    this.touchCache('supervisorShifts');
                }

                return normalizedShifts;
            }

            const restaurants = this.data.supervisor.restaurants;
            if (restaurants.length === 0) {
                return [];
            }

            const grouped = await Promise.all(
                restaurants.map(async (restaurant) => {
                    try {
                        const result = await apiClient.scheduledShiftsManage('list', {
                            ...payload,
                            restaurant_id: getRestaurantRecordId(restaurant),
                        });
                        return asArray(result);
                    } catch (error) {
                        console.warn(`No fue posible listar turnos para ${restaurant.name || restaurant.id}.`, error);
                        return [];
                    }
                })
            );

            const dedupe = new Map();
            grouped.flat().forEach((shift) => {
                const key =
                    shift.id ||
                    shift.scheduled_shift_id ||
                    `${shift.employee_id}-${shift.scheduled_start}-${shift.restaurant_id}`;
                dedupe.set(key, shift);
            });
            const shifts = Array.from(dedupe.values()).filter((shift) => {
                const shiftStatus = String(shift?.status || shift?.state || '')
                    .trim()
                    .toLowerCase();
                return !['cancelado', 'cancelled', 'anulado', 'deleted'].includes(shiftStatus);
            });

            const normalizedShifts = usesDefaultQuery ? this.getTodayShifts(shifts) : shifts;

            if (usesDefaultQuery) {
                this.data.supervisor.shifts = normalizedShifts;
                this.touchCache('supervisorShifts');
            }

            return normalizedShifts;
        };

        return this.runPending(requestKey, fetchShiftList);
    },

    async loadSupervisorDashboard() {
        const [restaurants, shifts] = await Promise.all([
            this.getSupervisorRestaurants(),
            this.getSupervisorShiftList({ forceRestaurants: false }),
            this.loadSupervisorEmployees(false).catch((error) => {
                console.warn(
                    'No fue posible precargar el directorio de empleados para resolver nombres en alertas.',
                    error
                );
            }),
        ]);
        const todayShifts = this.getTodayShifts(shifts);
        this.data.supervisor.shifts = todayShifts;

        const alertsContainer = document.getElementById('supervisor-alerts-container');
        const firstName = (this.currentUser.full_name || this.currentUser.email).split(' ')[0];
        document.getElementById('supervisor-welcome-title').textContent = `Bienvenida, ${firstName}`;
        document.getElementById('supervisor-welcome-subtitle').textContent =
            `${restaurants.length} restaurante(s) disponibles`;

        const now = Date.now();
        const graceMs = SHIFT_NOT_STARTED_ALERT_GRACE_MINUTES * 60 * 1000;
        const pendingAlerts = todayShifts
            .filter((shift) => {
                const status = String(shift.status || shift.state || '').toLowerCase();
                if (!['scheduled', 'programado', 'pending', 'pendiente'].includes(status)) {
                    return false;
                }

                const startTime = new Date(shift?.scheduled_start || shift?.start_time || '').getTime();
                if (!Number.isFinite(startTime) || startTime <= 0) {
                    return false;
                }

                return now >= startTime + graceMs;
            })
            .slice(0, 3);

        if (alertsContainer) {
            if (pendingAlerts.length === 0) {
                alertsContainer.innerHTML = `
                    <div class="alert alert-warning">
                        <i class="fas fa-check-circle"></i>
                        <div>
                            <strong>Sin alertas críticas</strong><br>
                            <small>La operación está al día.</small>
                        </div>
                    </div>
                `;
            } else {
                alertsContainer.innerHTML = pendingAlerts
                    .map(
                        (shift) => `
                    <div class="alert alert-warning">
                        <i class="fas fa-exclamation-circle"></i>
                        <div>
                            <strong>Turno no iniciado</strong><br>
                            <small>${escapeHtml(this.getResolvedShiftEmployeeName(shift, 'Empleado sin nombre visible'))} - ${escapeHtml(this.getResolvedShiftRestaurantName(shift, 'Restaurante sin nombre visible'))} (${escapeHtml(formatShiftRange(shift.scheduled_start, shift.scheduled_end))})</small>
                        </div>
                    </div>
                `
                    )
                    .join('');
            }
        }

        this.warmSupervisorWorkspace();
    },

    async loadSupervisorRestaurants(force = false) {
        if (force) {
            this.invalidateCache('supervisorRestaurants', 'supervisorShifts', 'supervisorEmployees');
            this.invalidateScopedCache('supervisorRestaurantStaff');
            this.invalidateScopedCache('supervisorAssignableEmployees');
        }

        const [restaurants, shifts] = await Promise.all([
            this.getSupervisorRestaurants(force),
            this.getSupervisorShiftList({ forceRestaurants: force }),
        ]);

        const container = document.getElementById('supervisor-restaurants-list');
        if (!container) {
            return;
        }

        if (restaurants.length === 0) {
            const card = document.createElement('div');
            card.className = 'card';
            const copy = document.createElement('p');
            copy.style.color = 'var(--gray)';
            copy.textContent = 'No hay restaurantes disponibles.';
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
                    ` ${availableEmployeeCount != null ? `${availableEmployeeCount} empleado(s) disponibles` : 'Empleados disponibles para programar'}`
                )
            );

            const shiftsLine = document.createElement('p');
            const shiftsIcon = document.createElement('i');
            shiftsIcon.className = 'fas fa-calendar-alt';
            shiftsLine.append(
                shiftsIcon,
                document.createTextNode(` ${String(shiftsForRestaurantCount)} turno(s) en el período actual`)
            );

            card.append(title, address, employeesLine, shiftsLine);

            if (canManageRestaurantLifecycle || canCreateRestaurantTasks) {
                const actions = document.createElement('div');
                actions.className = 'toolbar-actions restaurant-card-actions';
                if (canCreateRestaurantTasks) {
                    const taskBtn = document.createElement('button');
                    taskBtn.type = 'button';
                    taskBtn.className = 'btn btn-secondary btn-inline';
                    taskBtn.dataset.action = 'open-restaurant-special-task';
                    taskBtn.dataset.restaurantId = String(restaurantId || '');
                    taskBtn.innerHTML = '<i class="fas fa-star"></i> Tarea especial';
                    actions.appendChild(taskBtn);
                }

                const removeBtn = document.createElement('button');
                if (canManageRestaurantLifecycle) {
                    removeBtn.type = 'button';
                    removeBtn.className = 'btn btn-danger btn-inline';
                    removeBtn.dataset.action = 'confirm-deactivate-restaurant';
                    removeBtn.dataset.restaurantId = String(restaurantId || '');
                    removeBtn.textContent = 'Eliminar';
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
            this.showToast('No se pudo identificar el restaurante a eliminar.', {
                tone: 'warning',
                title: 'Restaurante inválido',
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
            this.showToast('No se pudo identificar el restaurante a eliminar.', {
                tone: 'warning',
                title: 'Restaurante inválido',
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
            this.showToast('No se pudo identificar el restaurante a eliminar.', {
                tone: 'warning',
                title: 'Restaurante inválido',
            });
            return;
        }

        this.showLoading('Eliminando restaurante...', 'Actualizando la configuración operativa.');

        try {
            await apiClient.adminRestaurantsManage('deactivate', {
                restaurant_id: normalizedRestaurantId,
            });

            this.invalidateCache('adminRestaurants', 'adminMetrics', 'supervisorRestaurants', 'supervisorShifts');
            this.invalidateScopedCache('supervisorRestaurantStaff');
            this.invalidateScopedCache('supervisorAssignableEmployees');

            await Promise.all([
                this.loadSupervisorRestaurants(true),
                this.loadSupervisorShifts(true),
                this.loadSupervisorDashboard(),
                this.isAdminRole() ? this.loadAdminDashboard() : Promise.resolve(),
            ]);

            this.showToast('Restaurante eliminado correctamente.', {
                tone: 'success',
                title: 'Eliminación exitosa',
            });
        } catch (error) {
            const title = this.isAdminRole() ? 'No fue posible eliminar el restaurante' : 'Permiso insuficiente';
            this.showToast(this.getErrorMessage(error, 'No fue posible eliminar el restaurante.'), {
                tone: 'error',
                title,
            });
        } finally {
            this.hideLoading();
        }
    },

    async loadSupervisorEmployees(force = false) {
        if (force) {
            this.invalidateCache('supervisorEmployees', 'supervisorRestaurants');
            this.invalidateScopedCache('supervisorRestaurantStaff');
            this.invalidateScopedCache('supervisorAssignableEmployees');
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
                if (this.currentUser.role === 'super_admin' || this.currentUser.role === 'superuser') {
                    const result = await apiClient.adminUsersManage('list', {
                        role: 'empleado',
                        limit: 100,
                    });
                    return asArray(result).map((item) => ({
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
                    }));
                }

                const directoryResult = await apiClient
                    .restaurantStaffManage('list_assignable_employees', {
                        limit: 200,
                    })
                    .catch((error) => {
                        console.warn('No fue posible cargar el directorio completo de empleados.', error);
                        return [];
                    });

                return asArray(directoryResult)
                    .map((item) => this.normalizeSupervisorEmployeeRecord(item))
                    .filter((employee) => employee.id)
                    .map((employee) => ({
                        id: employee.id,
                        full_name: employee.full_name,
                        email: employee.email,
                        phone_e164: employee.phone_e164,
                        username: employee.username || employee.user_name || employee.employee_username || '',
                        employee_code: employee.employee_code || employee.code || '',
                        is_active: employee.is_active,
                        assigned_restaurants_count: employee.assigned_restaurants_count || 0,
                        assignments: [],
                        available_restaurants: [],
                        raw: employee.raw || employee,
                    }))
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
            paragraph.textContent =
                this.supervisorEmployeesStatusFilter === 'inactive'
                    ? 'No hay empleados inactivos para mostrar.'
                    : this.supervisorEmployeesStatusFilter === 'active'
                      ? 'No hay empleados activos disponibles para mostrar.'
                      : 'No hay empleados disponibles para mostrar.';
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
                    ? 'Empleado inactivo para nuevas programaciones.'
                    : 'Disponible para programarse en cualquier restaurante.';

            info.append(heading, contact, auditMeta);

            const actions = document.createElement('div');
            actions.className = 'employee-list-actions';
            const badge = document.createElement('span');
            badge.className = `badge ${employee.is_active === false ? 'badge-danger' : 'badge-success'}`;
            badge.textContent = employee.is_active === false ? 'Inactivo' : 'Activo';
            actions.appendChild(badge);

            const phoneBindingAction = this.getPhoneBindingActionState(employee);
            if (canManagePhoneBinding && phoneBindingAction.visible) {
                const clearPhoneBtn = document.createElement('button');
                clearPhoneBtn.type = 'button';
                clearPhoneBtn.className = 'btn btn-warning btn-inline';
                clearPhoneBtn.dataset.action = 'clear-phone-user';
                clearPhoneBtn.dataset.userId = String(employee.id || '');
                clearPhoneBtn.textContent = 'Desvincular Teléfono';
                clearPhoneBtn.title = 'Remover el teléfono actual del perfil para poder registrar otro.';
                actions.appendChild(clearPhoneBtn);
            }

            if (employee.is_active !== false) {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn btn-danger btn-inline';
                removeBtn.dataset.action = 'confirm-deactivate-user';
                removeBtn.dataset.userId = String(employee.id || '');
                removeBtn.textContent = 'Eliminar';
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
            this.showToast('No se pudo identificar el empleado para el informe.', {
                tone: 'warning',
                title: 'Empleado inválido',
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
            this.showToast('No se pudo identificar el usuario a eliminar.', {
                tone: 'warning',
                title: 'Usuario inválido',
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
            this.showToast('No se pudo identificar el usuario a eliminar.', {
                tone: 'warning',
                title: 'Usuario inválido',
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
            this.showToast('No se pudo identificar el usuario a eliminar.', {
                tone: 'warning',
                title: 'Usuario inválido',
            });
            return;
        }

        this.showLoading('Eliminando usuario...', 'Actualizando permisos y estado de acceso.');

        try {
            await apiClient.adminUsersManage('deactivate', {
                user_id: normalizedUserId,
                reason: reason || undefined,
            });

            this.invalidateCache('supervisorEmployees', 'supervisorShifts');
            this.invalidateScopedCache('supervisorAssignableEmployees');

            await Promise.all([
                this.loadSupervisorEmployees(true),
                this.loadSupervisorShifts(true),
                this.loadSupervisorDashboard(),
            ]);

            this.showToast('Usuario eliminado correctamente.', {
                tone: 'success',
                title: 'Eliminación exitosa',
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

    getSupervisorWeekStart(date = new Date()) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        d.setDate(d.getDate() + diff);
        d.setHours(0, 0, 0, 0);
        return d;
    },

    getSupervisorWeekLabel() {
        const start = this.supervisorCurrentWeekStart || this.getSupervisorWeekStart();
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        const shortOpts = { day: 'numeric', month: 'short' };
        const fullOpts = { day: 'numeric', month: 'short', year: 'numeric' };
        return `${start.toLocaleDateString('es-CO', shortOpts)} — ${end.toLocaleDateString('es-CO', fullOpts)}`;
    },

    changeSupervisorWeek(dir) {
        if (!this.supervisorCurrentWeekStart) {
            this.supervisorCurrentWeekStart = this.getSupervisorWeekStart();
        }
        const next = new Date(this.supervisorCurrentWeekStart);
        next.setDate(next.getDate() + dir * 7);
        this.supervisorCurrentWeekStart = next;
        this.applySupervisorShiftFilters();
    },

    async replicateSupervisorLastWeek() {
        const weekStart = this.supervisorCurrentWeekStart || this.getSupervisorWeekStart();
        const lastWeekStart = new Date(weekStart.getTime() - 7 * 24 * 3600000);
        const lastWeekEnd = weekStart;

        const lastWeekShifts = asArray(this.data.supervisor.shifts).filter((shift) => {
            const startValue = shift?.scheduled_start || shift?.start_time;
            if (!startValue) return false;
            const d = new Date(startValue);
            return d >= lastWeekStart && d < lastWeekEnd;
        });

        if (lastWeekShifts.length === 0) {
            this.showToast('No hay turnos en la semana anterior para replicar.', {
                tone: 'warning',
                title: 'Sin turnos anteriores',
            });
            return;
        }

        if (!confirm(`¿Replicar ${lastWeekShifts.length} turno(s) de la semana anterior?`)) return;

        this.showLoading('Replicando turnos...', `Creando ${lastWeekShifts.length} programaciones.`);

        try {
            let success = 0;
            let failed = 0;
            await Promise.all(
                lastWeekShifts.map(async (shift) => {
                    try {
                        const startValue = shift?.scheduled_start || shift?.start_time;
                        const endValue = shift?.scheduled_end || shift?.end_time;
                        if (!startValue || !endValue) {
                            failed++;
                            return;
                        }

                        const newStart = new Date(new Date(startValue).getTime() + 7 * 24 * 3600000);
                        const newEnd = new Date(new Date(endValue).getTime() + 7 * 24 * 3600000);
                        const empId = shift.employee_id || shift.assigned_employee_id;
                        const restId = shift.restaurant_id;
                        if (!empId || !restId) {
                            failed++;
                            return;
                        }

                        await apiClient.scheduledShiftsManage('assign', {
                            employee_id: empId,
                            restaurant_id: restId,
                            scheduled_start: newStart.toISOString(),
                            scheduled_end: newEnd.toISOString(),
                            notes: shift.notes || undefined,
                        });
                        success++;
                    } catch {
                        failed++;
                    }
                })
            );

            await this.loadSupervisorShifts(true);
            const tone = failed > 0 ? 'warning' : 'success';
            const msg =
                failed > 0
                    ? `${success} turno(s) replicado(s). ${failed} no se pudieron crear.`
                    : `${success} turno(s) replicado(s) correctamente.`;
            this.showToast(msg, { tone, title: 'Semana replicada' });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible replicar la semana anterior.'), {
                tone: 'error',
                title: 'Error al replicar',
            });
        } finally {
            this.hideLoading();
        }
    },

    openShiftModalForCell(employeeId, dateTimeLocal) {
        this.openModal('modal-supervisor-schedule-shift');
        this.setSupervisorShiftMode('single');
        window.requestAnimationFrame(() => {
            const empSelect = document.getElementById('supervisor-shift-single-employee');
            if (empSelect && employeeId) empSelect.value = employeeId;
            const startInput = document.getElementById('supervisor-shift-single-start');
            const endInput = document.getElementById('supervisor-shift-single-end');
            if (startInput && dateTimeLocal) {
                startInput.value = dateTimeLocal;
                const startDate = new Date(dateTimeLocal);
                if (!Number.isNaN(startDate.getTime()) && endInput) {
                    endInput.value = toDateTimeLocalInput(new Date(startDate.getTime() + 8 * 3600000));
                }
            }
        });
    },

    async loadSupervisorShifts(force = false) {
        if (!this.supervisorCurrentWeekStart) {
            this.supervisorCurrentWeekStart = this.getSupervisorWeekStart();
        }

        if (force) {
            this.invalidateCache('supervisorShifts', 'supervisorRestaurants');
        }

        if (
            this.data.supervisor.employees.length === 0 ||
            !this.isCacheFresh('supervisorEmployees', CACHE_TTLS.supervisorEmployees)
        ) {
            await this.loadSupervisorEmployees(force);
        }

        const rangeStart = toIsoDate(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));
        const rangeEnd = toIsoDate(new Date(Date.now() + 180 * 24 * 60 * 60 * 1000));

        this.data.supervisor.shifts = await this.getSupervisorShiftList({
            forceRestaurants: force,
            from: rangeStart,
            to: rangeEnd,
            status: 'scheduled',
            limit: 500,
        });

        this.populateSupervisorShiftFilters(this.data.supervisor.shifts);
        this.applySupervisorShiftFilters();
    },

    normalizeSupervisorShiftEmployeeLabel(value, fallback = 'Empleado por confirmar') {
        const text = String(value || '').trim();
        if (!text) {
            return fallback;
        }

        const normalized = text.toLowerCase();
        if (
            normalized === 'empleado' ||
            normalized.includes('sin nombre visible') ||
            /^empleado\s+[a-f0-9-]{6,}$/i.test(text)
        ) {
            return fallback;
        }

        return text;
    },

    clearSupervisorShiftFilters() {
        this.supervisorShiftFilters = { employeeId: '', date: '', restaurantId: '', search: '' };
        this.supervisorCurrentWeekStart = this.getSupervisorWeekStart();

        const el = (id) => document.getElementById(id);
        if (el('supervisor-shifts-filter-employee')) el('supervisor-shifts-filter-employee').value = '';
        if (el('supervisor-shifts-filter-restaurant')) el('supervisor-shifts-filter-restaurant').value = '';
        if (el('supervisor-shifts-filter-search')) el('supervisor-shifts-filter-search').value = '';

        this.applySupervisorShiftFilters();
    },

    populateSupervisorShiftFilters(shifts = []) {
        const employeeFilter = document.getElementById('supervisor-shifts-filter-employee');
        if (!employeeFilter) {
            return;
        }

        const previousEmployeeId = this.supervisorShiftFilters.employeeId || employeeFilter.value || '';
        const employeeMap = new Map();

        asArray(this.data.supervisor.employees).forEach((employee) => {
            const employeeId = String(employee?.id || '').trim();
            if (!employeeId) {
                return;
            }

            employeeMap.set(employeeId, {
                id: employeeId,
                name: getEmployeeDisplayName(employee, 'Empleado'),
            });
        });

        asArray(shifts).forEach((shift) => {
            const employeeId = String(
                shift?.employee_id || shift?.assigned_employee_id || shift?.employee?.id || shift?.user_id || ''
            ).trim();
            if (!employeeId || employeeMap.has(employeeId)) {
                return;
            }

            employeeMap.set(employeeId, {
                id: employeeId,
                name: this.normalizeSupervisorShiftEmployeeLabel(
                    this.getResolvedShiftEmployeeName(shift, 'Empleado'),
                    'Empleado por confirmar'
                ),
            });
        });

        const options = Array.from(employeeMap.values()).sort((left, right) =>
            String(left.name || '').localeCompare(String(right.name || ''), 'es', { sensitivity: 'base' })
        );

        employeeFilter.innerHTML = `
            <option value="">Todos los empleados</option>
            ${options
                .map(
                    (option) => `
                <option value="${escapeHtml(option.id)}">${escapeHtml(option.name || 'Empleado')}</option>
            `
                )
                .join('')}
        `;

        const availableIds = new Set(options.map((option) => option.id));
        const selectedEmployeeId = availableIds.has(String(previousEmployeeId)) ? String(previousEmployeeId) : '';
        employeeFilter.value = selectedEmployeeId;
        this.supervisorShiftFilters.employeeId = selectedEmployeeId;

        const restaurantFilter = document.getElementById('supervisor-shifts-filter-restaurant');
        if (restaurantFilter) {
            const prevRestId = this.supervisorShiftFilters.restaurantId || restaurantFilter.value || '';
            const restaurantMap = new Map();
            asArray(this.data.supervisor.restaurants).forEach((r) => {
                const id = String(r?.id || '').trim();
                if (id) restaurantMap.set(id, getRestaurantDisplayName(r, 'Restaurante'));
            });
            restaurantFilter.innerHTML =
                '<option value="">Todos los restaurantes</option>' +
                Array.from(restaurantMap.entries())
                    .map(
                        ([id, name]) =>
                            `<option value="${escapeHtml(id)}" ${id === prevRestId ? 'selected' : ''}>${escapeHtml(name)}</option>`
                    )
                    .join('');
            this.supervisorShiftFilters.restaurantId = restaurantMap.has(prevRestId) ? prevRestId : '';
        }
    },

    getFilteredSupervisorShifts(shifts = this.data.supervisor.shifts || []) {
        const selectedEmployeeId = String(this.supervisorShiftFilters.employeeId || '').trim();
        const selectedRestaurantId = String(this.supervisorShiftFilters.restaurantId || '').trim();

        const weekStart = this.supervisorCurrentWeekStart || this.getSupervisorWeekStart();
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3600000);

        return asArray(shifts).filter((shift) => {
            const startValue = shift?.scheduled_start || shift?.start_time || null;
            if (!startValue) return false;
            const shiftDate = new Date(startValue);
            if (Number.isNaN(shiftDate.getTime())) return false;
            if (shiftDate < weekStart || shiftDate >= weekEnd) return false;

            if (selectedEmployeeId) {
                const shiftEmpId = String(
                    shift?.employee_id || shift?.assigned_employee_id || shift?.employee?.id || shift?.user_id || ''
                ).trim();
                if (shiftEmpId !== selectedEmployeeId) return false;
            }

            if (selectedRestaurantId) {
                const shiftRestId = String(shift?.restaurant_id || '').trim();
                if (shiftRestId !== selectedRestaurantId) return false;
            }

            return true;
        });
    },

    toShiftIntervalRange(item) {
        const startValue = item?.scheduled_start || item?.start_time || null;
        const endValue = item?.scheduled_end || item?.end_time || null;
        const start = startValue ? new Date(startValue) : null;
        const end = endValue ? new Date(endValue) : null;

        if (!start || Number.isNaN(start.getTime())) {
            return null;
        }

        const normalizedEnd =
            end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime()
                ? end
                : new Date(start.getTime() + 60000);

        return {
            start,
            end: normalizedEnd,
            startMs: start.getTime(),
            endMs: normalizedEnd.getTime(),
        };
    },

    doShiftIntervalsOverlap(leftRange, rightRange) {
        if (!leftRange || !rightRange) {
            return false;
        }

        return leftRange.startMs < rightRange.endMs && leftRange.endMs > rightRange.startMs;
    },

    findShiftAssignmentConflict(assignments = [], existingShifts = []) {
        const normalizedAssignments = asArray(assignments).filter(Boolean);
        if (normalizedAssignments.length === 0) {
            return null;
        }

        const nonBlockingStates = new Set([
            'cancelado',
            'cancelled',
            'anulado',
            'deleted',
            'completed',
            'completado',
            'finalizado',
            'finished',
            'closed',
            'done',
        ]);

        const normalizedExisting = asArray(existingShifts)
            .filter(Boolean)
            .filter(
                (shift) =>
                    !nonBlockingStates.has(
                        String(shift?.status || shift?.state || '')
                            .trim()
                            .toLowerCase()
                    )
            );

        const decoratedAssignments = normalizedAssignments.map((assignment, index) => ({
            index,
            assignment,
            employeeId: String(assignment?.employee_id || assignment?.assigned_employee_id || '').trim(),
            range: this.toShiftIntervalRange(assignment),
        }));

        for (const current of decoratedAssignments) {
            if (!current.employeeId || !current.range) {
                continue;
            }

            for (const shift of normalizedExisting) {
                const shiftEmployeeId = String(
                    shift?.employee_id || shift?.assigned_employee_id || shift?.employee?.id || shift?.user_id || ''
                ).trim();
                if (!shiftEmployeeId || shiftEmployeeId !== current.employeeId) {
                    continue;
                }

                const shiftRange = this.toShiftIntervalRange(shift);
                if (!shiftRange) {
                    continue;
                }

                if (this.doShiftIntervalsOverlap(current.range, shiftRange)) {
                    return {
                        type: 'existing',
                        assignment: current.assignment,
                        existingShift: shift,
                        employeeId: current.employeeId,
                    };
                }
            }
        }

        for (let leftIndex = 0; leftIndex < decoratedAssignments.length; leftIndex += 1) {
            const left = decoratedAssignments[leftIndex];
            if (!left.employeeId || !left.range) {
                continue;
            }

            for (let rightIndex = leftIndex + 1; rightIndex < decoratedAssignments.length; rightIndex += 1) {
                const right = decoratedAssignments[rightIndex];
                if (!right.employeeId || !right.range || right.employeeId !== left.employeeId) {
                    continue;
                }

                if (this.doShiftIntervalsOverlap(left.range, right.range)) {
                    return {
                        type: 'batch',
                        leftAssignment: left.assignment,
                        rightAssignment: right.assignment,
                        employeeId: left.employeeId,
                    };
                }
            }
        }

        return null;
    },

    applySupervisorShiftFilters() {
        const filteredShifts = this.getFilteredSupervisorShifts(this.data.supervisor.shifts || []);
        this.renderSupervisorShiftGrid(filteredShifts);
    },

    renderSupervisorWeekStats(weekShifts = []) {
        let totalMs = 0;
        weekShifts.forEach((shift) => {
            const range = this.toShiftIntervalRange(shift);
            if (range) totalMs += range.endMs - range.startMs;
        });
        const totalHours = totalMs / 3600000;
        const activeEmps = new Set(weekShifts.map((s) => String(s.employee_id || s.assigned_employee_id || ''))).size;
        const rests = new Set(weekShifts.map((s) => String(s.restaurant_id || ''))).size;

        const setStatEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setStatEl('sws-shifts', String(weekShifts.length));
        setStatEl('sws-hours', formatHours(totalHours));
        setStatEl('sws-employees', String(activeEmps));
        setStatEl('sws-restaurants', String(rests));
    },

    buildWeekShiftMap(weekShifts) {
        const map = new Map();
        weekShifts.forEach((shift) => {
            const empId = String(
                shift?.employee_id || shift?.assigned_employee_id || shift?.employee?.id || shift?.user_id || ''
            ).trim();
            const startValue = shift?.scheduled_start || shift?.start_time;
            if (!empId || !startValue) return;
            const key = `${empId}|${toLocalDateKey(new Date(startValue))}`;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(shift);
        });
        return map;
    },

    renderSsgShiftCell(cellShifts) {
        const entries = cellShifts
            .map((shift) => {
                const restName = escapeHtml(this.getResolvedShiftRestaurantName(shift, ''));
                const timeRange = escapeHtml(formatShiftRange(shift.scheduled_start, shift.scheduled_end));
                const shiftId = escapeHtml(String(shift.id || shift.scheduled_shift_id || ''));
                return `<div class="ssg-shift-entry">
                <div class="ssg-shift-rest">${restName}</div>
                <div class="ssg-shift-time">${timeRange}</div>
                ${shiftId ? `<button class="ssg-del-btn" onclick="event.stopPropagation();app.confirmCancelScheduledShift('${shiftId}')" title="Eliminar"><i class="fas fa-times"></i></button>` : ''}
            </div>`;
            })
            .join('');
        return `<div class="ssg-shift-cell ssg-has-shift">${entries}</div>`;
    },

    renderSupervisorShiftGrid(weekShifts = []) {
        const container = document.getElementById('supervisor-shifts-grid');
        if (!container) return;

        const weekStart = this.supervisorCurrentWeekStart || this.getSupervisorWeekStart();
        const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
        const today = toLocalDateKey(new Date());

        const weekLabel = document.getElementById('supervisor-week-label');
        if (weekLabel) weekLabel.textContent = this.getSupervisorWeekLabel();

        this.renderSupervisorWeekStats(weekShifts);

        const weekDays = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(weekStart);
            d.setDate(d.getDate() + i);
            return { date: d, key: toLocalDateKey(d) };
        });

        const search = String(this.supervisorShiftFilters.search || '')
            .toLowerCase()
            .trim();
        let displayEmployees = asArray(this.data.supervisor.employees).filter((e) => e.is_active !== false);
        if (this.supervisorShiftFilters.employeeId) {
            displayEmployees = displayEmployees.filter((e) => String(e.id) === this.supervisorShiftFilters.employeeId);
        }
        if (search) {
            displayEmployees = displayEmployees.filter((e) =>
                getEmployeeDisplayName(e, '').toLowerCase().includes(search)
            );
        }

        if (displayEmployees.length === 0 && weekShifts.length === 0) {
            container.innerHTML =
                '<div class="empty-state">No hay empleados disponibles. Agrega empleados para ver la grilla semanal.</div>';
            return;
        }

        const shiftsByKey = this.buildWeekShiftMap(weekShifts);

        let html = '<div class="ssg-grid">';
        html += `<div class="ssg-header-cell ssg-employee-header">Empleado</div>`;
        weekDays.forEach(({ date, key }, i) => {
            const isToday = key === today;
            html += `<div class="ssg-header-cell ssg-day-header${isToday ? ' ssg-today' : ''}">${DAY_NAMES[i]}<br><span class="ssg-date-num">${date.getDate()}</span></div>`;
        });

        displayEmployees.forEach((emp) => {
            const empId = String(emp.id || '');
            html += `<div class="ssg-employee-cell">${escapeHtml(getEmployeeDisplayName(emp, 'Empleado'))}</div>`;
            weekDays.forEach(({ key }) => {
                const cellShifts = shiftsByKey.get(`${empId}|${key}`) || [];
                html +=
                    cellShifts.length === 0
                        ? `<div class="ssg-shift-cell ssg-empty-cell"></div>`
                        : this.renderSsgShiftCell(cellShifts);
            });
        });

        html += '</div>';
        container.innerHTML = html;
    },

    confirmCancelScheduledShift(shiftId) {
        if (this.pendingShiftCancellationRequest) {
            this.showToast('Ya estamos procesando la eliminación del turno. Espera un momento.', {
                tone: 'info',
                title: 'Eliminación en progreso',
            });
            return;
        }

        const normalizedShiftId = normalizeRestaurantId(shiftId);
        if (normalizedShiftId == null) {
            this.showToast('No se pudo identificar el turno programado a eliminar.', {
                tone: 'warning',
                title: 'Turno inválido',
            });
            return;
        }

        void this.cancelScheduledShift(normalizedShiftId);
    },

    closeCancelScheduledShiftModal() {
        this.pendingShiftCancellationId = '';
        const reasonInput = document.getElementById('scheduled-shift-cancel-reason');
        if (reasonInput) {
            reasonInput.value = '';
        }
        this.closeModal('modal-scheduled-shift-cancel');
    },

    async submitCancelScheduledShiftModal() {
        const shiftId = normalizeRestaurantId(this.pendingShiftCancellationId);
        if (shiftId == null) {
            this.showToast('No se pudo identificar el turno programado a eliminar.', {
                tone: 'warning',
                title: 'Turno inválido',
            });
            this.closeCancelScheduledShiftModal();
            return;
        }

        const reasonInput = document.getElementById('scheduled-shift-cancel-reason');
        const reason = String(reasonInput?.value || '').trim();

        this.closeModal('modal-scheduled-shift-cancel');
        this.pendingShiftCancellationId = '';
        if (reasonInput) {
            reasonInput.value = '';
        }

        await this.cancelScheduledShift(shiftId, reason);
    },

    async cancelScheduledShift(shiftId, reason = '') {
        if (this.pendingShiftCancellationRequest) {
            this.showToast('Ya estamos procesando la eliminación del turno. Espera un momento.', {
                tone: 'info',
                title: 'Eliminación en progreso',
            });
            return;
        }

        const normalizedShiftId = normalizeRestaurantId(shiftId);
        if (normalizedShiftId == null) {
            this.showToast('No se pudo identificar el turno programado a eliminar.', {
                tone: 'warning',
                title: 'Turno inválido',
            });
            return;
        }

        this.pendingShiftCancellationRequest = true;

        this.showLoading('Eliminando turno...', 'Quitando la programación del turno seleccionado.');

        try {
            await apiClient.scheduledShiftsManage('cancel', {
                scheduled_shift_id: normalizedShiftId,
                reason: reason || undefined,
            });

            this.invalidateCache('supervisorShifts', 'employeeDashboard');
            await this.loadSupervisorShifts(true);

            if (this.currentPage === 'supervisor-dashboard') {
                await this.loadSupervisorDashboard();
            }

            if (this.currentPage === 'supervisor-supervision') {
                await this.prepareSupervisorSupervisionPage().catch((error) => {
                    console.warn('No fue posible refrescar la pantalla de supervisión tras eliminar el turno.', error);
                });
            }

            if (this.currentPage === 'employee-dashboard' || this.currentPage === 'employee-profile') {
                await this.loadEmployeeDashboard(true).catch((error) => {
                    console.warn('No fue posible refrescar el dashboard del empleado tras eliminar el turno.', error);
                });
            }

            this.showToast('Turno eliminado correctamente.', {
                tone: 'success',
                title: 'Eliminación exitosa',
            });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible eliminar el turno programado.'), {
                tone: 'error',
                title: 'No fue posible eliminar el turno',
            });
        } finally {
            this.pendingShiftCancellationRequest = false;
            this.hideLoading();
        }
    },

    async prepareSupervisorReportsPage() {
        const restaurants = await this.getSupervisorRestaurants();
        if (this.data.supervisor.employees.length === 0) {
            await this.loadSupervisorEmployees();
        }

        const restaurantSelect = document.getElementById('report-restaurant-select');
        const employeeSelect = document.getElementById('report-employee-select');
        if (!restaurantSelect) {
            return;
        }

        const currentRestaurantValue = restaurantSelect.value;
        const currentEmployeeValue = employeeSelect?.value || '';

        if (restaurants.length === 0) {
            restaurantSelect.innerHTML = '<option value="">Todos los restaurantes</option>';
            if (employeeSelect) {
                employeeSelect.innerHTML = `
                    <option value="">Todos los empleados</option>
                    ${this.data.supervisor.employees
                        .map(
                            (employee) => `
                        <option value="${escapeHtml(String(employee.id))}" ${String(employee.id) === currentEmployeeValue ? 'selected' : ''}>
                            ${escapeHtml(getEmployeeDisplayName(employee))}
                        </option>
                    `
                        )
                        .join('')}
                `;
            }
            this.updateReportSupportCard();
            return;
        }

        restaurantSelect.innerHTML = `
            <option value="">Todos los restaurantes</option>
            ${restaurants
                .map(
                    (restaurant, index) => `
            <option value="${escapeHtml(String(getRestaurantRecordId(restaurant)))}">
                ${escapeHtml(getRestaurantDisplayName(restaurant))}
            </option>
        `
                )
                .join('')}
        `;

        const availableRestaurantIds = new Set(
            restaurants.map((restaurant) => String(getRestaurantRecordId(restaurant)))
        );
        restaurantSelect.value = availableRestaurantIds.has(String(currentRestaurantValue))
            ? String(currentRestaurantValue)
            : '';

        if (employeeSelect) {
            employeeSelect.innerHTML = `
                <option value="">Todos los empleados</option>
                ${this.data.supervisor.employees
                    .map(
                        (employee) => `
                    <option value="${escapeHtml(String(employee.id))}" ${String(employee.id) === currentEmployeeValue ? 'selected' : ''}>
                        ${escapeHtml(getEmployeeDisplayName(employee))}
                    </option>
                `
                    )
                    .join('')}
            `;
        }
        this.updateReportSupportCard();
    },

    async prepareSupervisorSupervisionPage() {
        if (this.data.supervisor.restaurants.length === 0) {
            this.data.supervisor.restaurants = await this.getSupervisorRestaurants();
        }

        if (
            this.data.supervisor.shifts.length === 0 ||
            !this.isCacheFresh('supervisorShifts', CACHE_TTLS.supervisorShifts)
        ) {
            this.data.supervisor.shifts = await this.getSupervisorShiftList({ forceRestaurants: false });
        }

        this.populateSupervisorRestaurantOptions('supervision-restaurant-select', false);
        this.selectedSupervisorShiftId = '';
        this.updateSupervisorSupervisionLocationLabel();
        this.updateSupervisionSupportCard();
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
            container.innerHTML =
                '<div class="empty-state">Selecciona un restaurante para preparar la supervisión en sitio.</div>';
            return;
        }

        const availableAreas = this.getSupervisorAvailableAreas();
        const locationStatusLabel = !geofence?.isReady
            ? 'Geocerca pendiente'
            : locationCheck?.ok
              ? 'En sitio'
              : locationCheck?.attemptedAt
                ? 'Fuera de rango'
                : 'Pendiente';
        const locationStatusClass = !geofence?.isReady
            ? 'badge-warning'
            : locationCheck?.ok
              ? 'badge-success'
              : locationCheck?.attemptedAt
                ? 'badge-danger'
                : 'badge-warning';
        const locationSummary = !geofence?.isReady
            ? 'Este restaurante todavía no tiene coordenadas verificables.'
            : locationCheck?.ok
              ? `${Math.round(locationCheck.distanceMeters || 0)} m del punto de control`
              : locationCheck?.attemptedAt
                ? `${Math.round(locationCheck.distanceMeters || 0)} m del punto de control`
                : 'Verifica tu ubicación para validar presencia en sitio';

        container.innerHTML = `
            <div class="supervision-target-top">
                <div>
                    <strong>${escapeHtml(restaurantName)}</strong>
                    <p class="muted-copy">${escapeHtml(addressText || 'Ubicación del restaurante pendiente de detalle')}</p>
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
                    <span class="supervision-target-value">${escapeHtml(shifts.length > 0 ? 'La supervisión se guarda sobre el restaurante, no sobre un turno puntual.' : 'Puedes supervisar aunque hoy no haya turnos cargados en el resumen.')}</span>
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
            label.textContent = 'Selecciona un restaurante para verificar la ubicación en sitio.';
            if (button) {
                button.disabled = true;
                button.innerHTML = '<i class="fas fa-location-crosshairs"></i> Verificar en sitio';
            }
            this.renderSupervisorSupervisionSummary();
            return;
        }

        if (!geofence?.isReady) {
            shell.classList.add('warning');
            label.textContent = `El restaurante ${restaurantName} todavía no tiene geocerca configurada.`;
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
            label.textContent = `Ubicación validada en ${restaurantName}: ${Math.round(activeResult.distanceMeters || 0)} m del punto de control.`;
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-check"></i> Revalidar ubicación';
            }
        } else if (activeResult?.attemptedAt) {
            shell.classList.add('invalid');
            if (icon) {
                icon.className = 'fas fa-times-circle';
            }
            label.textContent = `Fuera de rango para ${restaurantName}: ${Math.round(activeResult.distanceMeters || 0)} m de distancia con radio de ${Math.round(activeResult.radiusMeters || 0)} m.`;
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-rotate-right"></i> Reintentar verificación';
            }
        } else {
            shell.classList.add('warning');
            label.textContent = `Ubicación lista para verificar en ${restaurantName}.`;
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
            this.showToast('Selecciona un restaurante antes de verificar la ubicación.', {
                tone: 'warning',
                title: 'Falta el restaurante',
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
                    `El restaurante ${restaurantName} aún no tiene ubicación o radio configurados para validar presencia en sitio.`,
                    {
                        tone: 'warning',
                        title: 'Geocerca pendiente',
                    }
                );
                return null;
            }

            let location = this.location;
            if (forceCapture || !location) {
                location = await this.captureLocation({ updateUi: false });
            }

            const distanceMeters = calculateDistanceMeters(location, {
                lat: geofence.lat,
                lng: geofence.lng,
            });
            const accuracyMeters = Math.max(0, Number(location?.accuracy || 0));
            const effectiveRadiusMeters = Math.max(geofence.radiusMeters || 0, 0) + Math.min(accuracyMeters, 35);
            const result = {
                restaurantId: String(getRestaurantRecordId(restaurant) || ''),
                restaurantName,
                attemptedAt: new Date().toISOString(),
                ok: distanceMeters != null && distanceMeters <= effectiveRadiusMeters,
                location,
                distanceMeters,
                radiusMeters: geofence.radiusMeters || 0,
                effectiveRadiusMeters,
                accuracyMeters,
            };

            this.supervisionLocationVerified = result.ok;
            this.supervisionLocationCheck = result;
            this.updateSupervisorSupervisionLocationUi(result);

            if (notify) {
                this.showToast(
                    result.ok
                        ? `Ubicación validada para ${restaurantName}. Ya puedes registrar la supervisión.`
                        : `No estás dentro del radio permitido de ${restaurantName}. Acércate al restaurante para registrar la supervisión.`,
                    {
                        tone: result.ok ? 'success' : 'warning',
                        title: result.ok ? 'Ubicación validada' : 'Fuera de rango',
                    }
                );
            }

            return result;
        } catch (error) {
            this.supervisionLocationVerified = false;
            this.supervisionLocationCheck = {
                restaurantId: String(getRestaurantRecordId(restaurant) || ''),
                restaurantName,
                attemptedAt: new Date().toISOString(),
                ok: false,
                distanceMeters: null,
                radiusMeters: geofence?.radiusMeters || 0,
                errorMessage: this.getGeolocationMessage(error),
            };
            this.updateSupervisorSupervisionLocationUi(this.supervisionLocationCheck);

            if (notify) {
                this.showToast(this.getGeolocationMessage(error), {
                    tone: 'error',
                    title: 'No fue posible verificar ubicación',
                });
                return null;
            }

            throw error;
        } finally {
            this.updateSupervisorSupervisionLocationUi();
        }
    },

    async ensureSupervisorSupervisionLocationVerified() {
        const { restaurantName, geofence } = this.getSupervisorSupervisionReference();
        if (!geofence?.isReady) {
            throw new Error(
                `No puedes registrar la supervisión porque ${restaurantName || 'el restaurante seleccionado'} no tiene geocerca configurada.`
            );
        }

        const result = await this.verifySupervisorSupervisionLocation({
            forceCapture: true,
            notify: false,
        });

        if (!result) {
            throw new Error('No fue posible verificar la ubicación para registrar la supervisión.');
        }

        if (!result?.ok) {
            const resolvedRestaurantName = result?.restaurantName || restaurantName || 'el restaurante seleccionado';
            const distanceText = Number.isFinite(Number(result.distanceMeters))
                ? `${Math.round(result.distanceMeters)} m`
                : 'una distancia no disponible';
            const radiusText = Number.isFinite(Number(result.radiusMeters))
                ? `${Math.round(result.radiusMeters)} m`
                : 'el radio configurado';

            throw new Error(
                `No puedes registrar la supervisión porque tu ubicación está fuera del rango permitido de ${resolvedRestaurantName}. Distancia detectada: ${distanceText}. Radio base: ${radiusText}.`
            );
        }

        return result;
    },

    updateSupervisorSupervisionLocationLabel() {
        this.clearSupervisionRegisterRetryState();
        this.clearSupervisorSupervisionLocationState();
        this.resetSupervisorSupervisionState();
        this.updateSupervisorSupervisionLocationUi();
    },

    openSupervisorRestaurantTaskModalFromSupervision() {
        const restaurant = this.getSupervisorSelectedRestaurant();
        const restaurantId = restaurant ? String(getRestaurantRecordId(restaurant) || '') : '';
        void this.openSupervisorRestaurantTaskModal(restaurantId, 'supervision');
    },

    async openSupervisorRestaurantTaskModal(restaurantId = '', source = 'restaurants') {
        this.restaurantTaskDraftRestaurantId = String(restaurantId || '').trim();
        this.restaurantTaskDraftSource = String(source || '').trim() || 'restaurants';
        await this.openModal('modal-supervisor-restaurant-task');
    },

    updateSupervisorRestaurantTaskContextCopy() {},

    async prepareSupervisorRestaurantTaskModal() {
        if (this.data.supervisor.restaurants.length === 0) {
            this.data.supervisor.restaurants = await this.getSupervisorRestaurants();
        }

        const form = document.getElementById('supervisor-restaurant-task-form');
        form?.reset();

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

        const prioritySelect = document.getElementById('supervisor-restaurant-task-priority');
        if (prioritySelect) {
            prioritySelect.value = 'high';
        }

        this.restaurantTaskSubmitPending = false;
        this.updateSupervisorRestaurantTaskContextCopy();
    },

    getSupervisorRestaurantTaskDraft() {
        return {
            restaurantId: String(document.getElementById('supervisor-restaurant-task-restaurant')?.value || '').trim(),
            title: document.getElementById('supervisor-restaurant-task-title')?.value?.trim() || '',
            description: document.getElementById('supervisor-restaurant-task-description')?.value?.trim() || '',
            requiresEvidence: document.getElementById('supervisor-restaurant-task-requires-evidence')?.checked === true,
            priority: document.getElementById('supervisor-restaurant-task-priority')?.value?.trim() || '',
            source: this.restaurantTaskDraftSource || 'restaurants',
        };
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
            return 'El empleado no tiene un turno activo en este restaurante. Debe activar su turno primero.';
        return this.getErrorMessage(error, fallback);
    },

    async submitSupervisorRestaurantTaskForm() {
        if (this.restaurantTaskSubmitPending) {
            return;
        }

        const draft = this.getSupervisorRestaurantTaskDraft();
        if (!draft.restaurantId) {
            this.showToast('Selecciona el restaurante al que vas a ligar la tarea especial.', {
                tone: 'warning',
                title: 'Falta el restaurante',
            });
            return;
        }

        if (draft.title.length < 3) {
            this.showToast('Escribe un título de al menos 3 caracteres para la tarea especial.', {
                tone: 'warning',
                title: 'Falta el título',
            });
            return;
        }

        if (draft.description.length < 5) {
            this.showToast('Describe la tarea especial con al menos 5 caracteres.', {
                tone: 'warning',
                title: 'Falta la descripción',
            });
            return;
        }

        const restaurant =
            asArray(this.data.supervisor.restaurants).find(
                (item) => String(getRestaurantRecordId(item) || '').trim() === draft.restaurantId
            ) || null;
        const restaurantName = restaurant ? getRestaurantDisplayName(restaurant) : 'el restaurante seleccionado';
        const payloadBase = {
            restaurant_id: this.normalizeTaskCreatePayloadValue(draft.restaurantId),
            task_scope: 'restaurant',
            scope: 'restaurant',
            title: draft.title,
            description: draft.description,
            requires_evidence: draft.requiresEvidence,
            priority: draft.priority || undefined,
            origin_page: draft.source,
        };
        const payloadVariants = payloadBase.priority
            ? [payloadBase, { ...payloadBase, priority: undefined }]
            : [payloadBase];

        this.setSupervisorRestaurantTaskSubmitState(true);
        this.showLoading('Creando tarea especial...', 'Guardando la novedad operativa del restaurante.');

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
                title: 'Tarea creada',
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
                    title: 'No fue posible crear la tarea',
                }
            );
        } finally {
            this.hideLoading();
            this.setSupervisorRestaurantTaskSubmitState(false);
        }
    },

    getShiftEvidenceDisplayTitle(item = {}) {
        return String(item.photo_label || item.subarea_label || item.area_label || 'Foto').trim();
    },

    getShiftEvidenceDisplayMeta(item = {}) {
        const titleKey = normalizeAreaToken(this.getShiftEvidenceDisplayTitle(item));
        const metaParts = [];

        [item.area_label, item.subarea_label].forEach((value) => {
            const label = String(value || '').trim();
            if (!label || normalizeAreaToken(label) === titleKey) {
                return;
            }

            if (!metaParts.some((existingLabel) => normalizeAreaToken(existingLabel) === normalizeAreaToken(label))) {
                metaParts.push(label);
            }
        });

        const capturedAt = formatDateTime(item.captured_at);
        if (capturedAt !== '-') {
            metaParts.push(capturedAt);
        }

        return metaParts.join(' • ');
    },

    getEarlyEndReasonLabel(shift = {}) {
        return String(shift?.early_end_reason || shift?.ended_early_reason || '').trim();
    },

    buildEvidenceItemKey(item = {}, index = 0) {
        const areaToken = normalizeAreaToken(item.area_label || '');
        const subareaToken = normalizeAreaToken(item.subarea_label || '');
        const titleToken = normalizeAreaToken(this.getShiftEvidenceDisplayTitle(item));
        const key = `${areaToken}__${subareaToken}__${titleToken}`.replace(/^_+|_+$/g, '');
        return key || `item_${index + 1}`;
    },

    renderReportEvidenceTile(phaseLabel, item, index) {
        if (!item?.url) {
            return `<div class="report-day-photo report-day-photo-empty">
                <div class="report-day-photo-copy">
                    <span class="report-day-photo-phase">${escapeHtml(phaseLabel)}</span>
                    <span class="report-day-photo-meta">Sin foto correspondiente</span>
                </div>
            </div>`;
        }
        return `<a class="report-day-photo" href="${escapeHtml(item.url)}" aria-label="${escapeHtml(`${phaseLabel} ${index + 1}`)}">
            <span class="report-day-photo-thumb">
                <img src="${escapeHtml(item.url)}" alt="${escapeHtml(this.getShiftEvidenceDisplayTitle(item))}" loading="lazy">
            </span>
            <span class="report-day-photo-copy">
                <span class="report-day-photo-phase">${escapeHtml(phaseLabel)}</span>
                <span class="report-day-photo-label">${escapeHtml(this.getShiftEvidenceDisplayTitle(item))}</span>
                ${
                    this.getShiftEvidenceDisplayMeta(item)
                        ? `<span class="report-day-photo-meta">${escapeHtml(this.getShiftEvidenceDisplayMeta(item))}</span>`
                        : ''
                }
            </span>
        </a>`;
    },

    renderReportEvidencePairs(startMap, endMap, startItems, endItems, orderedKeys) {
        const rows = orderedKeys
            .map((key, index) => {
                const startItem = startMap.get(key) || startItems[index] || null;
                const endItem = endMap.get(key) || endItems[index] || null;
                if (!startItem && !endItem) return '';
                return `<div class="report-day-pair-row">
                ${this.renderReportEvidenceTile('Antes', startItem, index)}
                ${this.renderReportEvidenceTile('Después', endItem, index)}
            </div>`;
            })
            .filter(Boolean);
        return rows.length === 0
            ? '<div class="report-day-phase-empty">No se recibieron fotos para este turno.</div>'
            : `<div class="report-day-pairs">${rows.join('')}</div>`;
    },

    renderReportDayEvidence(shiftItems, { isSingleDay = false } = {}) {
        const wrapper = document.getElementById('report-day-evidence');
        const list = document.getElementById('report-day-evidence-list');
        const copy = document.getElementById('report-day-evidence-copy');

        if (!wrapper || !list || !copy) {
            return;
        }

        if (!isSingleDay) {
            wrapper.classList.add('hidden');
            list.innerHTML = '';
            return;
        }

        const items = Array.isArray(shiftItems) ? shiftItems : [];
        wrapper.classList.remove('hidden');

        if (items.length === 0) {
            copy.textContent = 'Ese día no tuvo turnos registrados para los filtros seleccionados.';
            list.innerHTML = '<div class="report-day-phase-empty">No hay turnos que mostrar para esa fecha.</div>';
            return;
        }

        let foundEvidence = false;
        copy.textContent = 'Para reportes de un solo día aquí verás las evidencias de inicio y finalización.';

        list.innerHTML = items
            .map((shift) => {
                const employeeName = this.getResolvedShiftEmployeeName(shift, 'Empleado sin nombre visible');
                const restaurantName = this.getResolvedShiftRestaurantName(shift, 'Restaurante sin nombre visible');
                const scheduleText = formatShiftRange(
                    shift.scheduled_start || shift.start_time,
                    shift.scheduled_end || shift.end_time
                );
                const workedHours = formatHours(getWorkedHours(shift));
                const scheduledHours = formatHours(getScheduledHours(shift));
                const endedEarly = isShiftEndedEarly(shift);
                const earlyEndReason = this.getEarlyEndReasonLabel(shift);
                const startItems = this.extractShiftEvidenceItems(shift, 'start');
                const endItems = this.extractShiftEvidenceItems(shift, 'end');
                foundEvidence = foundEvidence || startItems.length > 0 || endItems.length > 0;

                const startMap = new Map();
                startItems.forEach((item, i) => {
                    const k = this.buildEvidenceItemKey(item, i);
                    if (!startMap.has(k)) startMap.set(k, item);
                });
                const endMap = new Map();
                endItems.forEach((item, i) => {
                    const k = this.buildEvidenceItemKey(item, i);
                    if (!endMap.has(k)) endMap.set(k, item);
                });

                const orderedKeys = [];
                startMap.forEach((_, k) => orderedKeys.push(k));
                endMap.forEach((_, k) => {
                    if (!orderedKeys.includes(k)) orderedKeys.push(k);
                });
                const maxLength = Math.max(startItems.length, endItems.length);
                for (let i = 0; i < maxLength; i++) {
                    const fb = `index_${i + 1}`;
                    if (!orderedKeys.includes(fb)) orderedKeys.push(fb);
                }

                const statusLabel = getShiftStatusLabel(shift);
                return `<article class="report-day-shift-card">
                <div class="report-day-shift-top">
                    <div>
                        <div class="report-day-shift-title">${escapeHtml(employeeName)}</div>
                        <div class="report-day-shift-subtitle">${escapeHtml(restaurantName)} • ${escapeHtml(scheduleText)}</div>
                    </div>
                    <div class="report-day-shift-statuses">
                        <span class="badge ${getBadgeClass(statusLabel)}">${escapeHtml(statusLabel)}</span>
                        ${endedEarly ? '<span class="badge badge-warning">Salida anticipada</span>' : ''}
                    </div>
                </div>
                <div class="report-day-shift-metrics">
                    <div class="report-day-shift-metric"><span>Horas trabajadas</span><strong>${escapeHtml(workedHours)}</strong></div>
                    <div class="report-day-shift-metric"><span>Horas programadas</span><strong>${escapeHtml(scheduledHours)}</strong></div>
                </div>
                ${endedEarly && earlyEndReason ? `<div class="report-day-shift-metric"><span>Motivo de salida anticipada</span><strong>${escapeHtml(earlyEndReason)}</strong></div>` : ''}
                ${this.renderReportEvidencePairs(startMap, endMap, startItems, endItems, orderedKeys)}
            </article>`;
            })
            .join('');

        if (!foundEvidence) {
            copy.textContent = 'Ese día sí tiene turnos, pero no se recibieron fotos de inicio y fin en este listado.';
        }
    },

    normalizeReportFilterValue(rawValue, { numeric = false } = {}) {
        const normalized = String(rawValue || '').trim();
        if (!normalized) return undefined;
        if (normalized.toLowerCase() === 'all') return 'all';
        if (!numeric) return normalized;
        const asNumber = Number(normalized);
        return Number.isFinite(asNumber) ? asNumber : normalized;
    },

    async generateReport() {
        const startDate = document.getElementById('report-start-date')?.value;
        const endDate = document.getElementById('report-end-date')?.value;
        const restaurantId = document.getElementById('report-restaurant-select')?.value;
        const employeeId = document.getElementById('report-employee-select')?.value;

        if (!startDate || !endDate) {
            this.showToast('Selecciona el rango de fechas del informe.', {
                tone: 'warning',
                title: 'Filtros incompletos',
            });
            return;
        }

        if (startDate > endDate) {
            this.showToast('La fecha de inicio no puede ser mayor que la fecha de fin.', {
                tone: 'warning',
                title: 'Rango de fechas inválido',
            });
            return;
        }

        this.showLoading('Generando informe...', 'Preparando el informe.');
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
            const reportIdempotencyKey = buildIdempotencyKey();
            const reportGenerateRequestOptions = {
                accessToken,
                requiresIdempotency: false,
                headers: {
                    'Idempotency-Key': reportIdempotencyKey,
                },
            };
            const runReportGenerate = async (timeoutMs) =>
                apiClient.reportsGenerate(payload, {
                    ...reportGenerateRequestOptions,
                    timeoutMs,
                });
            reportRequestContext = {
                endpoint: '/reports_generate',
                headers_sent: {
                    Authorization: accessToken ? 'Bearer <access_token>' : '',
                    apikey: apiClient.getConfig().anonKey || '',
                    'Idempotency-Key': reportIdempotencyKey,
                },
                timeout_ms: 45000,
                retry_on_timeout: true,
                jwt_decoded: buildJwtFullDebugSummary(accessToken),
            };

            const reportGeneratePromise = runReportGenerate(45000).catch(async (error) => {
                if (String(error?.code || '').toUpperCase() !== 'TIMEOUT') {
                    throw error;
                }

                return runReportGenerate(60000);
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

            document.getElementById('report-summary-worked-hours').textContent = formatHours(
                this.data.lastGeneratedReport.resolved_totals.total_worked_hours
            );
            document.getElementById('report-summary-scheduled-hours').textContent = formatHours(
                this.data.lastGeneratedReport.resolved_totals.total_scheduled_hours
            );
            document.getElementById('report-summary-shifts').textContent = String(shiftItems.length);
            document.getElementById('report-summary-ended-early').textContent = String(endedEarlyCount);
            const description = document.getElementById('report-result-description');
            if (description) {
                description.textContent = isSingleDay
                    ? 'Resumen completo del día seleccionado, con estado del turno, horas y evidencias de antes y después.'
                    : 'Resumen consolidado del período seleccionado, incluyendo horas trabajadas, horas programadas y estado operativo de los turnos.';
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
                restaurantTotalsCopy.textContent = `En este rango el restaurante acumula ${restaurantWorkedText} trabajadas y ${restaurantScheduledText} programadas.`;
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
                title: 'No fue posible generar el informe',
            });
        } finally {
            this.hideLoading();
        }
    },

    downloadGeneratedReport(type) {
        const report = this.data.lastGeneratedReport;
        if (!report) {
            this.showToast('Primero genera un informe.', {
                tone: 'warning',
                title: 'Aún no hay resultados',
            });
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

        this.closeReportDownloadMenu();
        this.navigateToCurrentTab(url);
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

    navigateToCurrentTab(url) {
        if (!url) {
            return;
        }

        window.location.assign(url);
    },

    openGeneratedReportPreview() {
        const report = this.data.lastGeneratedReport;
        if (!report) {
            this.showToast('Primero genera un informe.', {
                tone: 'warning',
                title: 'Aún no hay resultados',
            });
            return;
        }

        const html = this.buildGeneratedReportPreviewHtml(report);
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const previewUrl = URL.createObjectURL(blob);
        this.navigateToCurrentTab(previewUrl);
    },

    buildGeneratedReportPreviewHtml(report) {
        const shiftItems = asArray(report?.shift_items);
        const filters = report?.filters || {};
        const totals = report?.totals || {};
        const isSingleDay = Boolean(report?.is_single_day);
        const resolvedTotals = report?.resolved_totals || {};
        const totalWorkedHours = Number(
            resolvedTotals?.total_worked_hours ??
                report?.total_worked_hours ??
                totals?.total_worked_hours ??
                totals?.worked_hours_total
        );
        const totalScheduledHours = Number(
            resolvedTotals?.total_scheduled_hours ??
                report?.total_scheduled_hours ??
                totals?.total_scheduled_hours ??
                totals?.scheduled_hours_total
        );
        const restaurantWorkedHours = Number(
            resolvedTotals?.restaurant_worked_hours_total ??
                report?.restaurant_worked_hours_total ??
                totals?.restaurant_worked_hours_total
        );
        const restaurantScheduledHours = Number(
            resolvedTotals?.restaurant_scheduled_hours_total ??
                report?.restaurant_scheduled_hours_total ??
                totals?.restaurant_scheduled_hours_total
        );
        const summaryWorkedHours = formatHours(
            Number.isFinite(totalWorkedHours) && totalWorkedHours > 0 ? totalWorkedHours : sumWorkedHours(shiftItems)
        );
        const summaryScheduledHours = formatHours(
            Number.isFinite(totalScheduledHours) && totalScheduledHours > 0 ? totalScheduledHours : sumHours(shiftItems)
        );
        const summaryRestaurantWorkedHours = formatHours(
            Number.isFinite(restaurantWorkedHours) && restaurantWorkedHours > 0
                ? restaurantWorkedHours
                : Number.isFinite(totalWorkedHours) && totalWorkedHours > 0
                  ? totalWorkedHours
                  : sumWorkedHours(shiftItems)
        );
        const summaryRestaurantScheduledHours = formatHours(
            Number.isFinite(restaurantScheduledHours) && restaurantScheduledHours > 0
                ? restaurantScheduledHours
                : Number.isFinite(totalScheduledHours) && totalScheduledHours > 0
                  ? totalScheduledHours
                  : sumHours(shiftItems)
        );
        const endedEarlyCount = Number(resolvedTotals?.ended_early_count ?? report?.ended_early_count);
        const statusSummary =
            Array.isArray(report?.status_summary) && report.status_summary.length > 0
                ? report.status_summary
                : summarizeShiftStatuses(shiftItems);

        const dateSummary = [
            filters.start_date ? `Desde ${filters.start_date}` : '',
            filters.end_date ? `hasta ${filters.end_date}` : '',
        ]
            .filter(Boolean)
            .join(' ');

        const renderEvidencePhase = (label, evidenceItems) => {
            if (!evidenceItems.length) {
                return `
                    <div class="phase-block">
                        <div class="phase-title">${escapeHtml(label)}</div>
                        <div class="phase-empty">No hay fotos para esta fase.</div>
                    </div>
                `;
            }

            return `
                <div class="phase-block">
                    <div class="phase-title">${escapeHtml(label)}</div>
                    <div class="phase-gallery">
                        ${evidenceItems
                            .map(
                                (item, index) => `
                            <a class="phase-photo" href="${escapeHtml(item.url)}" aria-label="${escapeHtml(`${label} ${index + 1}`)}">
                                <img src="${escapeHtml(item.url)}" alt="${escapeHtml(this.getShiftEvidenceDisplayTitle(item))}">
                                <span class="phase-photo-copy">
                                    <span class="phase-photo-label">${escapeHtml(this.getShiftEvidenceDisplayTitle(item))}</span>
                                    ${
                                        this.getShiftEvidenceDisplayMeta(item)
                                            ? `<span class="phase-photo-meta">${escapeHtml(this.getShiftEvidenceDisplayMeta(item))}</span>`
                                            : ''
                                    }
                                </span>
                            </a>
                        `
                            )
                            .join('')}
                    </div>
                </div>
            `;
        };

        const rows =
            shiftItems.length > 0
                ? shiftItems
                      .map((shift) => {
                          const employeeName = this.getResolvedShiftEmployeeName(shift, 'Empleado sin nombre visible');
                          const restaurantName = this.getResolvedShiftRestaurantName(
                              shift,
                              'Restaurante sin nombre visible'
                          );
                          const scheduleText = formatShiftRange(
                              shift.scheduled_start || shift.start_time,
                              shift.scheduled_end || shift.end_time
                          );
                          const status = getShiftStatusLabel(shift);
                          const workedHours = formatHours(getWorkedHours(shift));
                          const scheduledHours = formatHours(getScheduledHours(shift));
                          const endedEarly = isShiftEndedEarly(shift);
                          const earlyEndReason = this.getEarlyEndReasonLabel(shift);
                          const startItems = this.extractShiftEvidenceItems(shift, 'start');
                          const endItems = this.extractShiftEvidenceItems(shift, 'end');

                          return `
                    <article class="report-card">
                        <div class="report-card-top">
                            <div>
                                <div class="report-card-title">${escapeHtml(employeeName)}</div>
                                <div class="report-card-subtitle">${escapeHtml(restaurantName)}</div>
                            </div>
                            <div class="report-card-statuses">
                                <span class="report-status ${getBadgeClass(status)}">${escapeHtml(String(status))}</span>
                                ${endedEarly ? '<span class="report-status badge-warning">Salida anticipada</span>' : ''}
                            </div>
                        </div>
                        <div class="report-meta-grid">
                            <div class="report-meta-item">
                                <span class="report-meta-label">Horario</span>
                                <span class="report-meta-value">${escapeHtml(scheduleText)}</span>
                            </div>
                            <div class="report-meta-item">
                                <span class="report-meta-label">Horas trabajadas</span>
                                <span class="report-meta-value">${escapeHtml(workedHours)}</span>
                            </div>
                            <div class="report-meta-item">
                                <span class="report-meta-label">Horas programadas</span>
                                <span class="report-meta-value">${escapeHtml(scheduledHours)}</span>
                            </div>
                            <div class="report-meta-item">
                                <span class="report-meta-label">Salida anticipada</span>
                                <span class="report-meta-value">${endedEarly ? 'Sí' : 'No'}</span>
                            </div>
                            ${
                                endedEarly && earlyEndReason
                                    ? `
                                <div class="report-meta-item">
                                    <span class="report-meta-label">Motivo</span>
                                    <span class="report-meta-value">${escapeHtml(earlyEndReason)}</span>
                                </div>
                            `
                                    : ''
                            }
                        </div>
                        ${
                            isSingleDay
                                ? `
                            <div class="phase-grid">
                                ${renderEvidencePhase('Antes', startItems)}
                                ${renderEvidencePhase('Después', endItems)}
                            </div>
                        `
                                : ''
                        }
                    </article>
                `;
                      })
                      .join('')
                : '<div class="empty-block">No hay turnos para los filtros seleccionados.</div>';

        return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Visualización del Informe - WorkTrace</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f172a;
      --panel: #172236;
      --border: rgba(148,163,184,.18);
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: linear-gradient(180deg, #0f172a 0%, #111c34 100%);
      color: var(--text);
      padding: 28px 18px 40px;
    }
    .shell { max-width: 1080px; margin: 0 auto; display: grid; gap: 20px; }
    .hero, .summary, .report-card, .empty-block {
      background: rgba(23,34,54,.94);
      border: 1px solid var(--border);
      border-radius: 22px;
      box-shadow: 0 18px 40px rgba(2,6,23,.3);
    }
    .hero {
      padding: 28px;
      background: linear-gradient(135deg, rgba(14,165,233,.18) 0%, rgba(20,184,166,.18) 100%), rgba(23,34,54,.94);
    }
    .hero h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 40px); line-height: 1.05; }
    .hero p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
    .summary {
      padding: 22px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
    }
    .summary-card {
      padding: 18px;
      border-radius: 18px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.05);
    }
    .summary-label {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .summary-value { font-size: 28px; font-weight: 800; }
    .report-list { display: grid; gap: 16px; }
    .report-card { padding: 22px; }
    .report-card-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 16px;
    }
    .report-card-title { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
    .report-card-subtitle { color: var(--muted); font-size: 14px; }
    .report-card-statuses {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .report-status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(34,197,94,.15);
      color: #86efac;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }
    .report-status.badge-success {
      background: rgba(34,197,94,.15);
      color: #86efac;
    }
    .report-status.badge-warning {
      background: rgba(245,158,11,.16);
      color: #fcd34d;
    }
    .report-status.badge-danger {
      background: rgba(248,113,113,.16);
      color: #fca5a5;
    }
    .report-meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .report-meta-item {
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.05);
    }
    .report-meta-label {
      display: block;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .05em;
      margin-bottom: 6px;
    }
    .report-meta-value { font-size: 15px; font-weight: 700; }
    .report-status-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 4px;
    }
    .report-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.06);
      color: var(--text);
      font-size: 13px;
      font-weight: 700;
    }
    .report-status-pill strong {
      font-size: 12px;
      color: var(--muted);
    }
    .report-status-pill.badge-success {
      color: #86efac;
      background: rgba(34,197,94,.15);
    }
    .report-status-pill.badge-warning {
      color: #fcd34d;
      background: rgba(245,158,11,.16);
    }
    .report-status-pill.badge-danger {
      color: #fca5a5;
      background: rgba(248,113,113,.16);
    }
    .phase-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
    }
    .phase-block {
      padding: 16px;
      border-radius: 18px;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.05);
    }
    .phase-title {
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 12px;
    }
    .phase-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: 10px;
    }
    .phase-photo {
      display: grid;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.04);
    }
    .phase-photo img {
      width: 100%;
      height: 100%;
      aspect-ratio: 1 / 1;
      object-fit: cover;
      display: block;
    }
    .phase-photo-copy {
      display: grid;
      gap: 4px;
      padding: 10px;
      background: rgba(15, 23, 42, 0.72);
    }
    .phase-photo-label {
      font-size: 12px;
      font-weight: 700;
      line-height: 1.35;
    }
    .phase-photo-meta {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .phase-empty, .empty-block {
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }
    .empty-block { padding: 26px; text-align: center; }
    @media (max-width: 640px) {
      body { padding: 18px 12px 28px; }
      .hero, .summary, .report-card { padding: 18px; border-radius: 18px; }
      .report-card-top { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>Visualización del Informe</h1>
      <p>${escapeHtml(dateSummary || 'Resumen del período seleccionado')}.</p>
    </section>
    <section class="summary">
      <div class="summary-card">
        <span class="summary-label">Horas trabajadas</span>
        <span class="summary-value">${escapeHtml(summaryWorkedHours)}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Horas programadas</span>
        <span class="summary-value">${escapeHtml(summaryScheduledHours)}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Horas restaurante</span>
        <span class="summary-value">${escapeHtml(summaryRestaurantWorkedHours)}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Programadas restaurante</span>
        <span class="summary-value">${escapeHtml(summaryRestaurantScheduledHours)}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Turnos</span>
        <span class="summary-value">${escapeHtml(String(shiftItems.length))}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Salidas anticipadas</span>
        <span class="summary-value">${escapeHtml(String(Number.isFinite(endedEarlyCount) ? endedEarlyCount : countEndedEarlyShifts(shiftItems)))}</span>
      </div>
    </section>
    <section class="summary">
      <div class="summary-card" style="grid-column: 1 / -1;">
        <span class="summary-label">Estados del período</span>
        <div class="report-status-summary">
          ${
              statusSummary.length > 0
                  ? statusSummary
                        .map(
                            ({ label, count }) => `
                  <span class="report-status-pill ${getBadgeClass(label)}">
                    <span>${escapeHtml(label)}</span>
                    <strong>${escapeHtml(String(count))}</strong>
                  </span>
                `
                        )
                        .join('')
                  : '<span class="phase-empty">No hay estados para mostrar.</span>'
          }
        </div>
      </div>
    </section>
    <section class="report-list">
      ${rows}
    </section>
  </main>
</body>
</html>`;
    },

    async uploadSupervisorSupervisionEvidence() {
        const evidences = [];

        for (const [slotKey, file] of Object.entries(this.supervisionPhotoFiles)) {
            if (!file) {
                continue;
            }

            const slot = this.getPhotoSlotDefinition(slotKey, 'supervision');

            const requestUpload = await apiClient.supervisorPresenceManage('request_evidence_upload', {
                phase: 'start',
                mime_type: file.type || 'image/jpeg',
            });

            const signedUrl = requestUpload?.upload?.signedUrl || requestUpload?.signedUrl;
            const path = requestUpload?.path || requestUpload?.upload?.path;

            if (!signedUrl || !path) {
                throw new Error('No fue posible preparar la subida de la foto de supervisión.');
            }

            await apiClient.uploadToSignedUrl(signedUrl, file, file.type);
            await apiClient.supervisorPresenceManage('finalize_evidence_upload', { path });

            evidences.push({
                path,
                label: slot?.title || slotKey,
                mime_type: file.type || 'image/jpeg',
                size_bytes: file.size || undefined,
            });
        }

        return evidences;
    },

    async submitSupervisorShiftForm() {
        if (this.supervisorShiftSubmitPending) {
            this.showToast('Ya estamos guardando la programación. Espera un momento.', {
                tone: 'info',
                title: 'Procesando programación',
            });
            return;
        }

        this.setSupervisorShiftSubmitState(true);

        try {
            const assignments = [];
            const taskTemplate = this.getSupervisorSpecialTaskTemplate();

            if (this.supervisorShiftMode === 'single') {
                const employeeId = document.getElementById('supervisor-shift-single-employee')?.value;
                const restaurantId = document.getElementById('supervisor-shift-single-restaurant')?.value;
                const startValue = document.getElementById('supervisor-shift-single-start')?.value;
                const endValue = document.getElementById('supervisor-shift-single-end')?.value;
                const notes = document.getElementById('supervisor-shift-single-notes')?.value?.trim();

                if (!employeeId || !restaurantId || !startValue || !endValue) {
                    this.showToast('Completa empleado, restaurante y horario para programar este turno.', {
                        tone: 'warning',
                        title: 'Faltan datos',
                    });
                    return;
                }

                const startDate = new Date(startValue);
                const endDate = new Date(endValue);
                if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
                    this.showToast('La fecha final del turno debe ser posterior a la fecha inicial.', {
                        tone: 'warning',
                        title: 'Horario inválido',
                    });
                    return;
                }

                assignments.push({
                    employee_id: normalizeRestaurantId(employeeId),
                    restaurant_id: normalizeRestaurantId(restaurantId),
                    scheduled_start: startDate.toISOString(),
                    scheduled_end: endDate.toISOString(),
                    notes: notes || undefined,
                });
            } else if (this.supervisorShiftMode === 'plan') {
                const employeeId = document.getElementById('supervisor-shift-plan-employee')?.value;
                const restaurantId = document.getElementById('supervisor-shift-plan-restaurant')?.value;
                const rows = this.supervisorShiftPlanRows || [];

                if (!employeeId) {
                    this.showToast('Selecciona el empleado al que le vas a programar la semana.', {
                        tone: 'warning',
                        title: 'Falta el empleado',
                    });
                    return;
                }

                if (!restaurantId) {
                    this.showToast('Selecciona el restaurante base de esta semana.', {
                        tone: 'warning',
                        title: 'Falta el restaurante',
                    });
                    return;
                }

                if (rows.length === 0) {
                    this.showToast('No encontramos los días de la semana para programar.', {
                        tone: 'warning',
                        title: 'Sin turnos por programar',
                    });
                    return;
                }

                const activeRows = rows.filter((row) => row.enabled === true);
                if (activeRows.length === 0) {
                    this.showToast('Activa al menos un día de la semana antes de guardar.', {
                        tone: 'warning',
                        title: 'Sin días seleccionados',
                    });
                    return;
                }

                for (const row of activeRows) {
                    if (!row.startTime || !row.endTime) {
                        this.showToast(`Completa entrada y salida para ${row.dayLabel || 'el día seleccionado'}.`, {
                            tone: 'warning',
                            title: 'Faltan datos',
                        });
                        return;
                    }

                    const startDate = this.buildSupervisorShiftDateTime(row.dateKey, row.startTime);
                    const endDate = this.buildSupervisorShiftDateTime(row.dateKey, row.endTime);
                    if (!startDate || !endDate) {
                        this.showToast(`Revisa el formato de hora en ${row.dayLabel || 'el día seleccionado'}.`, {
                            tone: 'warning',
                            title: 'Horario inválido',
                        });
                        return;
                    }

                    if (endDate <= startDate) {
                        endDate.setDate(endDate.getDate() + 1);
                    }

                    assignments.push({
                        employee_id: normalizeRestaurantId(employeeId),
                        restaurant_id: normalizeRestaurantId(restaurantId),
                        scheduled_start: startDate.toISOString(),
                        scheduled_end: endDate.toISOString(),
                        notes: row.notes?.trim() || undefined,
                    });
                }
            } else {
                const restaurantId = document.getElementById('supervisor-shift-restaurant')?.value;
                const startValue = document.getElementById('supervisor-shift-start')?.value;
                const endValue = document.getElementById('supervisor-shift-end')?.value;
                const notes = document.getElementById('supervisor-shift-notes')?.value?.trim();
                const selectedEmployees = (this.supervisorBatchSelectedEmployees || []).filter(Boolean);

                if (!restaurantId || !startValue || !endValue || selectedEmployees.length === 0) {
                    this.showToast(
                        'Selecciona restaurante, horario y al menos un empleado para este turno compartido.',
                        {
                            tone: 'warning',
                            title: 'Faltan datos',
                        }
                    );
                    return;
                }

                const startDate = new Date(startValue);
                const endDate = new Date(endValue);
                if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
                    this.showToast('La fecha final del turno debe ser posterior a la fecha inicial.', {
                        tone: 'warning',
                        title: 'Horario inválido',
                    });
                    return;
                }

                selectedEmployees.forEach((employeeId) => {
                    assignments.push({
                        employee_id: normalizeRestaurantId(employeeId),
                        restaurant_id: normalizeRestaurantId(restaurantId),
                        scheduled_start: startDate.toISOString(),
                        scheduled_end: endDate.toISOString(),
                        notes: notes || undefined,
                    });
                });
            }

            if (taskTemplate.enabled && taskTemplate.title.length < 3) {
                this.showToast('Escribe un título de al menos 3 caracteres para la tarea especial.', {
                    tone: 'warning',
                    title: 'Falta el título de la tarea',
                });
                return;
            }

            if (taskTemplate.enabled && taskTemplate.description.length < 5) {
                this.showToast('Describe la tarea especial con al menos 5 caracteres.', {
                    tone: 'warning',
                    title: 'Falta la descripción',
                });
                return;
            }

            try {
                const assignmentRanges = assignments
                    .map((assignment) => this.toShiftIntervalRange(assignment))
                    .filter(Boolean);
                const minStartMs =
                    assignmentRanges.length > 0 ? Math.min(...assignmentRanges.map((item) => item.startMs)) : null;
                const maxEndMs =
                    assignmentRanges.length > 0 ? Math.max(...assignmentRanges.map((item) => item.endMs)) : null;

                const nearbyShifts =
                    Number.isFinite(minStartMs) && Number.isFinite(maxEndMs)
                        ? await this.getSupervisorShiftList({
                              from: toIsoDate(new Date(minStartMs - 24 * 60 * 60 * 1000)),
                              to: toIsoDate(new Date(maxEndMs + 24 * 60 * 60 * 1000)),
                              limit: 500,
                              forceRestaurants: false,
                          })
                        : asArray(this.data.supervisor.shifts);

                const preConflict = this.findShiftAssignmentConflict(assignments, nearbyShifts);
                if (preConflict) {
                    const employeeRecord =
                        this.getKnownEmployeeRecord(preConflict.employeeId) ||
                        asArray(this.data.supervisor.employees).find(
                            (employee) =>
                                String(employee?.id || '').trim() === String(preConflict.employeeId || '').trim()
                        ) ||
                        null;
                    const employeeName = getEmployeeDisplayName(
                        employeeRecord || { id: preConflict.employeeId },
                        'el empleado seleccionado'
                    );

                    if (preConflict.type === 'existing') {
                        const conflictShift = preConflict.existingShift;
                        const conflictDate = formatDate(conflictShift?.scheduled_start || conflictShift?.start_time, {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                        });
                        const conflictRange = formatShiftRange(
                            conflictShift?.scheduled_start,
                            conflictShift?.scheduled_end
                        );

                        this.showToast(
                            `${employeeName} ya tiene un turno (${conflictDate} ${conflictRange}) que se cruza con ese horario.`,
                            {
                                tone: 'warning',
                                title: 'Conflicto de horario detectado',
                            }
                        );
                        return;
                    }

                    this.showToast(`${employeeName} tiene dos turnos en esta programación que se cruzan entre sí.`, {
                        tone: 'warning',
                        title: 'Conflicto de horario detectado',
                    });
                    return;
                }
            } catch (precheckError) {
                console.warn('No fue posible ejecutar la validación previa de conflictos de turnos.', precheckError);
            }

            if (taskTemplate.enabled) {
                try {
                    const assignmentValidation = await this.validateSpecialTaskAssignments(assignments);
                    if (!assignmentValidation.ok) {
                        this.showToast(
                            assignmentValidation.message ||
                                'Revisa el empleado y el restaurante antes de crear la tarea especial.',
                            {
                                tone: 'warning',
                                title: 'Tarea especial no disponible',
                            }
                        );
                        return;
                    }
                } catch (validationError) {
                    this.showToast(
                        this.getErrorMessage(
                            validationError,
                            'No fue posible validar la tarea especial antes de guardar.'
                        ),
                        {
                            tone: 'error',
                            title: 'No fue posible validar la tarea especial',
                        }
                    );
                    return;
                }
            }

            this.showLoading(
                'Programando turnos...',
                assignments.length === 1
                    ? 'Guardando la programación.'
                    : `Guardando ${assignments.length} programaciones.`
            );

            try {
                let successCount = 0;
                let failedCount = 0;
                let firstError = null;
                let createdAssignments = [];

                if (assignments.length === 1) {
                    try {
                        const response = await apiClient.scheduledShiftsManage('assign', assignments[0]);
                        const createdIds = this.extractScheduledShiftIdsFromResponse(response);
                        createdAssignments = createdIds.map((scheduledShiftId) => ({
                            ...assignments[0],
                            scheduled_shift_id: scheduledShiftId,
                        }));
                        this.registerShiftAssignDebug(response, assignments[0], createdAssignments);
                        successCount = 1;
                    } catch (error) {
                        firstError = error;
                        failedCount = 1;
                    }
                } else {
                    const bulkResult = await apiClient.scheduledShiftsManage('bulk_assign', {
                        entries: assignments,
                    });
                    const createdItems = this.extractCreatedScheduledShiftItems(bulkResult);
                    const createdIds = this.extractScheduledShiftIdsFromResponse(bulkResult);
                    successCount = Number(
                        bulkResult?.created ?? bulkResult?.data?.created ?? createdItems.length ?? createdIds.length
                    );
                    failedCount = Number(
                        bulkResult?.failed ?? bulkResult?.data?.failed ?? Math.max(assignments.length - successCount, 0)
                    );
                    if (Array.isArray(bulkResult?.errors) && bulkResult.errors[0]) {
                        firstError = new Error(
                            bulkResult.errors[0]?.message ||
                                bulkResult.errors[0]?.error ||
                                'No fue posible programar algunos turnos.'
                        );
                    }
                    if (createdItems.length > 0) {
                        createdAssignments = createdItems.map((item) => {
                            const rawIndex = Number(item.index);
                            const sourceIndex = Number.isFinite(rawIndex) ? Math.max(0, rawIndex - 1) : -1;
                            const sourceAssignment = sourceIndex >= 0 ? assignments[sourceIndex] || {} : {};
                            return {
                                ...sourceAssignment,
                                ...item,
                                source_index_1_based: Number.isFinite(rawIndex) ? rawIndex : null,
                                source_index_0_based: sourceIndex >= 0 ? sourceIndex : null,
                                employee_id: item.employee_id ?? sourceAssignment.employee_id,
                                restaurant_id: item.restaurant_id ?? sourceAssignment.restaurant_id,
                                scheduled_start: item.scheduled_start ?? sourceAssignment.scheduled_start,
                                scheduled_end: item.scheduled_end ?? sourceAssignment.scheduled_end,
                                notes: item.notes ?? sourceAssignment.notes,
                            };
                        });
                        this.registerBulkAssignDebug(createdItems, assignments, createdAssignments);
                    } else {
                        createdAssignments = createdIds.map((scheduledShiftId, index) => ({
                            ...(assignments[index] || {}),
                            scheduled_shift_id: scheduledShiftId,
                        }));
                    }
                }

                if (successCount === 0) {
                    throw firstError || new Error('No fue posible programar los turnos.');
                }

                let taskCreationResult = { created: 0, failed: 0 };
                if (taskTemplate.enabled) {
                    taskCreationResult = await this.createSpecialTasksForScheduledShifts(
                        createdAssignments,
                        taskTemplate
                    );
                }

                if (this.supervisorShiftMode === 'plan') {
                    this.persistSupervisorShiftTemplate(this.getSupervisorShiftPlanTemplate());
                }

                this.invalidateCache('supervisorShifts');
                this.closeModal('modal-supervisor-schedule-shift');
                await Promise.all([this.loadSupervisorShifts(true), this.loadSupervisorDashboard()]);

                if (successCount === assignments.length && failedCount === 0) {
                    const successMessage = taskTemplate.enabled
                        ? taskCreationResult.created === successCount
                            ? successCount === 1
                                ? 'Turno y tarea especial creados correctamente.'
                                : `${successCount} turnos y sus tareas especiales quedaron creados correctamente.`
                            : successCount === 1
                              ? 'Turno programado correctamente.'
                              : `${successCount} turnos programados correctamente.`
                        : successCount === 1
                          ? 'Turno programado correctamente.'
                          : `${successCount} turnos programados correctamente.`;
                    this.showToast(successMessage, {
                        tone: 'success',
                        title: 'Programación exitosa',
                    });
                } else {
                    const firstTaskIssue =
                        Array.isArray(taskCreationResult?.errors) && taskCreationResult.errors[0]
                            ? ` ${taskCreationResult.errors[0]}`
                            : '';
                    this.showToast(
                        taskTemplate.enabled
                            ? `${successCount} de ${assignments.length} turnos quedaron programados. Revisa también las tareas especiales del resto.${firstTaskIssue}`
                            : `${successCount} de ${assignments.length} turnos quedaron programados. Revisa el resto.`,
                        {
                            tone: 'warning',
                            title: 'Programación parcial',
                        }
                    );
                }
            } catch (error) {
                if (this.isEmployeeUnavailableInSchedule(error)) {
                    this.showToast('El empleado no está disponible en ese horario.', {
                        tone: 'warning',
                        title: 'Horario no disponible',
                    });
                    return;
                }

                this.showToast(this.getErrorMessage(error, 'No fue posible programar los turnos.'), {
                    tone: 'error',
                    title: 'No fue posible programar los turnos',
                });
            } finally {
                this.hideLoading();
            }
        } finally {
            this.setSupervisorShiftSubmitState(false);
        }
    },

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
            this.showToast('Escribe el nombre del restaurante.', {
                tone: 'warning',
                title: 'Falta el nombre',
            });
            return;
        }

        if (!addressLine || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            this.showToast('Busca una dirección completa y verifica el punto en el mapa antes de guardar.', {
                tone: 'warning',
                title: 'Ubicación pendiente',
            });
            return;
        }

        if (!Number.isFinite(radius)) {
            this.showToast('Define el radio de verificación del restaurante.', {
                tone: 'warning',
                title: 'Falta el radio',
            });
            return;
        }

        this.showLoading('Creando restaurante...', 'Espera un momento.');

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
            this.showToast('Restaurante creado correctamente.', {
                tone: 'success',
                title: 'Creación exitosa',
            });
        } catch (error) {
            if (!this.isAdminRole() && error?.status === 403) {
                this.showToast(this.getErrorMessage(error, 'Tu cuenta de supervisora no pudo crear el restaurante.'), {
                    tone: 'error',
                    title: 'Permiso insuficiente',
                });
                return;
            }
            this.showToast(this.getErrorMessage(error, 'No fue posible crear el restaurante.'), {
                tone: 'error',
                title: 'No fue posible crear el restaurante',
            });
        } finally {
            this.hideLoading();
        }
    },

    async submitAdminEmployeeForm() {
        const fullName = document.getElementById('admin-employee-name')?.value?.trim();
        const email = document.getElementById('admin-employee-email')?.value?.trim();
        const phone = document.getElementById('admin-employee-phone')?.value?.trim();
        const isActive = true;

        if (!fullName || !email || !phone) {
            this.showToast('Completa nombre, correo y teléfono del empleado.', {
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

        this.showLoading('Creando empleado...', 'Registrando usuario y credenciales iniciales.');

        try {
            const result = await apiClient.adminUsersManage('create', {
                role: 'empleado',
                full_name: fullName,
                email,
                phone_number: phone,
                is_active: isActive,
            });

            this.invalidateCache('supervisorEmployees');
            this.invalidateScopedCache('supervisorAssignableEmployees');
            this.closeModal('modal-admin-employee');
            await this.loadSupervisorEmployees(true);

            const initialPassword =
                result?.temporary_password || result?.generated_password || result?.password || '123456';
            this.showToast(`Empleado creado correctamente. Clave inicial: ${initialPassword}.`, {
                tone: 'success',
                title: 'Creación exitosa',
                duration: 5200,
            });
        } catch (error) {
            if (!this.isAdminRole() && error?.status === 403) {
                this.showToast(this.getErrorMessage(error, 'Tu cuenta de supervisora no pudo crear el empleado.'), {
                    tone: 'error',
                    title: 'Permiso insuficiente',
                });
                return;
            }
            this.showToast(this.getErrorMessage(error, 'No fue posible crear el empleado.'), {
                tone: 'error',
                title: 'No fue posible crear el empleado',
            });
        } finally {
            this.hideLoading();
        }
    },

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
                this.showToast('No hay restaurantes disponibles para registrar supervisión.', {
                    tone: 'warning',
                    title: 'Sin restaurantes disponibles',
                });
                return;
            }

            const requireSupervisionPhotos = this.getSystemSetting(
                'evidence.require_supervision_photos',
                DEFAULT_SYSTEM_SETTINGS.evidence.require_supervision_photos
            );
            if (requireSupervisionPhotos && Object.keys(this.supervisionPhotoFiles).length === 0) {
                this.showToast('Debes adjuntar al menos una foto de supervisión antes de guardar.', {
                    tone: 'warning',
                    title: 'Faltan evidencias',
                });
                return;
            }

            this.showLoading('Subiendo imágenes', 'Espera');

            let supervisionPayload = null;

            try {
                const locationCheck = await this.ensureSupervisorSupervisionLocationVerified();
                const location = locationCheck?.location || this.location;
                const notes = document.getElementById('supervision-observations')?.value?.trim();
                const evidences = await this.uploadSupervisorSupervisionEvidence();
                supervisionPayload = {
                    restaurant_id: targetRestaurant.restaurant_id || targetRestaurant.id,
                    phase: 'start',
                    lat: location.lat,
                    lng: location.lng,
                    accuracy: Math.round(location.accuracy || 0),
                    observed_at: new Date().toISOString(),
                    notes,
                    evidences,
                };

                const supervisionSignature = this.buildSupervisionRegisterSignature(supervisionPayload);
                const reuseCurrentIdempotencyKey = Boolean(
                    this.supervisionRegisterIdempotencyKey &&
                    this.supervisionRegisterRetrySignature &&
                    this.supervisionRegisterRetrySignature === supervisionSignature
                );
                const supervisionIdempotencyKey = reuseCurrentIdempotencyKey
                    ? this.supervisionRegisterIdempotencyKey
                    : buildIdempotencyKey();
                this.supervisionRegisterIdempotencyKey = supervisionIdempotencyKey;
                this.supervisionRegisterRetrySignature = supervisionSignature;

                const registerResult = await apiClient.supervisorPresenceManage('register', supervisionPayload, {
                    requiresIdempotency: false,
                    headers: {
                        'Idempotency-Key': supervisionIdempotencyKey,
                    },
                });
                const alreadyExists =
                    registerResult?.already_exists === true || registerResult?.data?.already_exists === true;

                this.invalidateCache('supervisorShifts');
                this.showToast(
                    alreadyExists
                        ? 'La supervisión ya existía y se tomó como registrada.'
                        : 'Supervisión registrada correctamente.',
                    {
                        tone: 'success',
                        title: 'Registro exitoso',
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
                        'No fue posible registrar la supervisión.'
                ).trim();
                this.showToast(supervisionErrorMessage || 'No fue posible registrar la supervisión.', {
                    tone: 'error',
                    title: 'No fue posible guardar la supervisión',
                });
            } finally {
                this.hideLoading();
            }
        } finally {
            this.setSupervisionSubmitState(false);
        }
    },

    openScheduleShiftModal() {
        this.schedShiftRows = [];
        this.schedShiftSelectedEmployees = [];

        const today = toIsoDate(new Date());
        const restaurantEl = document.getElementById('sched-shift-restaurant');
        const startDateEl = document.getElementById('sched-shift-start-date');
        const endDateEl = document.getElementById('sched-shift-end-date');
        const defaultStartEl = document.getElementById('sched-shift-default-start');
        const defaultEndEl = document.getElementById('sched-shift-default-end');
        const pickerEl = document.getElementById('sched-shift-employee-picker');

        if (restaurantEl) {
            const restaurants = this.data.supervisor.restaurants || [];
            restaurantEl.innerHTML =
                '<option value="">Selecciona un restaurante</option>' +
                restaurants
                    .map(
                        (r) =>
                            `<option value="${escapeHtml(String(getRestaurantRecordId(r)))}">${escapeHtml(getRestaurantDisplayName(r))}</option>`
                    )
                    .join('');
            restaurantEl.value = '';
        }
        if (pickerEl)
            this.setShiftBatchPickerEmpty(pickerEl, 'Selecciona un restaurante para ver los empleados disponibles.');
        if (startDateEl) startDateEl.value = today;
        if (endDateEl) endDateEl.value = today;
        if (defaultStartEl) defaultStartEl.value = '08:00';
        if (defaultEndEl) defaultEndEl.value = '16:00';

        this.renderSchedShiftRows();
        this.openModal('modal-supervisor-schedule-shift');
    },

    async renderSchedShiftEmployeePicker(restaurantId) {
        const container = document.getElementById('sched-shift-employee-picker');
        if (!container) return;

        if (!restaurantId) {
            this.setShiftBatchPickerEmpty(container, 'Selecciona un restaurante para ver los empleados disponibles.');
            this.schedShiftSelectedEmployees = [];
            return;
        }

        try {
            const employees = await this.getAssignableEmployeesForRestaurant(restaurantId);
            const validIds = new Set(employees.map((e) => String(e.id)));
            this.schedShiftSelectedEmployees = (this.schedShiftSelectedEmployees || []).filter((id) =>
                validIds.has(String(id))
            );

            if (employees.length === 0) {
                this.setShiftBatchPickerEmpty(container, 'No hay empleados activos disponibles para este restaurante.');
                return;
            }

            const selected = new Set((this.schedShiftSelectedEmployees || []).map(String));
            const fragment = document.createDocumentFragment();
            employees.forEach((employee) => {
                const id = String(employee.id);
                const isActive = selected.has(id);
                const label = document.createElement('label');
                label.className = `shift-batch-option${isActive ? ' active' : ''}`;

                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = isActive;
                input.onchange = () => {
                    const sel = new Set((this.schedShiftSelectedEmployees || []).map(String));
                    if (input.checked) sel.add(id);
                    else sel.delete(id);
                    this.schedShiftSelectedEmployees = Array.from(sel);
                    label.classList.toggle('active', input.checked);
                };

                const copy = document.createElement('div');
                copy.className = 'shift-batch-copy';
                const name = document.createElement('strong');
                name.textContent = getEmployeeDisplayName(employee);
                const detail = document.createElement('span');
                detail.textContent = employee.email || '';
                copy.append(name, detail);

                const check = document.createElement('span');
                check.className = 'shift-batch-check';
                check.setAttribute('aria-hidden', 'true');
                const icon = document.createElement('i');
                icon.className = 'fas fa-check';
                check.appendChild(icon);

                label.append(input, copy, check);
                fragment.appendChild(label);
            });
            container.replaceChildren(fragment);
        } catch (error) {
            console.warn('No fue posible cargar empleados para programación.', error);
            this.setShiftBatchPickerEmpty(container, 'No fue posible cargar los empleados disponibles.');
            this.schedShiftSelectedEmployees = [];
        }
    },

    buildSchedShiftRows(startDate, endDate, defaultStart = '08:00', defaultEnd = '16:00') {
        const DAY_LABELS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const start = new Date(`${startDate}T00:00:00`);
        const end = new Date(`${endDate}T00:00:00`);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];

        const rows = [];
        let current = new Date(start);
        while (current <= end && rows.length < 60) {
            const dow = current.getDay();
            rows.push({
                dateKey: toLocalDateKey(current),
                dayLabel: DAY_LABELS[dow],
                dayShort: DAY_SHORT[dow],
                enabled: dow !== 0 && dow !== 6,
                startTime: defaultStart,
                endTime: defaultEnd,
                isDefaultTime: true,
            });
            current = new Date(current.getTime() + 24 * 3600 * 1000);
        }
        return rows;
    },

    renderSchedShiftRows() {
        const container = document.getElementById('sched-shift-day-rows');
        if (!container) return;

        const rows = this.schedShiftRows || [];
        if (rows.length === 0) {
            container.innerHTML = '';
            return;
        }

        const fragment = document.createDocumentFragment();
        rows.forEach((row, index) => {
            const [y, m, d] = row.dateKey.split('-');
            const dateLabel = `${d}/${m}`;
            const rowEl = document.createElement('div');
            rowEl.className = `shift-plan-row${row.enabled ? '' : ' shift-plan-row--disabled'}`;

            rowEl.innerHTML = `
                <label class="shift-plan-row-toggle">
                    <input type="checkbox" ${row.enabled ? 'checked' : ''} onchange="app.onSchedShiftRowToggle(${index}, this.checked)">
                    <span class="shift-plan-day-label">${escapeHtml(row.dayShort)} <span class="shift-plan-date">${escapeHtml(dateLabel)}</span></span>
                </label>
                <div class="shift-plan-times${row.enabled ? '' : ' opacity-50'}">
                    <input type="time" class="dark-control" value="${escapeHtml(row.startTime)}"
                        ${row.enabled ? '' : 'disabled'}
                        onchange="app.onSchedShiftRowTimeChange(${index}, 'startTime', this.value)">
                    <span class="shift-plan-time-sep">→</span>
                    <input type="time" class="dark-control" value="${escapeHtml(row.endTime)}"
                        ${row.enabled ? '' : 'disabled'}
                        onchange="app.onSchedShiftRowTimeChange(${index}, 'endTime', this.value)">
                </div>
            `;
            fragment.appendChild(rowEl);
        });
        container.replaceChildren(fragment);
    },

    onSchedShiftDatesChange() {
        const startDate = document.getElementById('sched-shift-start-date')?.value;
        const endDate = document.getElementById('sched-shift-end-date')?.value;
        const defaultStart = document.getElementById('sched-shift-default-start')?.value || '08:00';
        const defaultEnd = document.getElementById('sched-shift-default-end')?.value || '16:00';

        if (!startDate || !endDate || startDate > endDate) {
            this.schedShiftRows = [];
            this.renderSchedShiftRows();
            return;
        }

        this.schedShiftRows = this.buildSchedShiftRows(startDate, endDate, defaultStart, defaultEnd);
        this.renderSchedShiftRows();
    },

    onSchedShiftDefaultTimeChange() {
        const defaultStart = document.getElementById('sched-shift-default-start')?.value || '08:00';
        const defaultEnd = document.getElementById('sched-shift-default-end')?.value || '16:00';

        if (!this.schedShiftRows) return;
        this.schedShiftRows = this.schedShiftRows.map((row) => {
            if (!row.isDefaultTime) return row;
            return { ...row, startTime: defaultStart, endTime: defaultEnd };
        });
        this.renderSchedShiftRows();
    },

    onSchedShiftRowToggle(index, enabled) {
        if (this.schedShiftRows?.[index] != null) {
            this.schedShiftRows[index].enabled = enabled;
            this.renderSchedShiftRows();
        }
    },

    onSchedShiftRowTimeChange(index, field, value) {
        if (this.schedShiftRows?.[index] != null) {
            this.schedShiftRows[index][field] = value;
            this.schedShiftRows[index].isDefaultTime = false;
        }
    },

    async submitSchedShiftForm() {
        if (this.supervisorShiftSubmitPending) {
            this.showToast('Ya estamos guardando la programación. Espera un momento.', {
                tone: 'info',
                title: 'Procesando',
            });
            return;
        }

        const restaurantId = document.getElementById('sched-shift-restaurant')?.value;
        const selectedEmployees = (this.schedShiftSelectedEmployees || []).filter(Boolean);
        const rows = this.schedShiftRows || [];
        const activeRows = rows.filter((r) => r.enabled);

        if (!restaurantId) {
            this.showToast('Selecciona un restaurante antes de guardar.', {
                tone: 'warning',
                title: 'Falta el restaurante',
            });
            return;
        }
        if (selectedEmployees.length === 0) {
            this.showToast('Selecciona al menos un empleado.', { tone: 'warning', title: 'Falta el empleado' });
            return;
        }
        if (activeRows.length === 0) {
            this.showToast('Activa al menos un día antes de guardar.', {
                tone: 'warning',
                title: 'Sin días seleccionados',
            });
            return;
        }

        const assignments = [];
        for (const row of activeRows) {
            if (!row.startTime || !row.endTime) {
                this.showToast(`Completa la hora de entrada y salida para el ${row.dayLabel} ${row.dateKey}.`, {
                    tone: 'warning',
                    title: 'Faltan horas',
                });
                return;
            }
            const startDate = this.buildSupervisorShiftDateTime(row.dateKey, row.startTime);
            const endDate = this.buildSupervisorShiftDateTime(row.dateKey, row.endTime);
            if (!startDate || !endDate) {
                this.showToast(`Revisa el formato de hora para el ${row.dayLabel} ${row.dateKey}.`, {
                    tone: 'warning',
                    title: 'Horario inválido',
                });
                return;
            }
            if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1);
            for (const employeeId of selectedEmployees) {
                assignments.push({
                    employee_id: normalizeRestaurantId(employeeId),
                    restaurant_id: normalizeRestaurantId(restaurantId),
                    scheduled_start: startDate.toISOString(),
                    scheduled_end: endDate.toISOString(),
                });
            }
        }

        try {
            const assignmentRanges = assignments.map((a) => this.toShiftIntervalRange(a)).filter(Boolean);
            const minStartMs = assignmentRanges.length > 0 ? Math.min(...assignmentRanges.map((r) => r.startMs)) : null;
            const maxEndMs = assignmentRanges.length > 0 ? Math.max(...assignmentRanges.map((r) => r.endMs)) : null;

            const nearbyShifts =
                Number.isFinite(minStartMs) && Number.isFinite(maxEndMs)
                    ? await this.getSupervisorShiftList({
                          from: toIsoDate(new Date(minStartMs - 86400000)),
                          to: toIsoDate(new Date(maxEndMs + 86400000)),
                          limit: 500,
                          forceRestaurants: false,
                      })
                    : asArray(this.data.supervisor.shifts);

            const conflict = this.findShiftAssignmentConflict(assignments, nearbyShifts);
            if (conflict) {
                const empRecord =
                    this.getKnownEmployeeRecord(conflict.employeeId) ||
                    asArray(this.data.supervisor.employees).find(
                        (e) => String(e?.id || '') === String(conflict.employeeId || '')
                    ) ||
                    null;
                const empName = getEmployeeDisplayName(
                    empRecord || { id: conflict.employeeId },
                    'el empleado seleccionado'
                );
                if (conflict.type === 'existing') {
                    const cs = conflict.existingShift;
                    this.showToast(
                        `${empName} ya tiene un turno (${formatDate(cs?.scheduled_start, { day: '2-digit', month: 'short' })} ${formatShiftRange(cs?.scheduled_start, cs?.scheduled_end)}) que se cruza con ese horario.`,
                        { tone: 'warning', title: 'Conflicto de horario' }
                    );
                } else {
                    this.showToast(`${empName} tiene dos turnos en esta programación que se cruzan entre sí.`, {
                        tone: 'warning',
                        title: 'Conflicto de horario',
                    });
                }
                return;
            }
        } catch (precheckError) {
            console.warn('No fue posible validar conflictos de horario.', precheckError);
        }

        this.setSupervisorShiftSubmitState(true);
        this.showLoading('Programando turnos...', `Guardando ${assignments.length} programaciones.`);

        try {
            let successCount = 0;
            let failedCount = 0;

            if (assignments.length === 1) {
                await apiClient.scheduledShiftsManage('assign', assignments[0]);
                successCount = 1;
            } else {
                const bulkResult = await apiClient.scheduledShiftsManage('bulk_assign', { entries: assignments });
                successCount = Number(bulkResult?.created ?? bulkResult?.data?.created ?? assignments.length);
                failedCount = Number(bulkResult?.failed ?? bulkResult?.data?.failed ?? 0);
            }

            await this.loadSupervisorShifts(true);
            this.closeModal('modal-supervisor-schedule-shift');

            const tone = failedCount > 0 ? 'warning' : 'success';
            const msg =
                failedCount > 0
                    ? `${successCount} turno(s) creado(s). ${failedCount} no se pudieron guardar.`
                    : `${successCount} turno(s) programado(s) correctamente.`;
            this.showToast(msg, { tone, title: tone === 'success' ? 'Turnos guardados' : 'Guardado parcial' });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible guardar los turnos.'), {
                tone: 'error',
                title: 'Error al guardar',
            });
        } finally {
            this.setSupervisorShiftSubmitState(false);
            this.hideLoading();
        }
    },
};
