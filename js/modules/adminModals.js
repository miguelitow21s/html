// @ts-nocheck
import { CACHE_TTLS } from '../constants.js';
import { apiClient } from '../api.js';
import {
    asArray, escapeHtml, getRestaurantRecordId,
    formatShiftRange,
    getShiftStatusLabel,
    normalizeLinkedPhoneValue,
    pickMeaningfulRestaurantName,
    getShiftEmployeeName, getShiftRestaurantName,
    getTodayEnd, getTodayStart, normalizeAreaToken, toIsoDate
} from '../utils.js';

export const adminModalMethods = {
    prepareAdminRestaurantModal() {
        const form = document.getElementById('admin-restaurant-form');
        form?.reset();

        const radiusInput = document.getElementById('admin-restaurant-radius');
        const queryInput = document.getElementById('admin-restaurant-address-query');

        if (radiusInput) {
            radiusInput.value = '100';
        }

        if (queryInput) {
            queryInput.value = '';
        }

        this.restaurantSearchResults = [];
        this.restaurantSelectedResultIndex = -1;
        this.restaurantLocationDraft = null;
        if (this.restaurantMapMarker?.setMap) {
            this.restaurantMapMarker.setMap(null);
            this.restaurantMapMarker = null;
        }
        if (this.restaurantMap) {
            this.restaurantMap.setCenter({ lat: 39.8283, lng: -98.5795 });
            this.restaurantMap.setZoom(4);
        }
        this.renderAdminRestaurantSearchResults();
        this.setAdminRestaurantSearchFeedback('');
        this.updateAdminRestaurantLocationSummary();
    },

    async useCurrentAdminRestaurantLocation() {
        const button = document.getElementById('admin-restaurant-current-location-btn');
        const defaultButtonHtml = button?.innerHTML;

        await this.ensureAdminRestaurantMapReady();

        if (!navigator.geolocation) {
            this.setAdminRestaurantSearchFeedback('Este navegador no permite usar tu ubicación actual.', 'error');
            return;
        }

        if (this.restaurantGeocodeAbortController) {
            this.restaurantGeocodeAbortController.abort();
            this.restaurantGeocodeAbortController = null;
        }

        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Ubicando...';
        }

        this.setAdminRestaurantSearchFeedback('Tomando tu ubicación actual y ubicándola en el mapa...', 'info');

        try {
            const position = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0
                });
            });

            this.restaurantSearchResults = [];
            this.restaurantSelectedResultIndex = -1;
            this.renderAdminRestaurantSearchResults();

            await this.setAdminRestaurantLocationFromCoordinates(
                position.coords.latitude,
                position.coords.longitude,
                { reverseLookup: true, preserveQuery: false }
            );

            const roundedAccuracy = Number.isFinite(position.coords.accuracy)
                ? Math.round(position.coords.accuracy)
                : null;
            const accuracyCopy = roundedAccuracy
                ? ` Precisión aproximada: ${roundedAccuracy} m.`
                : '';

            this.setAdminRestaurantSearchFeedback(
                `Se tomó tu ubicación actual. Revisa el punto exacto en el mapa antes de guardar.${accuracyCopy}`,
                'info'
            );
        } catch (error) {
            console.warn('No fue posible usar la ubicación actual para el restaurante.', error);
            this.setAdminRestaurantSearchFeedback(this.getGeolocationMessage(error), 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = defaultButtonHtml || '<i class="fas fa-location-crosshairs"></i> Usar ubicación actual';
            }
        }
    },

    async ensureAdminRestaurantMapReady() {
        const container = document.getElementById('admin-restaurant-map');
        if (!container) {
            return;
        }

        try {
            await this.ensureGoogleMapsLibrary();
        } catch (error) {
            console.warn('No fue posible cargar Google Maps.', error);
            this.setAdminRestaurantSearchFeedback('No fue posible cargar el mapa en este momento. Intenta recargar la página.', 'error');
            return;
        }

        if (!this.restaurantMap) {
            this.restaurantMap = new window.google.maps.Map(container, {
                center: { lat: 39.8283, lng: -98.5795 },
                zoom: 4,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: false,
                gestureHandling: 'greedy'
            });
            this.restaurantGeocoder = new window.google.maps.Geocoder();
            this.restaurantAutocompleteService = new window.google.maps.places.AutocompleteService();

            this.restaurantMap.addListener('click', (event) => {
                const clickedLat = typeof event?.latLng?.lat === 'function' ? event.latLng.lat() : Number.NaN;
                const clickedLng = typeof event?.latLng?.lng === 'function' ? event.latLng.lng() : Number.NaN;
                void this.setAdminRestaurantLocationFromCoordinates(
                    clickedLat,
                    clickedLng,
                    { reverseLookup: true, preserveQuery: false }
                );
            });
        }

        window.setTimeout(() => {
            if (this.restaurantLocationDraft?.lat && this.restaurantLocationDraft?.lng) {
                this.setAdminRestaurantMapMarker(this.restaurantLocationDraft.lat, this.restaurantLocationDraft.lng);
                return;
            }

            this.restaurantMap?.setCenter({ lat: 39.8283, lng: -98.5795 });
            this.restaurantMap?.setZoom(4);
        }, 0);
    },

    setAdminRestaurantSearchFeedback(message = '', tone = 'info') {
        const feedback = document.getElementById('admin-restaurant-search-feedback');
        if (!feedback) {
            return;
        }

        feedback.textContent = message;
        feedback.classList.toggle('hidden', !message);
        feedback.style.background = tone === 'error'
            ? 'rgba(239, 68, 68, 0.12)'
            : 'rgba(14, 165, 233, 0.12)';
        feedback.style.borderColor = tone === 'error'
            ? 'rgba(239, 68, 68, 0.28)'
            : 'rgba(14, 165, 233, 0.28)';
        feedback.style.color = tone === 'error' ? '#fecaca' : '#e0f2fe';
    },

    getGoogleMapsApiKey() {
        return String(window.WORKTRACE_CONFIG?.googleMapsApiKey || '').trim();
    },

    async ensureGoogleMapsLibrary() {
        if (window.google?.maps?.Map && window.google?.maps?.Geocoder && window.google?.maps?.places?.AutocompleteService) {
            return window.google.maps;
        }

        if (this.googleMapsPromise) {
            return this.googleMapsPromise;
        }

        const apiKey = this.getGoogleMapsApiKey();
        if (!apiKey) {
            throw new Error('Google Maps API key is missing.');
        }

        this.googleMapsPromise = new Promise((resolve, reject) => {
            const existingScript = document.getElementById('worktrace-google-maps-script');
            const callbackName = '__worktraceGoogleMapsReady';

            const cleanup = () => {
                try {
                    delete window[callbackName];
                } catch (error) {
                    window[callbackName] = undefined;
                }
            };

            window[callbackName] = () => {
                cleanup();
                resolve(window.google.maps);
            };

            if (existingScript) {
                existingScript.addEventListener('error', () => {
                    cleanup();
                    this.googleMapsPromise = null;
                    reject(new Error('No fue posible cargar Google Maps.'));
                }, { once: true });
                return;
            }

            const script = document.createElement('script');
            script.id = 'worktrace-google-maps-script';
            script.async = true;
            script.defer = true;
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&language=es&v=weekly&callback=${callbackName}`;
            script.onerror = () => {
                cleanup();
                this.googleMapsPromise = null;
                reject(new Error('No fue posible cargar Google Maps.'));
            };

            document.head.appendChild(script);
        });

        return this.googleMapsPromise;
    },

    getGoogleAddressComponent(components = [], type, key = 'long_name') {
        return asArray(components).find((component) => asArray(component?.types).includes(type))?.[key] || '';
    },

    normalizeGoogleAddressLocation(result = {}) {
        if (!result) {
            return null;
        }

        if (Number.isFinite(result?.lat) && Number.isFinite(result?.lng) && (result?.display_name || result?.address_line)) {
            return {
                display_name: result.display_name || result.address_line || '',
                address_line: result.address_line || result.display_name || '',
                city: result.city || '',
                state: result.state || '',
                country: result.country || '',
                postcode: result.postcode || '',
                lat: Number(result.lat),
                lng: Number(result.lng),
                summary: result.summary || '',
                detail_line: result.detail_line || '',
                place_id: result.place_id || ''
            };
        }

        const geometryLocation = result?.geometry?.location;
        const lat = typeof geometryLocation?.lat === 'function'
            ? Number(geometryLocation.lat())
            : Number(result?.lat);
        const lng = typeof geometryLocation?.lng === 'function'
            ? Number(geometryLocation.lng())
            : Number(result?.lng);
        const streetNumber = this.getGoogleAddressComponent(result.address_components, 'street_number');
        const route = this.getGoogleAddressComponent(result.address_components, 'route');
        const premise = this.getGoogleAddressComponent(result.address_components, 'premise')
            || this.getGoogleAddressComponent(result.address_components, 'establishment')
            || this.getGoogleAddressComponent(result.address_components, 'subpremise');
        const addressLine = [streetNumber, route].filter(Boolean).join(' ').trim()
            || premise
            || result?.formatted_address
            || result?.display_name
            || 'Dirección sin identificar';
        const city = this.getGoogleAddressComponent(result.address_components, 'locality')
            || this.getGoogleAddressComponent(result.address_components, 'postal_town')
            || this.getGoogleAddressComponent(result.address_components, 'administrative_area_level_2')
            || this.getGoogleAddressComponent(result.address_components, 'sublocality')
            || '';
        const state = this.getGoogleAddressComponent(result.address_components, 'administrative_area_level_1');
        const country = this.getGoogleAddressComponent(result.address_components, 'country');
        const postcode = this.getGoogleAddressComponent(result.address_components, 'postal_code');

        return {
            display_name: result?.formatted_address || result?.display_name || addressLine,
            address_line: addressLine,
            city,
            state,
            country,
            postcode,
            lat,
            lng,
            summary: [city, state, postcode, country].filter(Boolean).join(', '),
            detail_line: '',
            place_id: result?.place_id || ''
        };
    },

    normalizeAdminRestaurantAutocompletePrediction(prediction = {}) {
        const title = String(prediction?.description || prediction?.structured_formatting?.main_text || '').trim();
        const detailLine = String(prediction?.structured_formatting?.secondary_text || '').trim();

        return {
            display_name: title || 'Ubicación encontrada',
            address_line: title || 'Ubicación encontrada',
            city: '',
            state: '',
            country: '',
            postcode: '',
            lat: Number.NaN,
            lng: Number.NaN,
            summary: detailLine,
            detail_line: detailLine,
            place_id: prediction?.place_id || ''
        };
    },

    geocodeAdminRestaurantPlaceId(placeId, signal) {
        if (!this.restaurantGeocoder || !placeId) {
            return Promise.resolve(null);
        }

        return new Promise((resolve, reject) => {
            this.restaurantGeocoder.geocode({ placeId }, (results, status) => {
                if (signal?.aborted) {
                    resolve(null);
                    return;
                }

                if (status === 'OK' && Array.isArray(results) && results[0]) {
                    resolve(this.normalizeGoogleAddressLocation(results[0]));
                    return;
                }

                if (status === 'ZERO_RESULTS') {
                    resolve(null);
                    return;
                }

                reject(new Error(`No fue posible resolver la dirección seleccionada (${status}).`));
            });
        });
    },

    geocodeAdminRestaurantAddress(address, signal) {
        if (!this.restaurantGeocoder || !address) {
            return Promise.resolve([]);
        }

        return new Promise((resolve, reject) => {
            this.restaurantGeocoder.geocode({ address }, (results, status) => {
                if (signal?.aborted) {
                    resolve([]);
                    return;
                }

                if (status === 'OK' && Array.isArray(results)) {
                    resolve(results.map((item) => this.normalizeGoogleAddressLocation(item)).filter(Boolean));
                    return;
                }

                if (status === 'ZERO_RESULTS') {
                    resolve([]);
                    return;
                }

                reject(new Error(`No fue posible buscar la dirección (${status}).`));
            });
        });
    },

    reverseGeocodeAdminRestaurantCoordinates(lat, lng, signal) {
        if (!this.restaurantGeocoder || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            return Promise.resolve(null);
        }

        return new Promise((resolve, reject) => {
            this.restaurantGeocoder.geocode({ location: { lat, lng } }, (results, status) => {
                if (signal?.aborted) {
                    resolve(null);
                    return;
                }

                if (status === 'OK' && Array.isArray(results) && results[0]) {
                    resolve(this.normalizeGoogleAddressLocation(results[0]));
                    return;
                }

                if (status === 'ZERO_RESULTS') {
                    resolve(null);
                    return;
                }

                reject(new Error(`No fue posible resolver la ubicación en el mapa (${status}).`));
            });
        });
    },

    getAdminRestaurantResultTitle(result = {}) {
        return result.display_name || result.address_line || 'Ubicación encontrada';
    },

    getAdminRestaurantResultMeta(result = {}) {
        return [result.city, result.state, result.country]
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .filter((value, index, values) => values.indexOf(value) === index);
    },

    getAdminRestaurantResultDetail(result = {}) {
        const detailLine = String(result.detail_line || '').trim();
        if (detailLine) {
            return detailLine;
        }

        const addressLine = String(result.address_line || '').trim();
        const title = String(this.getAdminRestaurantResultTitle(result) || '').trim();
        if (!addressLine || addressLine === title) {
            return '';
        }

        return addressLine;
    },

    normalizeAdminRestaurantSearchText(value = '') {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    },

    buildAdminRestaurantSearchQueries(query = '') {
        const baseQuery = String(query || '').trim().replace(/\s+/g, ' ');
        if (!baseQuery) {
            return [];
        }

        const variants = [
            baseQuery,
            baseQuery.replace(/\s*#\s*/g, ' No '),
            baseQuery.replace(/\s*#\s*/g, ' '),
            baseQuery.replace(/[#,]/g, ' ').replace(/\s+/g, ' ').trim()
        ];

        return variants.filter((value, index, values) => value && values.indexOf(value) === index);
    },

    scoreAdminRestaurantSearchResult(result = {}, originalQuery = '') {
        const normalizedQuery = this.normalizeAdminRestaurantSearchText(originalQuery);
        const haystack = this.normalizeAdminRestaurantSearchText([
            result.display_name,
            result.address_line,
            result.city,
            result.state,
            result.country,
            result.postcode
        ].filter(Boolean).join(' '));

        if (!normalizedQuery || !haystack) {
            return 0;
        }

        const tokens = normalizedQuery.split(' ').filter((token) => token.length > 0);
        let score = 0;

        tokens.forEach((token) => {
            if (haystack.includes(token)) {
                score += /^\d+$/.test(token) ? 4 : 2;
            }
        });

        if (haystack.includes(normalizedQuery)) {
            score += 10;
        }

        if (String(result.address_line || '').trim()) {
            score += 2;
        }

        return score;
    },

    mergeAdminRestaurantSearchResults(items = [], originalQuery = '') {
        const seen = new Map();

        asArray(items).forEach((item) => {
            const key = [
                Number.isFinite(item?.lat) ? Number(item.lat).toFixed(6) : '',
                Number.isFinite(item?.lng) ? Number(item.lng).toFixed(6) : '',
                String(item?.display_name || '').trim()
            ].join('|');

            if (!seen.has(key)) {
                seen.set(key, item);
            }
        });

        return Array.from(seen.values())
            .map((item) => ({
                ...item,
                __searchScore: this.scoreAdminRestaurantSearchResult(item, originalQuery)
            }))
            .sort((left, right) => {
                if ((right.__searchScore || 0) !== (left.__searchScore || 0)) {
                    return (right.__searchScore || 0) - (left.__searchScore || 0);
                }

                const leftTitle = this.getAdminRestaurantResultTitle(left);
                const rightTitle = this.getAdminRestaurantResultTitle(right);
                return String(leftTitle).localeCompare(String(rightTitle), 'es', { sensitivity: 'base' });
            })
            .map(({ __searchScore, ...item }) => item)
            .slice(0, 5);
    },

    renderAdminRestaurantSearchResults() {
        const container = document.getElementById('admin-restaurant-search-results');
        if (!container) {
            return;
        }

        if (!this.restaurantSearchResults.length) {
            container.innerHTML = '';
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');

        const fragment = document.createDocumentFragment();
        this.restaurantSearchResults.forEach((result, index) => {
            const title = this.getAdminRestaurantResultTitle(result);
            const meta = this.getAdminRestaurantResultMeta(result);
            const detail = this.getAdminRestaurantResultDetail(result);
            const postcode = String(result.postcode || '').trim();

            const button = document.createElement('button');
            button.type = 'button';
            button.className = `restaurant-search-result ${index === this.restaurantSelectedResultIndex ? 'active' : ''}`.trim();
            button.dataset.action = 'select-admin-restaurant-search-result';
            button.dataset.resultIndex = String(index);

            const titleNode = document.createElement('strong');
            titleNode.textContent = title;
            button.appendChild(titleNode);

            if (meta.length > 0 || postcode) {
                const metaWrap = document.createElement('div');
                metaWrap.className = 'restaurant-search-result-meta';
                meta.forEach((item) => {
                    const chip = document.createElement('span');
                    chip.className = 'restaurant-search-result-chip';
                    chip.textContent = item;
                    metaWrap.appendChild(chip);
                });

                if (postcode) {
                    const postcodeChip = document.createElement('span');
                    postcodeChip.className = 'restaurant-search-result-chip restaurant-search-result-chip-muted';
                    postcodeChip.textContent = postcode;
                    metaWrap.appendChild(postcodeChip);
                }

                button.appendChild(metaWrap);
            }

            if (detail) {
                const detailNode = document.createElement('small');
                detailNode.textContent = detail;
                button.appendChild(detailNode);
            }

            fragment.appendChild(button);
        });

        container.replaceChildren(fragment);
    },

    clearAdminRestaurantSelectedLocation(options = {}) {
        const {
            removeMarker = true
        } = options;

        this.restaurantLocationDraft = null;
        this.updateAdminRestaurantHiddenLocationFields();
        this.updateAdminRestaurantLocationSummary();

        if (removeMarker && this.restaurantMapMarker?.setMap) {
            this.restaurantMapMarker.setMap(null);
            this.restaurantMapMarker = null;
        }
    },

    focusAdminRestaurantSearchResultsOnMap() {
        if (!window.google?.maps?.LatLngBounds || !this.restaurantMap || this.restaurantSearchResults.length === 0) {
            return;
        }

        const points = this.restaurantSearchResults
            .filter((item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lng))
            .map((item) => ({ lat: item.lat, lng: item.lng }));

        if (points.length === 0) {
            return;
        }

        if (points.length === 1) {
            this.restaurantMap.setCenter(points[0]);
            this.restaurantMap.setZoom(17);
            return;
        }

        const bounds = new window.google.maps.LatLngBounds();
        points.forEach((point) => bounds.extend(point));
        this.restaurantMap.fitBounds(bounds, 28);
    },

    normalizeAdminRestaurantGeocodeResult(result = {}) {
        return this.normalizeGoogleAddressLocation(result) || null;
    },

    async searchAdminRestaurantLocation() {
        const query = document.getElementById('admin-restaurant-address-query')?.value?.trim();
        if (!query) {
            this.setAdminRestaurantSearchFeedback('Escribe una dirección completa antes de buscar.', 'error');
            return;
        }

        if (this.restaurantGeocodeAbortController) {
            this.restaurantGeocodeAbortController.abort();
        }

        const controller = new AbortController();
        this.restaurantGeocodeAbortController = controller;
        this.setAdminRestaurantSearchFeedback('Buscando ubicaciones cercanas a esa dirección...', 'info');

        try {
            await this.ensureAdminRestaurantMapReady();

            const maps = window.google?.maps;
            if (!maps || !this.restaurantAutocompleteService) {
                throw new Error('Google Maps no está disponible.');
            }

            const predictions = await new Promise((resolve, reject) => {
                this.restaurantAutocompleteService.getPlacePredictions(
                    {
                        input: query,
                        types: ['address']
                    },
                    (items, status) => {
                        if (controller.signal.aborted) {
                            resolve([]);
                            return;
                        }

                        if (status === maps.places.PlacesServiceStatus.OK && Array.isArray(items)) {
                            resolve(items);
                            return;
                        }

                        if (status === maps.places.PlacesServiceStatus.ZERO_RESULTS) {
                            resolve([]);
                            return;
                        }

                        reject(new Error(`No fue posible buscar la dirección (${status}).`));
                    }
                );
            });

            if (controller.signal.aborted) {
                return;
            }

            if (Array.isArray(predictions) && predictions.length > 0) {
                this.restaurantSearchResults = predictions
                    .slice(0, 5)
                    .map((item) => this.normalizeAdminRestaurantAutocompletePrediction(item))
                    .filter(Boolean);
            } else {
                this.restaurantSearchResults = await this.geocodeAdminRestaurantAddress(query, controller.signal);
            }

            if (!this.restaurantSearchResults.length) {
                this.restaurantSelectedResultIndex = -1;
                this.clearAdminRestaurantSelectedLocation();
                this.renderAdminRestaurantSearchResults();
                this.setAdminRestaurantSearchFeedback('No encontramos coincidencias. Prueba con calle, número, ciudad, estado y país.', 'error');
                return;
            }

            this.restaurantSelectedResultIndex = -1;
            this.clearAdminRestaurantSelectedLocation();
            this.renderAdminRestaurantSearchResults();
            this.focusAdminRestaurantSearchResultsOnMap();
            this.setAdminRestaurantSearchFeedback('Elige una dirección de la lista para continuar.', 'info');
        } catch (error) {
            if (error.name === 'AbortError') {
                return;
            }

            console.warn('No fue posible buscar la dirección del restaurante.', error);
            this.restaurantSearchResults = [];
            this.restaurantSelectedResultIndex = -1;
            this.renderAdminRestaurantSearchResults();
            this.setAdminRestaurantSearchFeedback('No fue posible buscar la dirección en el mapa en este momento.', 'error');
        } finally {
            if (this.restaurantGeocodeAbortController === controller) {
                this.restaurantGeocodeAbortController = null;
            }
        }
    },

    selectAdminRestaurantSearchResult(index) {
        const result = this.restaurantSearchResults[index];
        if (!result) {
            return;
        }

        if (this.restaurantGeocodeAbortController) {
            this.restaurantGeocodeAbortController.abort();
            this.restaurantGeocodeAbortController = null;
        }

        const controller = new AbortController();
        this.restaurantGeocodeAbortController = controller;
        this.restaurantSelectedResultIndex = index;
        this.renderAdminRestaurantSearchResults();
        this.setAdminRestaurantSearchFeedback('Cargando ubicación seleccionada...', 'info');

        void (async () => {
            try {
                const resolvedLocation = result.place_id
                    ? await this.geocodeAdminRestaurantPlaceId(result.place_id, controller.signal)
                    : result;

                if (controller.signal.aborted || !resolvedLocation) {
                    return;
                }

                this.applyAdminRestaurantLocation(resolvedLocation, { preserveQuery: false });
                this.setAdminRestaurantSearchFeedback('Ubicación seleccionada.', 'info');
            } catch (error) {
                if (controller.signal.aborted) {
                    return;
                }

                console.warn('No fue posible seleccionar la dirección del restaurante.', error);
                this.setAdminRestaurantSearchFeedback('No fue posible cargar esa dirección. Intenta con otra opción.', 'error');
            } finally {
                if (this.restaurantGeocodeAbortController === controller) {
                    this.restaurantGeocodeAbortController = null;
                }
            }
        })();
    },

    applyAdminRestaurantLocation(location, options = {}) {
        if (!location) {
            return;
        }

        const {
            preserveQuery = false
        } = options;

        this.restaurantLocationDraft = {
            address_line: location.address_line || '',
            city: location.city || '',
            state: location.state || '',
            country: location.country || '',
            lat: Number(location.lat),
            lng: Number(location.lng),
            display_name: location.display_name || location.address_line || '',
            postcode: location.postcode || ''
        };

        if (!preserveQuery) {
            const queryInput = document.getElementById('admin-restaurant-address-query');
            if (queryInput) {
                queryInput.value = this.restaurantLocationDraft.display_name || '';
            }
        }

        this.updateAdminRestaurantHiddenLocationFields();
        this.updateAdminRestaurantLocationSummary();
        this.setAdminRestaurantMapMarker(this.restaurantLocationDraft.lat, this.restaurantLocationDraft.lng);
    },

    updateAdminRestaurantHiddenLocationFields() {
        const location = this.restaurantLocationDraft || {};
        const setValue = (id, value = '') => {
            const element = document.getElementById(id);
            if (element) {
                element.value = value;
            }
        };

        setValue('admin-restaurant-address', location.address_line || '');
        setValue('admin-restaurant-city', location.city || '');
        setValue('admin-restaurant-state', location.state || '');
        setValue('admin-restaurant-country', location.country || '');
        setValue('admin-restaurant-lat', Number.isFinite(location.lat) ? String(location.lat) : '');
        setValue('admin-restaurant-lng', Number.isFinite(location.lng) ? String(location.lng) : '');
    },

    updateAdminRestaurantLocationSummary() {
        const location = this.restaurantLocationDraft;
        const badge = document.getElementById('admin-restaurant-map-badge');

        if (badge) {
            const ready = Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
            badge.textContent = ready ? 'Verificado' : 'Pendiente';
            badge.classList.toggle('ready', ready);
        }
    },

    setAdminRestaurantMapMarker(lat, lng) {
        if (!window.google?.maps?.Marker || !this.restaurantMap || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            return;
        }

        if (!this.restaurantMapMarker) {
            this.restaurantMapMarker = new window.google.maps.Marker({
                position: { lat, lng },
                map: this.restaurantMap,
                draggable: true
            });

            this.restaurantMapMarker.addListener('dragend', () => {
                const markerPosition = this.restaurantMapMarker.getPosition();
                void this.setAdminRestaurantLocationFromCoordinates(
                    typeof markerPosition?.lat === 'function' ? markerPosition.lat() : Number.NaN,
                    typeof markerPosition?.lng === 'function' ? markerPosition.lng() : Number.NaN,
                    { reverseLookup: true, preserveQuery: false }
                );
            });
        } else {
            this.restaurantMapMarker.setPosition({ lat, lng });
            this.restaurantMapMarker.setMap(this.restaurantMap);
        }

        this.restaurantMap.setCenter({ lat, lng });
        this.restaurantMap.setZoom(17);
    },

    async setAdminRestaurantLocationFromCoordinates(lat, lng, options = {}) {
        const {
            reverseLookup = true,
            preserveQuery = false
        } = options;

        const nextLocation = {
            ...(this.restaurantLocationDraft || {}),
            lat,
            lng
        };

        if (reverseLookup) {
            try {
                const controller = this.restaurantGeocodeAbortController;
                const resolvedLocation = await this.reverseGeocodeAdminRestaurantCoordinates(lat, lng, controller?.signal);
                if (resolvedLocation) {
                    Object.assign(nextLocation, resolvedLocation);
                }
            } catch (error) {
                console.warn('No fue posible resolver la dirección desde el mapa.', error);
            }
        }

        if (!nextLocation.display_name) {
            nextLocation.display_name = 'Punto seleccionado en el mapa';
        }

        if (!nextLocation.address_line) {
            nextLocation.address_line = nextLocation.display_name;
        }

        this.applyAdminRestaurantLocation(nextLocation, { preserveQuery });
        return this.restaurantLocationDraft;
    },

    prepareAdminEmployeeModal() {
        const form = document.getElementById('admin-employee-form');
        form?.reset();
    },

    getKnownSupervisorEmployeeRecord(employeeId) {
        const normalizedEmployeeId = String(employeeId || '').trim();
        if (!normalizedEmployeeId) {
            return null;
        }

        return asArray(this.data.supervisor.employees).find((employee) => String(employee?.id || '').trim() === normalizedEmployeeId) || null;
    },

    getKnownSupervisorRestaurantRecord(restaurantId) {
        const normalizedRestaurantId = String(restaurantId || '').trim();
        if (!normalizedRestaurantId) {
            return null;
        }

        return asArray(this.data.supervisor.restaurants).find((restaurant) => (
            String(getRestaurantRecordId(restaurant) || '').trim() === normalizedRestaurantId
        )) || null;
    },

    getKnownAdminRestaurantRecord(restaurantId) {
        const normalizedRestaurantId = String(restaurantId || '').trim();
        if (!normalizedRestaurantId) {
            return null;
        }

        return asArray(this.data.admin.restaurants).find((restaurant) => (
            String(getRestaurantRecordId(restaurant) || '').trim() === normalizedRestaurantId
        )) || null;
    },

    getKnownAdminSupervisorRecord(supervisorId) {
        const normalizedSupervisorId = String(supervisorId || '').trim();
        if (!normalizedSupervisorId) {
            return null;
        }

        return asArray(this.data.admin.supervisors).find((supervisor) => (
            String(supervisor?.id || supervisor?.user_id || '').trim() === normalizedSupervisorId
        )) || null;
    },

    getPhoneBindingActionState(record) {
        const userId = String(record?.id || record?.user_id || record?.raw?.id || record?.raw?.user_id || '').trim();
        const phoneNumber = normalizeLinkedPhoneValue(
            record?.phone_e164
            || record?.phone_number
            || record?.raw?.phone_e164
            || record?.raw?.phone_number
            || record?.raw?.phone
        );

        return {
            userId,
            phoneNumber,
            enabled: Boolean(userId && phoneNumber),
            visible: Boolean(userId && phoneNumber)
        };
    },

    async clearPhoneBindingRecord(record, options = {}) {
        const {
            emptyMessage = 'No se pudo identificar el perfil seleccionado.',
            subjectLabel = 'perfil',
            refresh = null
        } = options;

        if (!record) {
            this.showToast(emptyMessage, {
                tone: 'warning',
                title: 'Perfil inválido'
            });
            return;
        }

        if (this.currentUser?.role !== 'super_admin') {
            this.showToast('Solo una cuenta super_admin puede remover el teléfono de un usuario.', {
                tone: 'warning',
                title: 'Permiso insuficiente'
            });
            return;
        }

        const { userId, phoneNumber, enabled } = this.getPhoneBindingActionState(record);
        if (!enabled) {
            this.showToast('El perfil seleccionado no tiene un teléfono removible en este momento.', {
                tone: 'warning',
                title: 'Sin teléfono vinculado'
            });
            return;
        }

        const displayName = String(record.full_name || record.email || subjectLabel).trim() || subjectLabel;
        const confirmed = window.confirm(`¿Seguro que deseas remover el teléfono ${phoneNumber} de ${displayName}? Luego podrás registrar un nuevo número para este perfil.`);
        if (!confirmed) {
            return;
        }

        this.showLoading('Removiendo teléfono...', 'Limpiando el teléfono del perfil seleccionado.');

        try {
            const result = await apiClient.adminUserPhoneRemove(userId);

            if (typeof refresh === 'function') {
                await refresh();
            }

            const legalConsent = result?.legal_consent || null;
            const consentStatus = legalConsent?.accepted
                ? 'Consentimiento legal vigente.'
                : 'Consentimiento legal pendiente.';
            this.showToast(`El teléfono de ${displayName} fue removido correctamente. ${consentStatus}`, {
                tone: 'success',
                title: 'Teléfono removido',
                duration: 5200
            });
        } catch (error) {
            this.showToast(this.getErrorMessage(error, 'No fue posible remover el teléfono de este perfil.'), {
                tone: 'error',
                title: 'No fue posible remover el teléfono'
            });
        } finally {
            this.hideLoading();
        }
    },

    async handleClearPhoneUser(userId) {
        const employee = this.getKnownSupervisorEmployeeRecord(userId);
        await this.clearPhoneBindingRecord(employee, {
            emptyMessage: 'No se pudo identificar el empleado seleccionado.',
            subjectLabel: 'empleado',
            refresh: async () => {
                this.invalidateCache('supervisorEmployees');
                await this.loadSupervisorEmployees(true);
            }
        });
    },

    async handleClearPhoneSupervisor(supervisorId) {
        const supervisor = this.getKnownAdminSupervisorRecord(supervisorId);
        await this.clearPhoneBindingRecord(supervisor, {
            emptyMessage: 'No se pudo identificar la supervisora seleccionada.',
            subjectLabel: 'supervisora',
            refresh: async () => {
                this.invalidateCache('adminSupervisors');
                await this.loadAdminSupervisors(true);
            }
        });
    },

    getKnownEmployeeRestaurantRecord(restaurantId) {
        const normalizedRestaurantId = String(restaurantId || '').trim();
        if (!normalizedRestaurantId) {
            return null;
        }

        return this.resolveEmployeeRestaurantRecord(normalizedRestaurantId, this.data.employee.dashboard || {});
    },

    getKnownRestaurantRecord(restaurantId) {
        return this.getKnownEmployeeRestaurantRecord(restaurantId)
            || this.getKnownSupervisorRestaurantRecord(restaurantId)
            || this.getKnownAdminRestaurantRecord(restaurantId)
            || null;
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

        const scheduledShiftEmployee = this.data.currentScheduledShift?.employee || this.data.currentScheduledShift?.user || null;
        if (String(scheduledShiftEmployee?.id || '').trim() === normalizedEmployeeId) {
            return scheduledShiftEmployee;
        }

        return null;
    },

    getKnownEmployeeRecordByAlias(aliasCandidates = []) {
        const normalizedAliases = new Set(
            asArray(aliasCandidates)
                .map((value) => String(value || '').trim().toLowerCase())
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
                record.raw?.email
            ];

            return candidateValues.some((value) => normalizedAliases.has(String(value || '').trim().toLowerCase()));
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

        const scheduledShiftEmployee = this.data.currentScheduledShift?.employee || this.data.currentScheduledShift?.user || null;
        if (matchesAlias(scheduledShiftEmployee)) {
            return scheduledShiftEmployee;
        }

        return null;
    },

    getResolvedShiftEmployeeName(shift, fallback = 'Empleado') {
        const employeeId = shift?.employee_id || shift?.assigned_employee_id || shift?.employee?.id || shift?.user_id || '';
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
            shift?.user?.id
        ];
        const employeeRecord = this.getKnownEmployeeRecord(employeeId)
            || this.getKnownEmployeeRecordByAlias(employeeAliasCandidates)
            || null;

        return getShiftEmployeeName(shift, {
            employeeRecord
        }) || fallback;
    },

    getResolvedShiftRestaurantName(shift, fallback = 'Restaurante') {
        const restaurantId = shift?.restaurant_id
            || shift?.restaurant?.restaurant_id
            || shift?.restaurant?.id
            || shift?.location_id
            || shift?.location?.id
            || shift?.site_id
            || shift?.site?.id
            || '';
        return getShiftRestaurantName(shift, {
            restaurantRecord: this.getKnownRestaurantRecord(restaurantId)
        }) || fallback;
    },

    getSupervisorShiftSelectionKey(shift) {
        if (!shift) {
            return '';
        }

        return String(
            shift?.id
            || shift?.scheduled_shift_id
            || `${shift?.employee_id || shift?.assigned_employee_id || 'employee'}__${shift?.restaurant_id || shift?.restaurant?.id || 'restaurant'}__${shift?.scheduled_start || shift?.start_time || shift?.created_at || 'shift'}`
        ).trim();
    },

    getSupervisorSelectedRestaurant() {
        const selectedRestaurantId = document.getElementById('supervision-restaurant-select')?.value;
        const restaurants = this.data.supervisor.restaurants || [];
        return restaurants.find((restaurant) => String(getRestaurantRecordId(restaurant)) === String(selectedRestaurantId))
            || restaurants[0]
            || null;
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
                    shift?.restaurant_id
                    || shift?.restaurant?.restaurant_id
                    || shift?.restaurant?.id
                    || shift?.location_id
                    || shift?.location?.id
                    || shift?.site_id
                    || shift?.site?.id
                    || ''
                );
                return shiftRestaurantId === restaurantId;
            })
            .sort((left, right) => {
                const leftTime = new Date(left?.scheduled_start || left?.start_time || left?.created_at || '').getTime();
                const rightTime = new Date(right?.scheduled_start || right?.start_time || right?.created_at || '').getTime();
                return (Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER)
                    - (Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER);
            });
    },

    getShiftReferenceDate(shift) {
        const value = shift?.scheduled_start
            || shift?.start_time
            || shift?.scheduled_end
            || shift?.end_time
            || null;

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

    buildSupervisorShiftOptionLabel(shift) {
        const employeeName = this.getResolvedShiftEmployeeName(shift, 'Empleado sin nombre');
        const scheduleText = formatShiftRange(shift?.scheduled_start, shift?.scheduled_end);
        const statusText = getShiftStatusLabel(shift);
        return `${employeeName} • ${scheduleText} • ${statusText}`;
    },

    populateSupervisorShiftOptions() {
        const select = document.getElementById('supervision-shift-select');
        if (!select) {
            return;
        }

        const restaurant = this.getSupervisorSelectedRestaurant();
        const shifts = this.getSupervisorRestaurantShifts();

        if (!restaurant) {
            this.selectedSupervisorShiftId = '';
            select.disabled = true;
            select.innerHTML = '<option value="">Selecciona primero un restaurante</option>';
            return;
        }

        if (shifts.length === 0) {
            this.selectedSupervisorShiftId = '';
            select.disabled = true;
            select.innerHTML = '<option value="">No hay turnos hoy en este restaurante</option>';
            return;
        }

        const availableKeys = new Set(shifts.map((shift) => this.getSupervisorShiftSelectionKey(shift)));
        if (!availableKeys.has(this.selectedSupervisorShiftId)) {
            this.selectedSupervisorShiftId = this.getSupervisorShiftSelectionKey(shifts[0]);
        }

        select.disabled = false;
        select.innerHTML = shifts.map((shift) => {
            const shiftKey = this.getSupervisorShiftSelectionKey(shift);
            return `
                <option value="${escapeHtml(shiftKey)}" ${shiftKey === this.selectedSupervisorShiftId ? 'selected' : ''}>
                    ${escapeHtml(this.buildSupervisorShiftOptionLabel(shift))}
                </option>
            `;
        }).join('');
    },

    setSupervisorSelectedShift(shiftId = '') {
        this.selectedSupervisorShiftId = String(shiftId || '').trim();
        const select = document.getElementById('supervision-shift-select');
        if (select && select.value !== this.selectedSupervisorShiftId) {
            select.value = this.selectedSupervisorShiftId;
        }
        this.renderSupervisorSupervisionSummary();
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

    async getSupervisorRestaurants(force = false) {
        if (
            !force
            && this.data.supervisor.restaurants.length > 0
            && this.isCacheFresh('supervisorRestaurants', CACHE_TTLS.supervisorRestaurants)
        ) {
            return this.data.supervisor.restaurants;
        }

        return this.runPending(`supervisorRestaurants:${this.currentUser?.role || 'unknown'}:${force ? 'force' : 'default'}`, async () => {
            let restaurants = [];
            const mapRestaurantList = (result) => asArray(result).map((item) => ({
                ...item,
                id: getRestaurantRecordId(item),
                restaurant_id: getRestaurantRecordId(item),
                is_active: item.is_active !== false,
                name: pickMeaningfulRestaurantName([
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
                    item.restaurant?.title
                ], item) || '',
                address_line: item.address_line || item.restaurant?.address_line,
                city: item.city || item.restaurant?.city,
                state: item.state || item.restaurant?.state,
                country: item.country || item.restaurant?.country,
                cleaning_areas: item.cleaning_areas || item.restaurant?.cleaning_areas,
                effective_cleaning_areas: item.effective_cleaning_areas || item.restaurant?.effective_cleaning_areas || item.cleaning_areas || item.restaurant?.cleaning_areas,
                raw: item
            })).filter((item) => item.is_active !== false && getRestaurantRecordId(item) != null);

            if (this.currentUser.role === 'super_admin' || this.currentUser.role === 'superuser') {
                const result = await apiClient.adminRestaurantsManage('list', {
                    is_active: true,
                    limit: 200
                });
                restaurants = mapRestaurantList(result);
            } else {
                try {
                    const result = await apiClient.adminRestaurantsManage('list', {
                        is_active: true,
                        limit: 200
                    });
                    restaurants = mapRestaurantList(result);
                } catch (error) {
                    console.warn('No fue posible cargar todos los restaurantes para supervisora. Se usará el listado disponible como respaldo.', error);
                    const assignments = await apiClient.restaurantStaffManage('list_my_restaurants');
                    const items = asArray(assignments);

                    restaurants = items.map((item) => ({
                        id: getRestaurantRecordId(item),
                        restaurant_id: getRestaurantRecordId(item),
                        name: pickMeaningfulRestaurantName([
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
                            item.restaurant?.title
                        ], item) || '',
                        address_line: item.restaurant?.address_line || item.address_line,
                        city: item.restaurant?.city || item.city,
                        state: item.restaurant?.state || item.state,
                        country: item.restaurant?.country || item.country,
                        is_active: item.is_active !== false && item.restaurant?.is_active !== false,
                        cleaning_areas: item.restaurant?.cleaning_areas || item.cleaning_areas,
                        effective_cleaning_areas: item.restaurant?.effective_cleaning_areas || item.effective_cleaning_areas || item.restaurant?.cleaning_areas || item.cleaning_areas,
                        assigned_at: item.assigned_at,
                        raw: item
                    })).filter((item) => item.is_active !== false && getRestaurantRecordId(item) != null);
                }
            }

            this.data.supervisor.restaurants = restaurants;
            this.touchCache('supervisorRestaurants');
            return restaurants;
        });
    },

    async getSupervisorShiftList(options = {}) {
        const todayStart = getTodayStart();
        const todayEnd = getTodayEnd();
        const defaultFrom = toIsoDate(new Date(todayStart.getTime() - (12 * 60 * 60 * 1000)));
        const defaultTo = toIsoDate(new Date(todayEnd.getTime() + (12 * 60 * 60 * 1000)));

        const {
            forceRestaurants = false,
            restaurantId,
            from = defaultFrom,
            to = defaultTo,
            status,
            employeeId,
            limit = 100
        } = options;

        const usesDefaultQuery = !restaurantId && !status && !employeeId
            && from === defaultFrom
            && to === defaultTo
            && limit === 100;

        if (
            !forceRestaurants
            && usesDefaultQuery
            && this.data.supervisor.shifts.length > 0
            && this.isCacheFresh('supervisorShifts', CACHE_TTLS.supervisorShifts)
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
                    const shiftStatus = String(shift?.status || shift?.state || '').trim().toLowerCase();
                    return !['cancelado', 'cancelled', 'anulado', 'deleted'].includes(shiftStatus);
                });

                const normalizedShifts = usesDefaultQuery
                    ? this.getTodayShifts(shifts)
                    : shifts;

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

            const grouped = await Promise.all(restaurants.map(async (restaurant) => {
                try {
                    const result = await apiClient.scheduledShiftsManage('list', {
                        ...payload,
                        restaurant_id: getRestaurantRecordId(restaurant)
                    });
                    return asArray(result);
                } catch (error) {
                    console.warn(`No fue posible listar turnos para ${restaurant.name || restaurant.id}.`, error);
                    return [];
                }
            }));

            const dedupe = new Map();
            grouped.flat().forEach((shift) => {
                const key = shift.id || shift.scheduled_shift_id || `${shift.employee_id}-${shift.scheduled_start}-${shift.restaurant_id}`;
                dedupe.set(key, shift);
            });
            const shifts = Array.from(dedupe.values()).filter((shift) => {
                const shiftStatus = String(shift?.status || shift?.state || '').trim().toLowerCase();
                return !['cancelado', 'cancelled', 'anulado', 'deleted'].includes(shiftStatus);
            });

            const normalizedShifts = usesDefaultQuery
                ? this.getTodayShifts(shifts)
                : shifts;

            if (usesDefaultQuery) {
                this.data.supervisor.shifts = normalizedShifts;
                this.touchCache('supervisorShifts');
            }

            return normalizedShifts;
        };

        return this.runPending(requestKey, fetchShiftList);
    },
};
