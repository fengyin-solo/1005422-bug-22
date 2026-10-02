<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警发布管理</h2>
        <p class="page-desc">维护预警信息，围绕预警编号、发布对象、预警级别、触发雨量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警信息</button>
        <button class="btn" type="button" @click="openThreshold">调整雨量阈值</button>
        <button class="btn" type="button" @click="exportRows">导出预警发布清单</button>
      </div>
    </header>

    <!-- 口径优先级写清：级别以本页现行阈值的实时重判为准，雨量站设备阈值不作定级依据 -->
    <div class="policy-banner">
      <div>
        <strong>发布口径（优先级以此为准）：</strong>预警级别一律按本页现行雨量阈值实时重判——触发雨量达到哪一档就按那一档发布；
        页面标注、落库级别、详情页与工作台统计均以重判结果为准，历史老级别不作为依据。雨量站网页的「阈值雨量」是设备告警参数，不参与预警定级。
      </div>
      <div style="margin-top:4px">
        <span v-for="band in bands" :key="band.level" class="band">
          <LevelBadge :level="band.level" />≥{{ overview.thresholds[band.key] }}mm
        </span>
        <span class="band">流转次序：待发布 → 已发布 → 已解除 → 已误报（只准逐步往后走）</span>
      </div>
    </div>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待发布预警</span>
        <strong class="stat-value">{{ overview.stats.pendingPublish }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已发布预警（含已解除/已误报）</span>
        <strong class="stat-value">{{ overview.stats.published }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">本月误报数（2026-10）</span>
        <strong class="stat-value">{{ overview.stats.falseAlarmsMonth }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待校准雨量</span>
        <strong class="stat-value">{{ overview.stats.calibration }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待转移预警（避险搬迁清单）</span>
        <strong class="stat-value">{{ overview.pendingTransfers }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
        <tr v-for="row in rows" :key="String(row.id)" :class="rowClass(row)">
          <td>
            <RouterLink class="link" :to="`/warning/${row.id}`">{{ row['预警编号'] }}</RouterLink>
          </td>
          <td>{{ row['发布对象'] ?? '—' }}</td>
          <td><LevelBadge :level="String(row['预警级别'] ?? '')" /></td>
          <td class="mono">{{ row['触发雨量'] ?? '—' }} mm</td>
          <td>{{ row['发布时间'] || '—' }}</td>
          <td>
            {{ row['发布渠道'] || '' }}
            <button v-if="!row['发布渠道']" class="link" type="button" @click="openChannel(row)">补渠道</button>
          </td>
          <td>{{ row['解除时间'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="infoOf(row).level === LEVEL_CALIBRATING"
              class="link"
              type="button"
              @click="openCalibrate(row)"
            >
              退回校准
            </button>
            <button
              v-if="allowedAction(row)"
              class="link"
              type="button"
              @click="runAction(allowedAction(row)!, row)"
            >
              {{ allowedAction(row) }}
            </button>
            <span v-if="blockedHint(row)" class="page-desc">
              {{ blockedHint(row) }}
            </span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警发布数据，可先登记预警信息</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警发布记录 · 明细统计与工作台同源</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记预警：发布渠道必填；同一编号重复提交沿用已有记录 -->
    <div v-if="modal === 'create'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3 class="modal-title">登记预警信息</h3>
        <p class="modal-desc">预警级别按现行阈值自动判定；发布渠道未填不允许保存；编号留空自动生成，编号重复则沿用原记录更新。</p>
        <div class="form-grid">
          <label class="form-field">
            <span>预警编号（可留空）</span>
            <input v-model="form.code" placeholder="如 WARN-0010，留空自动生成" />
          </label>
          <label class="form-field">
            <span>发布对象 *</span>
            <input v-model="form.target" placeholder="乡镇/村/隐患点" />
          </label>
          <label class="form-field">
            <span>触发雨量（mm，精确到 0.1）*</span>
            <input v-model="form.rain" placeholder="如 52.6" />
          </label>
          <label class="form-field">
            <span>发布渠道 *</span>
            <select v-model="form.channel">
              <option value="">请选择发布渠道</option>
              <option v-for="item in channelOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="form-field full">
            <span>级别预判（达到哪一档按哪一档发布）</span>
            <input :value="formPreview" readonly />
          </label>
        </div>
        <p v-if="modalError" class="form-error">{{ modalError }}</p>
        <div class="form-actions">
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交</button>
        </div>
      </div>
    </div>

    <!-- 调整阈值：改完全部存量预警按新标准重判 -->
    <div v-else-if="modal === 'threshold'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3 class="modal-title">调整现行雨量阈值</h3>
        <p class="modal-desc">四档阈值需为 0.1mm 精度且严格递增；保存后存量预警立即按新标准重判一遍并回写搬迁清单。</p>
        <div class="form-grid">
          <label v-for="item in thresholdForm" :key="item.key" class="form-field">
            <span>{{ item.label }}阈值（mm）</span>
            <input v-model="item.value" />
          </label>
        </div>
        <p v-if="modalError" class="form-error">{{ modalError }}</p>
        <div class="form-actions">
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="submitThreshold">保存并重判存量</button>
        </div>
      </div>
    </div>

    <!-- 退回校准 -->
    <div v-else-if="modal === 'calibrate'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3 class="modal-title">退回校准触发雨量</h3>
        <p class="modal-desc">原观测值精度不足（需精确到 0.1mm），校准合格后级别按现行阈值重判。</p>
        <div class="form-grid">
          <label class="form-field">
            <span>预警编号</span>
            <input :value="activeRow?.['预警编号']" readonly />
          </label>
          <label class="form-field">
            <span>原触发雨量（mm）</span>
            <input :value="activeRow?.['触发雨量']" readonly />
          </label>
          <label class="form-field full">
            <span>校准后雨量（mm，精确到 0.1）*</span>
            <input v-model="calibrateValue" placeholder="如 55.2" />
          </label>
        </div>
        <p v-if="modalError" class="form-error">{{ modalError }}</p>
        <div class="form-actions">
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="submitCalibrate">校准并重判</button>
        </div>
      </div>
    </div>

    <!-- 补全发布渠道 -->
    <div v-else-if="modal === 'channel'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3 class="modal-title">补全发布渠道</h3>
        <p class="modal-desc">发布渠道没填的预警不允许发布，补全后才可进入发布环节。</p>
        <div class="form-grid">
          <label class="form-field full">
            <span>预警编号</span>
            <input :value="activeRow?.['预警编号']" readonly />
          </label>
          <label class="form-field full">
            <span>发布渠道 *</span>
            <select v-model="channelValue">
              <option value="">请选择发布渠道</option>
              <option v-for="item in channelOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
        </div>
        <p v-if="modalError" class="form-error">{{ modalError }}</p>
        <div class="form-actions">
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="submitChannel">保存渠道</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  calibrateWarningRain,
  downloadEntries,
  fillWarningChannel,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  saveWarningDraft,
  updateWarningThresholds,
  allowedWarningAction,
  warningOverview,
} from '@/api/local-service'
import {
  LEVEL_BELOW_BANDS,
  LEVEL_CALIBRATING,
  rainInfo,
  thresholdBands,
  type RainThresholds,
} from '@/domain/warning'
import type { EntryRow } from '@/data/types'
import LevelBadge from '@/components/LevelBadge.vue'

const meta = moduleMeta('warning')
const columns = ["预警编号", "发布对象", "预警级别", "触发雨量", "发布时间", "发布渠道", "解除时间"]
const channelOptions = ['应急广播', '短信', '微信群', '铜锣预警', '上门通知', '短信+铜锣预警', '应急广播+短信', '应急广播+上门通知']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["预警编号", "发布对象", "预警级别"]
const overview = ref(warningOverview())
const bands = computed(() => thresholdBands(overview.value.thresholds))

const statusSummary = computed(() =>
  ['待发布', '已发布', '已解除', '已误报'].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type ModalKind = '' | 'create' | 'threshold' | 'calibrate' | 'channel'
const modal = ref<ModalKind>('')
const modalError = ref('')
const activeRow = ref<EntryRow | null>(null)
const calibrateValue = ref('')
const channelValue = ref('')

const form = reactive({ code: '', target: '', rain: '', channel: '' })

const thresholdForm = ref<{ key: keyof RainThresholds; label: string; value: string }[]>([])

function currentThresholds(): RainThresholds {
  return warningOverview().thresholds
}

function infoOf(row: EntryRow) {
  return rainInfo(row, currentThresholds())
}

function allowedAction(row: EntryRow): string | null {
  const info = infoOf(row)
  if (!info.precise) {
    return null
  }
  if (info.level === LEVEL_BELOW_BANDS) {
    return null
  }
  if (String(row.status) === '待发布' && !String(row['发布渠道'] ?? '').trim()) {
    return null
  }
  return allowedWarningAction(String(row.status))
}

function blockedHint(row: EntryRow): string {
  const info = infoOf(row)
  if (!info.precise) {
    return '待校准'
  }
  if (String(row.status) === '已误报') {
    return '已办结'
  }
  if (info.level === LEVEL_BELOW_BANDS) {
    return '未达预警档，不发布'
  }
  if (String(row.status) === '待发布' && !String(row['发布渠道'] ?? '').trim()) {
    return '补全渠道后可发布'
  }
  return ''
}

function rowClass(row: EntryRow): Record<string, boolean> {
  const info = infoOf(row)
  return {
    'row-calibrate': info.level === LEVEL_CALIBRATING,
    'row-warn': String(row.status) === '待发布' && !String(row['发布渠道'] ?? '').trim(),
  }
}

const formPreview = computed(() => {
  const info = rainInfo({ 触发雨量: form.rain }, currentThresholds())
  if (!form.rain.trim()) {
    return '输入触发雨量后自动判定'
  }
  if (!info.precise) {
    return '触发雨量精度不足（需精确到 0.1mm），先退回校准'
  }
  return info.level === '未达预警档' ? `未达到蓝色档（${currentThresholds().blue}mm），不构成预警` : info.level
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function closeModal() {
  modal.value = ''
  modalError.value = ''
  activeRow.value = null
  calibrateValue.value = ''
  channelValue.value = ''
}

function openCreate() {
  Object.assign(form, { code: '', target: '', rain: '', channel: '' })
  modalError.value = ''
  modal.value = 'create'
}

function openThreshold() {
  const t = currentThresholds()
  thresholdForm.value = [
    { key: 'blue', label: '蓝色预警', value: String(t.blue) },
    { key: 'yellow', label: '黄色预警', value: String(t.yellow) },
    { key: 'orange', label: '橙色预警', value: String(t.orange) },
    { key: 'red', label: '红色预警', value: String(t.red) },
  ]
  modalError.value = ''
  modal.value = 'threshold'
}

function openCalibrate(row: EntryRow) {
  activeRow.value = row
  calibrateValue.value = ''
  modalError.value = ''
  modal.value = 'calibrate'
}

function openChannel(row: EntryRow) {
  activeRow.value = row
  channelValue.value = ''
  modalError.value = ''
  modal.value = 'channel'
}

function submitCreate() {
  modalError.value = ''
  const result = saveWarningDraft({
    预警编号: form.code.trim(),
    发布对象: form.target,
    触发雨量: form.rain,
    发布渠道: form.channel,
  })
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeModal()
  errorMessage.value = result.message
  reload()
}

function submitThreshold() {
  modalError.value = ''
  const input = {
    blue: Number(thresholdForm.value[0].value),
    yellow: Number(thresholdForm.value[1].value),
    orange: Number(thresholdForm.value[2].value),
    red: Number(thresholdForm.value[3].value),
  }
  const result = updateWarningThresholds(input)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeModal()
  errorMessage.value = result.message
  reload()
}

function submitCalibrate() {
  if (!activeRow.value) {
    return
  }
  modalError.value = ''
  const result = calibrateWarningRain(Number(activeRow.value.id), calibrateValue.value)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeModal()
  errorMessage.value = result.message
  reload()
}

function submitChannel() {
  if (!activeRow.value) {
    return
  }
  modalError.value = ''
  const result = fillWarningChannel(Number(activeRow.value.id), channelValue.value)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeModal()
  errorMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  try {
    // 列表、统计、工作台同一份数据：都从 local-store 经领域重判后读取。
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    overview.value = warningOverview()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警发布列表读取失败'
  }
}

onMounted(reload)
</script>
