# Rehab Rhythm - Web Client

这是“康复音游”项目的 Web 前端部分。采用现代化的前端工具链开发，旨在提供流畅的康复训练体验和精细的数据采集功能。

## 🛠 技术栈

- **游戏引擎**: [Phaser 3](https://phaser.io/) - 负责高性能的游戏渲染与输入处理。
- **构建工具**: [Vite](https://vitejs.dev/) - 提供极速的开发环境与优化后的构建产物。
- **编程语言**: [TypeScript](https://www.typescriptlang.org/) - 确保代码的健壮性与可维护性。
- **本地数据库**: [Dexie.js](https://dexie.org/) - 基于 IndexedDB，用于本地海量采样数据的存储与缓存。
- **后端同步**: [Supabase](https://supabase.com/) - 提供云端数据持久化、用户同步及音频存储。
- **离线支持**: [Vite PWA](https://vite-pwa-org.netlify.app/) - 使得应用可以作为桌面/移动端应用安装，并支持离线训练。

## 📦 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
在根目录创建 `.env` 文件，并配置你的 Supabase 密钥：
```env
VITE_SUPABASE_URL=你的Supabase项目地址
VITE_SUPABASE_ANON_KEY=你的Supabase匿名密钥
```

### 3. 本地开发
```bash
npm run dev
```

### 4. 生产构建
```bash
npm run build
```

## 📐 核心机制说明

### 数据同步流
1. **启动阶段**: 自动调用 `syncSongs()` 从云端同步最新的歌曲列表至本地 IndexedDB。
2. **训练阶段**: 游戏实时记录每个 Note 的击打偏移（ms）和按键持续时间，存入本地 `note_events` 表。
3. **同步阶段**: 应用每隔 30 秒自动尝试将本地未同步的 `sessions` 和 `note_events` 推送到 Supabase 云端。

### 资源加载机制
- **内置歌曲**: 存放于 `public/assets/songs/`，通过静态路径加载。
- **动态歌曲**: 歌曲元数据与谱面 JSON 存储在数据库中，音频文件通过 Supabase Storage 的公网 URL 加载。

## 🌐 部署

本项目适配 Vercel 部署。在部署时，请务必在 Vercel 后台添加 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY` 环境变量。

---
Developed for Rehabilitation Training.
