import Dexie from 'dexie'
import type { Table } from 'dexie'
import { createClient } from '@supabase/supabase-js'

// --- Supabase 初始化 ---
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('Supabase 环境变量未配置，云端同步功能将受限。请检查 .env 文件或平台环境变量设置。')
}

export const supabase = createClient(SUPABASE_URL || '', SUPABASE_ANON_KEY || '')

export type Judgement = 'perfect' | 'good' | 'miss'

export interface User {
  id: string
  name: string
  sex?: 'male' | 'female' | 'other'
  age?: number
  affectedSide?: 'left' | 'right' | 'both'
  illnessDurationMonths?: number
  illnessCause?: 'ischemic' | 'hemorrhagic' | 'unknown'
  functionalAssessment?: string
  complications?: string
  createdAt: string
  updatedAt?: string
  synced?: 0 | 1
}

export type HandPosture = 'rightUp' | 'rightDown' | 'leftUp' | 'leftDown'

export interface Session {
  id: string
  userId: string
  songId: string
  songName: string
  densityLevel: number
  trainingMode?: 'fourFinger' | 'singleFinger'
  targetFinger?: 'index' | 'middle' | 'ring' | 'pinky'
  handPosture?: HandPosture
  npmCap?: number
  minGapMs?: number
  chartAlgoVersion?: number
  masterChartLevel?: number
  generatedNoteCount?: number
  startedAt: string
  endedAt?: string
  durationSec?: number
  score?: number
  hitRate?: number
  perfectCount?: number
  goodCount?: number
  missCount?: number
  avgOffsetMs?: number
  stdOffsetMs?: number
  maxCombo?: number
  synced?: 0 | 1
  createdAt: string
}

export interface NoteEvent {
  id?: number
  sessionId: string
  lane: number
  targetTimeS: number
  hitTimeS?: number
  offsetMs?: number
  pressDurationMs?: number
  judgement?: Judgement
  synced?: 0 | 1
}

export interface DeviceReading {
  id?: number
  sessionId: string
  tMs: number
  deviceId: string
  sensorType: string
  value: unknown
  tags?: Record<string, unknown>
  synced?: 0 | 1
}

export interface Feature {
  id?: number
  sessionId: string
  name: string
  value: number
  unit?: string
  synced?: 0 | 1
}

export interface SettingKV {
  key: string
  value: unknown
  updatedAt: string
}

export interface SongData {
  id: string
  name: string
  audioUrl: string
  levels: {
    [key: number]: any
  }
  updatedAt: string
}

export class RehabDB extends Dexie {
  users!: Table<User, string>
  sessions!: Table<Session, string>
  noteEvents!: Table<NoteEvent, number>
  deviceReadings!: Table<DeviceReading, number>
  features!: Table<Feature, number>
  settings!: Table<SettingKV, string>
  songs!: Table<SongData, string>

  constructor() {
    super('rehab-db')
    // 基础版本
    this.version(1).stores({
      users: 'id, name, createdAt',
      sessions: 'id, userId, startedAt, synced',
      noteEvents: '++id, sessionId, synced',
      settings: 'key'
    })
    
    // 版本 3：引入 UUID 迁移后的结构，补回缺失的表
    this.version(3).stores({
      users: 'id, name, createdAt, synced',
      sessions: 'id, userId, startedAt, synced',
      noteEvents: '++id, sessionId, synced',
      deviceReadings: '++id, sessionId, synced',
      features: '++id, sessionId, synced',
      settings: 'key'
    })

    // 版本 4：增加 songs 表用于缓存动态歌曲
    this.version(4).stores({
      songs: 'id, name, updatedAt'
    })

    // 版本 5：为 sessions 增加训练模式与指头索引，便于筛选统计
    this.version(5).stores({
      sessions: 'id, userId, startedAt, synced, trainingMode, targetFinger'
    })

    this.version(6).stores({
      users: 'id, name, createdAt, synced, affectedSide, illnessCause',
      sessions: 'id, userId, startedAt, synced, trainingMode, targetFinger',
      noteEvents: '++id, sessionId, synced',
      deviceReadings: '++id, sessionId, synced',
      features: '++id, sessionId, synced',
      settings: 'key',
      songs: 'id, name, updatedAt'
    })
  }
}

