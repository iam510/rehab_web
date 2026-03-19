import Phaser from 'phaser';
import './style.css';
import { GameScene } from './GameScene';
import { registerSW } from 'virtual:pwa-register';
import { syncSongs, getAllSongs } from './db';

if (import.meta.env.DEV) {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(async (registrations) => {
            let changed = false;
            for (const registration of registrations) {
                const ok = await registration.unregister();
                changed = changed || ok;
            }
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
            if (changed) {
                location.reload();
            }
        });
    }
} else {
    registerSW({ immediate: true });
}

async function initGame() {
    console.log('Main: 正在初始化数据库和歌曲列表...');
    
    // 1. 同步云端歌曲
    try {
        await syncSongs();
    } catch (e) {
        console.error('Main: 同步歌曲失败', e);
    }
    
    // 2. 获取所有歌曲（内置 + 云端）
    const dbSongs = await getAllSongs();
    const staticSongs = [
        { id: '甜蜜蜜', name: '甜蜜蜜', isStatic: true }
    ];

    const allSongs = [
        ...staticSongs,
        ...dbSongs.map(s => ({
            id: s.id,
            name: s.name,
            audioUrl: s.audioUrl,
            isStatic: false
        }))
    ];

    console.log('Main: 准备就绪，启动游戏引擎...');

    const config: Phaser.Types.Core.GameConfig = {
        type: Phaser.AUTO,
        width: 800,
        height: 680,
        parent: 'app',
        physics: {
            default: 'arcade',
            arcade: {
                gravity: { x: 0, y: 0 },
                debug: false
            }
        }
    };

    const game = new Phaser.Game(config);
    
    // 手动添加并启动场景，确保传入初始数据
    game.scene.add('GameScene', GameScene);
    game.scene.start('GameScene', { songs: allSongs });
}

void initGame();
