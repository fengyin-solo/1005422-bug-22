import { assert } from 'node:console'
import {
  DEFAULT_THRESHOLDS,
  LEVEL_BELOW_BANDS,
  LEVEL_CALIBRATING,
  WARNING_STATUSES,
  levelForRain,
  migrateStore,
  normalizeWarningRow,
  parseRainMm,
  rainInfo,
  syncTransferEntries,
  warningStats,
} from '../src/domain/warning.ts'
import type { EntryRow } from '../src/data/types.ts'

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    console.error(`FAIL: ${name} ${extra}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`PASS: ${name}`)
  }
}

const T = DEFAULT_THRESHOLDS

// 1. 达到哪一档按哪一档发布（边界值归更高档）
check('20mm 蓝色（达档）', levelForRain(20, T) === '蓝色预警')
check('49.9mm 蓝色', levelForRain(49.9, T) === '蓝色预警')
check('50mm 黄色（边界）', levelForRain(50, T) === '黄色预警')
check('100mm 橙色（边界）', levelForRain(100, T) === '橙色预警')
check('200mm 红色（边界）', levelForRain(200, T) === '红色预警')
check('19.9mm 未达档', levelForRain(19.9, T) === null)
check('300mm 红色', levelForRain(300, T) === '红色预警')

// 2. 精度：只认 0.1mm
check('整数毫米合法', parseRainMm('55') === 55)
check('一位小数合法', parseRainMm('55.2') === 55.2)
check('两位小数退回', parseRainMm('55.25') === null)
check('非数字退回', parseRainMm('abc') === null)
check('空值退回', parseRainMm('') === null)
check('负毫米退回', parseRainMm('-3') === null)

// 3. 存量重判：老级别覆盖成新结论
function row(partial: Partial<EntryRow>): EntryRow {
  return {
    id: 1,
    status: '待发布',
    pending: true,
    abnormal: false,
    预警编号: 'W1',
    发布对象: '测试点',
    预警级别: '老级别',
    触发雨量: '205.3',
    发布时间: '',
    发布渠道: '短信',
    解除时间: '',
    预警状态: '待发布',
    ...partial,
  }
}
check('205.3 老蓝改判红', normalizeWarningRow(row({ 触发雨量: '205.3', 预警级别: '蓝色预警' }), T)['预警级别'] === '红色预警')
check('18.4 老黄改判未达档', normalizeWarningRow(row({ 触发雨量: '18.4', 预警级别: '黄色预警' }), T)['预警级别'] === LEVEL_BELOW_BANDS)

// 4. 精度不足的已发布 → 挡回待发布 + 待校准
const calib = normalizeWarningRow(row({ status: '已发布', 触发雨量: '55.25', 预警状态: '已发布' }), T)
check('精度不足挡回待发布', calib.status === '待发布')
check('精度不足级别待校准', calib['预警级别'] === LEVEL_CALIBRATING)
check('精度不足标记异常', calib.abnormal === true)

// 5. 渠道空的已发布 → 挡回待发布
const noChannel = normalizeWarningRow(row({ status: '已发布', 发布渠道: '', 预警状态: '已发布', 触发雨量: '63.7' }), T)
check('空渠道挡回待发布', noChannel.status === '待发布')
check('空渠道标记异常', noChannel.abnormal === true)

// 6. 合法已发布不被改动
const valid = normalizeWarningRow(row({ status: '已发布', 触发雨量: '52.6', 预警状态: '已发布' }), T)
check('合法已发布保留', valid.status === '已发布' && valid['预警级别'] === '黄色预警')

// 7. 流转次序
check('状态次序', JSON.stringify(WARNING_STATUSES) === JSON.stringify(['待发布', '已发布', '已解除', '已误报']))

// 8. 搬迁回写：已发布/已解除/已误报各一条待转移
const warnings = [
  row({ id: 1, 预警编号: 'W1', status: '已发布', 触发雨量: '52.6', 发布对象: 'A点', 预警级别: '黄色预警' }),
  row({ id: 2, 预警编号: 'W2', status: '已解除', 触发雨量: '26', 发布对象: 'B点', 预警级别: '蓝色预警' }),
  row({ id: 3, 预警编号: 'W3', status: '已误报', 触发雨量: '21.5', 发布对象: 'C点', 预警级别: '蓝色预警' }),
  row({ id: 4, 预警编号: 'W4', status: '待发布', 触发雨量: '205.3', 发布对象: 'D点', 预警级别: '红色预警' }),
]
const transfer = syncTransferEntries(warnings, [])
check('回写3条待转移(待发布不回写)', transfer.length === 3)
check('回写编号沿用预警号', transfer.some((r) => r['搬迁编号'] === 'TRANS-W1'))
check('回写类别为待转移预警', transfer.every((r) => r['清单类别'] === '待转移预警' && r.status === '待签订'))
check('回写级别同步', transfer.find((r) => r['来源预警'] === 'W1')!['预警级别'] === '黄色预警')

// 9. 重复回写不新增：再同步一次仍 3 条
const again = syncTransferEntries(warnings, transfer)
check('重复同步不新增记录', again.length === 3)

// 10. 预警退回待发布 → 未转移的清单撤下；已完成的留痕
const withDone = syncTransferEntries(
  [
    row({ id: 1, 预警编号: 'W1', status: '待发布', 触发雨量: '52.6', 发布对象: 'A点' }),
  ],
  [
    { id: 99, status: '待签订', pending: true, abnormal: false, 清单类别: '待转移预警', 搬迁编号: 'TRANS-W1', 来源预警: 'W1' },
    { id: 100, status: '已完成', pending: false, abnormal: false, 清单类别: '待转移预警', 搬迁编号: 'TRANS-W2', 来源预警: 'W2' },
  ],
)
check('退回后未完成清单撤下', !withDone.some((r) => r['来源预警'] === 'W1'))
check('退回后已完成清单留痕', withDone.some((r) => r['来源预警'] === 'W2' && r.status === '已完成'))

// 11. 本月误报数：只统计当前月（2026-10）
const statsRows = [
  row({ id: 1, status: '已误报', 解除时间: '2026-10-01' }),
  row({ id: 2, status: '已误报', 解除时间: '2026-09-30' }),
  row({ id: 3, status: '待发布' }),
  row({ id: 4, status: '已发布' }),
]
const stats = warningStats(statsRows, new Date('2026-10-02'))
check('本月误报数=1', stats.falseAlarmsMonth === 1)
check('待发布=1', stats.pendingPublish === 1)
check('已发布=1', stats.published === 1)

// 12. migrateStore 幂等：连续迁移两次结果一致
const store = { warning: warnings, relocate: [{ id: 1, status: '搬迁中', pending: true, abnormal: false, 搬迁编号: 'R1' }] }
const m1 = migrateStore(store, T)
const m2 = migrateStore(JSON.parse(JSON.stringify(m1)), T)
check('迁移幂等-预警数', JSON.stringify(m2.warning) === JSON.stringify(m1.warning))
check('迁移幂等-搬迁数', m2.relocate.length === m1.relocate.length)

// 13. 阈值升级后重判：蓝档升到 30，26mm 由蓝变未达档
const raised = { blue: 30, yellow: 60, orange: 120, red: 250 }
const rerun = normalizeWarningRow(row({ status: '已解除', 触发雨量: '26', 发布渠道: '短信' }), raised)
check('阈值升级后重判', rerun['预警级别'] === LEVEL_BELOW_BANDS)

console.log(`\n${passed} checks passed`)