export const db = new RehabDB()

// --- 工具函数 ---

/**
 * 获取北京时间 (UTC+8) 的 ISO 字符串
 * 注意：为了保持数据库兼容性，我们将时间偏移到北京时间，但后缀保留 Z 或不带时区，
 * 或者直接生成符合本地习惯的格式。
 */
export function getBeijingTimeISO() {
  // 恢复到最标准的方式：直接返回当前时刻的 ISO 字符串
  // 这样发送给数据库时会带上正确的时区信息（或 UTC），保证物理时间的准确性
  return new Date().toISOString()
}

export function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// --- 数据迁移逻辑 ---
export async function migrateToUUID() {
  const users = await db.users.toArray()
  const sessions = await db.sessions.toArray()
  
  // 检查是否包含旧的数字 ID (Dexie 会将其存为 number)
  const needsMigration = users.some(u => typeof u.id === 'number') || 
                        sessions.some(s => typeof s.id === 'number')
  
  if (!needsMigration) return

  console.log('检测到旧版本数据，正在启动 UUID 迁移...')

  await db.transaction('rw', db.users, db.sessions, db.noteEvents, async () => {
    const userMap = new Map<string | number, string>()
    const sessionMap = new Map<string | number, string>()

    // 1. 迁移用户
    for (const user of users) {
      if (typeof user.id === 'number') {
        const newId = genId()
        userMap.set(user.id, newId)
        const oldId = user.id
        await db.users.add({ ...user, id: newId, synced: 0 })
        await db.users.delete(oldId as any)
      }
    }

    // 2. 迁移会话
    for (const session of sessions) {
      const oldId = session.id
      const newId = typeof oldId === 'number' ? genId() : oldId
      if (typeof oldId === 'number') sessionMap.set(oldId, newId)
      
      const newUserId = userMap.get(session.userId) || session.userId
      
      if (typeof oldId === 'number' || newUserId !== session.userId) {
        await db.sessions.add({ ...session, id: newId as string, userId: newUserId, synced: 0 })
        await db.sessions.delete(oldId as any)
      }
    }

    // 3. 迁移音符事件 (关联 sessionId)
    const events = await db.noteEvents.toArray()
    for (const event of events) {
      const newSessionId = sessionMap.get(event.sessionId)
      if (newSessionId) {
        await db.noteEvents.update(event.id!, { sessionId: newSessionId, synced: 0 })
      }
    }
  })
  console.log('UUID 迁移完成。')
}

// --- 业务函数 ---

export async function listUsers() {
  return db.users.orderBy('createdAt').toArray()
}

export async function createUser(input: Omit<User, 'id' | 'createdAt' | 'updatedAt' | 'synced'> & { id?: string }) {
  const id = input.id || genId()
  const now = getBeijingTimeISO()
  const user: User = { ...input, id, createdAt: now, updatedAt: now, synced: 0 }
  await db.users.add(user)
  return id
}

export async function startSession(input: {
  userId: string
  songId: string
  songName: string
  densityLevel: number
  trainingMode?: Session['trainingMode']
  targetFinger?: Session['targetFinger']
  handPosture?: Session['handPosture']
  npmCap?: number
  minGapMs?: number
  chartAlgoVersion?: number
  masterChartLevel?: number
  generatedNoteCount?: number
}) {
  const id = genId()
  const now = getBeijingTimeISO()
  const session: Session = {
    ...input,
    id,
    startedAt: now,
    synced: 0,
    createdAt: now
  }
  await db.sessions.add(session)
  return id
}

export async function endSession(sessionId: string, summary: Partial<Session>) {
  const now = getBeijingTimeISO()
  await db.sessions.update(sessionId, {
    ...summary,
    endedAt: now,
    synced: 0
  })
}

export async function addNoteEvents(sessionId: string, events: NoteEvent[]) {
  const payload: NoteEvent[] = events.map(e => ({ ...e, sessionId, synced: 0 }))
  return db.noteEvents.bulkAdd(payload, { allKeys: true })
}

export async function addDeviceReadings(
  sessionId: string,
  rows: DeviceReading[]
) {
  const payload: DeviceReading[] = rows.map(r => ({ ...r, sessionId, synced: 0 }))
  await db.deviceReadings.bulkAdd(payload)
}

