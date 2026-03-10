import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true
      },
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg', 'assets/sounds/*.mp3'],
      manifest: {
        name: '康复音游 - Rehab Rhythm',
        short_name: '康复音游',
        description: '专业的康复训练节奏游戏',
        theme_color: '#0a0a12',
        background_color: '#0a0a12',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        // 关键配置：允许缓存大文件（默认 2MB，调高到 15MB 以支持歌曲 MP3）
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        // 修改点：从 precache 中移除 html，防止它被 Cache-First 策略锁死
        globPatterns: ['**/*.{js,css,ico,png,svg,mp3,json}'],
        // 允许立即接管并更新
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // 针对 index.html 的策略：始终优先联网获取，只有断网才看缓存
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-cache-v2', // 修改 cacheName 强制刷新缓存
              networkTimeoutSeconds: 3, // 3秒没响应就用缓存，保证速度
              expiration: {
                maxEntries: 5
              }
            }
          },
          {
            // 针对 manifest.json 的策略：Network First (始终尝试从网络获取最新的歌曲清单)
            urlPattern: /^.*\/assets\/songs\/manifest\.json$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'manifest-cache',
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60 * 60 * 24 // 1天
              }
            }
          },
          {
            // 针对歌曲目录的特殊缓存策略：Cache First (优先从本地缓存读取)
            urlPattern: /^.*\/assets\/songs\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'songs-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30天
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // 针对其他音频文件的缓存
            urlPattern: /^.*\/assets\/sounds\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'sounds-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    })
  ]
});
