import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    root: '.',
    publicDir: 'public',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2020',
        minify: 'esbuild',
        cssMinify: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html')
            },
            output: {
                manualChunks: {
                    supabase: ['@supabase/supabase-js']
                },
                chunkFileNames: 'js/[name]-[hash].js',
                entryFileNames: 'js/[name]-[hash].js',
                assetFileNames: (assetInfo) => {
                    // Exclude legacy font formats — modern browsers only need woff2
                    if (/\.(ttf|eot|otf)$/i.test(assetInfo.name)) {
                        return 'fonts/[name]-[hash][extname]';
                    }
                    if (/\.woff2?$/i.test(assetInfo.name)) {
                        return 'fonts/[name]-[hash][extname]';
                    }
                    if (/\.css$/i.test(assetInfo.name)) {
                        return 'css/[name]-[hash][extname]';
                    }
                    return 'assets/[name]-[hash][extname]';
                }
            },
            plugins: [
                {
                    name: 'exclude-legacy-fonts',
                    generateBundle(_, bundle) {
                        for (const key of Object.keys(bundle)) {
                            if (/\.(ttf|eot|otf)$/i.test(key)) {
                                delete bundle[key];
                            }
                        }
                    }
                }
            ]
        }
    },
    server: {
        port: 5173,
        open: true
    }
});
