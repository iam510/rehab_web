import Phaser from 'phaser';
import { startSession, endSession, addNoteEvents, db, listUsers, createUser, getSetting, setSetting, deleteUserCascade, migrateToUUID, syncToSupabase } from './db';

interface NoteInfo {
    time: number;
    lane: number;
    spawned: boolean;
}

interface SongInfo {
    id: string;
    name: string;
    audioUrl?: string; // 支持动态 URL
    isStatic?: boolean; // 区分静态资源和动态资源
}

export class GameScene extends Phaser.Scene {
    private lanes = [200, 333, 466, 600];
    private laneKeys = ['D', 'F', 'J', 'K'];
    private notes: Phaser.GameObjects.Rectangle[] = [];
    private laneGlows: Phaser.GameObjects.Rectangle[] = [];
    private hitEffects!: Phaser.GameObjects.Group;
    
    private score = 0;
    private combo = 0;
    private scoreText!: Phaser.GameObjects.Text;
    private comboText!: Phaser.GameObjects.Text;
    private timerText!: Phaser.GameObjects.Text;
    private feedbackText!: Phaser.GameObjects.Text;
    
    private noteSpeed = 400;
    private judgeY = 520;
    private spawnY = -50;
    private perfectRange = 70;
    private goodRange = 130;

    private gameTime = 0; 
    private currentTime = 0;
    private isGameStarted = false;
    private isGamePaused = false;
    private isGameOver = false;
    
    private currentBgm?: Phaser.Sound.BaseSound;
    private hitSound?: Phaser.Sound.BaseSound;
    private timerEvent?: Phaser.Time.TimerEvent;

    private chartData: NoteInfo[] = [];
    private currentSongId = 'default';
    private currentDensity = 3;
    private songs: SongInfo[] = [];
    private currentUserId?: string;

    private currentSessionId?: string;
    private perfectCount = 0;
    private goodCount = 0;
    private missCount = 0;
    private maxCombo = 0;
    private offsetsMs: number[] = [];
    
    // 记录每个轨道按下的开始时间，用于计算按键时长
    private lanePressStartTimes: Map<number, number> = new Map();
    // 记录每个轨道当前命中的 NoteEvent ID，用于抬起时更新时长
    private laneActiveNoteIds: Map<number, number | undefined> = new Map();

    constructor() {
        super('GameScene');
    }

    init(data: { songs: SongInfo[] }) {
        // 如果是从外部传入的歌曲列表（比如 BootScene 或 main.ts）
        if (data && data.songs) {
            this.songs = data.songs;
        }
    }

    preload() {
        const width = this.cameras.main.width;
        const height = this.cameras.main.height;
        
        const progressBar = this.add.graphics();
        const progressBox = this.add.graphics();
        progressBox.fillStyle(0x222222, 0.8);
        progressBox.fillRect(width / 2 - 160, height / 2 - 25, 320, 50);

        this.load.on('progress', (value: number) => {
            progressBar.clear();
            progressBar.fillStyle(0x4cc9f0, 1);
            progressBar.fillRect(width / 2 - 150, height / 2 - 15, 300 * value, 30);
        });

        this.load.on('complete', () => {
            progressBar.destroy();
            progressBox.destroy();
        });

        this.load.audio('hit', 'assets/sounds/hit.mp3');
        
        // 5. 预加载资源
        this.songs.forEach(song => {
            if (song.isStatic) {
                // 静态歌曲加载
                const audioPath = `assets/songs/${song.id}/audio.mp3`;
                this.load.audio(`audio-${song.id}`, audioPath);
                for (let i = 1; i <= 4; i++) {
                    this.load.json(`chart-${song.id}-level-${i}`, `assets/songs/${song.id}/chart_level_${i}.json`);
                }
            } else {
                // 动态歌曲加载
                if (song.audioUrl) {
                    this.load.audio(`audio-${song.id}`, song.audioUrl);
                }
            }
        });

        // 歌曲列表加载完成后，强制刷新 UI
        if ((this as any).refreshSongList) {
            (this as any).refreshSongList();
        }
    }

