<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>预警详情</h2>
        <p class="page-desc">详情页与预警列表、工作台读取同一份数据；级别一律按现行阈值实时重判展示。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/warning">返回预警列表</RouterLink>
      </div>
    </header>

    <div v-if="!row" class="empty-state" style="padding:40px">
      没有找到这条预警，<RouterLink class="link" to="/warning">返回列表</RouterLink>
    </div>

    <template v-else>
      <div class="policy-banner">
        <strong>发布口径：</strong>级别以预警发布页现行阈值（蓝{{ thresholds.blue }} / 黄{{ thresholds.yellow }} /
        橙{{ thresholds.orange }} / 红{{ thresholds.red }} mm）的重判结果为准，本页不保留任何历史定级。
      </div>

      <div class="flow-line">
        <template v-for="(step, index) in flow" :key="step">
          <span class="flow-step" :class="{ active: index <= activeIndex }">{{ step }}</span>
          <span v-if="index < flow.length - 1" class="flow-arrow">→</span>
        </template>
      </div>

      <div class="detail-grid">
        <div class="detail-item"><span>预警编号</span><strong>{{ row['预警编号'] }}</strong></div>
        <div class="detail-item"><span>当前状态</span><strong>{{ row.status }}</strong></div>
        <div class="detail-item"><span>发布对象</span><strong>{{ row['发布对象'] || '—' }}</strong></div>
        <div class="detail-item">
          <span>预警级别（现行阈值重判）</span>
          <strong><LevelBadge :level="info.level" /></strong>
        </div>
        <div class="detail-item">
          <span>触发雨量</span>
          <strong class="mono">{{ row['触发雨量'] }} mm</strong>
        </div>
        <div class="detail-item"><span>发布渠道</span><strong>{{ row['发布渠道'] || '未填写（禁止发布）' }}</strong></div>
        <div class="detail-item"><span>发布时间</span><strong>{{ row['发布时间'] || '—' }}</strong></div>
        <div class="detail-item"><span>解除时间</span><strong>{{ row['解除时间'] || '—' }}</strong></div>
        <div class="detail-item">
          <span>关联搬迁清单</span>
          <strong>{{ transferNo || '发布后回写' }}</strong>
        </div>
      </div>

      <div v-if="info.level === LEVEL_CALIBRATING" class="policy-banner" style="background:#faf5ff;border-color:#d8b4fe;color:#6b21a8">
        触发雨量「{{ row['触发雨量'] }}」精度不足（需精确到 0.1mm），已先退回校准；校准合格前不允许发布。
      </div>

      <div class="page-actions" style="margin-top:12px">
        <button v-if="info.level === LEVEL_CALIBRATING" class="btn primary" type="button" @click="openCalibrate">退回校准雨量</button>
        <button v-if="String(row.status) === '待发布' && !row['发布渠道']" class="btn" type="button" @click="openChannel">补全发布渠道</button>
        <button v-if="nextAction" class="btn primary" type="button" @click="doAction(nextAction)">{{ nextAction }}</button>
        <span v-if="!nextAction && row.status === '已误报'" class="page-desc">已到末态「已误报」，无后续环节</span>
      </div>

      <p v-if="message" :class="message.startsWith('环节') || message.includes('不允许') || message.includes('未达') || message.includes('精度') ? 'form-error' : 'page-desc'" style="margin-top:10px">
        {{ message }}
      </p>
    </template>

    <div v-if="modal === 'calibrate'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3 class="modal-title">退回校准触发雨量</h3>
        <div class="form-grid">
          <label class="form-field full">
            <span>校准后雨量（mm，精确到 0.1）</span>
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

    <div v-else-if="modal === 'channel'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3 class="modal-title">补全发布渠道</h3>
        <div class="form-grid">
          <label class="form-field full">
            <span>发布渠道</span>
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
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  calibrateWarningRain,
  fillWarningChannel,
  getWarning,
  runAction as applyAction,
  warningOverview,
} from '@/api/local-service'
import {
  LEVEL_BELOW_BANDS,
  LEVEL_CALIBRATING,
  WARNING_STATUSES,
  rainInfo,
} from '@/domain/warning'
import { listRows } from '@/data/local-store'
import LevelBadge from '@/components/LevelBadge.vue'

const route = useRoute()
const channelOptions = ['应急广播', '短信', '微信群', '铜锣预警', '上门通知', '短信+铜锣预警', '应急广播+短信', '应急广播+上门通知']

const message = ref('')
const modal = ref<'' | 'calibrate' | 'channel'>('')
const modalError = ref('')
const calibrateValue = ref('')
const channelValue = ref('')
// 用 ref 持有行数据，操作后整体重取，保证与列表页是同一份数据。
const row = ref(getWarning(Number(route.params.id)))
const thresholds = computed(() => warningOverview().thresholds)
const info = computed(() => (row.value ? rainInfo(row.value, thresholds.value) : rainInfo({ 触发雨量: '' }, thresholds.value)))
const flow = [...WARNING_STATUSES]
const activeIndex = computed(() => (row.value ? flow.indexOf(String(row.value.status) as (typeof WARNING_STATUSES)[number]) : -1))
const nextAction = computed(() => {
  if (!row.value || !info.value.precise || info.value.level === LEVEL_BELOW_BANDS) {
    return null
  }
  if (String(row.value.status) === '待发布' && !String(row.value['发布渠道'] ?? '').trim()) {
    return null
  }
  const order = [...WARNING_STATUSES]
  const index = order.indexOf(String(row.value.status) as (typeof WARNING_STATUSES)[number])
  return ['确认发布', '解除预警', '标记误报'][index] ?? null
})
const transferNo = computed(() => {
  if (!row.value) {
    return ''
  }
  const found = listRows('relocate').find(
    (item) => String(item['来源预警'] ?? '') === String(row.value!['预警编号'] ?? ''),
  )
  return found ? String(found['搬迁编号']) : ''
})

function refresh() {
  row.value = getWarning(Number(route.params.id))
}

watch(
  () => route.params.id,
  () => {
    message.value = ''
    closeModal()
    refresh()
  },
)

function closeModal() {
  modal.value = ''
  modalError.value = ''
}

function openCalibrate() {
  calibrateValue.value = ''
  modalError.value = ''
  modal.value = 'calibrate'
}

function openChannel() {
  channelValue.value = ''
  modalError.value = ''
  modal.value = 'channel'
}

function submitCalibrate() {
  if (!row.value) {
    return
  }
  const result = calibrateWarningRain(Number(row.value.id), calibrateValue.value)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeModal()
  message.value = result.message
  refresh()
}

function submitChannel() {
  if (!row.value) {
    return
  }
  const result = fillWarningChannel(Number(row.value.id), channelValue.value)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeModal()
  message.value = result.message
  refresh()
}

function doAction(action: string) {
  if (!row.value) {
    return
  }
  const result = applyAction('warning', Number(row.value.id), action)
  message.value = result.message
  refresh()
}
</script>