export async function addFeatures(sessionId: string, feats: Feature[]) {
  const payload: Feature[] = feats.map(f => ({ ...f, sessionId, synced: 0 }))
  await db.features.bulkAdd(payload)
}

export async function setSetting<T = unknown>(key: string, value: T) {
  const updatedAt = getBeijingTimeISO()
  await db.settings.put({ key, value, updatedAt })
}

export async function getSetting<T = unknown>(key: string) {
  const row = await db.settings.get(key)
  return row?.value as T | undefined
}

export async function deleteUserCascade(userId: string) {
  await db.transaction('rw', db.sessions, db.noteEvents, async () => {
    const sessions = await db.sessions.where('userId').equals(userId).toArray()
    const sids = sessions.map(s => s.id)
    if (sids.length > 0) {
      await db.noteEvents.where('sessionId').anyOf(sids).delete()
      await db.sessions.bulkDelete(sids)
    }
  })
  await db.users.delete(userId)
}

// --- 歌曲同步与获取 ---

/**
 * 从 Supabase 同步歌曲数据到本地 Dexie
 */
export async function syncSongs() {
  console.log('正在从 Supabase 同步歌曲列表...')
  try {
    const { data: remoteSongs, error } = await supabase
      .from('songs')
      .select('*')
    
    if (error) throw error
    if (!remoteSongs) return

    // 将 Supabase 的下划线字段映射到本地驼峰字段
    const formattedSongs: SongData[] = remoteSongs.map(s => ({
      id: s.id,
      name: s.name,
      audioUrl: s.audio_url,
      levels: s.levels, // 假设远程存储的就是 {1:..., 2:...} 这种格式
      updatedAt: s.updated_at
    }))

    // 批量更新本地缓存
    await db.songs.bulkPut(formattedSongs)
    console.log(`已同步 ${formattedSongs.length} 首云端歌曲`)
  } catch (err) {
    console.error('同步歌曲失败:', err)
  }
}

/**
 * 获取所有歌曲（包括本地缓存的云端歌曲）
 */
export async function getAllSongs() {
  return db.songs.toArray()
}

// --- Supabase 同步器 ---

