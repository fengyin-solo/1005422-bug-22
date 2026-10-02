<template>
  <section class="page" data-module="relocate">
    <header class="page-head">
      <div>
        <h2>避险搬迁管理</h2>
        <p class="page-desc">维护搬迁安置单，围绕搬迁编号、所属隐患点、涉及户数、安置方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记搬迁安置单</button>
        <button class="btn" type="button" @click="exportRows">导出避险搬迁清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待签订户数</span>
        <strong class="stat-value">{{ stats.unsigned }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">搬迁中户数</span>
        <strong class="stat-value">{{ stats.moving }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已安置户数</span>
        <strong class="stat-value">{{ stats.done }}</strong>
      </article>
      <!-- 清单里多出来的一项：预警发布结果回写的待转移预警，数量与预警页同源 -->
      <article class="stat-card">
        <span class="stat-label">待转移预警（预警发布回写）</span>
        <strong class="stat-value">{{ stats.pendingTransfers }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <h3 class="section-title">搬迁安置单</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in regularRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!regularRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无搬迁安置单</td>
        </tr>
      </tbody>
    </table>

    <!-- 待转移预警：预警发布/解除/误报环节回写，同一条预警沿用同一条清单 -->
    <h3 class="section-title">
      待转移预警清单
      <span class="page-desc">（预警发布结果自动回写；按预警编号去重，重复提交不新增）</span>
    </h3>
    <table class="data-table transfer-table">
      <thead>
        <tr>
          <th>清单编号</th>
          <th>来源预警</th>
          <th>发布对象</th>
          <th>预警级别（与预警页一致）</th>
          <th>触发雨量</th>
          <th>发布渠道</th>
          <th>转移状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in transferRows" :key="String(row.id)">
          <td>{{ row['搬迁编号'] }}</td>
          <td>
            <RouterLink class="link" :to="warningLink(row)">{{ row['来源预警'] }}</RouterLink>
          </td>
          <td>{{ row['所属隐患点'] }}</td>
          <td><LevelBadge :level="String(row['预警级别'] ?? '')" /></td>
          <td class="mono">{{ row['触发雨量'] }} mm</td>
          <td>{{ row['发布渠道'] || '—' }}</td>
          <td>{{ transferStatusLabel(row) }}</td>
          <td class="row-actions">
            <button v-if="String(row.status) === '待签订'" class="link" type="button" @click="runAction('确认签订', row)">
              确认转移
            </button>
            <button v-if="String(row.status) === '已签订'" class="link" type="button" @click="runAction('开始搬迁', row)">
              开始搬迁
            </button>
            <button v-if="String(row.status) === '搬迁中'" class="link" type="button" @click="runAction('确认完成', row)">
              确认完成
            </button>
            <span v-if="String(row.status) === '已完成'" class="page-desc">已完成转移</span>
          </td>
        </tr>
        <tr v-if="!transferRows.length">
          <td colspan="8" class="empty-state">暂无回写的待转移预警；预警发布后会自动出现在这里</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条避险搬迁记录（含安置单 {{ regularRows.length }} 条、待转移预警 {{ transferRows.length }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import LevelBadge from '@/components/LevelBadge.vue'

const meta = moduleMeta('relocate')
const columns = ["搬迁编号", "所属隐患点", "涉及户数", "安置方式", "安置地点", "签订日期", "完成日期", "搬迁状态"]
// 搬迁安置单环节次序：待签订 → 已签订 → 搬迁中 → 已完成，只能按序流转。
const actionByStatus: Record<string, string> = {
  待签订: '确认签订',
  已签订: '开始搬迁',
  搬迁中: '确认完成',
  已完成: '',
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')

const transferRows = computed(() => rows.value.filter((row) => String(row['清单类别'] ?? '') === '待转移预警'))
const regularRows = computed(() => rows.value.filter((row) => String(row['清单类别'] ?? '') !== '待转移预警'))

function toHouseholds(list: EntryRow[]): number {
  return list.reduce((sum, row) => sum + (Number(row['涉及户数']) || 0), 0)
}

const stats = computed(() => ({
  unsigned: toHouseholds(regularRows.value.filter((row) => String(row.status) === '待签订')),
  moving: toHouseholds(regularRows.value.filter((row) => String(row.status) === '搬迁中')),
  done: toHouseholds(regularRows.value.filter((row) => String(row.status) === '已完成')),
  // 待转移预警数直接取清单条目，与预警页 warningOverview() 是同一份回写数据
  pendingTransfers: transferRows.value.filter((row) => String(row.status) === '待签订').length,
}))

const statusSummary = computed(() =>
  ['待签订', '已签订', '搬迁中', '已完成'].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  const action = actionByStatus[String(row.status)]
  return action ? [action] : []
}

function transferStatusLabel(row: EntryRow): string {
  const map: Record<string, string> = {
    待签订: '待转移',
    已签订: '已确认转移',
    搬迁中: '转移中',
    已完成: '转移完成',
  }
  return map[String(row.status)] ?? String(row.status)
}

function warningLink(row: EntryRow): string {
  // 预警详情按编号找 id；找不到就回预警列表。
  const code = String(row['来源预警'] ?? '')
  const found = listEntries('warning').items.find((item) => String(item['预警编号']) === code)
  return found ? `/warning/${found.id}` : '/warning'
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '搬迁安置单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, {})
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险搬迁列表读取失败'
  }
}

onMounted(reload)
</script>
