import type { EntryRow } from './types'

/**
 * 预警领域规则：预警级别、状态流转、登记校验都以这里为唯一口径。
 * 页面与本地数据服务都不自己判级别，避免「触发雨量算出来的级别」和「落库标注」两套结论。
 */

// 预警环节固定次序：只能相邻向后流转，跳到后面的环节一律挡回。
export const WARNING_STATUS_FLOW = ['待发布', '已发布', '已解除', '已误报'] as const
export type WarningStatus = (typeof WARNING_STATUS_FLOW)[number]

// 各环节允许执行的动作：动作目标必须是当前环节的下一环节，不能跳级。
export const WARNING_ACTION_FROM: Record<string, WarningStatus> = {
  确认发布: '待发布',
  解除预警: '已发布',
  标记误报: '已发布',
}

// 预警级别（发布口径）：蓝 < 黄 < 橙 < 红，由重到轻排列便于「达到哪一档按哪一档」判定。
export const WARNING_LEVELS = ['红色', '橙色', '黄色', '蓝色'] as const
export type WarningLevel = (typeof WARNING_LEVELS)[number]

/**
 * 现行雨量阈值（单位 mm，24 小时累计降雨量）：
 * 触发雨量达到哪一档的下限，就按那一档发布；取「就高不就低」的命中档。
 * 修改这里的阈值后，应调用 rejudgeWarnings() 把存量预警按新标准重判一遍。
 */
export const DEFAULT_LEVEL_THRESHOLDS: Record<Exclude<WarningLevel, '蓝色'>, number> = {
  红色: 200,
  橙色: 100,
  黄色: 50,
}
// 蓝色为关注级：有有效触发雨量（达到观测下限）但未到黄色阈值时按蓝色发布。
export const RAIN_MIN_MM = 0.1

// 触发雨量允许的最小精度（mm）：比这更小的值视为精度不够，先退回校准，不参与定级。
export const RAIN_PRECISION_MM = 0.1

export const RELEASE_CHANNELS = ['短信', '电话', '应急广播', '上门通知'] as const

const THRESHOLD_STORAGE_KEY = 'geohazard-patrol:warning-thresholds'

function cloneThresholds(
  source: Record<string, number>,
): Record<Exclude<WarningLevel, '蓝色'>, number> {
  return {
    红色: Number(source.红色 ?? DEFAULT_LEVEL_THRESHOLDS.红色),
    橙色: Number(source.橙色 ?? DEFAULT_LEVEL_THRESHOLDS.橙色),
    黄色: Number(source.黄色 ?? DEFAULT_LEVEL_THRESHOLDS.黄色),
  }
}

/** 读取现行阈值；阈值只存这一份，页面标注、落库定级、存量重判都以它为准。 */
export function readThresholds(): Record<Exclude<WarningLevel, '蓝色'>, number> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_LEVEL_THRESHOLDS }
  }
  const raw = window.localStorage.getItem(THRESHOLD_STORAGE_KEY)
  if (!raw) {
    return { ...DEFAULT_LEVEL_THRESHOLDS }
  }
  try {
    return normalizeThresholds(JSON.parse(raw) as Record<string, number>)
  } catch {
    return { ...DEFAULT_LEVEL_THRESHOLDS }
  }
}

/** 保存新阈值并做口径校验：必须满足 红 > 橙 > 黄 > 0，且各档至少相差一个最小精度。 */
export function saveThresholds(input: Record<string, number>): {
  ok: boolean
  message: string
  thresholds?: Record<Exclude<WarningLevel, '蓝色'>, number>
} {
  const normalized = normalizeThresholds(input)
  const check = validateThresholds(normalized)
  if (!check.ok) {
    return check
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(normalized))
  }
  return { ok: true, message: '阈值已更新', thresholds: normalized }
}

export function normalizeThresholds(
  input: Record<string, number>,
): Record<Exclude<WarningLevel, '蓝色'>, number> {
  return cloneThresholds({
    红色: Number(input.红色),
    橙色: Number(input.橙色),
    黄色: Number(input.黄色),
  })
}

export function validateThresholds(
  thresholds: Record<string, number>,
): { ok: boolean; message: string } {
  const values = [thresholds.红色, thresholds.橙色, thresholds.黄色]
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return { ok: false, message: '阈值必须是大于 0 的数字（单位 mm）' }
  }
  if (!(thresholds.黄色 < thresholds.橙色 && thresholds.橙色 < thresholds.红色)) {
    return { ok: false, message: '阈值口径必须满足 红色 > 橙色 > 黄色，请核对后再保存' }
  }
  return { ok: true, message: '' }
}

/** 解析触发雨量：非数字、NaN、低于最小精度一律视为精度不够，需退回校准。 */
export function parseRainMm(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= RAIN_PRECISION_MM ? value : null
  }
  const text = String(value ?? '').trim()
  if (text === '') {
    return null
  }
  const num = Number(text)
  if (!Number.isFinite(num) || num < RAIN_PRECISION_MM) {
    return null
  }
  return num
}

/**
 * 按现行阈值判定预警级别（唯一发布口径）：
 * 达到哪一档的下限就按那一档发布，从红色往下匹配，命中即返回。
 */
export function judgeLevel(
  rainMm: number,
  thresholds: Record<Exclude<WarningLevel, '蓝色'>, number> = readThresholds(),
): WarningLevel {
  if (rainMm >= thresholds.红色) {
    return '红色'
  }
  if (rainMm >= thresholds.橙色) {
    return '橙色'
  }
  if (rainMm >= thresholds.黄色) {
    return '黄色'
  }
  return '蓝色'
}

export function isSameLevel(a: unknown, b: unknown): boolean {
  return String(a ?? '') === String(b ?? '')
}

/** 预警级别与触发雨量是否和现行阈值口径对得上。 */
export function levelMatchesThreshold(row: EntryRow): boolean {
  const rain = parseRainMm(row.触发雨量)
  if (rain === null) {
    return false
  }
  return isSameLevel(row.预警级别, judgeLevel(rain))
}

export function statusIndex(status: unknown): number {
  return WARNING_STATUS_FLOW.indexOf(String(status) as WarningStatus)
}

/** 动作能否在当前环节执行：只允许走到相邻的下一环节，跳级挡回。 */
export function canRunAction(action: string, currentStatus: unknown): { ok: boolean; message: string } {
  const requiredFrom = WARNING_ACTION_FROM[action]
  if (!requiredFrom) {
    return { ok: false, message: `没有登记「${action}」这个预警动作` }
  }
  const target = WARNING_STATUS_FLOW[statusIndex(requiredFrom) + 1]
  if (String(currentStatus) !== requiredFrom) {
    return {
      ok: false,
      message: `环节只能按「待发布 → 已发布 → 已解除 / 已误报」的次序流转，当前为「${String(
        currentStatus,
      )}」，不能${action}`,
    }
  }
  return { ok: true, message: target }
}

/** 预警编号规则：WARN-四位流水号。 */
export function formatWarningCode(seq: number): string {
  return `WARN-${String(seq).padStart(4, '0')}`
}
