// 端到端：用内存 localStorage 跑通 local-service 的登记、流转、重判、回写全链路。
const storage = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
}

const svc = await import('../src/api/local-service.ts')

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

// 首次加载即迁移（示例数据会被重判）
const overview0 = svc.warningOverview()
const byCode = (code: string) => svc.listEntries('warning').items.find((r) => r['预警编号'] === code)!
const w1 = byCode('WARN-0001')
check('WARN-0001 52.6 判黄色', w1['预警级别'] === '黄色预警', String(w1['预警级别']))
check('WARN-0001 已发布保留', w1.status === '已发布')
const w5 = byCode('WARN-0005')
check('WARN-0005 205.3 改判红色（老蓝覆盖）', w5['预警级别'] === '红色预警', String(w5['预警级别']))
const w6 = byCode('WARN-0006')
check('WARN-0006 18.4 改判未达预警档', w6['预警级别'] === '未达预警档')
const w7 = byCode('WARN-0007')
check('WARN-0007 精度不足挡回待发布', w7.status === '待发布' && w7['预警级别'] === '待校准')
const w8 = byCode('WARN-0008')
check('WARN-0008 空渠道挡回待发布', w8.status === '待发布')
check('WARN-0008 63.7 仍判黄色', w8['预警级别'] === '黄色预警')

// 本月误报：WARN-0004 在 10 月，WARN-0009 在 9 月 → 本月 1 条
check('本月误报数=1', overview0.stats.falseAlarmsMonth === 1, String(overview0.stats.falseAlarmsMonth))

// 跳跃流转拦截：WARN-0001 已发布，直接标记误报（跳过已解除）必须挡回
const jump = svc.runAction('warning', Number(w1.id), '标记误报')
check('跳过已解除直接误报被挡回', !jump.ok && jump.message.includes('挡回'), jump.message)
// 往回跳也挡：不能从待发布"确认发布"到已发布之后……先测已发布不能重复发布
const republish = svc.runAction('warning', Number(w1.id), '确认发布')
check('已发布不能再确认发布', !republish.ok)
// 正确次序：已发布 → 解除预警
const release = svc.runAction('warning', Number(w1.id), '解除预警')
check('已发布→解除预警 放行', release.ok)
check('解除时间已回写', Boolean(byCode('WARN-0001')['解除时间']))

// 待发布但无渠道：确认发布拦截
const noChannelPublish = svc.runAction('warning', Number(w8.id), '确认发布')
check('无渠道确认发布被拦', !noChannelPublish.ok && noChannelPublish.message.includes('发布渠道'))

// 登记校验：缺渠道 / 精度不足 / 未达档
check('登记缺渠道被拦', !svc.saveWarningDraft({ 预警编号: 'X1', 发布对象: '点', 触发雨量: '60', 发布渠道: '' }).ok)
check('登记精度不足被拦', !svc.saveWarningDraft({ 预警编号: 'X2', 发布对象: '点', 触发雨量: '60.12', 发布渠道: '短信' }).ok)
check('登记未达档被拦', !svc.saveWarningDraft({ 预警编号: 'X3', 发布对象: '点', 触发雨量: '5', 发布渠道: '短信' }).ok)

// 正常登记
const before = svc.listEntries('warning').total
const create = svc.saveWarningDraft({ 预警编号: '', 发布对象: '新桥村', 触发雨量: '150.8', 发布渠道: '应急广播' })
check('登记成功并自动编号', create.ok && create.message.includes('橙色预警'), create.message)
check('登记后总数+1', svc.listEntries('warning').total === before + 1)
const newCode = svc.listEntries('warning').items.at(-1)!['预警编号']
check('新预警待发布', svc.listEntries('warning').items.at(-1)!.status === '待发布')

// 重复提交同一编号：不新增，沿用更新
const dup = svc.saveWarningDraft({ 预警编号: String(newCode), 发布对象: '新桥村2组', 触发雨量: '260.0', 发布渠道: '应急广播+短信' })
check('重复提交沿用原记录', dup.ok && dup.duplicated === true)
check('重复提交不新增', svc.listEntries('warning').total === before + 1)
const updated = svc.listEntries('warning').items.find((r) => r['预警编号'] === newCode)!
check('沿用记录已更新并改判红色', updated['发布对象'] === '新桥村2组' && updated['预警级别'] === '红色预警')

// 校准：WARN-0007 55.25 → 55.2 后改判黄色，仍待发布
const calib = svc.calibrateWarningRain(Number(w7.id), '55.2')
check('校准成功并重判', calib.ok && byCode('WARN-0007')['预警级别'] === '黄色预警', calib.message)
check('校准非法值被拦', !svc.calibrateWarningRain(Number(w7.id), '55.255').ok)

// 补渠道后确认发布放行
svc.fillWarningChannel(Number(w8.id), '应急广播')
const publish8 = svc.runAction('warning', Number(w8.id), '确认发布')
check('补渠道后发布放行', publish8.ok && byCode('WARN-0008').status === '已发布')
check('发布时间已回写', Boolean(byCode('WARN-0008')['发布时间']))

// 搬迁清单回写
const relocations = svc.listEntries('relocate').items
const transfers = relocations.filter((r) => r['清单类别'] === '待转移预警')
const codes = transfers.map((r) => r['来源预警'])
check('已发布/已解除/已误报均回写待转移', codes.includes('WARN-0001') && codes.includes('WARN-0004') && codes.includes('WARN-0008'))
check('待发布不回写', !codes.includes('WARN-0005'))
check('待转移数与预警页工作台一致', transfers.filter((r) => r.status === '待签订').length === svc.warningOverview().pendingTransfers)
const t3 = transfers.find((r) => r['来源预警'] === 'WARN-0003')!
check('回写级别与预警一致(解除的蓝 26mm)', t3['预警级别'] === '蓝色预警', String(t3['预警级别']))

// 改阈值：蓝档提到 30，黄档提到 60 → WARN-0003 的 26mm 变未达档；WARN-0001 的 52.6 由黄降蓝
const raised = svc.updateWarningThresholds({ blue: 30, yellow: 60, orange: 120, red: 250 })
check('阈值更新触发存量重判', raised.ok)
check('26mm 在新阈值下未达档', byCode('WARN-0003')['预警级别'] === '未达预警档', String(byCode('WARN-0003')['预警级别']))
check('52.6mm 在新阈值下降为蓝', byCode('WARN-0001')['预警级别'] === '蓝色预警', String(byCode('WARN-0001')['预警级别']))
check('级别变更同步回写搬迁清单', transfers.find((r) => r['来源预警'] === 'WARN-0003')!['预警级别'] === '未达预警档')
check('非法阈值(倒序)被拦', !svc.updateWarningThresholds({ blue: 100, yellow: 60, orange: 120, red: 250 }).ok)
check('非法阈值(精度)被拦', !svc.updateWarningThresholds({ blue: 20.55, yellow: 60, orange: 120, red: 250 }).ok)

// 详情读取同一份
const detail = svc.getWarning(Number(w1.id))
check('详情页与列表同源', detail && detail['预警级别'] === byCode('WARN-0001')['预警级别'])

// 非预警模块保持原流转行为（relocate 待签订→确认签订）
const someRelocation = svc.listEntries('relocate').items.find((r) => !r['清单类别'])
const relocateOk = svc.runAction('relocate', Number(someRelocation.id), '确认签订')
check('其他模块流转不受影响', relocateOk.ok || someRelocation.status !== '待签订')

console.log(`\n${passed} checks passed`)