    create() {
        this.hitEffects = this.add.group();
        
        // 将动态 JSON 注入 Phaser 缓存
        db.songs.toArray().then(dbSongs => {
            dbSongs.forEach(song => {
                for (let i = 1; i <= 4; i++) {
                    if (song.levels && song.levels[i]) {
                        this.cache.json.add(`chart-${song.id}-level-${i}`, song.levels[i]);
                    }
                }
            });
        });

        const { width, height } = this.scale;
        this.add.rectangle(width / 2, height / 2, width, height, 0x0f0f1b);

        this.hitSound = this.sound.add('hit', { volume: 0.8 });

        this.lanes.forEach((x, i) => {
            this.add.rectangle(x, height / 2, 2, height, 0xffffff, 0.1);
            const glow = this.add.rectangle(x, height / 2, 100, height, 0x4361ee, 0);
            this.laneGlows.push(glow);
            this.add.text(x, height - 40, this.laneKeys[i], {
                fontSize: '32px', fontStyle: 'bold', color: '#4cc9f0'
            }).setOrigin(0.5);

            const clickZone = this.add.rectangle(x, height / 2, 100, height, 0x000000, 0.01)
                .setInteractive({ useHandCursor: true });
            
            clickZone.on('pointerdown', () => {
                if (!this.isGameStarted || this.isGamePaused || this.isGameOver) return;
                this.lanePressStartTimes.set(i, Date.now());
                this.triggerLaneGlow(i);
                this.handleInput(i);
            });

            clickZone.on('pointerup', () => {
                this.handleInputUp(i);
            });

            clickZone.on('pointerout', () => {
                this.handleInputUp(i);
            });
        });

        this.add.rectangle(width / 2, this.judgeY, 600, 4, 0x4cc9f0).setAlpha(0.6);

        this.scoreText = this.add.text(40, 40, 'SCORE: 0', { 
            fontSize: '42px', fontStyle: 'bold', color: '#fff', stroke: '#0f172a', strokeThickness: 6
        });
        this.comboText = this.add.text(40, 100, 'COMBO: 0', { 
            fontSize: '32px', fontStyle: 'bold', color: '#38bdf8', stroke: '#0f172a', strokeThickness: 4
        });
        this.timerText = this.add.text(width - 40, 40, `TIME: 0`, {
            fontSize: '42px', fontStyle: 'bold', color: '#fff', stroke: '#0f172a', strokeThickness: 6
        }).setOrigin(1, 0);

        this.feedbackText = this.add.text(width / 2, 300, '', { 
            fontSize: '84px', fontStyle: 'bold', color: '#fbbf24', stroke: '#0f172a', strokeThickness: 8
        }).setOrigin(0.5);

        this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
            if (event.code === 'Space') {
                try { event.preventDefault(); } catch {}
                this.togglePause();
                return;
            }
            if (!this.isGameStarted || this.isGamePaused || this.isGameOver) return;
            const key = event.key.toUpperCase();
            const laneIndex = this.laneKeys.indexOf(key);
            if (laneIndex !== -1) {
                // 如果按键已经按下但还没抬起，不重复触发（防抖）
                if (this.lanePressStartTimes.has(laneIndex)) return;
                this.lanePressStartTimes.set(laneIndex, Date.now());
                this.triggerLaneGlow(laneIndex);
                this.handleInput(laneIndex);
            }
        });

        this.input.keyboard?.on('keyup', (event: KeyboardEvent) => {
            const key = event.key.toUpperCase();
            const laneIndex = this.laneKeys.indexOf(key);
            if (laneIndex !== -1) {
                this.handleInputUp(laneIndex);
            }
        });

        this.setupExternalUI();
        this.physics.pause();
    }

    private updateTopRightUserDisplay(users: any[], currentId: string | null | undefined) {
        const targetId = this.currentUserId || currentId;
        const current = users.find(u => u.id === targetId);
        const labelName = current?.name || '用户';
        const userBtnEl = document.getElementById('userBtn');
        if (userBtnEl) userBtnEl.textContent = `用户：${labelName}`;
    }

    private setupExternalUI() {
        const startBtn = document.getElementById('startBtn');
        const userBtn = document.getElementById('userBtn');
        const userOverlay = document.getElementById('user-overlay');
        const userCloseBtn = document.getElementById('userCloseBtn');
        const userManageSelect = document.getElementById('userManageSelect') as HTMLSelectElement | null;
        const userNewBtn = document.getElementById('userNewBtn');
        const userManageForm = document.getElementById('userManageForm') as HTMLDivElement | null;
        const mUserCreateBtn = document.getElementById('mUserCreateBtn');
        const userDeleteBtn = document.getElementById('userDeleteBtn');
        const resumeBtn = document.getElementById('resumeBtn');
        const endBtn = document.getElementById('endBtn');
        const pauseBtn = document.getElementById('pauseBtn');
        const restartBtn = document.getElementById('restartBtn');
        const returnHomeBtn = document.getElementById('returnHomeBtn');
        const addUserBtn = document.getElementById('addUserBtn');
        const saveUserBtn = document.getElementById('saveUserBtn');
        const userForm = document.getElementById('userForm') as HTMLDivElement | null;
        const userSelect = document.getElementById('userSelect') as HTMLSelectElement | null;
        const densityInput = document.getElementById('densityRange') as HTMLInputElement;
        const volumeInput = document.getElementById('volumeRange') as HTMLInputElement;
        const songSelect = document.getElementById('songSelect') as HTMLSelectElement;

        const refreshSongList = () => {
            const songSelect = document.getElementById('songSelect') as HTMLSelectElement | null;
            if (songSelect) {
                console.log('UI: 刷新歌曲列表，当前歌曲数:', this.songs.length);
                songSelect.innerHTML = this.songs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
                if (this.currentSongId && this.songs.some(s => s.id === this.currentSongId)) {
                    songSelect.value = this.currentSongId;
                } else if (this.songs.length > 0) {
                    this.currentSongId = this.songs[0].id;
                    songSelect.value = this.currentSongId;
                }
            } else {
                console.error('UI: 找不到 id 为 songSelect 的元素');
            }
        };

        // 挂载到类实例上，以便 preload 调用
        (this as any).refreshSongList = refreshSongList;

        // 立即刷新一次
        refreshSongList();

        const initUsers = async () => {
            const users = await listUsers();
            const currentId = await getSetting<string>('currentUserId');
            if (users.length === 0) {
                const defaultId = await createUser({ name: '访客' });
                await setSetting('currentUserId', defaultId);
                this.currentUserId = defaultId;
                users.push({ id: defaultId, name: '访客', createdAt: new Date().toISOString() } as any);
            }
            if (userSelect) {
                userSelect.innerHTML = users.map(u => `<option value="${u.id}">${u.name}</option>`).join('');
                if (currentId) {
                    const found = users.find(u => u.id === currentId);
                    if (found) {
                        userSelect.value = currentId;
                        this.currentUserId = currentId;
                    } else {
                        userSelect.value = users[0]?.id || '';
                        this.currentUserId = users[0]?.id;
                        if (this.currentUserId) await setSetting('currentUserId', this.currentUserId);
                    }
                }
                // 若没有 currentId，默认选第一个
                if (!currentId && users[0]) {
                    userSelect.value = users[0].id;
                    this.currentUserId = users[0].id;
                    await setSetting('currentUserId', this.currentUserId);
                }
            } else {
                // 没有开始界面下拉时，直接依据设置或首个用户确定当前用户
                if (currentId && users.find(u => u.id === currentId)) {
                    this.currentUserId = currentId;
                } else if (users[0]) {
                    this.currentUserId = users[0].id;
                    await setSetting('currentUserId', this.currentUserId);
                }
            }

            // 加载用户设置
            if (this.currentUserId) {
                const userPrefs = await getSetting<any>(`userPrefs_${this.currentUserId}`);
                if (userPrefs) {
                    if (userPrefs.volume !== undefined) {
                        this.sound.volume = userPrefs.volume;
                        if (volumeInput) volumeInput.value = (userPrefs.volume * 100).toString();
                        const vDisplay = document.getElementById('volumeValue');
                        if (vDisplay) vDisplay.innerText = Math.round(userPrefs.volume * 100).toString();
                    }
                    if (userPrefs.songId && songSelect) {
                        const songExists = this.songs.some(s => s.id === userPrefs.songId);
                        if (songExists) {
                            songSelect.value = userPrefs.songId;
                            this.currentSongId = userPrefs.songId;
                        } else if (this.songs.length > 0) {
                            // 如果保存的歌曲已不存在，选第一个
                            this.currentSongId = this.songs[0].id;
                            songSelect.value = this.currentSongId;
                        }
                    }
                    if (userPrefs.density !== undefined && densityInput) {
                        densityInput.value = userPrefs.density.toString();
                        this.currentDensity = userPrefs.density;
                        const dDisplay = document.getElementById('densityValue');
                        if (dDisplay) dDisplay.innerText = densityLabels[userPrefs.density - 1];
                    }
                }
            }

            this.updateTopRightUserDisplay(users, currentId);
        };
        void initUsers();

        userManageSelect?.addEventListener('change', async () => {
            const newId = userManageSelect.value;
            this.currentUserId = newId;
            await setSetting('currentUserId', newId);
            const users = await listUsers();
            this.updateTopRightUserDisplay(users, newId);
            await this.refreshUserPanel();
        });

        // 启动同步循环
        const startSyncLoop = async () => {
            await migrateToUUID(); // 启动时尝试迁移
            setInterval(async () => {
                await syncToSupabase();
            }, 30000); // 每 30 秒同步一次
            // 立即执行一次
            void syncToSupabase();
        };
        void startSyncLoop();

        userBtn?.addEventListener('click', async () => {
            await this.refreshUserPanel();
            userOverlay?.classList.remove('hidden');
        });
        userCloseBtn?.addEventListener('click', () => {
            userOverlay?.classList.add('hidden');
        });
        userNewBtn?.addEventListener('click', () => {
            if (!userManageForm) return;
            userManageForm.classList.toggle('hidden');
        });
        mUserCreateBtn?.addEventListener('click', async () => {
            const nameEl = document.getElementById('mUserName') as HTMLInputElement | null;
            const sexEl = document.getElementById('mUserSex') as HTMLSelectElement | null;
            const ageEl = document.getElementById('mUserAge') as HTMLInputElement | null;
            const handEl = document.getElementById('mUserHand') as HTMLSelectElement | null;
            const phaseEl = document.getElementById('mUserPhase') as HTMLInputElement | null;
            const msgEl = document.getElementById('mUserMsg') as HTMLDivElement | null;
            const name = nameEl?.value?.trim();
            if (!name) {
                if (msgEl) msgEl.textContent = '请先输入姓名';
                return;
            }
            try {
                const id = await createUser({
                    id: undefined,
                    name,
                    sex: (sexEl?.value as any) || undefined,
                    age: ageEl?.value ? parseInt(ageEl.value) : undefined,
                    handDominance: (handEl?.value as any) || undefined,
                    rehabPhase: phaseEl?.value || undefined
                });
                await setSetting('currentUserId', id);
                this.currentUserId = id;
                const users = await listUsers();
                this.updateTopRightUserDisplay(users, id);
                if (msgEl) msgEl.textContent = '已保存，并设为当前用户';
                await this.refreshUserPanel();
                if (userManageForm) userManageForm.classList.add('hidden');
            } catch (e: any) {
                const m = e?.message || String(e);
                const msg = m.includes('IDBObjectStore') || m.includes('DataError') ? '保存失败：本地数据库结构不一致' : `保存失败：${m}`;
                if (document.getElementById('mUserMsg')) (document.getElementById('mUserMsg') as HTMLDivElement).textContent = msg;
            }
        });
        userManageSelect?.addEventListener('change', async () => {
            if (!userManageSelect.value) return;
            this.currentUserId = userManageSelect.value;
            await setSetting('currentUserId', this.currentUserId);
            await initUsers(); // 重新初始化，加载新用户的设置
            await this.refreshUserPanel();
            const opt = userManageSelect.options[userManageSelect.selectedIndex];
            const userBtnEl = document.getElementById('userBtn');
            if (userBtnEl && opt) userBtnEl.textContent = `用户：${opt.text}`;
        });
        userDeleteBtn?.addEventListener('click', async () => {
            if (!userManageSelect?.value) return;
            const id = userManageSelect.value;
            const ok = window.confirm('确定删除该用户及其全部训练记录？此操作不可恢复。');
            if (!ok) return;
            await deleteUserCascade(id);
            let users = await listUsers();
            if (users.length === 0) {
                const defaultId = await createUser({ name: '访客' });
                await setSetting('currentUserId', defaultId);
                this.currentUserId = defaultId;
            } else {
                const next = users[0].id;
                await setSetting('currentUserId', next);
                this.currentUserId = next;
            }
            await this.refreshUserPanel();
            await initUsers();
        });

        userSelect?.addEventListener('change', async () => {
            if (!userSelect.value) return;
            this.currentUserId = userSelect.value;
            await setSetting('currentUserId', this.currentUserId);
        });

        addUserBtn?.addEventListener('click', () => {
            if (!userForm) return;
            userForm.style.display = userForm.style.display === 'none' ? 'block' : 'none';
        });

        saveUserBtn?.addEventListener('click', async () => {
            const nameEl = document.getElementById('userName') as HTMLInputElement | null;
            const sexEl = document.getElementById('userSex') as HTMLSelectElement | null;
            const ageEl = document.getElementById('userAge') as HTMLInputElement | null;
            const handEl = document.getElementById('userHand') as HTMLSelectElement | null;
            const phaseEl = document.getElementById('userPhase') as HTMLInputElement | null;
            const msgEl = document.getElementById('userMsg') as HTMLDivElement | null;
            const name = nameEl?.value?.trim();
            if (!name) {
                if (msgEl) msgEl.textContent = '请先输入姓名';
                return;
            }
            try {
                const id = await createUser({
                    id: undefined,
                    name,
                    sex: (sexEl?.value as any) || undefined,
                    age: ageEl?.value ? parseInt(ageEl.value) : undefined,
                    handDominance: (handEl?.value as any) || undefined,
                    rehabPhase: phaseEl?.value || undefined
                });
                await setSetting('currentUserId', id);
                this.currentUserId = id;
                if (msgEl) msgEl.textContent = '已保存，并设为当前用户';
                await initUsers();
                if (userForm) userForm.style.display = 'none';
            } catch (e: any) {
                const m = e?.message || String(e);
                if (msgEl) {
                    if (m.includes('IDBObjectStore') || m.includes('DataError')) {
                        msgEl.textContent = '保存失败：本地数据库结构与当前版本不一致，请点击“清理本地数据库”后重试';
                    } else {
                        msgEl.textContent = `保存失败：${m}`;
                    }
                }
            }
        });

        

        const densityLabels = ['极简', '稀疏', '中等', '原始'];
        densityInput?.addEventListener('input', async (e) => {
            const val = parseInt((e.target as HTMLInputElement).value);
            this.currentDensity = val;
            const display = document.getElementById('densityValue');
            if (display) display.innerText = densityLabels[val - 1];
            
            if (this.currentUserId) {
                const prefs = await getSetting<any>(`userPrefs_${this.currentUserId}`) || {};
                await setSetting(`userPrefs_${this.currentUserId}`, { ...prefs, density: val });
            }
        });

        startBtn?.addEventListener('click', async () => {
            if (!this.currentUserId) {
                const currentId = await getSetting<string>('currentUserId');
                if (currentId) {
                    this.currentUserId = currentId;
                } else {
                    const defaultId = await createUser({ name: '访客' });
                    await setSetting('currentUserId', defaultId);
                    this.currentUserId = defaultId;
                }
            }
            this.currentSongId = songSelect.value;
            
            // 保存歌曲设置
            if (this.currentUserId) {
                const prefs = await getSetting<any>(`userPrefs_${this.currentUserId}`) || {};
                await setSetting(`userPrefs_${this.currentUserId}`, { ...prefs, songId: this.currentSongId });
            }

            this.startGame();
            document.getElementById('start-overlay')?.classList.add('hidden');
        });

        restartBtn?.addEventListener('click', async () => {
            this.currentSongId = songSelect.value;

            // 保存歌曲设置
            if (this.currentUserId) {
                const prefs = await getSetting<any>(`userPrefs_${this.currentUserId}`) || {};
                await setSetting(`userPrefs_${this.currentUserId}`, { ...prefs, songId: this.currentSongId });
            }

            this.restartGame();
            document.getElementById('game-over-overlay')?.classList.add('hidden');
        });
        
        returnHomeBtn?.addEventListener('click', () => {
            document.getElementById('game-over-overlay')?.classList.add('hidden');
            document.getElementById('start-overlay')?.classList.remove('hidden');
        });

        resumeBtn?.addEventListener('click', () => this.resumeGame());
        endBtn?.addEventListener('click', () => {
            if (!this.isGameStarted || this.isGameOver) return;
            document.getElementById('pause-overlay')?.classList.add('hidden');
            this.endGame();
        });
        pauseBtn?.addEventListener('click', () => this.togglePause());

        volumeInput?.addEventListener('input', async (e) => {
            const val = parseInt((e.target as HTMLInputElement).value) / 100;
            this.sound.volume = val;
            const display = document.getElementById('volumeValue');
            if (display) display.innerText = Math.round(val * 100).toString();

            if (this.currentUserId) {
                const prefs = await getSetting<any>(`userPrefs_${this.currentUserId}`) || {};
                await setSetting(`userPrefs_${this.currentUserId}`, { ...prefs, volume: val });
            }
        });

        songSelect?.addEventListener('change', async () => {
            if (this.currentUserId) {
                const prefs = await getSetting<any>(`userPrefs_${this.currentUserId}`) || {};
                await setSetting(`userPrefs_${this.currentUserId}`, { ...prefs, songId: songSelect.value });
            }
        });
    }

    private async refreshUserPanel() {
        const userManageSelect = document.getElementById('userManageSelect') as HTMLSelectElement | null;
        const userInfoText = document.getElementById('userInfoText');
        const userSessions = document.getElementById('userSessions');
        const users = await listUsers();
        const currentId = await getSetting<string>('currentUserId');
        const current = users.find(u => u.id === (this.currentUserId || currentId));

        if (userManageSelect) {
            userManageSelect.innerHTML = users.map(u => `<option value="${u.id}">${u.name}</option>`).join('');
            if (current) userManageSelect.value = current.id;
        }

        if (userInfoText) {
            if (current) {
                const sexMap = { male: '男', female: '女', other: '其他' };
                const items = [
                    { label: '姓名', value: current.name },
                    { label: '性别', value: (sexMap as any)[current.sex || ''] || '未指定' },
                    { label: '年龄', value: current.age ? `${current.age} 岁` : '未指定' },
                    { label: '主用手', value: current.handDominance === 'left' ? '左手' : current.handDominance === 'right' ? '右手' : current.handDominance === 'both' ? '双手' : '未指定' },
                    { label: '康复阶段', value: current.rehabPhase || '未指定' }
                ];
                userInfoText.innerHTML = items.map(item => `
                    <div class="info-item">
                        <span class="info-label">${item.label}</span>
                        <span class="info-value">${item.value}</span>
                    </div>
                `).join('');
            } else {
                userInfoText.innerHTML = '<div style="grid-column: span 3; text-align:center; color:#94a3b8;">未选择用户</div>';
            }
        }

        if (userSessions && current) {
            const rows = await db.sessions.where('userId').equals(current.id).toArray();
            rows.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
            const items = rows.slice(0, 50).map(r => {
                const t = r.startedAt ? new Date(r.startedAt).toLocaleString() : '';
                const name = r.songName || r.songId;
                const score = r.score ?? 0;
                const hr = r.hitRate !== undefined ? Math.round(r.hitRate * 100) + '%' : '0%';
                
                return `
                    <div class="record-card">
                        <div class="record-main">
                            <div class="record-time">📅 ${t}</div>
                            <div class="record-detail">🎵 ${name}</div>
                        </div>
                        <div class="record-score">
                            <div class="record-score-val">${score}</div>
                            <div class="record-hit-rate">准确率 ${hr}</div>
                        </div>
                    </div>
                `;
            }).join('');
            userSessions.innerHTML = items || '<div style="text-align:center; padding:20px; color:#94a3b8;">暂无历史记录</div>';
        }
    }

    private async startGame() {
        const audioKey = `audio-${this.currentSongId}`;
        const chartKey = `chart-${this.currentSongId}-level-${this.currentDensity}`;
        
        // 根据难度动态调整下落速度
        const speeds = { 1: 220, 2: 300, 3: 400, 4: 500 };
        this.noteSpeed = (speeds as any)[this.currentDensity] || 400;
        
        if (chartKey && this.cache.json.exists(chartKey)) {
            this.chartData = this.cache.json.get(chartKey).map((n: any) => ({ ...n, spawned: false }));
            this.gameTime = Math.ceil(this.chartData[this.chartData.length - 1].time + 5);
        } else {
            this.gameTime = 60;
            this.chartData = [];
        }
        this.currentTime = this.gameTime;

        if (this.hitEffects) this.hitEffects.clear(true, true);
        try { this.tweens.resumeAll(); } catch {}

        this.isGameStarted = true;
        this.isGamePaused = false;
        this.isGameOver = false;
        this.score = 0;
        this.combo = 0;
        this.perfectCount = 0;
        this.goodCount = 0;
        this.missCount = 0;
        this.maxCombo = 0;
        this.offsetsMs = [];
        this.updateUI();

        if (this.currentBgm) this.currentBgm.stop();
        this.currentBgm = this.sound.add(audioKey, { loop: false, volume: 1.0 });
        
        if (this.sound instanceof Phaser.Sound.WebAudioSoundManager) {
            this.sound.context.resume();
        }
        this.sound.resumeAll();
        this.currentBgm.play();
        this.physics.resume();

        const songName = this.songs.find(s => s.id === this.currentSongId)?.name || this.currentSongId;
        this.currentSessionId = await startSession({
            userId: this.currentUserId || 'local-user',
            songId: this.currentSongId,
            songName,
            densityLevel: this.currentDensity
        });

        if (this.timerEvent) this.timerEvent.destroy();
        this.timerEvent = this.time.addEvent({
            delay: 1000,
            callback: this.updateTimer,
            callbackScope: this,
            loop: true
        });
    }

    private updateTimer() {
        if (this.isGamePaused || this.isGameOver) return;
        this.currentTime--;
        this.timerText.setText(`TIME: ${Math.max(0, this.currentTime)}`);
        if (this.currentTime <= 0 && this.notes.length === 0) {
            this.endGame();
        }
    }

    private spawnNote(lane: number, targetTimeS: number) {
        const x = this.lanes[lane];
        const note = this.add.rectangle(x, this.spawnY, 90, 25, 0x4cc9f0);
        
        (note as any).lane = lane;
        (note as any).targetTimeS = targetTimeS;
        
        note.setStrokeStyle(2, 0xffffff);
        note.setInteractive({ useHandCursor: true });
        note.on('pointerdown', () => {
            if (!this.isGameStarted || this.isGamePaused) return;
            this.lanePressStartTimes.set(lane, Date.now());
            this.triggerLaneGlow(lane);
            this.handleInput(lane);
        });
        this.physics.add.existing(note);
        (note.body as Phaser.Physics.Arcade.Body).setVelocityY(this.noteSpeed);
        this.notes.push(note);
    }

    private triggerLaneGlow(index: number) {
        const glow = this.laneGlows[index];
        if (glow) {
            glow.setAlpha(0.3);
            this.tweens.add({ targets: glow, alpha: 0, duration: 200 });
        }
    }

    private handleInput(laneIndex: number) {
        const laneX = this.lanes[laneIndex];
        let closestNote: Phaser.GameObjects.Rectangle | null = null;
        let minDiff = Infinity;
        let noteIndex = -1;

        for (let i = 0; i < this.notes.length; i++) {
            const note = this.notes[i];
            if (Math.abs(note.x - laneX) < 10) {
                const diff = Math.abs(note.y - this.judgeY);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestNote = note;
                    noteIndex = i;
                }
            }
        }
        if (closestNote && minDiff < this.goodRange) {
            this.judge(minDiff, noteIndex);
        }
    }

    private async judge(diff: number, noteIndex: number) {
        const note = this.notes[noteIndex];
        if (!note) return;
        this.notes.splice(noteIndex, 1);
        const noteX = note.x;
        const noteY = note.y;
        note.destroy(); 
        if (this.hitSound) this.hitSound.play();
        const circle = this.add.circle(noteX, noteY, 10, 0xffffff, 0.8);
        this.hitEffects.add(circle);
        this.tweens.add({
            targets: circle, scale: 4, alpha: 0, duration: 300, onComplete: () => circle.destroy()
        });
        const hitTimeS = (this.currentBgm as any)?.seek || 0;
        const targetTimeS = (note as any).targetTimeS as number | undefined;
        let offsetMs: number | undefined = undefined;
        if (targetTimeS !== undefined) {
            offsetMs = Math.round((hitTimeS - targetTimeS) * 1000);
            this.offsetsMs.push(offsetMs);
        }
        if (diff < this.perfectRange) {
            this.showFeedback('PERFECT', 0x4ade80); // Success green
            this.score += 100;
            this.combo++;
            this.perfectCount++;
        } else {
            this.showFeedback('GOOD', 0x38bdf8); // Primary blue
            this.score += 50;
            this.combo++;
            this.goodCount++;
        }
        if (this.combo > this.maxCombo) this.maxCombo = this.combo;
        this.updateUI();
        if (this.currentSessionId) {
            const lane = (note as any).lane ?? 0;
            const events = await addNoteEvents(this.currentSessionId, [{
                sessionId: this.currentSessionId,
                lane,
                targetTimeS: targetTimeS ?? hitTimeS,
                hitTimeS,
                offsetMs,
                judgement: diff < this.perfectRange ? 'perfect' : 'good'
            }]);
            
            // 记录当前轨道命中的 NoteEvent 数据库 ID (Dexie 返回的是主键)
            if (events && events.length > 0) {
                this.laneActiveNoteIds.set(lane, events[0]);
            }
        }
    }

    private async handleInputUp(laneIndex: number) {
        const startTime = this.lanePressStartTimes.get(laneIndex);
        if (startTime) {
            const duration = Date.now() - startTime;
            this.lanePressStartTimes.delete(laneIndex);

            // 更新数据库中对应 NoteEvent 的按下时长
            const activeNoteId = this.laneActiveNoteIds.get(laneIndex);
            if (activeNoteId) {
                await db.noteEvents.update(activeNoteId, { 
                    pressDurationMs: duration,
                    synced: 0 // 标记为未同步，以便触发同步
                });
                this.laneActiveNoteIds.delete(laneIndex);
            }
        }
    }

    private showFeedback(text: string, color: number) {
        this.feedbackText.setText(text).setTint(color).setAlpha(1).setScale(1.2).setY(300);
        this.tweens.add({
            targets: this.feedbackText, alpha: 0, scale: 1.5, y: 250, duration: 400
        });
    }

    private updateUI() {
        this.scoreText.setText(`SCORE: ${this.score}`);
        this.comboText.setText(`COMBO: ${this.combo}`);
    }

    private pauseGame() {
        if (!this.isGameStarted || this.isGamePaused || this.isGameOver) return;
        this.isGamePaused = true;
        this.physics.pause();
        for (const note of this.notes) {
            const body = note.body as Phaser.Physics.Arcade.Body | undefined;
            if (body) body.setVelocity(0, 0);
        }
        try { this.tweens.pauseAll(); } catch {}
        try { this.sound.pauseAll(); } catch { if (this.currentBgm) this.currentBgm.pause(); }
        document.getElementById('pause-overlay')?.classList.remove('hidden');
    }

    private resumeGame() {
        if (!this.isGameStarted || !this.isGamePaused) return;
        this.isGamePaused = false;
        this.physics.resume();
        for (const note of this.notes) {
            const body = note.body as Phaser.Physics.Arcade.Body | undefined;
            if (body) body.setVelocity(0, this.noteSpeed);
        }
        try { this.tweens.resumeAll(); } catch {}
        try { this.sound.resumeAll(); } catch { if (this.currentBgm) this.currentBgm.resume(); }
        document.getElementById('pause-overlay')?.classList.add('hidden');
    }

    private togglePause() {
        if (!this.isGameStarted || this.isGameOver) return;
        if (this.isGamePaused) this.resumeGame();
        else this.pauseGame();
    }

    private async endGame() {
        this.isGameOver = true;
        this.physics.pause();
        if (this.currentBgm) this.currentBgm.stop();
        if (this.timerEvent) this.timerEvent.destroy();
        this.notes.forEach(note => note.destroy());
        this.notes = [];
        if (this.hitEffects) this.hitEffects.clear(true, true);
        try { this.tweens.resumeAll(); } catch {}
        
        const finalScoreText = document.getElementById('finalScore');
        if (finalScoreText) finalScoreText.innerText = this.score.toString();
        document.getElementById('game-over-overlay')?.classList.remove('hidden');
        const total = this.perfectCount + this.goodCount + this.missCount;
        const hitRate = total > 0 ? (this.perfectCount + this.goodCount) / total : 0;
        const avg = this.offsetsMs.length > 0 ? this.offsetsMs.reduce((a, b) => a + b, 0) / this.offsetsMs.length : 0;
        const variance = this.offsetsMs.length > 1 ? this.offsetsMs.reduce((s, v) => s + (v - avg) * (v - avg), 0) / (this.offsetsMs.length - 1) : 0;
        const std = Math.sqrt(variance);
        const durationSec = Math.max(0, this.gameTime - this.currentTime);
        if (this.currentSessionId) {
            await endSession(this.currentSessionId, {
                durationSec,
                score: this.score,
                hitRate,
                perfectCount: this.perfectCount,
                goodCount: this.goodCount,
                missCount: this.missCount,
                avgOffsetMs: Math.round(avg),
                stdOffsetMs: Math.round(std),
                maxCombo: this.maxCombo
            });
        }
    }

    private restartGame() {
        this.startGame();
    }

    update() {
        if (!this.isGameStarted || this.isGamePaused || this.isGameOver) return;

        if (this.chartData.length > 0 && this.currentBgm) {
            const bgmTime = (this.currentBgm as any).seek || 0; 
            const leadTime = (this.judgeY - this.spawnY) / this.noteSpeed;

            for (let i = 0; i < this.chartData.length; i++) {
                const note = this.chartData[i];
                if (!note.spawned && note.time <= bgmTime + leadTime) {
                    this.spawnNote(note.lane, note.time);
                    note.spawned = true;
                }
            }
        }

        for (let i = this.notes.length - 1; i >= 0; i--) {
            const note = this.notes[i];
            if (note.y > 650) {
                this.notes.splice(i, 1);
                note.destroy();
                this.combo = 0;
                this.missCount++;
                this.showFeedback('MISS', 0xf87171); // Danger red
                this.updateUI();
                if (this.currentSessionId) {
                    const targetTimeS = (note as any).targetTimeS as number | undefined;
                    const lane = (note as any).lane ?? 0;
                    addNoteEvents(this.currentSessionId, [{
                        sessionId: this.currentSessionId,
                        lane,
                        targetTimeS: targetTimeS ?? 0,
                        judgement: 'miss'
                    }]);
                }
            }
        }

        if (this.currentBgm && !this.currentBgm.isPlaying && !this.isGamePaused && this.notes.length === 0) {
            this.endGame();
        }
    }
}
