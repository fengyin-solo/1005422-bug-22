<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警发布管理</h2>
        <p class="page-desc">
          预警级别一律按现行雨量阈值判定：达到哪一档按哪一档发布；环节按「待发布 → 已发布 → 已解除 / 已误报」流转。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警信息</button>
        <button class="btn" type="button" @click="openThreshold">维护雨量阈值</button>
        <button class="btn" type="button" @click="exportRows">导出预警发布清单</button>
      </div>
    </header>

    <!-- 现行阈值口径说明：页面标注、落库定级、存量重判都以此为准。 -->
    <p class="threshold-banner" data-testid="threshold-banner">
      现行发布口径（优先级以此为准）：
      <template v-for="(item, idx) in thresholdText" :key="item">
        <span class="level-tag" :class="`level-${levelClass(idx)}`">{{ item }}</span>
      </template>
      <span class="threshold-note">（触发雨量单位 mm，达到档位下限即按该档发布；蓝色为关注级）</span>
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="item.tone">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span v-if="summary.staleLevel > 0" class="legend-warn">
        级别与现行阈值不符：{{ summary.staleLevel }} 条（可点「按现行阈值重判」）
      </span>
      <span v-if="summary.missingChannel > 0" class="legend-warn">
        已发布但缺发布渠道：{{ summary.missingChannel }} 条
      </span>
    </p>

    <div class="rejudge-bar">
      <button class="btn" type="button" @click="rejudgeAll">按现行阈值重判存量预警</button>
      <span class="threshold-note">改完阈值或发现落库级别是老结论时，点这里把存量预警全部重判一遍。</span>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '预警级别'">
              <span class="level-tag" :class="'level-' + levelClassByText(String(row[column]))">{{ row[column] }}</span>
              <span v-if="!rowMatches(row)" class="mismatch-dot" title="级别与现行阈值口径不符">⚠</span>
            </template>
            <template v-else-if="column === '发布渠道'">
              <span v-if="row[column]">{{ row[column] }}</span>
              <button v-else class="link" type="button" @click="openChannel(row)">补填渠道</button>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <button class="link" type="button" @click="openDetail(row)">{{ row.status }}</button>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length" class="threshold-note">环节已办结</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警发布数据，可先登记预警信息</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警发布记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 登记预警 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <form class="modal-panel" @submit.prevent="submitCreate">
        <h3>登记预警信息</h3>
        <label class="form-item">
          <span>发布对象（隐患点 / 聚居区）</span>
          <input v-model="form.发布对象" placeholder="如：青山乡石门沟隐患点" />
        </label>
        <label class="form-item">
          <span>触发雨量（mm，最小精度 0.1）</span>
          <input v-model="form.触发雨量" type="number" min="0.1" step="0.1" placeholder="如：76.5" />
        </label>
        <div class="form-item level-preview" data-testid="level-preview">
          <span>按现行阈值预判级别</span>
          <strong v-if="previewLevel" class="level-tag" :class="'level-' + levelClassByText(previewLevel)">
            {{ previewLevel }}预警
          </strong>
          <strong v-else class="threshold-note">触发雨量精度不够，先退回雨量站校准</strong>
        </div>
        <p class="form-tip">预警初始为「待发布」；发布前需补填发布渠道，渠道为空不允许发布。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="submit">提交登记</button>
        </div>
      </form>
    </div>

    <!-- 补填发布渠道 -->
    <div v-if="channelTarget" class="modal-mask" @click.self="channelTarget = null">
      <form class="modal-panel" @submit.prevent="submitChannel">
        <h3>补填发布渠道 · {{ channelTarget.预警编号 }}</h3>
        <label class="form-item">
          <span>发布渠道（必填）</span>
          <select v-model="channelValue">
            <option value="" disabled>请选择发布渠道</option>
            <option v-for="ch in channels" :key="ch" :value="ch">{{ ch }}</option>
          </select>
        </label>
        <p class="form-tip">没填发布渠道的预警不允许保存、也不允许发布。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="channelTarget = null">取消</button>
          <button class="btn primary" type="submit">保存渠道</button>
        </div>
      </form>
    </div>

    <!-- 阈值维护 -->
    <div v-if="thresholdEditing" class="modal-mask" @click.self="thresholdEditing = false">
      <form class="modal-panel" @submit.prevent="submitThreshold">
        <h3>维护雨量预警阈值</h3>
        <p class="form-tip">
          阈值是级别判定的唯一口径（页面标注与落库结论以此为准）；需满足 红色 &gt; 橙色 &gt; 黄色。
          保存后存量预警自动按新标准重判。
        </p>
        <label v-for="lv in editableLevels" :key="lv" class="form-item">
          <span>{{ lv }}预警阈值下限（mm）</span>
          <input v-model.number="thresholdForm[lv]" type="number" min="0.1" step="0.1" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="thresholdEditing = false">取消</button>
          <button class="btn primary" type="submit">保存并重判存量</button>
        </div>
      </form>
    </div>

    <!-- 预警详情：与工作台是同一份数据，此处只读展示 localStorage 中的当前记录 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal-panel">
        <h3>预警详情 · {{ detailRow.预警编号 }}</h3>
        <dl class="detail-list">
          <div v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] || '—' }}</dd>
          </div>
          <div>
            <dt>当前状态</dt>
            <dd>{{ detailRow.status }}</dd>
          </div>
          <div>
            <dt>口径校验</dt>
            <dd>
              <span v-if="rowMatches(detailRow)" class="ok-text">级别与现行阈值一致</span>
              <span v-else class="error-text">级别与现行阈值不符，请点「按现行阈值重判」</span>
            </dd>
          </div>
        </dl>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  currentThresholds,
  downloadEntries,
  listEntries,
  moduleMeta,
  publishWarning,
  rejudgeWarnings,
  runAction as applyAction,
  submitWarning,
  saveWarningChannel,
  updateWarningThresholds,
  warningStats,
} from '@/api/local-service'
import {
  RELEASE_CHANNELS,
  judgeLevel,
  levelMatchesThreshold,
  parseRainMm,
} from '@/data/warning-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('warning')
const columns = ['预警编号', '发布对象', '预警级别', '触发雨量', '发布时间', '发布渠道', '解除时间', '预警状态']
const flowActions = ['确认发布', '解除预警', '标记误报']
const channels = [...RELEASE_CHANNELS]
const editableLevels = ['黄色', '橙色', '红色'] as const

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const thresholds = ref(currentThresholds())
const summary = ref(warningStats())

