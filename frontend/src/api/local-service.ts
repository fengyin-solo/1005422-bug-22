import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  RELEASE_CHANNELS,
  WARNING_STATUS_FLOW,
  canRunAction,
  formatWarningCode,
  isSameLevel,
  judgeLevel,
  levelMatchesThreshold,
  parseRainMm,
  readThresholds,
  saveThresholds,
  validateThresholds,
} from '@/data/warning-rules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  // 预警模块按固定环节次序流转：只能相邻向后走，跳级一律挡回。
  if (key === 'warning') {
    const guard = canRunAction(action, rows[index].status)
    if (!guard.ok) {
      return guard
    }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: key === 'warning' ? target === WARNING_STATUS_FLOW[0] || target === WARNING_STATUS_FLOW[1] : target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === 'warning') {
    // 预警状态字段与环节状态保持同值；解除/误报时登记解除时间，供「本月误报数」统计。
    updated.预警状态 = target
    if (target === '已解除' || target === '已误报') {
      updated.解除时间 = String(updated.解除时间 ?? '').trim() || today()
    }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 预警发布/解除/误报的结果同步回写到避险搬迁清单，保证两处是同一份数据。
  if (key === 'warning') {
    syncRelocateItem(next[index])
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ── 预警发布专属服务 ─────────────────────────────────────────────────────────

export type WarningDraft = {
  发布对象: string
  触发雨量: string | number
  发布渠道?: string
  发布时间?: string
}

export type WarningSubmitResult = ActionResult & { id?: number; duplicated?: boolean }

/**
 * 登记预警：
 * - 触发雨量按现行阈值定级，达到哪一档按哪一档发布；
 * - 精度不够（非数字 / 低于 0.1mm）先退回校准，不落库；
 * - 同一发布对象 + 同一触发雨量视为重复提交，沿用已有那条，不新增记录。
 */
export function submitWarning(draft: WarningDraft): WarningSubmitResult {
  const target = String(draft.发布对象 ?? '').trim()
  if (!target) {
    return { ok: false, message: '发布对象不能为空' }
  }
  const rainMm = parseRainMm(draft.触发雨量)
  if (rainMm === null) {
    return { ok: false, message: '触发雨量精度不够或不是有效数值（最小精度 0.1mm），先退回雨量站校准后再提交' }
  }

  const rows = listRows('warning')
  const duplicate = rows.find(
    (row) => String(row.发布对象 ?? '').trim() === target && parseRainMm(row.触发雨量) === rainMm,
  )
  if (duplicate) {
    // 重复提交不新增记录：沿用已有那条，只把级别按现行阈值校正后回写。
    const level = judgeLevel(rainMm)
    if (!isSameLevel(duplicate.预警级别, level)) {
      const next = rows.map((row) =>
        Number(row.id) === Number(duplicate.id) ? { ...row, 预警级别: level } : row,
      )
      saveRows('warning', next)
    }
    return {
      ok: true,
      duplicated: true,
      id: Number(duplicate.id),
      message: `该预警已登记过（编号 ${String(duplicate.预警编号)}），沿用已有记录，不重复新增`,
    }
  }

  const level = judgeLevel(rainMm)
  const seq = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const now = draft.发布时间?.trim() || today()
  const row: EntryRow = {
    id: seq,
    status: '待发布',
    pending: true,
    abnormal: false,
    预警编号: formatWarningCode(seq),
    发布对象: target,
    预警级别: level,
    触发雨量: rainMm,
    发布时间: now,
    发布渠道: '',
    解除时间: '',
    预警状态: '待发布',
  }
  saveRows('warning', [...rows, row])
  // 待发布预警也要进避险搬迁清单，作为一条「待转移」任务挂着。
  syncRelocateItem(row)
  return { ok: true, id: seq, message: `预警已登记（编号 ${row.预警编号}），按现行触发雨量判定为${level}预警，当前待发布` }
}

/** 保存发布渠道；没填发布渠道的预警不允许保存（也不允许进入已发布）。 */
export function saveWarningChannel(id: number, channel: string): ActionResult {
  const value = channel.trim()
  if (!value) {
    return { ok: false, message: '发布渠道没填，不允许保存；发布前必须明确发布渠道' }
  }
  if (!RELEASE_CHANNELS.includes(value as (typeof RELEASE_CHANNELS)[number])) {
    return { ok: false, message: `发布渠道必须是：${RELEASE_CHANNELS.join('、')}` }
  }
  const rows = listRows('warning')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警信息` }
  }
  const next = [...rows]
  next[index] = { ...rows[index], 发布渠道: value }
  saveRows('warning', next)
  return { ok: true, message: `发布渠道已保存为「${value}」` }
}

/** 预警发布前的统一闸口：必须已填发布渠道，且级别与现行阈值口径一致。 */
export function publishWarning(id: number, channel?: string): ActionResult {
  const rows = listRows('warning')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警信息` }
  }
  if (channel !== undefined) {
    const saved = saveWarningChannel(id, channel)
    if (!saved.ok) {
      return saved
    }
  }
  const fresh = listRows('warning').find((item) => Number(item.id) === id) as EntryRow
  if (!String(fresh.发布渠道 ?? '').trim()) {
    return { ok: false, message: '发布渠道没填，不允许发布，请先补全发布渠道' }
  }
  return runAction('warning', id, '确认发布')
}

