// WorkTrace runtime config — cargada como <script src> (mismo origen, CSP self OK).
// Se sirve desde public/ tal cual, sin bundlear, para permitir cambiarla sin rebuild.
window.WORKTRACE_CONFIG = window.WORKTRACE_CONFIG || {
    supabaseUrl: 'https://orwingqtwoqfhcogggac.supabase.co',
    apiBaseUrl: 'https://orwingqtwoqfhcogggac.supabase.co/functions/v1',
    supabaseAnonKey:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yd2luZ3F0d29xZmhjb2dnZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzEyMzcsImV4cCI6MjA4NjI0NzIzN30.QA86sHHsgN2K96YetNnafJdKWZffT1FugDTRB7E_drA',
    googleMapsApiKey: 'AIzaSyAugcqnN-QxUH2mRmgPH_hA5zo-5_RBtX0',
    accessToken: '',
    shiftOtpToken: '',
    timeoutMs: 15000,
    // Branding cliente: cambiable por deploy sin rebuild.
    // Se aplica al slot izquierdo del header (Logo cliente).
    // Los archivos deben vivir en /css/logos/ y ser referenciados como URL relativa.
    clientBranding: {
        name: 'R3 Service & Solutions Inc.',
        legalName: 'R3 Service & Solutions Inc.',
        logoSrc: 'css/logos/r3-logo.png',
        logoAlt: 'R3',
    },
    // URLs de los documentos legales — abren en nueva pestaña desde el
    // login. Configurables por deploy sin rebuild. Dejar '' desactiva
    // el link visualmente.
    legalUrls: {
        terms: '',
        privacy: '',
    },
};
