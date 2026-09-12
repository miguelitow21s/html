// @ts-nocheck
/**
 * ============================================================================
 * modules/adminModals.js — Modales "pesados" de sitios y contratistas
 * ============================================================================
 *
 * QUÉ ES
 *   El modal de crear/editar sitio (con mapa y búsqueda de direcciones de
 *   Google Maps) y el de contratista. Está separado por peso: el contratista
 *   nunca lo carga. Lo cargan el inspector y el super_admin.
 *
 * ⚠ OJO — ORDEN DE CARGA
 *   Este archivo se mezcla en `app` DESPUÉS de supervisor.js (y de admin.js):
 *     inspector   → Object.assign(app, supervisorMethods, adminModalMethods)
 *     super_admin → Object.assign(app, supervisorMethods, adminMethods, adminModalMethods)
 *   Si aquí se define un método con el mismo nombre que uno de supervisor.js
 *   o app.js, para inspector y admin corre EL DE ESTE ARCHIVO y el otro queda
 *   muerto sin avisar. Aquí solo va lo de los modales; lo compartido vive
 *   en app.js (varios roles) o en supervisor.js (inspector y admin). Hubo ~20
 *   funciones repetidas que se unificaron.
 */

import { CACHE_TTLS } from '../constants.js';
import { apiClient } from '../api.js';
import {
    asArray,
    getTodayEnd,
    getTodayStart,
    normalizeAreaToken,
    toIsoDate,
} from '../utils.js';