/**
 * 改阈值：保存新阈值后把存量预警按新标准重判一遍，级别落库更新，
 * 避免「触发雨量按新阈值算的级别」和「库里老结论」对不上。
 */
export function updateWarningThresholds(input: Record<string, number>): ActionResult & {
  thresholds?: Record<string, number>
  rejudged?: number
} {
  const check = validateThresholds(input)
  if (!check.ok) {
    return { ok: false, message: check.message }
  }
  const saved = saveThresholds(input)
  if (!saved.ok || !saved.thresholds) {
    return { ok: false, message: saved.message }
  }
  const rejudged = rejudgeWarnings()
  return {
    ok: true,
    thresholds: saved.thresholds,
    rejudged: rejudged.length,
    message: `阈值已更新，存量预警已按新标准重判，共校正 ${rejudged.length} 条`,
  }
}

export function currentThresholds() {
  return readThresholds()
}

/**
 * 存量预警重判：逐条按现行阈值重新计算级别。
 * 触发雨量精度不够的不强行定级，标记为待校准，返回清单供页面退回处理。
 */
export function rejudgeWarnings(): EntryRow[] {
  const thresholds = readThresholds()
  const rows = listRows('warning')
  const changed: EntryRow[] = []
  const next = rows.map((row) => {
    const rainMm = parseRainMm(row.触发雨量)
    if (rainMm === null) {
      const marked = { ...row, abnormal: true, 预警状态: `${String(row.预警状态 ?? '').replace('（待校准）', '')}（待校准）` }
      return marked
    }
    const level = judgeLevel(rainMm, thresholds)
    if (!isSameLevel(row.预警级别, level)) {
      const fixed = { ...row, 预警级别: level, abnormal: false }
      changed.push(fixed)
      return fixed
    }
    return row
  })
  saveRows('warning', next)
  return changed
}

/** 预警统计：明细、状态图例、工作台卡片共用这一份口径，避免两处数对不齐。 */
export function warningStats(monthPrefix = today().slice(0, 7)) {
  const rows = listRows('warning')
  const thresholds = readThresholds()
  const countBy = (status: string) => rows.filter((row) => String(row.status) === status).length
  const pending = countBy('待发布')
  const published = countBy('已发布')
  // 本月误报数：以解除/误报时间落在本月的「已误报」为准，与明细筛选同口径。
  const falseAlarmsThisMonth = rows.filter((row) => {
    if (String(row.status) !== '已误报') {
      return false
    }
    const time = String(row.解除时间 ?? row.发布时间 ?? '')
    return time.startsWith(monthPrefix)
  }).length
  const staleLevel = rows.filter((row) => !levelMatchesThreshold(row)).length
  const missingChannel = rows.filter(
    (row) => String(row.status) === '已发布' && !String(row.发布渠道 ?? '').trim(),
  ).length
  return {
    total: rows.length,
    pending,
    published,
    released: countBy('已解除'),
    falseAlarm: countBy('已误报'),
    falseAlarmsThisMonth,
    staleLevel,
    missingChannel,
    thresholds,
  }
}

