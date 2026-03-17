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

type TrainingMode = 'fourFinger' | 'singleFinger';
type FingerName = 'index' | 'middle' | 'ring' | 'pinky';

const generatedChartCache = new Map<string, NoteInfo[]>();

export class GameScene extends Phaser.Scene {
    private lanes = [200, 333, 466, 600];
    private laneKeys = ['D', 'F', 'J', 'K'];
    private handPosture: 'indexRight' | 'indexLeft' = 'indexRight';
    private laneLabels: Phaser.GameObjects.Text[] = [];
    private laneLines: Phaser.GameObjects.Rectangle[] = [];
    private notes: Phaser.GameObjects.Rectangle[] = [];
    private laneGlows: Phaser.GameObjects.Rectangle[] = [];
    private hitEffects!: Phaser.GameObjects.Group;
    private trainingMode: TrainingMode = 'fourFinger';
    private targetFinger: FingerName = 'index';
    
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
                this.load.json(`chart-${song.id}-level-4`, `assets/songs/${song.id}/chart_level_4.json`);
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

        const judgeBg = this.add.graphics();
        const judgeColor = 0x4cc9f0;
        const judgeAreaWidth = 600;
        const judgeAlpha = 0.18;
        const left = width / 2 - judgeAreaWidth / 2;
        judgeBg.fillGradientStyle(judgeColor, judgeColor, judgeColor, judgeColor, 0, 0, judgeAlpha, judgeAlpha);
        judgeBg.fillRect(left, 0, judgeAreaWidth, this.judgeY);
        judgeBg.fillGradientStyle(judgeColor, judgeColor, judgeColor, judgeColor, judgeAlpha, judgeAlpha, 0, 0);
        judgeBg.fillRect(left, this.judgeY, judgeAreaWidth, height - this.judgeY);

        this.hitSound = this.sound.add('hit', { volume: 0.8 });

