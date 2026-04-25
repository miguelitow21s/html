// @ts-nocheck

export const STORAGE_KEYS = Object.freeze({
    user: 'worktrace_user',
    shiftOtpExpiresAt: 'worktrace_shift_otp_expires_at',
    shiftSelectedAreas: 'worktrace_shift_selected_areas',
    shiftRestaurantNames: 'worktrace_shift_restaurant_names',
    shiftRequestTrace: 'worktrace_shift_request_trace'
});

export const ROLE_ROUTES = Object.freeze({
    empleado: 'employee-dashboard',
    supervisora: 'supervisor-dashboard',
    super_admin: 'admin-dashboard',
    employee: 'employee-dashboard',
    supervisor: 'supervisor-dashboard',
    superuser: 'admin-dashboard'
});

export const ROLE_LABELS = Object.freeze({
    empleado: 'Empleado de Limpieza',
    supervisora: 'Supervisora',
    super_admin: 'Super Admin',
    employee: 'Empleado de Limpieza',
    supervisor: 'Supervisora',
    superuser: 'Super Admin'
});

export const REPORT_COLUMNS = [
    'Turno',
    'Restaurante',
    'Empleado',
    'Supervisora',
    'Inicio',
    'Fin',
    'Estado',
    'Duracion',
    'Novedades',
    'Evidencia inicial',
    'Evidencia final'
];

export const AREA_META = Object.freeze({
    Cocina: { area_key: 'cocina', area_label: 'Cocina' },
    Comedor: { area_key: 'comedor', area_label: 'Comedor' },
    'Baños': { area_key: 'banos', area_label: 'Baños' },
    Patio: { area_key: 'patio', area_label: 'Patio' },
    'Almacén': { area_key: 'almacen', area_label: 'Almacén' }
});

export const AREA_SUBAREAS = Object.freeze({
    Cocina: ['Campana', 'Pisos', 'Esquinas', 'Detrás de freidoras', 'Debajo de mesas', 'Frente de neveras'],
    Comedor: ['General', 'Pisos', 'Esquinas', 'Debajo de mesas y asientos', 'Marcos de ventanas'],
    'Puntos de dispensadores de gaseosas': ['Frente', 'Atrás', 'Gabinetes'],
    'Desagües': ['General'],
    'Fachadas - patios': ['Pisos', 'Esquinas', 'Debajo de mesas y asientos', 'Marcos de las ventanas'],
    'Baños': ['Pisos', 'Sanitarios adelante', 'Sanitarios atrás', 'Lavamanos', 'Cambiador de niños', 'Puertas y marcos']
});

export const AREA_GROUP_ALIASES = Object.freeze({
    cocina: 'Cocina',
    comedor: 'Comedor',
    banos: 'Baños',
    bano: 'Baños',
    baños: 'Baños',
    patio: 'Fachadas - patios',
    patios: 'Fachadas - patios',
    fachada: 'Fachadas - patios',
    fachadas: 'Fachadas - patios',
    'fachadas_patio': 'Fachadas - patios',
    'fachadas_patios': 'Fachadas - patios',
    'fachadas_-_patios': 'Fachadas - patios',
    desagues: 'Desagües',
    desagües: 'Desagües',
    'puntos_de_dispensadores_de_gaseosas': 'Puntos de dispensadores de gaseosas',
    dispensadores: 'Puntos de dispensadores de gaseosas'
});

export const DEFAULT_SYSTEM_SETTINGS = Object.freeze({
    security: {
        pin_length: 6,
        force_password_change_on_first_login: false,
        otp_expiration_minutes: 10,
        trusted_device_days: 30
    },
    legal: {
        consent_text: 'Autorizo el uso de mis datos personales, ubicacion GPS y camara para fines de verificacion de turnos laborales.',
        support_email: 'soporte@worktrace.com'
    },
    gps: {
        default_radius_meters: 100,
        min_accuracy_meters: 100,
        require_gps_for_shift_start: true,
        require_gps_for_supervision: true
    },
    shifts: {
        default_hours: 6,
        min_hours: 1,
        max_hours: 12,
        early_start_tolerance_minutes: 60,
        late_start_tolerance_minutes: 60
    },
    evidence: {
        require_start_photos: true,
        require_end_photos: true,
        require_supervision_photos: true,
        default_cleaning_areas: ['Cocina', 'Comedor', 'Baños', 'Patio'],
        areas_mode: 'restaurant_or_default'
    },
    tasks: {
        require_special_task_completion_check: true,
        require_special_task_notes: true
    }
});

export const CACHE_TTLS = Object.freeze({
    employeeDashboard: 20 * 1000,
    employeeHoursHistory: 60 * 1000,
    supervisorRestaurants: 60 * 1000,
    supervisorRestaurantStaff: 30 * 1000,
    supervisorAssignableEmployees: 30 * 1000,
    supervisorShifts: 30 * 1000,
    supervisorEmployees: 30 * 1000,
    adminRestaurants: 60 * 1000,
    adminSettings: 60 * 1000,
    adminMetrics: 30 * 1000,
    adminSupervisors: 30 * 1000,
    adminSupervisions: 90 * 1000
});

export const SHIFT_NOT_STARTED_ALERT_GRACE_MINUTES = 15;

export function createScopedConsole() {
    const baseConsole = globalThis.console || {};
    const host = globalThis.location?.hostname || '';
    const debugEnabled = Boolean(globalThis.WORKTRACE_CONFIG?.debugConsole)
        || /^(localhost|127\.0\.0\.1)$/i.test(host);

    const noop = () => {};
    const bindMethod = (method) => (
        typeof baseConsole?.[method] === 'function'
            ? baseConsole[method].bind(baseConsole)
            : noop
    );

    const error = bindMethod('error');

    return {
        ...baseConsole,
        log: debugEnabled ? bindMethod('log') : noop,
        info: debugEnabled ? bindMethod('info') : noop,
        warn: debugEnabled ? bindMethod('warn') : noop,
        debug: debugEnabled ? bindMethod('debug') : noop,
        error
    };
}

export const scopedConsole = createScopedConsole();
