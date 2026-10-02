import type { EntryRow } from '@/data/types'

// 预警发布领域规则：级别、阈值、状态流转、搬迁回写都收敛到这一处，
// 列表、详情、工作台只能调用这里的判定结果，保证「两处口径」一致。

export const WARNING_MODULE = 'warning'
export const RELOCATE_MODULE = 'relocate'

// 环节只能按这个次序流转，跳到后面一律挡回。
export const WARNING_STATUSES = ['待发布', '已发布', '已解除', '已误报'] as const
export const WARNING_ACTIONS = ['确认发布', '解除预警', '标记误报'] as const

// 级别按低到高排列；触发雨量达到哪一档，就按那一档发布。
export const WARNING_LEVELS = ['蓝色预警', '黄色预警', '橙色预警', '红色预警'] as const
export const LEVEL_CALIBRATING = '待校准'
export const LEVEL_BELOW_BANDS = '未达预警档'

export type RainThresholds = {
  blue: number
  yellow: number
  orange: number
  red: number
}

// 现行雨量阈值（毫米，精确到 0.1mm）：蓝 20 / 黄 50 / 橙 100 / 红 200。
export const DEFAULT_THRESHOLDS: RainThresholds = {
  blue: 20,
  yellow: 50,
  orange: 100,
  red: 200,
}

const THRESHOLD_STORAGE_KEY = 'geohazard-patrol:warning-thresholds'
const TRANSFER_KIND = '待转移预警'

// 触发雨量必须是毫米、且精确到 0.1mm；整数毫米视为 0.1mm 的整十倍，合法。
export function parseRainMm(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (!/^\d+(\.\d)?$/.test(text)) {
    return null
  }
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) {
    return null
  }
  const tenths = Math.round(value * 10)
  if (Math.abs(tenths / 10 - value) > 1e-9) {
    return null
  }
  return tenths / 10
}

export function levelForRain(rain: number, thresholds: RainThresholds): string | null {
  if (rain >= thresholds.red) {
    return '红色预警'
  }
  if (rain >= thresholds.orange) {
    return '橙色预警'
  }
  if (rain >= thresholds.yellow) {
    return '黄色预警'
  }
  if (rain >= thresholds.blue) {
    return '蓝色预警'
  }
  return null
}

export type RainInfo = {
  raw: string
  rain: number | null
  precise: boolean
  level: string
}

// 任何页面要显示级别，都只能走这里：同一份触发雨量 + 同一份现行阈值，结论唯一。
export function rainInfo(row: Record<string, unknown>, thresholds: RainThresholds): RainInfo {
  const raw = String(row['触发雨量'] ?? '').trim()
  const rain = parseRainMm(raw)
  if (rain === null) {
    return { raw, rain: null, precise: false, level: LEVEL_CALIBRATING }
  }
  return { raw, rain, precise: true, level: levelForRain(rain, thresholds) ?? LEVEL_BELOW_BANDS }
}

export function loadThresholds(): RainThresholds {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_THRESHOLDS }
  }
  try {
    const raw = window.localStorage.getItem(THRESHOLD_STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_THRESHOLDS }
    }
    const parsed = JSON.parse(raw) as Partial<RainThresholds>
    const candidate = {
      blue: Number(parsed.blue),
      yellow: Number(parsed.yellow),
      orange: Number(parsed.orange),
      red: Number(parsed.red),
    }
    return validateThresholds(candidate) === null ? candidate : { ...DEFAULT_THRESHOLDS }
  } catch {
    return { ...DEFAULT_THRESHOLDS }
  }
}

export function saveThresholds(thresholds: RainThresholds): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(thresholds))
  }
}

// 阈值必须是 0.1mm 的正数倍，且严格蓝 < 黄 < 橙 < 红，否则不允许改。
export function validateThresholds(input: RainThresholds): string | null {
  const values = [input.blue, input.yellow, input.orange, input.red]
  const labels = ['蓝色档', '黄色档', '橙色档', '红色档']
  for (let i = 0; i < values.length; i += 1) {
    if (parseRainMm(values[i]) === null || values[i] <= 0) {
      return `${labels[i]}阈值必须是大于 0、精确到 0.1mm 的雨量值`
    }
  }
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] <= values[i - 1]) {
      return `${labels[i]}阈值必须高于${labels[i - 1]}阈值，四档要从低到高`
    }
  }
  return null
}

// 重判单条存量预警：
// 1) 预警级别一律按现行阈值重算，落库的老级别覆盖掉；
// 2) 触发雨量精度不足的，先退回「待发布」校准；
// 3) 发布渠道没填的，不允许停留在发布之后的环节，挡回「待发布」。
export function normalizeWarningRow(source: EntryRow, thresholds: RainThresholds): EntryRow {
  const info = rainInfo(source, thresholds)
  let status = String(source.status ?? WARNING_STATUSES[0])
  if (!WARNING_STATUSES.includes(status as (typeof WARNING_STATUSES)[number])) {
    status = WARNING_STATUSES[0]
  }
  const channelMissing = String(source['发布渠道'] ?? '').trim() === ''
  if (!info.precise && status !== '待发布') {
    status = '待发布'
  }
  if (channelMissing && status !== '待发布') {
    status = '待发布'
  }
  const abnormal = !info.precise || (channelMissing && status === '待发布')
  return {
    ...source,
    status,
    pending: status !== '已误报',
    abnormal,
    触发雨量: info.raw === '' ? source['触发雨量'] : info.raw,
    预警级别: info.level,
    预警状态: status,
  }
}