        const fingerLabels = this.getFingerLabels();
        this.lanes.forEach((x, i) => {
            const laneLine = this.add.rectangle(x, height / 2, 2, height, 0xffffff, 0.1);
            this.laneLines.push(laneLine);
            const glow = this.add.rectangle(x, height / 2, 100, height, 0x4361ee, 0);
            this.laneGlows.push(glow);
            const label = this.add.text(x, height - 40, fingerLabels[i], {
                fontSize: '28px', fontStyle: 'bold', color: '#4cc9f0'
            }).setOrigin(0.5);
            this.laneLabels.push(label);

            const clickZone = this.add.rectangle(x, height / 2, 100, height, 0x000000, 0.01)
                .setInteractive({ useHandCursor: true });
            
            clickZone.on('pointerdown', () => {
                if (!this.isGameStarted || this.isGamePaused || this.isGameOver) return;
                if (!this.isLaneActive(i)) return;
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
                if (!this.isLaneActive(laneIndex)) return;
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
        this.updateLaneEmphasis();
    }

    private updateTopRightUserDisplay(users: any[], currentId: string | null | undefined) {
        const targetId = this.currentUserId || currentId;
        const current = users.find(u => u.id === targetId);
        const labelName = current?.name || '用戶';
        const userBtnEl = document.getElementById('userBtn');
        if (userBtnEl) userBtnEl.textContent = `用戶：${labelName}`;
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
        const postureRightBtn = document.getElementById('postureIndexRight') as HTMLButtonElement | null;
        const postureLeftBtn = document.getElementById('postureIndexLeft') as HTMLButtonElement | null;
        const trainModeFourBtn = document.getElementById('trainModeFour') as HTMLButtonElement | null;
        const trainModeSingleBtn = document.getElementById('trainModeSingle') as HTMLButtonElement | null;
        const singleFingerPanel = document.getElementById('singleFingerPanel') as HTMLDivElement | null;
        const fingerIndexBtn = document.getElementById('fingerIndex') as HTMLButtonElement | null;
        const fingerMiddleBtn = document.getElementById('fingerMiddle') as HTMLButtonElement | null;
        const fingerRingBtn = document.getElementById('fingerRing') as HTMLButtonElement | null;
        const fingerPinkyBtn = document.getElementById('fingerPinky') as HTMLButtonElement | null;

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
                const defaultId = await createUser({ name: '訪客' });
                await setSetting('currentUserId', defaultId);
                this.currentUserId = defaultId;
                users.push({ id: defaultId, name: '訪客', createdAt: new Date().toISOString() } as any);
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
                    if (userPrefs.handPosture === 'indexLeft' || userPrefs.handPosture === 'indexRight') {
                        this.applyHandPosture(userPrefs.handPosture);
                        if (postureRightBtn && postureLeftBtn) {
                            postureRightBtn.classList.toggle('selected', userPrefs.handPosture === 'indexRight');
                            postureLeftBtn.classList.toggle('selected', userPrefs.handPosture === 'indexLeft');
                        }
                    } else {
                        this.applyHandPosture('indexRight');
                        if (postureRightBtn) postureRightBtn.classList.add('selected');
                        if (postureLeftBtn) postureLeftBtn.classList.remove('selected');
                    }
                    if (userPrefs.targetFinger === 'index' || userPrefs.targetFinger === 'middle' || userPrefs.targetFinger === 'ring' || userPrefs.targetFinger === 'pinky') {
                        this.targetFinger = userPrefs.targetFinger;
                    } else {
                        this.targetFinger = 'index';
                    }
                    if (userPrefs.trainingMode === 'singleFinger' || userPrefs.trainingMode === 'fourFinger') {
                        this.applyTrainingMode(userPrefs.trainingMode);
                    } else {
                        this.applyTrainingMode('fourFinger');
                    }
                }
            }

            this.updateTopRightUserDisplay(users, currentId);
            this.syncTrainingUI(trainModeFourBtn, trainModeSingleBtn, singleFingerPanel, fingerIndexBtn, fingerMiddleBtn, fingerRingBtn, fingerPinkyBtn);
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
                if (msgEl) msgEl.textContent = '請先輸入姓名';
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
                if (msgEl) msgEl.textContent = '已保存，並設為目前用戶';
                await this.refreshUserPanel();
                if (userManageForm) userManageForm.classList.add('hidden');
            } catch (e: any) {
                const m = e?.message || String(e);
                const msg = m.includes('IDBObjectStore') || m.includes('DataError') ? '保存失敗：本地資料庫結構不一致' : `保存失敗：${m}`;
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
            if (userBtnEl && opt) userBtnEl.textContent = `用戶：${opt.text}`;
        });
        userDeleteBtn?.addEventListener('click', async () => {
            if (!userManageSelect?.value) return;
            const id = userManageSelect.value;
            const ok = window.confirm('確定刪除該用戶及其全部訓練記錄？此操作不可恢復。');
            if (!ok) return;
            await deleteUserCascade(id);
            let users = await listUsers();
            if (users.length === 0) {
                const defaultId = await createUser({ name: '訪客' });
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
                if (msgEl) msgEl.textContent = '請先輸入姓名';
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
                if (msgEl) msgEl.textContent = '已保存，並設為目前用戶';
                await initUsers();
                if (userForm) userForm.style.display = 'none';
            } catch (e: any) {
                const m = e?.message || String(e);
                if (msgEl) {
                    if (m.includes('IDBObjectStore') || m.includes('DataError')) {
                        msgEl.textContent = '保存失敗：本地資料庫結構與目前版本不一致，請點擊「清理本地資料庫」後重試';
                    } else {
                        msgEl.textContent = `保存失敗：${m}`;
                    }
                }
            }
        });

        

        const densityLabels = ['20 NPM', '35 NPM', '55 NPM', '75 NPM'];
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
                    const defaultId = await createUser({ name: '訪客' });
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
        
