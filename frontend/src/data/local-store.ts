import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
export const STORAGE_KEY = 'geohazard-patrol:entries'
// 数据结构版本：字段或口径调整时递增，老缓存会走 migrateRows 而不是整包沿用旧值。
const STORAGE_VERSION_KEY = 'geohazard-patrol:entries-version'
const STORAGE_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 老缓存迁移：只按 key 合并数组本身，逐条补上种子里新增的字段，
 * 这样阈值口径、新增列（如避险搬迁的「待转移预警」）调整后，旧值不会反复冒出来。
 */
function migrateRows(
  stored: Record<string, EntryRow[]>,
  fallback: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const merged: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(fallback)) {
    const seedList = fallback[key]
    const storedList = stored[key]
    if (!storedList) {
      merged[key] = seedList
      continue
    }
    const seedById = new Map(seedList.map((row) => [Number(row.id), row]))
    merged[key] = storedList.map((row) => {
      const seed = seedById.get(Number(row.id))
      // 以存量记录为底，补齐种子里新增/缺失的字段；用户业务数据不被覆盖。
      return seed ? { ...seed, ...row } : { ...row }
    })
  }
  // 本地新增过、种子里没有的模块（如预警回写产生的搬迁单）原样保留。
  for (const key of Object.keys(stored)) {
    if (!(key in merged)) {
      merged[key] = stored[key]
    }
  }
  return merged
}

function readVersion(): number {
  if (typeof window === 'undefined' || !window.localStorage) {
    return STORAGE_VERSION
  }
  return Number(window.localStorage.getItem(STORAGE_VERSION_KEY) || '1')
}

function writeVersion(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    writeVersion()
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = readVersion()
    const data = version < STORAGE_VERSION ? migrateRows(parsed, fallback) : { ...fallback, ...parsed }
    if (version < STORAGE_VERSION) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      writeVersion()
    }
    return data
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    writeVersion()
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