export async function syncToSupabase() {
  console.log('开始同步到 Supabase...');
  try {
    // 1. 同步用户
    const unsyncedUsers = await db.users.where('synced').equals(0).toArray()
    console.log(`发现 ${unsyncedUsers.length} 个未同步用户`);
    if (unsyncedUsers.length > 0) {
      const payloadV2 = unsyncedUsers.map(u => ({
        id: u.id,
        name: u.name,
        sex: u.sex,
        age: u.age,
        affected_side: u.affectedSide,
        illness_duration_months: u.illnessDurationMonths,
        illness_cause: u.illnessCause,
        functional_assessment: u.functionalAssessment,
        complications: u.complications,
        created_at: u.createdAt
      }))
      const payloadV1 = unsyncedUsers.map(u => ({
        id: u.id,
        name: u.name,
        sex: u.sex,
        age: u.age,
        created_at: u.createdAt
      }))
      const res2 = await supabase.from('users').upsert(payloadV2)
      if (res2.error) {
        const msg = (res2.error as any)?.message || String(res2.error)
        const shouldFallback = msg.includes('column') || msg.includes('does not exist') || msg.includes('schema')
        if (shouldFallback) {
          const res1 = await supabase.from('users').upsert(payloadV1)
          if (res1.error) {
            console.error('同步用户失败:', res1.error)
          } else {
            console.log('同步用户成功:', res1.data)
            await db.users.bulkUpdate(unsyncedUsers.map(u => ({ key: u.id, changes: { synced: 1 } })))
          }
        } else {
          console.error('同步用户失败:', res2.error)
        }
      } else {
        console.log('同步用户成功:', res2.data)
        await db.users.bulkUpdate(unsyncedUsers.map(u => ({ key: u.id, changes: { synced: 1 } })))
      }
    }

    // 2. 同步会话
    // 注意：为了防止外键约束失败，我们只同步那些其所属用户已经同步成功的会话
    const syncedUserIds = (await db.users.where('synced').equals(1).toArray()).map(u => u.id)
    const unsyncedSessionsRaw = await db.sessions.where('synced').equals(0).toArray()
    const unsyncedSessions = unsyncedSessionsRaw.filter(s => syncedUserIds.includes(s.userId))
    
    console.log(`发现 ${unsyncedSessionsRaw.length} 个未同步会话，其中 ${unsyncedSessions.length} 个符合外键同步条件`);
    if (unsyncedSessions.length > 0) {
      const payloadV2 = unsyncedSessions.map(s => ({
        id: s.id,
        user_id: s.userId,
        song_id: s.songId,
        song_name: s.songName,
        density_level: s.densityLevel,
        training_mode: s.trainingMode,
        target_finger: s.targetFinger,
        hand_posture: s.handPosture,
        npm_cap: s.npmCap,
        min_gap_ms: s.minGapMs,
        chart_algo_version: s.chartAlgoVersion,
        master_chart_level: s.masterChartLevel,
        generated_note_count: s.generatedNoteCount,
        started_at: s.startedAt,
        ended_at: s.endedAt,
        duration_sec: s.durationSec,
        score: s.score,
        hit_rate: s.hitRate,
        perfect_count: s.perfectCount,
        good_count: s.goodCount,
        miss_count: s.missCount,
        avg_offset_ms: s.avgOffsetMs,
        std_offset_ms: s.stdOffsetMs,
        max_combo: s.maxCombo
      }))
      const payloadV1 = unsyncedSessions.map(s => ({
        id: s.id,
        user_id: s.userId,
        song_id: s.songId,
        song_name: s.songName,
        density_level: s.densityLevel,
        started_at: s.startedAt,
        ended_at: s.endedAt,
        duration_sec: s.durationSec,
        score: s.score,
        hit_rate: s.hitRate,
        perfect_count: s.perfectCount,
        good_count: s.goodCount,
        miss_count: s.missCount,
        avg_offset_ms: s.avgOffsetMs,
        std_offset_ms: s.stdOffsetMs,
        max_combo: s.maxCombo
      }))
      const res2 = await supabase.from('sessions').upsert(payloadV2)
      if (res2.error) {
        const msg = (res2.error as any)?.message || String(res2.error)
        const shouldFallback = msg.includes('column') || msg.includes('does not exist') || msg.includes('schema')
        if (shouldFallback) {
          const res1 = await supabase.from('sessions').upsert(payloadV1)
          if (res1.error) {
            console.error('同步会话失败:', res1.error)
          } else {
            console.log('同步会话成功:', res1.data)
            await db.sessions.bulkUpdate(unsyncedSessions.map(s => ({ key: s.id, changes: { synced: 1 } })))
          }
        } else {
          console.error('同步会话失败:', res2.error)
        }
      } else {
        console.log('同步会话成功:', res2.data)
        await db.sessions.bulkUpdate(unsyncedSessions.map(s => ({ key: s.id, changes: { synced: 1 } })))
      }
    }

    // 3. 同步音符事件 (分批 500 条)
    // 同样，只同步那些其所属会话已经同步成功的音符事件
    const syncedSessionIds = (await db.sessions.where('synced').equals(1).toArray()).map(s => s.id)
    const BATCH_SIZE = 500
    const unsyncedEventsRaw = await db.noteEvents.where('synced').equals(0).limit(BATCH_SIZE).toArray()
    const unsyncedEvents = unsyncedEventsRaw.filter(e => syncedSessionIds.includes(e.sessionId))
    
    console.log(`发现 ${unsyncedEventsRaw.length} 个未同步音符事件，其中 ${unsyncedEvents.length} 个符合外键同步条件`);
    if (unsyncedEvents.length > 0) {
      const { data, error } = await supabase.from('note_events').insert(
        unsyncedEvents.map(e => ({
          session_id: e.sessionId,
          lane: e.lane,
          target_time_s: e.targetTimeS,
          hit_time_s: e.hitTimeS,
          offset_ms: e.offsetMs,
          press_duration_ms: e.pressDurationMs,
          judgement: e.judgement
        }))
      )
      if (error) {
        console.error('同步音符事件失败:', error);
      } else {
        console.log('同步音符事件成功:', data);
        await db.noteEvents.bulkUpdate(unsyncedEvents.map(e => ({ key: e.id!, changes: { synced: 1 } })))
      }
    }
  } catch (err) {
    console.error('Supabase Sync Error:', err)
  }
}
