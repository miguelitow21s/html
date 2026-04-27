// @ts-nocheck
import { AREA_META, AREA_GROUP_ALIASES, scopedConsole as console } from './constants.js';

export function getMonthStart(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function getTodayStart(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getTodayEnd(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function getDaysAgo(days, date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - days);
}

export function toInputDate(value) {
    if (!value) {
        return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return date.toISOString().slice(0, 10);
}

export function toLocalDateKey(value) {
    if (!value) {
        return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function toIsoDate(value) {
    if (!value) {
        return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return date.toISOString();
}

export function decodeJwtPart(token = '', index = 1) {
    if (!token || typeof token !== 'string') {
        return null;
    }

    const parts = token.split('.');
    if (parts.length <= index) {
        return null;
    }

    try {
        const base64 = parts[index]
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(parts[index].length / 4) * 4, '=');
        const json = decodeURIComponent(
            Array.from(atob(base64))
                .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
                .join('')
        );
        return JSON.parse(json);
    } catch (error) {
        console.warn('No fue posible decodificar una parte del JWT.', error);
        return null;
    }
}

export function decodeJwtHeader(token = '') {
    return decodeJwtPart(token, 0);
}

export function decodeJwtPayload(token = '') {
    return decodeJwtPart(token, 1);
}

export function buildJwtFullDebugSummary(token = '') {
    if (!token || typeof token !== 'string') {
        return null;
    }

    const parts = token.split('.');
    return {
        header: decodeJwtHeader(token),
        payload: decodeJwtPayload(token),
        unsigned_token: parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null,
    };
}

export function buildJwtDebugSummary(token = '') {
    const payload = decodeJwtPayload(token);
    if (!payload) {
        return null;
    }

    return {
        sub: payload.sub || null,
        email: payload.email || payload.user_email || payload.phone || null,
        role: payload.role || payload.user_role || payload.app_metadata?.role || null,
        session_id: payload.session_id || payload.sessionId || payload.sid || null,
        exp: payload.exp || null,
        aal: payload.aal || null,
    };
}

export function toDateTimeLocalInput(value) {
    if (!value) {
        return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

export function formatDate(value, options = {}) {
    if (!value) {
        return '-';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }

    return date.toLocaleDateString('es-CO', options);
}

export function formatTime(value) {
    if (!value) {
        return '-';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }

    return date.toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function formatDateTime(value) {
    if (!value) {
        return '-';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }

    return date.toLocaleString('es-CO', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function formatShiftRange(startValue, endValue) {
    const start = formatTime(startValue);
    const end = formatTime(endValue);

    if (start === '-' && end === '-') {
        return '-';
    }

    return `${start} - ${end}`;
}

export function formatHours(value) {
    const numericValue = Number(value || 0);
    if (!Number.isFinite(numericValue)) {
        return '0h';
    }

    return `${numericValue.toFixed(1).replace(/\.0$/, '')}h`;
}

export function isHttpUrl(value) {
    return typeof value === 'string' && /^(https?:)?\/\//i.test(value.trim());
}

export function collectEvidenceUrls(value, bucket = new Set()) {
    if (!value) {
        return bucket;
    }

    if (typeof value === 'string') {
        if (isHttpUrl(value)) {
            bucket.add(value.trim());
        }
        return bucket;
    }

    if (Array.isArray(value)) {
        value.forEach((item) => collectEvidenceUrls(item, bucket));
        return bucket;
    }

    if (typeof value === 'object') {
        [
            value.url,
            value.public_url,
            value.publicUrl,
            value.signed_url,
            value.signedUrl,
            value.download_url,
            value.downloadUrl,
            value.image_url,
            value.imageUrl,
        ].forEach((candidate) => collectEvidenceUrls(candidate, bucket));
    }

    return bucket;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function normalizeAreaToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

export function extractCleaningAreas(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => {
            if (typeof item === 'string') {
                return item.trim();
            }

            if (item && typeof item === 'object') {
                if (item.active === false) {
                    return '';
                }

                return String(item.area || item.label || item.name || item.area_label || item.title || '').trim();
            }

            return '';
        })
        .filter(Boolean);
}

export function extractCleaningAreaSubareas(value) {
    return uniqueCleaningAreas(
        asArray(value)
            .map((item) => {
                if (typeof item === 'string') {
                    return item.trim();
                }

                if (item && typeof item === 'object') {
                    return String(
                        item.label || item.name || item.subarea_label || item.title || item.area || ''
                    ).trim();
                }

                return '';
            })
            .filter(Boolean)
    );
}

export function extractCleaningAreaGroups(value) {
    if (!Array.isArray(value)) {
        return {};
    }

    const groups = {};

    value.forEach((item) => {
        if (typeof item === 'string') {
            const areaLabel = item.trim();
            if (!areaLabel) {
                return;
            }

            const canonicalLabel = normalizeAreaGroupLabel(areaLabel);
            const key = normalizeAreaToken(canonicalLabel || areaLabel);
            if (!groups[key]) {
                groups[key] = {
                    label: canonicalLabel || areaLabel,
                    subareas: [],
                };
            }
            return;
        }

        if (!item || typeof item !== 'object' || item.active === false) {
            return;
        }

        const areaLabel = String(item.area || item.label || item.name || item.area_label || item.title || '').trim();
        if (!areaLabel) {
            return;
        }

        const canonicalLabel = normalizeAreaGroupLabel(areaLabel);
        const key = normalizeAreaToken(canonicalLabel || areaLabel);
        if (!groups[key]) {
            groups[key] = {
                label: canonicalLabel || areaLabel,
                subareas: [],
            };
        }

        const nextSubareas = extractCleaningAreaSubareas(item.subareas);
        nextSubareas.forEach((subareaLabel) => {
            if (
                !groups[key].subareas.some(
                    (currentLabel) => normalizeAreaToken(currentLabel) === normalizeAreaToken(subareaLabel)
                )
            ) {
                groups[key].subareas.push(subareaLabel);
            }
        });
    });

    return groups;
}

export function uniqueCleaningAreas(items) {
    const seen = new Set();
    const result = [];

    items.forEach((item) => {
        const key = normalizeAreaToken(item);
        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        result.push(item);
    });

    return result;
}

export function buildAreaMeta(areaLabel) {
    return (
        AREA_META[areaLabel] || {
            area_key: normalizeAreaToken(areaLabel),
            area_label: areaLabel,
        }
    );
}

export function formatEntityReference(prefix, id) {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) {
        return prefix;
    }

    if (/^\d+$/.test(normalizedId)) {
        return `${prefix} #${normalizedId}`;
    }

    return `${prefix} ${normalizedId.slice(-6)}`;
}

export function getDisplayTextCandidate(value) {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value).trim();
    }

    return '';
}

export function normalizeComparableText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\w\s#-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function pickMeaningfulDisplayValue(candidates = [], type = 'text') {
    for (const candidate of candidates) {
        const label = getDisplayTextCandidate(candidate);
        if (label && !isGenericNamedPlaceholder(label, type)) {
            return label;
        }
    }

    return '';
}

export function getRestaurantAddressFallback(record) {
    const source = record && typeof record === 'object' ? record : {};
    return pickMeaningfulDisplayValue(
        [
            source.address_line,
            source.formatted_address,
            source.display_address,
            source.restaurant?.address_line,
            source.location?.address_line,
            source.site?.address_line,
            source.raw?.address_line,
            source.raw?.formatted_address,
            [source.city, source.state].filter(Boolean).join(', '),
            [source.city, source.state, source.country].filter(Boolean).join(', '),
        ],
        'text'
    );
}

export function collectRestaurantAddressCandidates(record) {
    const source = record && typeof record === 'object' ? record : {};
    return [
        source.address_line,
        source.formatted_address,
        source.display_name,
        source.display_address,
        source.restaurant?.address_line,
        source.restaurant?.formatted_address,
        source.restaurant?.display_name,
        source.location?.address_line,
        source.location?.formatted_address,
        source.location?.display_name,
        source.site?.address_line,
        source.site?.formatted_address,
        source.site?.display_name,
        source.raw?.address_line,
        source.raw?.formatted_address,
        source.raw?.display_name,
        [source.city, source.state].filter(Boolean).join(', '),
        [source.city, source.state, source.country].filter(Boolean).join(', '),
    ]
        .map((value) => getDisplayTextCandidate(value))
        .filter(Boolean)
        .map((value) => normalizeComparableText(value))
        .filter(Boolean);
}

export function isLikelyAddressDisplayValue(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) {
        return false;
    }

    const addressPattern =
        /\b(calle|carrera|cra|cl|av|avenida|street|st|road|rd|drive|dr|lane|ln|boulevard|blvd|highway|hwy|way|place|pl|court|ct|suite|ste|apt|apartment)\b/;
    const startsWithNumber = /^\d+[a-z]?(?:[\s#-]+\d+)/.test(normalized) || /^\d+[a-z]?\s/.test(normalized);
    const hasAddressSeparator = normalized.includes('#') || /\b\d{1,5}[-/]\d{1,5}\b/.test(normalized);
    const hasCommaAndStreet = normalized.includes(',') && addressPattern.test(normalized);

    return addressPattern.test(normalized) || startsWithNumber || hasAddressSeparator || hasCommaAndStreet;
}

export function isLikelyIdentifierDisplayValue(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return false;
    }

    const normalized = normalizeComparableText(raw);
    if (!normalized) {
        return false;
    }

    const compact = raw.replace(/[\s_-]/g, '');
    const hasOnlyIdCharacters = /^[a-z0-9-]+$/i.test(raw);

    if (/^\d+$/.test(raw)) {
        return true;
    }

    if (/^(?:#|id[:\s-]*)\d+$/i.test(raw)) {
        return true;
    }

    if (/^\w+@\w+\.\w+/.test(raw)) {
        return true;
    }

    if (/^(restaurant|restaurante|site|location|sede)[\s#:_-]*\d+$/i.test(raw)) {
        return true;
    }

    if (/^(restaurant_id|rest_id|location_id|site_id|id)[\s:#_-]*[a-z0-9-]+$/i.test(raw)) {
        return true;
    }

    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw)) {
        return true;
    }

    if (hasOnlyIdCharacters && compact.length >= 20 && /^[a-f0-9]+$/i.test(compact)) {
        return true;
    }

    return false;
}

export function pickMeaningfulRestaurantName(candidates = [], record = null) {
    const normalizedAddressCandidates = new Set(collectRestaurantAddressCandidates(record));

    for (const candidate of candidates) {
        const label = getDisplayTextCandidate(candidate);
        if (!label || isGenericNamedPlaceholder(label, 'restaurant')) {
            continue;
        }

        const normalizedLabel = normalizeComparableText(label);
        if (!normalizedLabel) {
            continue;
        }

        if (normalizedAddressCandidates.has(normalizedLabel)) {
            continue;
        }

        if (isLikelyAddressDisplayValue(label)) {
            continue;
        }

        if (isLikelyIdentifierDisplayValue(label)) {
            continue;
        }

        return label;
    }

    return '';
}

export function getEmployeeDisplayName(record, fallback = 'Empleado') {
    const source = record && typeof record === 'object' ? record : {};
    const directName = pickMeaningfulDisplayValue(
        [
            source.full_name,
            source.employee_full_name,
            source.employee_name,
            source.employee_visible_name,
            source.assigned_employee_name,
            source.user_name,
            source.visible_name,
            source.name,
            source.display_name,
            source.label,
            source.title,
            source.user?.full_name,
            source.user?.name,
            source.employee?.full_name,
            source.employee?.name,
            source.raw?.full_name,
            source.raw?.employee_full_name,
            source.raw?.employee_name,
            source.raw?.name,
        ],
        'employee'
    );

    if (directName) {
        return directName;
    }

    const composedName = [source.first_name, source.last_name].filter(Boolean).join(' ').trim();
    if (composedName && !isGenericNamedPlaceholder(composedName, 'employee')) {
        return composedName;
    }

    const email = String(source.email || source.employee_email || '').trim();
    if (email) {
        return email;
    }

    const phone = String(source.phone_e164 || source.phone_number || source.phone || '').trim();
    if (phone) {
        return phone;
    }

    const referenceLabel = formatEntityReference(
        'Empleado',
        source.id || source.employee_id || source.user_id || source.assigned_employee_id
    );
    return referenceLabel !== 'Empleado' ? referenceLabel : fallback;
}

export function getRestaurantDisplayName(record, fallback = 'Restaurante') {
    const source = record && typeof record === 'object' ? record : {};
    const directName = pickMeaningfulRestaurantName(
        [
            source.restaurant_name,
            source.restaurant_visible_name,
            source.restaurant_label,
            source.location_name,
            source.site_name,
            source.restaurant?.restaurant_name,
            source.restaurant?.restaurant_visible_name,
            source.restaurant?.restaurant_label,
            source.location?.location_name,
            source.site?.site_name,
            source.raw?.restaurant_name,
            source.raw?.restaurant_visible_name,
            source.raw?.restaurant_label,
            source.raw?.restaurant?.restaurant_name,
            source.raw?.restaurant?.restaurant_visible_name,
            source.raw?.restaurant?.restaurant_label,
            source.name,
            source.visible_name,
            source.label,
            source.title,
            source.display_name,
            source.restaurant?.name,
            source.restaurant?.label,
            source.restaurant?.title,
            source.restaurant?.display_name,
            source.location?.name,
            source.location?.label,
            source.location?.title,
            source.location?.display_name,
            source.site?.name,
            source.site?.label,
            source.site?.title,
            source.site?.display_name,
            source.raw?.name,
            source.raw?.display_name,
            source.raw?.label,
            source.raw?.title,
            source.raw?.restaurant?.name,
            source.raw?.restaurant?.label,
            source.raw?.restaurant?.title,
            source.raw?.restaurant?.display_name,
            source.raw?.location_name,
            source.raw?.site_name,
        ],
        source
    );

    if (directName) {
        return directName;
    }

    const directFallback = pickMeaningfulRestaurantName([fallback], source);
    if (directFallback) {
        return directFallback;
    }

    const restaurantReference = formatEntityReference('Restaurante', getRestaurantRecordId(source));
    return restaurantReference !== 'Restaurante' ? restaurantReference : 'Restaurante asignado';
}

export function isRestaurantReferenceLabel(value = '') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase();
    return /^restaurante\s*#\s*[a-z0-9_-]+$/i.test(normalized);
}

export function getShiftEmployeeName(shift, options = {}) {
    const employeeRecord =
        options.employeeRecord && typeof options.employeeRecord === 'object' ? options.employeeRecord : {};
    const employee = shift?.employee || shift?.user || shift?.staff || shift?.worker || shift?.employee_user || {};
    const employeeText = typeof employee === 'string' ? employee.trim() : '';
    const directName = pickMeaningfulDisplayValue(
        [
            employeeText,
            employeeRecord.full_name,
            employeeRecord.employee_full_name,
            employeeRecord.employee_name,
            employeeRecord.visible_name,
            employeeRecord.name,
            employeeRecord.display_name,
            employeeRecord.label,
            employeeRecord.title,
            employeeRecord.email,
            employee.full_name,
            employee.employee_full_name,
            employee.visible_name,
            employee.name,
            employee.display_name,
            employee.label,
            employee.title,
            employee.user?.full_name,
            shift?.assigned_employee?.full_name,
            shift?.employee_user?.full_name,
            shift?.employee,
            shift?.employee_name,
            shift?.employee_visible_name,
            shift?.employee_display_name,
            shift?.employee_full_name,
            shift?.assigned_employee_name,
            shift?.assignee_name,
            shift?.worker_name,
            shift?.full_name,
            shift?.user_name,
            shift?.user?.full_name,
        ],
        'employee'
    );

    if (directName) {
        return directName;
    }

    const composedName = [
        employee.first_name || employeeRecord.first_name || shift?.first_name,
        employee.last_name || employeeRecord.last_name || shift?.last_name,
    ]
        .filter(Boolean)
        .join(' ')
        .trim();

    if (composedName) {
        return composedName;
    }

    return getEmployeeDisplayName(
        {
            ...employeeRecord,
            ...(employee && typeof employee === 'object' ? employee : {}),
            email: employee.email || employeeRecord.email || shift?.email || shift?.employee_email || '',
            id:
                employee.id ||
                employeeRecord.id ||
                shift?.employee_id ||
                shift?.assigned_employee_id ||
                shift?.user_id ||
                '',
        },
        'Empleado'
    );
}

export function getShiftRestaurantName(shift, options = {}) {
    const restaurantRecord =
        options.restaurantRecord && typeof options.restaurantRecord === 'object' ? options.restaurantRecord : {};
    const restaurant = shift?.restaurant || shift?.location || shift?.site || {};
    const restaurantText = typeof restaurant === 'string' ? restaurant.trim() : '';
    const directName = pickMeaningfulRestaurantName(
        [
            shift?.restaurant_name,
            shift?.restaurant_visible_name,
            shift?.restaurant_label,
            shift?.location_name,
            shift?.site_name,
            restaurantRecord.restaurant_name,
            restaurantRecord.restaurant_visible_name,
            restaurantRecord.restaurant_label,
            restaurant.restaurant_name,
            restaurant.restaurant_visible_name,
            restaurant.restaurant_label,
            restaurantText,
            restaurantRecord.name,
            restaurantRecord.visible_name,
            restaurantRecord.label,
            restaurantRecord.title,
            restaurantRecord.display_name,
            restaurant.name,
            restaurant.visible_name,
            restaurant.label,
            restaurant.title,
            restaurant.display_name,
            shift?.name,
            shift?.display_name,
        ],
        {
            ...restaurantRecord,
            ...(restaurant && typeof restaurant === 'object' ? restaurant : {}),
            ...(shift && typeof shift === 'object' ? shift : {}),
        }
    );

    if (directName) {
        return directName;
    }

    return getRestaurantDisplayName(
        {
            ...restaurantRecord,
            ...(restaurant && typeof restaurant === 'object' ? restaurant : {}),
            address_line: restaurant?.address_line || restaurantRecord?.address_line || shift?.address_line || '',
            city: restaurant?.city || restaurantRecord?.city || shift?.city || '',
            state: restaurant?.state || restaurantRecord?.state || shift?.state || '',
            country: restaurant?.country || restaurantRecord?.country || shift?.country || '',
            id:
                restaurant?.id ||
                restaurantRecord?.id ||
                shift?.restaurant_id ||
                shift?.location_id ||
                shift?.site_id ||
                '',
        },
        'Restaurante'
    );
}

export function normalizeAreaGroupLabel(areaLabel) {
    const normalized = normalizeAreaToken(areaLabel);
    return AREA_GROUP_ALIASES[normalized] || areaLabel;
}

export function buildPhotoSlotKey(areaLabel, subareaLabel) {
    return `${normalizeAreaToken(areaLabel)}__${normalizeAreaToken(subareaLabel)}`;
}

export function areaDomId(areaLabel) {
    return normalizeAreaToken(areaLabel).replace(/_/g, '-') || 'area';
}

export function getRestaurantRecordId(restaurant) {
    const candidate =
        restaurant?.restaurant_id ??
        restaurant?.id ??
        restaurant?.restaurant?.restaurant_id ??
        restaurant?.restaurant?.id ??
        restaurant?.location_id ??
        restaurant?.location?.id ??
        restaurant?.site_id ??
        restaurant?.site?.id ??
        restaurant?.raw?.restaurant_id ??
        restaurant?.raw?.id ??
        null;

    if (candidate == null) {
        return null;
    }

    const normalized = String(candidate).trim();
    if (!normalized || normalized === 'undefined' || normalized === 'null') {
        return null;
    }

    return candidate;
}

export function normalizeRestaurantId(value) {
    if (value == null) {
        return null;
    }

    const normalized = String(value).trim();
    if (!normalized || normalized === 'undefined' || normalized === 'null') {
        return null;
    }

    const numericValue = Number(normalized);
    return Number.isFinite(numericValue) ? numericValue : normalized;
}

export function deepMergeSettings(base, override) {
    const result = Array.isArray(base) ? [...base] : { ...(base || {}) };

    Object.entries(override || {}).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            result[key] = [...value];
            return;
        }

        if (value && typeof value === 'object') {
            result[key] = deepMergeSettings(base?.[key] || {}, value);
            return;
        }

        result[key] = value;
    });

    return result;
}

export function initials(value) {
    const parts = String(value || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (parts.length === 0) {
        return 'U';
    }

    return parts
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join('');
}

export function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function isGenericNamedPlaceholder(value, type = 'text') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase();
    if (!normalized) {
        return true;
    }

    if (
        [
            '-',
            '--',
            'n/a',
            'na',
            'null',
            'undefined',
            'unknown',
            'scheduled',
            'programado',
            'programada',
            'pending',
            'pendiente',
            'active',
            'activo',
            'inactivo',
            'inactive',
            'completed',
            'completado',
            'finalizado',
            'finished',
        ].includes(normalized)
    ) {
        return true;
    }

    const genericTokens =
        type === 'restaurant'
            ? ['restaurante', 'restaurant', 'local', 'sede', 'site', 'location']
            : ['empleado', 'employee', 'usuario', 'user', 'trabajador', 'worker', 'staff'];

    return genericTokens.some((token) => normalized === token || normalized.startsWith(`${token} `));
}

export function getBadgeClass(status) {
    const normalized = String(status || '').toLowerCase();

    if (
        [
            'activo',
            'active',
            'approved',
            'aprobado',
            'completado',
            'completed',
            'finished',
            'finalizado',
            'ok',
            'success',
            'en progreso',
            'in_progress',
            'in-progress',
        ].includes(normalized)
    ) {
        return 'badge-success';
    }

    if (
        [
            'rechazado',
            'rejected',
            'cancelado',
            'cancelled',
            'canceled',
            'deactivated',
            'inactive',
            'error',
            'failed',
        ].includes(normalized)
    ) {
        return 'badge-danger';
    }

    return 'badge-warning';
}

export function asArray(value, keys = ['items']) {
    if (Array.isArray(value)) {
        return value;
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    for (const key of keys) {
        if (Array.isArray(value[key])) {
            return value[key];
        }
    }

    const nestedArray = Object.values(value).find((candidate) => Array.isArray(candidate));
    if (nestedArray) {
        return nestedArray;
    }

    return [];
}

export function normalizeLinkedPhoneValue(value) {
    const phone = String(value || '').trim();
    if (!phone || phone === '-' || phone.toLowerCase() === 'null' || phone.toLowerCase() === 'undefined') {
        return '';
    }

    return phone;
}

export function getHoursFromRange(startValue, endValue) {
    if (!startValue || !endValue) {
        return null;
    }

    const start = new Date(startValue);
    const end = new Date(endValue);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return null;
    }

    const diffHours = (end.getTime() - start.getTime()) / 3600000;
    return Number.isFinite(diffHours) && diffHours > 0 ? diffHours : null;
}

export function getScheduledHours(item) {
    if (!item || typeof item !== 'object') {
        return 0;
    }

    const scheduledCandidates = [
        item?.scheduled_hours,
        item?.hours_scheduled,
        item?.assigned_hours,
        item?.hours_assigned,
        item?.planned_hours,
        item?.expected_hours,
        item?.scheduled_duration_hours,
        item?.shift_hours,
        item?.scheduled_shift?.scheduled_hours,
        item?.scheduled_shift?.hours_scheduled,
        item?.scheduled_shift?.assigned_hours,
        item?.scheduled_shift?.hours_assigned,
        getHoursFromRange(
            item?.scheduled_start || item?.scheduled_shift?.scheduled_start,
            item?.scheduled_end || item?.scheduled_shift?.scheduled_end
        ),
    ];

    for (const candidate of scheduledCandidates) {
        const numericCandidate = Number(candidate);
        if (Number.isFinite(numericCandidate) && numericCandidate > 0) {
            return numericCandidate;
        }
    }

    const fallbackCandidates = [item?.hours, item?.duration_hours, item?.hours_worked, item?.worked_hours];

    for (const candidate of fallbackCandidates) {
        const numericCandidate = Number(candidate);
        if (Number.isFinite(numericCandidate) && numericCandidate > 0) {
            return numericCandidate;
        }
    }

    return 0;
}

export function getWorkedHours(item) {
    if (!item || typeof item !== 'object') {
        return 0;
    }

    const directCandidates = [
        item?.hours_worked,
        item?.worked_hours,
        item?.actual_hours,
        item?.completed_hours,
        item?.tracked_hours,
        item?.effective_hours,
        item?.total_hours_worked,
    ];

    for (const candidate of directCandidates) {
        const numericCandidate = Number(candidate);
        if (Number.isFinite(numericCandidate) && numericCandidate > 0) {
            return numericCandidate;
        }
    }

    return 0;
}

export function getShiftStatusLabel(item) {
    const label = String(item?.status || item?.state || 'Pendiente').trim();
    const normalized = label.toLowerCase();
    const labelMap = {
        scheduled: 'Programado',
        pending: 'Pendiente',
        active: 'Activo',
        in_progress: 'En progreso',
        'in-progress': 'En progreso',
        completed: 'Finalizado',
        finished: 'Finalizado',
        finalized: 'Finalizado',
        cancelled: 'Cancelado',
        canceled: 'Cancelado',
        rejected: 'Rechazado',
    };

    return labelMap[normalized] || label || 'Pendiente';
}

export function isShiftEndedEarly(item) {
    const rawValue = item?.ended_early;

    if (typeof rawValue === 'boolean') {
        return rawValue;
    }

    if (typeof rawValue === 'number') {
        return rawValue > 0;
    }

    const normalized = String(rawValue || '')
        .trim()
        .toLowerCase();
    return ['1', 'true', 'yes', 'si', 'sí'].includes(normalized);
}

export function sumHours(items) {
    return items.reduce((total, item) => {
        return total + getScheduledHours(item);
    }, 0);
}

export function sumWorkedHours(items) {
    return items.reduce((total, item) => {
        return total + getWorkedHours(item);
    }, 0);
}

export function countEndedEarlyShifts(items) {
    return items.reduce((total, item) => total + (isShiftEndedEarly(item) ? 1 : 0), 0);
}

export function summarizeShiftStatuses(items) {
    const counts = new Map();

    items.forEach((item) => {
        const label = getShiftStatusLabel(item);
        counts.set(label, (counts.get(label) || 0) + 1);
    });

    return Array.from(counts.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'es'));
}
