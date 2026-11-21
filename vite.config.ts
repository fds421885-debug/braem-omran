import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  const rawBase = process.env.VITE_BASE_PATH || '/';
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

  return {
    base,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'icon.svg',
          'apple-touch-icon.png',
          'pwa-192x192.png',
          'pwa-512x512.png',
          'pwa-maskable-512x512.png',
          'sw-notifications.js',
        ],
        manifest: {
          id: base,
          name: 'براعم عمران',
          short_name: 'براعم عمران',
          description: 'منصة براعم عمران التعليمية التفاعلية بثيم حيوي دافئ.',
          theme_color: '#F56900',
          background_color: '#FFFFFF',
          display: 'standalone',
          dir: 'rtl',
          lang: 'ar',
          start_url: base,
          scope: base,
          icons: [
            {
              src: `${base}pwa-192x192.png`,
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: `${base}pwa-512x512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: `${base}pwa-maskable-512x512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          importScripts: [`${base}sw-notifications.js`],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,woff,woff2}'],
          navigateFallbackDenylist: [/^\/api\//, /\/pdfjs\//],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
      // Serve pdfjs-dist worker, wasm (JBIG2/OpenJPEG/QCMS), cmaps, iccs, and standard_fonts
      // in dev and bundle them into dist/pdfjs/ for 100% static hosts like GitHub Pages.
      {
        name: 'serve-and-bundle-pdfjs-assets',
        configureServer(server) {
          const pdfjsRoot = path.resolve(__dirname, 'node_modules/pdfjs-dist');
          server.middlewares.use((req, res, next) => {
            const reqUrl = (req.url || '').split('?')[0];
            const prefix = `${base}pdfjs/`;
            const altPrefix = '/pdfjs/';
            let relPath: string | null = null;
            if (reqUrl.startsWith(prefix)) {
              relPath = reqUrl.slice(prefix.length);
            } else if (reqUrl.startsWith(altPrefix)) {
              relPath = reqUrl.slice(altPrefix.length);
            }
            if (!relPath) {
              next();
              return;
            }
            const safeRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
            const candidate =
              safeRel === 'pdf.worker.min.mjs'
                ? path.join(pdfjsRoot, 'build/pdf.worker.min.mjs')
                : path.join(pdfjsRoot, safeRel);
            if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) {
              next();
              return;
            }
            const ext = path.extname(candidate).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.mjs': 'application/javascript; charset=utf-8',
              '.js': 'application/javascript; charset=utf-8',
              '.wasm': 'application/wasm',
              '.bcmap': 'application/octet-stream',
              '.pfb': 'application/octet-stream',
              '.ttf': 'font/ttf',
              '.icc': 'application/vnd.iccprofile',
            };
            res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
            fs.createReadStream(candidate).pipe(res);
          });
        },
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }

          // Copy pdfjs-dist runtime assets into dist/pdfjs/
          const pdfjsRoot = path.resolve(__dirname, 'node_modules/pdfjs-dist');
          const distPdfjs = path.resolve(distDir, 'pdfjs');
          if (fs.existsSync(distDir) && fs.existsSync(pdfjsRoot)) {
            fs.mkdirSync(distPdfjs, {recursive: true});
            const workerSrc = path.join(pdfjsRoot, 'build/pdf.worker.min.mjs');
            if (fs.existsSync(workerSrc)) {
              fs.copyFileSync(workerSrc, path.join(distPdfjs, 'pdf.worker.min.mjs'));
            }
            for (const subDir of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) {
              const srcSub = path.join(pdfjsRoot, subDir);
              if (fs.existsSync(srcSub)) {
                fs.cpSync(srcSub, path.join(distPdfjs, subDir), {
                  recursive: true,
                  force: true,
                });
              }
            }
          }

          const indexHtml = path.resolve(distDir, 'index.html');
          const fallback404 = path.resolve(distDir, '404.html');
          if (fs.existsSync(indexHtml)) {
            fs.copyFileSync(indexHtml, fallback404);
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