export const adminModalMethods = {
    // ==========================================================================
    // SECCIÓN: Modal de sitio: ubicación con Google Maps
    // --------------------------------------------------------------------------
    // Buscar la dirección (autocompletado + geocoding), elegir un resultado,
    // mover el marcador en el mapa o "usar mi ubicación". Al final quedan lat,
    // lng y dirección en campos ocultos del formulario, que envía
    // submitAdminRestaurantForm (supervisor.js). La API key de Maps sale de
    // public/config.js (googleMapsApiKey).
    // ==========================================================================

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
                    maximumAge: 0,
                });
            });

            this.restaurantSearchResults = [];
            this.restaurantSelectedResultIndex = -1;
            this.renderAdminRestaurantSearchResults();

            await this.setAdminRestaurantLocationFromCoordinates(position.coords.latitude, position.coords.longitude, {
                reverseLookup: true,
                preserveQuery: false,
            });

            const roundedAccuracy = Number.isFinite(position.coords.accuracy)
                ? Math.round(position.coords.accuracy)
                : null;
            const accuracyCopy = roundedAccuracy ? ` Precisión aproximada: ${roundedAccuracy} m.` : '';

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
                button.innerHTML =
                    defaultButtonHtml || '<i class="fas fa-location-crosshairs"></i> Usar ubicación actual';
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
            this.setAdminRestaurantSearchFeedback(
                'No fue posible cargar el mapa en este momento. Intenta recargar la página.',
                'error'
            );
            return;
        }

        if (!this.restaurantMap) {
            this.restaurantMap = new window.google.maps.Map(container, {
                center: { lat: 39.8283, lng: -98.5795 },
                zoom: 4,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: false,
                gestureHandling: 'greedy',
            });
            this.restaurantGeocoder = new window.google.maps.Geocoder();
            this.restaurantAutocompleteService = new window.google.maps.places.AutocompleteService();

            this.restaurantMap.addListener('click', (event) => {
                const clickedLat = typeof event?.latLng?.lat === 'function' ? event.latLng.lat() : Number.NaN;
                const clickedLng = typeof event?.latLng?.lng === 'function' ? event.latLng.lng() : Number.NaN;
                void this.setAdminRestaurantLocationFromCoordinates(clickedLat, clickedLng, {
                    reverseLookup: true,
                    preserveQuery: false,
                });
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
        feedback.style.background = tone === 'error' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(14, 165, 233, 0.12)';
        feedback.style.borderColor = tone === 'error' ? 'rgba(239, 68, 68, 0.28)' : 'rgba(14, 165, 233, 0.28)';
        feedback.style.color = tone === 'error' ? '#fecaca' : '#e0f2fe';
    },

    getGoogleMapsApiKey() {
        return String(window.WORKTRACE_CONFIG?.googleMapsApiKey || '').trim();
    },

    async ensureGoogleMapsLibrary() {
        if (
            window.google?.maps?.Map &&
            window.google?.maps?.Geocoder &&
            window.google?.maps?.places?.AutocompleteService
        ) {
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
                existingScript.addEventListener(
                    'error',
                    () => {
                        cleanup();
                        this.googleMapsPromise = null;
                        reject(new Error('No fue posible cargar Google Maps.'));
                    },
                    { once: true }
                );
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

        if (
            Number.isFinite(result?.lat) &&
            Number.isFinite(result?.lng) &&
            (result?.display_name || result?.address_line)
        ) {
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
                place_id: result.place_id || '',
            };
        }

        const geometryLocation = result?.geometry?.location;
        const lat = typeof geometryLocation?.lat === 'function' ? Number(geometryLocation.lat()) : Number(result?.lat);
        const lng = typeof geometryLocation?.lng === 'function' ? Number(geometryLocation.lng()) : Number(result?.lng);
        const streetNumber = this.getGoogleAddressComponent(result.address_components, 'street_number');
        const route = this.getGoogleAddressComponent(result.address_components, 'route');
        const premise =
            this.getGoogleAddressComponent(result.address_components, 'premise') ||
            this.getGoogleAddressComponent(result.address_components, 'establishment') ||
            this.getGoogleAddressComponent(result.address_components, 'subpremise');
        const addressLine =
            [streetNumber, route].filter(Boolean).join(' ').trim() ||
            premise ||
            result?.formatted_address ||
            result?.display_name ||
            'Dirección sin identificar';
        const city =
            this.getGoogleAddressComponent(result.address_components, 'locality') ||
            this.getGoogleAddressComponent(result.address_components, 'postal_town') ||
            this.getGoogleAddressComponent(result.address_components, 'administrative_area_level_2') ||
            this.getGoogleAddressComponent(result.address_components, 'sublocality') ||
            '';
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
            place_id: result?.place_id || '',
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
            place_id: prediction?.place_id || '',
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
            button.className =
                `restaurant-search-result ${index === this.restaurantSelectedResultIndex ? 'active' : ''}`.trim();
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
        const { removeMarker = true } = options;

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
                        types: ['address'],
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
                this.setAdminRestaurantSearchFeedback(
                    'No encontramos coincidencias. Prueba con calle, número, ciudad, estado y país.',
                    'error'
                );
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
            this.setAdminRestaurantSearchFeedback(
                'No fue posible buscar la dirección en el mapa en este momento.',
                'error'
            );
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
                this.setAdminRestaurantSearchFeedback(
                    'No fue posible cargar esa dirección. Intenta con otra opción.',
                    'error'
                );
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

        const { preserveQuery = false } = options;

        this.restaurantLocationDraft = {
            address_line: location.address_line || '',
            city: location.city || '',
            state: location.state || '',
            country: location.country || '',
            lat: Number(location.lat),
            lng: Number(location.lng),
            display_name: location.display_name || location.address_line || '',
            postcode: location.postcode || '',
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
                draggable: true,
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
        const { reverseLookup = true, preserveQuery = false } = options;

        const nextLocation = {
            ...(this.restaurantLocationDraft || {}),
            lat,
            lng,
        };

        if (reverseLookup) {
            try {
                const controller = this.restaurantGeocodeAbortController;
                const resolvedLocation = await this.reverseGeocodeAdminRestaurantCoordinates(
                    lat,
                    lng,
                    controller?.signal
                );
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

    // ==========================================================================
    // SECCIÓN: Modal de contratista
    // --------------------------------------------------------------------------
    // Prepara el formulario (lo envía submitAdminEmployeeForm en supervisor.js).
    // ==========================================================================

    prepareAdminEmployeeModal() {
        const form = document.getElementById('admin-employee-form');
        form?.reset();
    },

    // ==========================================================================
    // SECCIÓN: Catálogo de sitios del admin
    // --------------------------------------------------------------------------
    // Carga (con caché) la lista de sitios para las pantallas del admin.
    // ==========================================================================

    async ensureAdminRestaurants(force = false) {
        if (force) {
            this.invalidateCache('adminRestaurants', 'adminMetrics', 'adminSupervisors');
        }

        if (
            force ||
            this.data.admin.restaurants.length === 0 ||
            !this.isCacheFresh('adminRestaurants', CACHE_TTLS.adminRestaurants)
        ) {
            this.data.admin.restaurants = await this.runPending(
                `adminRestaurants:${force ? 'force' : 'default'}`,
                async () => {
                    const restaurantsResult = await apiClient.adminRestaurantsManage('list', {
                        is_active: true,
                        limit: 200,
                    });
                    const restaurants = asArray(restaurantsResult);
                    this.touchCache('adminRestaurants');
                    return restaurants;
                }
            );
        }

        return this.data.admin.restaurants;
    },
};