export function rejudgeWarnings(rows: EntryRow[], thresholds: RainThresholds): EntryRow[] {
  return rows.map((row) => normalizeWarningRow(row, thresholds))
}

// 已发布（含已解除、已误报）的预警，回写一条「待转移预警」到避险搬迁清单。
// 同一条预警只对应一条清单（按预警编号沿用）；预警退回待发布时，尚未转移的那条同步撤下。
export function syncTransferEntries(warnings: EntryRow[], relocations: EntryRow[]): EntryRow[] {
  const activeStatuses = ['已发布', '已解除', '已误报']
  const activeCodes = new Set(
    warnings
      .filter((row) => activeStatuses.includes(String(row.status)))
      .map((row) => String(row['预警编号'] ?? '')),
  )

  const result: EntryRow[] = []
  for (const row of relocations) {
    if (row['清单类别'] !== TRANSFER_KIND) {
      result.push(row)
      continue
    }
    const code = String(row['来源预警'] ?? '')
    if (!activeCodes.has(code)) {
      // 预警已退回待发布：还没完成转移的清单随预警撤下；已完成的留痕保留。
      if (String(row.status) === '待签订') {
        continue
      }
    }
    result.push(row)
  }

  let nextId = relocations.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const existingCodes = new Set(
    result.filter((row) => row['清单类别'] === TRANSFER_KIND).map((row) => String(row['来源预警'])),
  )

  for (const warning of warnings) {
    if (!activeStatuses.includes(String(warning.status))) {
      continue
    }
    const code = String(warning['预警编号'] ?? '')
    const existed = result.find(
      (row) => row['清单类别'] === TRANSFER_KIND && String(row['来源预警']) === code,
    )
    if (existed) {
      // 级别、雨量重判后回写到已有清单，沿用同一条记录，不新增。
      existed['所属隐患点'] = String(warning['发布对象'] ?? '')
      existed['预警级别'] = String(warning['预警级别'] ?? '')
      existed['触发雨量'] = warning['触发雨量']
      existed['发布渠道'] = warning['发布渠道']
      continue
    }
    if (existingCodes.has(code)) {
      continue
    }
    nextId += 1
    result.push({
      id: nextId,
      status: '待签订',
      pending: true,
      abnormal: false,
      清单类别: TRANSFER_KIND,
      搬迁编号: `TRANS-${code}`,
      所属隐患点: String(warning['发布对象'] ?? ''),
      涉及户数: '',
      安置方式: '避险转移',
      安置地点: '',
      签订日期: '',
      完成日期: '',
      搬迁状态: '',
      来源预警: code,
      预警级别: String(warning['预警级别'] ?? ''),
      触发雨量: warning['触发雨量'],
      发布渠道: warning['发布渠道'],
    })
    existingCodes.add(code)
  }
  return result
}

// 数据加载时执行一次：存量预警按现行阈值重判，搬迁清单按重判结果回写。
export function migrateStore(
  store: Record<string, EntryRow[]>,
  thresholds: RainThresholds = loadThresholds(),
): Record<string, EntryRow[]> {
  const warnings = rejudgeWarnings(store[WARNING_MODULE] ?? [], thresholds)
  const relocations = syncTransferEntries(warnings, store[RELOCATE_MODULE] ?? [])
  return { ...store, [WARNING_MODULE]: warnings, [RELOCATE_MODULE]: relocations }
}

export function todayText(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function monthText(value: unknown): string {
  const text = String(value ?? '').slice(0, 7)
  return /^\d{4}-\d{2}$/.test(text) ? text : ''
}

export function isCurrentMonth(value: unknown, now: Date = new Date()): boolean {
  const month = monthText(value)
  if (!month) {
    return false
  }
  return month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export type WarningStats = {
  pendingPublish: number
  published: number
  released: number
  falseAlarmsMonth: number
  calibration: number
  levelCounts: Record<string, number>
}

// 明细与「本月误报数」同源：都从同一份预警记录统计，不存在两处对不齐。
export function warningStats(rows: EntryRow[], now: Date = new Date()): WarningStats {
  const stats: WarningStats = {
    pendingPublish: 0,
    published: 0,
    released: 0,
    falseAlarmsMonth: 0,
    calibration: 0,
    levelCounts: {},
  }
  for (const row of rows) {
    const status = String(row.status)
    if (status === '待发布') {
      stats.pendingPublish += 1
    } else if (status === '已发布') {
      stats.published += 1
    } else if (status === '已解除') {
      stats.released += 1
    } else if (status === '已误报') {
      const mark = row['解除时间'] || row['发布时间']
      if (isCurrentMonth(mark, now)) {
        stats.falseAlarmsMonth += 1
      }
    }
    const level = String(row['预警级别'] ?? '')
    stats.levelCounts[level] = (stats.levelCounts[level] ?? 0) + 1
    if (level === LEVEL_CALIBRATING) {
      stats.calibration += 1
    }
  }
  return stats
}

// 状态 → 唯一允许的下一步动作；已是末态返回 null。
export function nextWarningAction(status: string): string | null {
  const index = WARNING_STATUSES.indexOf(status as (typeof WARNING_STATUSES)[number])
  return WARNING_ACTIONS[index] ?? null
}

export function thresholdBands(thresholds: RainThresholds): { level: string; min: number; key: keyof RainThresholds }[] {
  return [
    { level: '红色预警', min: thresholds.red, key: 'red' },
    { level: '橙色预警', min: thresholds.orange, key: 'orange' },
    { level: '黄色预警', min: thresholds.yellow, key: 'yellow' },
    { level: '蓝色预警', min: thresholds.blue, key: 'blue' },
  ]
}