        const saveHandPosture = async (val: 'indexRight' | 'indexLeft') => {
            if (this.currentUserId) {
                const prefs = await getSetting<any>(`userPrefs_${this.currentUserId}`) || {};
                await setSetting(`userPrefs_${this.currentUserId}`, { ...prefs, handPosture: val });
            }
        };
        postureRightBtn?.addEventListener('click', async () => {
            this.applyHandPosture('indexRight');
            postureRightBtn.classList.add('selected');
            postureLeftBtn?.classList.remove('selected');
            await saveHandPosture('indexRight');
        });
        postureLeftBtn?.addEventListener('click', async () => {
            this.applyHandPosture('indexLeft');
            postureLeftBtn.classList.add('selected');
            postureRightBtn?.classList.remove('selected');
            await saveHandPosture('indexLeft');
        });

        const saveTrainingPrefs = async (patch: Partial<{ trainingMode: TrainingMode; targetFinger: FingerName }>) => {
            if (!this.currentUserId) return;
            const prefs = await getSetting<any>(`userPrefs_${this.currentUserId}`) || {};
            await setSetting(`userPrefs_${this.currentUserId}`, { ...prefs, ...patch });
        };

        trainModeFourBtn?.addEventListener('click', async () => {
            this.applyTrainingMode('fourFinger');
            this.syncTrainingUI(trainModeFourBtn, trainModeSingleBtn, singleFingerPanel, fingerIndexBtn, fingerMiddleBtn, fingerRingBtn, fingerPinkyBtn);
            await saveTrainingPrefs({ trainingMode: 'fourFinger' });
        });
        trainModeSingleBtn?.addEventListener('click', async () => {
            this.applyTrainingMode('singleFinger');
            this.syncTrainingUI(trainModeFourBtn, trainModeSingleBtn, singleFingerPanel, fingerIndexBtn, fingerMiddleBtn, fingerRingBtn, fingerPinkyBtn);
            await saveTrainingPrefs({ trainingMode: 'singleFinger', targetFinger: this.targetFinger });
        });

