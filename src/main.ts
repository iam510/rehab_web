import Phaser from 'phaser';
import './style.css';
import { GameScene } from './GameScene';
import { registerSW } from 'virtual:pwa-register';
import { syncSongs, getAllSongs } from './db';

// 强制注销旧的 Service Worker 以清理顽固缓存
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
            registration.unregister();
            console.log('已强制注销 Service Worker:', registration);
        }
    });
}

// 注册新的 PWA Service Worker
registerSW({ immediate: true });

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
        height: 600,
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
