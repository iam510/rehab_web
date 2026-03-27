# Rehab Rhythm - Web Client

康复节奏训练 Web 应用。项目以 Phaser 3 为核心，结合 Dexie(IndexedDB) 做本地训练数据落盘，并通过 Supabase 做云端同步；支持 PWA 离线缓存，可在弱网或断网场景下继续训练。

## 项目特性

- 4 轨节奏训练，支持键盘 `D F J K` 与点击触控
- 手姿势模式：`leftUp` / `rightUp` / `rightDown` / `leftDown`
- 训练模式：四指训练、单指训练（食指/中指/无名指/小拇指）
- 用户管理：新建、切换、删除用户，保存个人训练偏好
- 本地数据：用户、会话、击打事件等写入 IndexedDB
- 云端同步：按周期自动同步用户/会话/音符事件到 Supabase
- 歌曲来源：内置静态歌曲 + 云端动态歌曲
- PWA：生产环境自动注册 Service Worker，支持安装和离线缓存

## 技术栈

- 前端与构建：Vite 7 + TypeScript 5
- 游戏引擎：Phaser 3
- 本地数据库：Dexie 4 (IndexedDB)
- 云端服务：Supabase (`@supabase/supabase-js`)
- PWA：vite-plugin-pwa (Workbox)

## 目录结构

```text
.
├─ index.html                # 外层 UI 容器（设置栏、Overlay、用户面板）
├─ src/
│  ├─ main.ts                # 应用入口，歌曲同步、SW 注册、启动场景
│  ├─ GameScene.ts           # Phaser 主场景与训练逻辑
│  ├─ db.ts                  # Dexie 数据模型、业务接口、Supabase 同步
│  └─ style.css              # 整体 UI 样式
├─ public/assets/
│  ├─ images/                # 手姿势图片等静态资源
│  ├─ sounds/                # 打击音效
│  └─ songs/                 # 内置歌曲（音频 + 谱面）
└─ vite.config.ts            # Vite + PWA 配置
```

## 环境要求

- Node.js 18+
- npm 9+

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 创建环境变量文件 `.env`

```env
VITE_SUPABASE_URL=你的_supabase_url
VITE_SUPABASE_ANON_KEY=你的_supabase_anon_key
```

如果未配置以上变量，应用仍可运行本地训练流程，但云端同步与云端歌曲同步会受限（控制台会出现警告）。

3. 启动开发环境

```bash
npm run dev
```

4. 构建生产包

```bash
npm run build
```

5. 本地预览生产构建

```bash
npm run preview
```

## 数据与同步说明

### 本地数据库（Dexie）

数据库名：`rehab-db`

主要表：

- `users`：用户基础信息与病程相关字段
- `sessions`：每局训练会话汇总
- `noteEvents`：音符级击打事件（偏移、判定、按压时长），同步后自动清理
- `features`：特征数据（预留）
- `settings`：键值配置（当前用户、用户偏好等）
- `songs`：云端歌曲缓存

### 同步流程

- 启动时调用 `syncSongs()` 拉取 Supabase `songs` 表并缓存到本地
- 游戏中记录训练数据到本地表，默认标记 `synced = 0`
- 进入场景后启动同步循环：每 30 秒执行 `syncToSupabase()`
- 同步顺序：`users` -> `sessions` -> `note_events`，并处理外键依赖
- 同步成功后将本地记录标记为 `synced = 1`，**`noteEvents` 同步成功后自动从本地删除以节省存储空间**

## 歌曲加载机制

- 内置歌曲：从 `public/assets/songs/<songId>/` 加载 `audio.mp3` 与 `chart_level_4.json`
- 云端歌曲：由 Supabase 返回 `audio_url` 与 `levels`，运行时注入 Phaser JSON 缓存并加载音频 URL

## PWA 与缓存策略

- 开发模式：主动清理历史 Service Worker 与 Cache，避免调试缓存干扰
- 生产模式：自动注册 SW（`registerType: autoUpdate`）
- Workbox 关键策略：
- 导航请求使用 `NetworkFirst`
- 歌曲与音效资源使用 `CacheFirst`
- 提升缓存文件体积上限以适配音频资源

## 目前脚本命令

- `npm run dev`：启动开发服务器
- `npm run build`：TypeScript 检查并打包
- `npm run preview`：预览打包产物

## 部署建议

- 可部署到 Vercel、Netlify 或任意静态托管平台
- 需要在部署平台配置：
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- 首次上线建议手动清理旧缓存（若曾使用过早期 SW 策略）

## 常见问题

1. 启动后看不到云端歌曲

- 检查 Supabase 环境变量是否正确
- 检查 `songs` 表字段是否包含 `id/name/audio_url/levels/updated_at`
- 打开浏览器控制台查看 `syncSongs` 日志

2. 数据没有同步到云端

- 检查网络与 Supabase 表权限(RLS)
- 确认 `users` 成功同步后 `sessions` 才会继续同步
- 确认 `sessions` 同步后 `note_events` 才会继续同步

3. 开发时缓存导致页面内容异常

- 项目在开发模式会自动注销 SW 并清缓存
- 如仍异常，可手动在浏览器 Application 面板清理 Service Worker 与 Cache Storage

---

Developed for Rehabilitation Training.