/**
 * 把预警结果回写到避险搬迁清单：
 * 每条预警对应一条搬迁安置单（编号 RELW-预警id），新增一列「待转移预警」。
 * - 待发布/已发布：清单里挂「待转移」；
 * - 已解除：解除转移；
 * - 已误报：无需转移。
 */
export function syncRelocateItem(warning: EntryRow): void {
  const rows = listRows('relocate')
  const linkId = relocateLinkId(warning)
  const index = rows.findIndex((row) => String(row.搬迁编号) === linkId)
  const stage = relocateStage(String(warning.status))
  const nextRow: EntryRow = {
    id: index >= 0 ? rows[index].id : nextRelocateId(rows),
    status: stage.status,
    pending: stage.pending,
    abnormal: false,
    搬迁编号: linkId,
    所属隐患点: String(warning.发布对象 ?? ''),
    涉及户数: '',
    安置方式: '',
    安置地点: '',
    签订日期: '',
    完成日期: stage.finishedAt,
    搬迁状态: stage.label,
    待转移预警: stage.needTransfer ? String(warning.预警编号 ?? '') : '',
    来源预警: String(warning.预警编号 ?? ''),
  }
  const next = index >= 0 ? rows.map((row, i) => (i === index ? nextRow : row)) : [...rows, nextRow]
  saveRows('relocate', next)
}

function relocateStage(status: string): {
  status: string
  label: string
  pending: boolean
  needTransfer: boolean
  finishedAt: string
} {
  switch (status) {
    case '已发布':
      return { status: '搬迁中', label: '待转移', pending: true, needTransfer: true, finishedAt: '' }
    case '待发布':
      return { status: '待签订', label: '待转移（预警待发布）', pending: true, needTransfer: true, finishedAt: '' }
    case '已解除':
      return { status: '已完成', label: '预警已解除', pending: false, needTransfer: false, finishedAt: today() }
    case '已误报':
      return { status: '已完成', label: '预警误报，无需转移', pending: false, needTransfer: false, finishedAt: today() }
    default:
      return { status: '待签订', label: '待转移', pending: true, needTransfer: true, finishedAt: '' }
  }
}

function relocateLinkId(warning: EntryRow): string {
  return `RELW-${String(Number(warning.id)).padStart(4, '0')}`
}

function nextRelocateId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

let bootstrapped = false

/**
 * 应用启动引导：
 * 1. 存量预警一律按现行阈值重判一次，老结论不会再反复冒出来；
 * 2. 预警结果统一回写避险搬迁清单（含待发布预警）。
 * 幂等：每次打开页面只跑一次。
 */
export function bootstrapWarningData(): void {
  if (bootstrapped) {
    return
  }
  bootstrapped = true
  const thresholds = readThresholds()
  const warnings = listRows('warning')
  let changed = false
  for (const row of warnings) {
    const rainMm = parseRainMm(row.触发雨量)
    if (rainMm === null) {
      continue
    }
    const level = judgeLevel(rainMm, thresholds)
    if (!isSameLevel(row.预警级别, level)) {
      changed = true
      break
    }
  }
  if (changed) {
    rejudgeWarnings()
  }
  // 以当前预警状态为准刷新搬迁清单里的待转移任务。
  for (const row of listRows('warning')) {
    syncRelocateItem(row)
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
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
  const stats = warningStats()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    // 预警模块的待处理/异常与预警详情页用同一份口径，避免工作台和详情页两个数。
    if (meta.key === 'warning') {
      return {
        name: meta.name,
        created: entries.length,
        pending: stats.pending + stats.published,
        abnormal: stats.staleLevel + stats.missingChannel,
      }
    }
    if (meta.key === 'relocate') {
      return {
        name: meta.name,
        created: entries.length,
        pending: entries.filter((row) => String(row.待转移预警 ?? '') !== '').length,
        abnormal: entries.filter((row) => row.abnormal).length,
      }
    }
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