const thresholdText = computed(() => [
  `红色 ≥ ${thresholds.value.红色}mm`,
  `橙色 ≥ ${thresholds.value.橙色}mm`,
  `黄色 ≥ ${thresholds.value.黄色}mm`,
  `蓝色 < ${thresholds.value.黄色}mm`,
])

const stats = computed(() => [
  { label: '待发布预警', value: summary.value.pending, tone: '' },
  { label: '已发布预警', value: summary.value.published, tone: '' },
  { label: '已解除预警', value: summary.value.released, tone: '' },
  { label: '本月误报数', value: summary.value.falseAlarmsThisMonth, tone: summary.value.falseAlarmsThisMonth ? 'tone-warn' : '' },
  { label: '级别/渠道异常', value: summary.value.staleLevel + summary.value.missingChannel, tone: summary.value.staleLevel + summary.value.missingChannel ? 'tone-warn' : '' },
])

const statusSummary = computed(() =>
  ['待发布', '已发布', '已解除', '已误报'].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 登记弹窗
const creating = ref(false)
const form = reactive<{ 发布对象: string; 触发雨量: string }>({ 发布对象: '', 触发雨量: '' })
const previewLevel = computed(() => {
  const rain = parseRainMm(form.触发雨量)
  return rain === null ? '' : judgeLevel(rain, thresholds.value)
})

// 渠道弹窗
const channelTarget = ref<EntryRow | null>(null)
const channelValue = ref('')

// 阈值弹窗
const thresholdEditing = ref(false)
const thresholdForm = reactive<Record<string, number>>({ ...currentThresholds() })

// 详情
const detailRow = ref<EntryRow | null>(null)

function levelClass(idx: number): string {
  return ['red', 'orange', 'yellow', 'blue'][idx] ?? ''
}

function levelClassByText(text: string): string {
  if (text.includes('红')) return 'red'
  if (text.includes('橙')) return 'orange'
  if (text.includes('黄')) return 'yellow'
  return 'blue'
}

function rowMatches(row: EntryRow): boolean {
  return levelMatchesThreshold(row)
}

/** 只给出当前环节允许的下一步动作，跳级动作不渲染，即使硬触发也会被服务端挡回。 */
function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待发布') return ['确认发布']
  if (status === '已发布') return ['解除预警', '标记误报']
  return []
}