        const bindFinger = (btn: HTMLButtonElement | null, finger: FingerName) => {
            btn?.addEventListener('click', async () => {
                this.targetFinger = finger;
                this.updateLaneEmphasis();
                this.syncTrainingUI(trainModeFourBtn, trainModeSingleBtn, singleFingerPanel, fingerIndexBtn, fingerMiddleBtn, fingerRingBtn, fingerPinkyBtn);
                await saveTrainingPrefs({ targetFinger: finger });
            });
        };
        bindFinger(fingerIndexBtn, 'index');
        bindFinger(fingerMiddleBtn, 'middle');
        bindFinger(fingerRingBtn, 'ring');
        bindFinger(fingerPinkyBtn, 'pinky');
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
                    { label: '性別', value: (sexMap as any)[current.sex || ''] || '未指定' },
                    { label: '年齡', value: current.age ? `${current.age} 歲` : '未指定' },
                    { label: '主用手', value: current.handDominance === 'left' ? '左手' : current.handDominance === 'right' ? '右手' : current.handDominance === 'both' ? '雙手' : '未指定' },
                    { label: '康復階段', value: current.rehabPhase || '未指定' }
                ];
                userInfoText.innerHTML = items.map(item => `
                    <div class="info-item">
                        <span class="info-label">${item.label}</span>
                        <span class="info-value">${item.value}</span>
                    </div>
                `).join('');
            } else {
                userInfoText.innerHTML = '<div style="grid-column: span 3; text-align:center; color:#94a3b8;">未選擇用戶</div>';
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
                const mode = (r as any).trainingMode === 'singleFinger' ? '單指' : '四指';
                const fingerMap: any = { index: '食指', middle: '中指', ring: '無名指', pinky: '小拇指' };
                const finger = (r as any).trainingMode === 'singleFinger' ? (fingerMap[(r as any).targetFinger] || '未知') : '';
                const modeText = (r as any).trainingMode === 'singleFinger' ? `${mode}（${finger}）` : mode;
                
                return `
                    <div class="record-card">
                        <div class="record-main">
                            <div class="record-time">📅 ${t}</div>
                            <div class="record-detail">🎵 ${name}</div>
                            <div class="record-time">🧠 ${modeText}</div>
                        </div>
                        <div class="record-score">
                            <div class="record-score-val">${score}</div>
                            <div class="record-hit-rate">準確率 ${hr}</div>
                        </div>
                    </div>
                `;
            }).join('');
            userSessions.innerHTML = items || '<div style="text-align:center; padding:20px; color:#94a3b8;">暫無歷史記錄</div>';
        }
    }

    private async startGame() {
        const audioKey = `audio-${this.currentSongId}`;
        
        // 根据难度动态调整下落速度
        const speeds = { 1: 220, 2: 300, 3: 400, 4: 500 };
        this.noteSpeed = (speeds as any)[this.currentDensity] || 400;
        
        const masterKey = this.getMasterChartKey(this.currentSongId);
        if (masterKey && this.cache.json.exists(masterKey)) {
            const master = this.cache.json.get(masterKey) as any[];
            this.chartData = this.getGeneratedChart(this.currentSongId, master);
            this.gameTime = this.chartData.length > 0 ? Math.ceil(this.chartData[this.chartData.length - 1].time + 5) : 60;
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
        const masterLevel = masterKey ? parseInt(masterKey.split('-').pop() || '') : undefined;
        const npmCap = this.getNpmCap(this.currentDensity);
        const minGapMs = this.trainingMode === 'singleFinger' ? this.getSingleMinGapMs(this.currentDensity) : 0;
        this.currentSessionId = await startSession({
            userId: this.currentUserId || 'local-user',
            songId: this.currentSongId,
            songName,
            densityLevel: this.currentDensity,
            trainingMode: this.trainingMode,
            targetFinger: this.trainingMode === 'singleFinger' ? this.targetFinger : undefined,
            handPosture: this.handPosture,
            npmCap,
            minGapMs,
            chartAlgoVersion: 1,
            masterChartLevel: Number.isFinite(masterLevel as any) ? (masterLevel as any) : undefined,
            generatedNoteCount: this.chartData.length
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
            if (!this.isLaneActive(lane)) return;
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

    private applyHandPosture(posture: 'indexRight' | 'indexLeft') {
        this.handPosture = posture;
        this.laneKeys = posture === 'indexRight' ? ['D', 'F', 'J', 'K'] : ['K', 'J', 'F', 'D'];
        const labels = this.getFingerLabels();
        for (let i = 0; i < this.laneLabels.length; i++) {
            const t = this.laneLabels[i];
            if (t) t.setText(labels[i]);
        }
        this.updateLaneEmphasis();
    }

    private getFingerLabels(): string[] {
        if (this.handPosture === 'indexLeft') {
            return ['食指', '中指', '無名指', '小拇指'];
        } else {
            return ['小拇指', '無名指', '中指', '食指'];
        }
    }

    private applyTrainingMode(mode: TrainingMode) {
        this.trainingMode = mode;
        this.updateLaneEmphasis();
    }

    private isLaneActive(laneIndex: number): boolean {
        if (this.trainingMode !== 'singleFinger') return true;
        const targetLane = this.fingerToLane(this.targetFinger, this.handPosture);
        return laneIndex === targetLane;
    }

    private updateLaneEmphasis() {
        for (let i = 0; i < 4; i++) {
            const active = this.isLaneActive(i);
            const label = this.laneLabels[i];
            const line = this.laneLines[i];
            const glow = this.laneGlows[i];
            if (label) label.setAlpha(active ? 1 : 0.25);
            if (line) line.setAlpha(active ? 0.1 : 0.03);
            if (glow) glow.setAlpha(0);
        }
    }

    private syncTrainingUI(
        trainModeFourBtn: HTMLButtonElement | null,
        trainModeSingleBtn: HTMLButtonElement | null,
        singleFingerPanel: HTMLDivElement | null,
        fingerIndexBtn: HTMLButtonElement | null,
        fingerMiddleBtn: HTMLButtonElement | null,
        fingerRingBtn: HTMLButtonElement | null,
        fingerPinkyBtn: HTMLButtonElement | null
    ) {
        trainModeFourBtn?.classList.toggle('selected', this.trainingMode === 'fourFinger');
        trainModeSingleBtn?.classList.toggle('selected', this.trainingMode === 'singleFinger');
        singleFingerPanel?.classList.toggle('hidden', this.trainingMode !== 'singleFinger');
        fingerIndexBtn?.classList.toggle('selected', this.targetFinger === 'index');
        fingerMiddleBtn?.classList.toggle('selected', this.targetFinger === 'middle');
        fingerRingBtn?.classList.toggle('selected', this.targetFinger === 'ring');
        fingerPinkyBtn?.classList.toggle('selected', this.targetFinger === 'pinky');
    }

    private getMasterChartKey(songId: string): string | undefined {
        for (let i = 4; i >= 1; i--) {
            const key = `chart-${songId}-level-${i}`;
            if (this.cache.json.exists(key)) return key;
        }
        return undefined;
    }

    private getNpmCap(level: number): number {
        const map = { 1: 20, 2: 35, 3: 55, 4: 75 };
        return (map as any)[level] || 55;
    }

    private getSingleMinGapMs(level: number): number {
        const map = { 1: 500, 2: 350, 3: 250, 4: 180 };
        return (map as any)[level] || 250;
    }

    private fingerToLane(finger: FingerName, posture: 'indexRight' | 'indexLeft'): number {
        const laneToFinger: FingerName[] = posture === 'indexLeft'
            ? ['index', 'middle', 'ring', 'pinky']
            : ['pinky', 'ring', 'middle', 'index'];
        return Math.max(0, laneToFinger.indexOf(finger));
    }

    private getGeneratedChart(songId: string, masterNotes: any[]): NoteInfo[] {
        const npmCap = this.getNpmCap(this.currentDensity);
        const minGapMs = this.trainingMode === 'singleFinger' ? this.getSingleMinGapMs(this.currentDensity) : 0;
        const cacheKey = JSON.stringify({
            v: 1,
            songId,
            mode: this.trainingMode,
            posture: this.handPosture,
            finger: this.targetFinger,
            npmCap,
            minGapMs
        });
        const cached = generatedChartCache.get(cacheKey);
        if (cached) return cached.map(n => ({ ...n, spawned: false }));

        const normalized: { time: number; lane: number }[] = (masterNotes || [])
            .map((n: any) => ({ time: Number(n.time), lane: Number(n.lane) }))
            .filter(n => Number.isFinite(n.time) && Number.isFinite(n.lane))
            .sort((a, b) => a.time - b.time);

        let working: { time: number; lane: number }[] = normalized;
        if (this.trainingMode === 'singleFinger') {
            const targetLane = this.fingerToLane(this.targetFinger, this.handPosture);
            const minGapS = Math.max(0, minGapMs) / 1000;
            const kept: { time: number; lane: number }[] = [];
            let lastTime = -Infinity;
            for (const n of working) {
                const t = n.time;
                if (t - lastTime >= minGapS) {
                    kept.push({ time: t, lane: targetLane });
                    lastTime = t;
                }
            }
            working = kept;
        }

        const lastTime = working.length > 0 ? working[working.length - 1].time : 0;
        const durationMin = Math.max(0.01, lastTime / 60);
        const targetCount = Math.max(1, Math.floor(npmCap * durationMin));
        if (working.length > targetCount) {
            const down: { time: number; lane: number }[] = [];
            const step = working.length / targetCount;
            for (let i = 0; i < targetCount; i++) {
                const idx = Math.min(working.length - 1, Math.floor(i * step));
                down.push(working[idx]);
            }
            working = down;
        }

        const result = working.map(n => ({ time: n.time, lane: n.lane, spawned: false }));
        generatedChartCache.set(cacheKey, result.map(n => ({ ...n })));
        return result;
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
