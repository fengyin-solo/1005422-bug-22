import {
  DEFAULT_THRESHOLDS,
  LEVEL_BELOW_BANDS,
  LEVEL_CALIBRATING,
  RELOCATE_MODULE,
  WARNING_ACTIONS,
  WARNING_MODULE,
  WARNING_STATUSES,
  loadThresholds,
  migrateStore,
  normalizeWarningRow,
  parseRainMm,
  rainInfo,
  rejudgeWarnings,
  saveThresholds,
  syncTransferEntries,
  thresholdBands,
  todayText,
  validateThresholds,
  warningStats,
  type RainThresholds,
} from '@/domain/warning'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export { DEFAULT_THRESHOLDS, LEVEL_BELOW_BANDS, LEVEL_CALIBRATING, thresholdBands }
export type { RainThresholds }

export type WarningDraft = {
  预警编号: string
  发布对象: string
  触发雨量: string
  发布渠道: string
  发布时间?: string
}

export type WarningOverview = {
  thresholds: RainThresholds
  stats: ReturnType<typeof warningStats>
  pendingTransfers: number
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 预警动作的落库后处理：发布填发布时间，解除/误报填解除时间，级别按现行阈值重算，
// 结果同步回避险搬迁清单。
function persistWarningChange(rows: EntryRow[], thresholds: RainThresholds): EntryRow[] {
  return rejudgeWarnings(rows, thresholds)
}

function syncRelocations(warnings: EntryRow[]): EntryRow[] {
  const relocations = syncTransferEntries(warnings, listRows(RELOCATE_MODULE))
  saveRows(RELOCATE_MODULE, relocations)
  return relocations
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 预警环节只能按登记次序逐步流转：目标状态必须正好是当前状态的下一档，跳跃一律挡回。
  // 其他模块保持原有动作语义（如「取消」允许从较早环节直达末态）。
  if (key === WARNING_MODULE) {
    const order: readonly string[] = WARNING_STATUSES
    const currentIndex = order.indexOf(current)
    const targetIndex = order.indexOf(target)
    if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        message: `环节只能按「${order.join(' → ')}」的次序流转，不能从「${current}」直接跳到「${target}」，已挡回`,
      }
    }
  }

  if (key === WARNING_MODULE) {
    const thresholds = loadThresholds()
    if (action === '确认发布') {
      const info = rainInfo(rows[index], thresholds)
      if (!info.precise) {
        return { ok: false, message: '触发雨量精度不足（需精确到 0.1mm），先退回校准后再发布' }
      }
      if (info.level === LEVEL_BELOW_BANDS) {
        return {
          ok: false,
          message: `触发雨量 ${info.raw}mm 未达到蓝色档（${thresholds.blue}mm），不构成预警，不能发布`,
        }
      }
      if (String(rows[index]['发布渠道'] ?? '').trim() === '') {
        return { ok: false, message: '发布渠道没填的预警不允许发布，先补全发布渠道' }
      }
    }
    const today = todayText()
    const patch: EntryRow = { ...rows[index] }
    if (action === '确认发布' && String(patch['发布时间'] ?? '').trim() === '') {
      patch['发布时间'] = today
    }
    if (action === '解除预警' || action === '标记误报') {
      patch['解除时间'] = today
    }
    patch.status = target
    const updated = normalizeWarningRow(patch, thresholds)
    const next = [...rows]
    next[index] = updated
    const normalized = persistWarningChange(next, thresholds)
    saveRows(key, normalized)
    syncRelocations(normalized)
    return { ok: true, message: `预警已${action}，当前状态「${target}」，级别按现行阈值为「${updated['预警级别']}」`, id }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function nextWarningCode(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /^WARN-(\d+)$/.exec(String(row['预警编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `WARN-${String(max + 1).padStart(4, '0')}`
}

// 登记/重复提交预警：
// - 发布渠道没填的不允许保存；
// - 触发雨量精度不足先退回校准；
// - 达到哪一档就按哪一档发布级别；
// - 同一预警编号重复提交不新增记录，沿用已有那条并更新。
export function saveWarningDraft(draft: WarningDraft): ActionResult {
  const code = draft.预警编号.trim()
  const target = draft.发布对象.trim()
  const rainText = draft.触发雨量.trim()
  const channel = draft.发布渠道.trim()

  if (!target) {
    return { ok: false, message: '发布对象没填，不允许保存' }
  }
  if (!channel) {
    return { ok: false, message: '发布渠道没填的预警不允许保存，请先选择发布渠道' }
  }
  const rain = parseRainMm(rainText)
  if (rain === null) {
    return { ok: false, message: `触发雨量「${rainText}」精度不足或不是毫米数（需精确到 0.1mm），先退回校准后再提交` }
  }

  const thresholds = loadThresholds()
  const level = rainInfo({ 触发雨量: rainText }, thresholds).level
  if (level === LEVEL_BELOW_BANDS) {
    return {
      ok: false,
      message: `触发雨量 ${rainText}mm 未达到蓝色预警档（${thresholds.blue}mm），不构成预警，不予登记`,
    }
  }

  const rows = listRows(WARNING_MODULE)
  const index = rows.findIndex((row) => String(row['预警编号'] ?? '').trim() === code)
  if (index >= 0) {
    const merged: EntryRow = {
      ...rows[index],
      发布对象: target,
      触发雨量: rainText,
      发布渠道: channel,
    }
    if (draft.发布时间) {
      merged['发布时间'] = draft.发布时间
    }
    const updated = normalizeWarningRow(merged, thresholds)
    const next = [...rows]
    next[index] = updated
    const normalized = persistWarningChange(next, thresholds)
    saveRows(WARNING_MODULE, normalized)
    syncRelocations(normalized)
    return {
      ok: true,
      duplicated: true,
      id: Number(updated.id),
      message: `预警编号 ${code} 已存在，重复提交未新增记录，沿用已有那条并按现行阈值更新`,
    }
  }

  const finalCode = code || nextWarningCode(rows)
  if (rows.some((row) => String(row['预警编号'] ?? '').trim() === finalCode)) {
    return { ok: false, message: `预警编号 ${finalCode} 已存在` }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const created = normalizeWarningRow(
    {
      id: nextId,
      status: '待发布',
      pending: true,
      abnormal: false,
      预警编号: finalCode,
      发布对象: target,
      预警级别: level,
      触发雨量: rainText,
      发布时间: draft.发布时间 ?? '',
      发布渠道: channel,
      解除时间: '',
      预警状态: '待发布',
    },
    thresholds,
  )
  const normalized = persistWarningChange([...rows, created], thresholds)
  saveRows(WARNING_MODULE, normalized)
  syncRelocations(normalized)
  return { ok: true, id: nextId, message: `预警 ${finalCode} 已登记，按现行阈值判定为「${level}」，进入待发布` }
}

// 触发雨量精度不够的先退回校准：校准值合格后，级别按现行阈值重判。
export function calibrateWarningRain(id: number, rainText: string): ActionResult {
  const rain = parseRainMm(rainText)
  if (rain === null) {
    return { ok: false, message: `校准值「${rainText}」仍不合法：需精确到 0.1mm 的毫米数` }
  }
  const thresholds = loadThresholds()
  const rows = listRows(WARNING_MODULE)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警` }
  }
  const level = rainInfo({ 触发雨量: rainText }, thresholds).level
  if (level === LEVEL_BELOW_BANDS) {
    return { ok: false, message: `校准值 ${rainText}mm 未达到蓝色预警档（${thresholds.blue}mm），不构成预警` }
  }
  const updated = normalizeWarningRow({ ...rows[index], 触发雨量: rainText }, thresholds)
  const next = [...rows]
  next[index] = updated
  const normalized = persistWarningChange(next, thresholds)
  saveRows(WARNING_MODULE, normalized)
  syncRelocations(normalized)
  return { ok: true, id, message: `触发雨量已校准为 ${rainText}mm，预警级别重判为「${level}」` }
}

// 没填发布渠道的预警补渠道后，仍按当前环节展示，不再被挡回。
export function fillWarningChannel(id: number, channel: string): ActionResult {
  const value = channel.trim()
  if (!value) {
    return { ok: false, message: '发布渠道不能保存为空' }
  }
  const thresholds = loadThresholds()
  const rows = listRows(WARNING_MODULE)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警` }
  }
  const updated = normalizeWarningRow({ ...rows[index], 发布渠道: value }, thresholds)
  const next = [...rows]
  next[index] = updated
  const normalized = persistWarningChange(next, thresholds)
  saveRows(WARNING_MODULE, normalized)
  syncRelocations(normalized)
  return { ok: true, id, message: '发布渠道已补全' }
}

// 改阈值之后，存量预警按新标准重判一遍，落库级别同步刷新，并回写搬迁清单。
export function updateWarningThresholds(input: RainThresholds): ActionResult & { overview?: WarningOverview } {
  const invalid = validateThresholds(input)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  saveThresholds(input)
  const normalized = rejudgeWarnings(listRows(WARNING_MODULE), input)
  saveRows(WARNING_MODULE, normalized)
  saveRows(RELOCATE_MODULE, syncTransferEntries(normalized, listRows(RELOCATE_MODULE)))
  return { ok: true, message: '阈值已更新，存量预警已按新标准全部重判', overview: buildWarningOverview(input, normalized) }
}

function buildWarningOverview(
  thresholds: RainThresholds,
  warnings: EntryRow[] = listRows(WARNING_MODULE),
): WarningOverview {
  const pendingTransfers = listRows(RELOCATE_MODULE).filter(
    (row) => String(row['清单类别'] ?? '') === '待转移预警' && String(row.status) === '待签订',
  ).length
  return { thresholds, stats: warningStats(warnings), pendingTransfers }
}

// 预警列表、详情、工作台都从这里取数：同一份数据、同一套判定。
export function warningOverview(): WarningOverview {
  return buildWarningOverview(loadThresholds())
}

export function getWarning(id: number): EntryRow | null {
  return listRows(WARNING_MODULE).find((row) => Number(row.id) === id) ?? null
}

export function warningThresholds(): RainThresholds {
  return loadThresholds()
}

export function allowedWarningAction(status: string): string | null {
  const index = WARNING_STATUSES.indexOf(status as (typeof WARNING_STATUSES)[number])
  return WARNING_ACTIONS[index] ?? null
}


export function resetModule(key: string): PageResult {
  resetRows(key)
  // 重置后同样过一遍领域迁移：预警按现行阈值重判，搬迁清单按预警结果重建。
  const normalized = migrateStore(allRows(), loadThresholds())
  for (const [moduleKey, rows] of Object.entries(normalized)) {
    saveRows(moduleKey, rows)
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