function flashOk(message: string) {
  okMessage.value = message
  window.setTimeout(() => {
    okMessage.value = ''
  }, 4000)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  form.发布对象 = ''
  form.触发雨量 = ''
  errorMessage.value = ''
  creating.value = true
}

function submitCreate() {
  errorMessage.value = ''
  const result = submitWarning({ 发布对象: form.发布对象, 触发雨量: form.触发雨量 })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  creating.value = false
  flashOk(result.message)
  reload()
}

function openChannel(row: EntryRow) {
  channelTarget.value = row
  channelValue.value = String(row.发布渠道 ?? '')
  errorMessage.value = ''
}

function submitChannel() {
  if (!channelTarget.value) return
  const result = saveWarningChannel(Number(channelTarget.value.id), channelValue.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  channelTarget.value = null
  flashOk(result.message)
  reload()
}

function openThreshold() {
  Object.assign(thresholdForm, currentThresholds())
  thresholdEditing.value = true
  errorMessage.value = ''
}

function submitThreshold() {
  const result = updateWarningThresholds({ ...thresholdForm })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  thresholdEditing.value = false
  thresholds.value = currentThresholds()
  flashOk(result.message)
  reload()
}

function rejudgeAll() {
  const changed = rejudgeWarnings()
  flashOk(changed.length ? `存量预警已按新标准重判，校正 ${changed.length} 条` : '所有存量预警级别均与现行阈值一致，无需校正')
  reload()
}

function openDetail(row: EntryRow) {
  detailRow.value = row
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 确认发布走发布闸口：没填渠道直接挡下，引导先补渠道。
  const result = action === '确认发布'
    ? publishWarning(Number(row.id))
    : applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    if (action === '确认发布' && result.message.includes('发布渠道')) {
      openChannel(row)
    }
    return
  }
  flashOk(result.message)
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    thresholds.value = currentThresholds()
    summary.value = warningStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警发布列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.threshold-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: #f4f8ff;
  border: 1px solid #cfe0fb;
  border-radius: 8px;
  font-size: 13px;
}
.threshold-note {
  color: #6b7280;
  font-size: 12px;
}
.level-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  color: #fff;
  background: #6b7280;
}
.level-red { background: #dc2626; }
.level-orange { background: #ea580c; }
.level-yellow { background: #ca8a04; }
.level-blue { background: #2563eb; }
.legend-warn {
  margin-left: 12px;
  color: #b91c1c;
  font-size: 12px;
}
.rejudge-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
}
.tone-warn {
  border-color: #fca5a5;
}
.mismatch-dot {
  margin-left: 6px;
  color: #b91c1c;
  cursor: help;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal-panel {
  width: 460px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: #fff;
  border-radius: 10px;
  padding: 20px 22px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.25);
}
.modal-panel h3 {
  margin: 0 0 14px;
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
}
.form-item input,
.form-item select {
  padding: 7px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}
.form-tip {
  font-size: 12px;
  color: #6b7280;
  margin: 4px 0 12px;
}
.level-preview {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.detail-list div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
  border-bottom: 1px dashed #e5e7eb;
  font-size: 13px;
}
.detail-list dt {
  color: #6b7280;
}
.detail-list dd {
  margin: 0;
  text-align: right;
}
.ok-text {
  color: #15803d;
}
</style>
