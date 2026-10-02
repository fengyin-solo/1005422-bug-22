<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>

    <!-- 预警发布口径：与预警列表/详情页同一份数据，阈值调整后这里同步重判 -->
    <div class="overview-grid">
      <div class="overview-panel">
        <h3>预警发布口径（与预警发布页同源）</h3>
        <p class="page-desc" style="margin:0 0 10px">
          级别一律以预警发布页现行雨量阈值的实时重判为准：达到哪一档就按哪一档发布；
          雨量站设备阈值不参与定级。环节按 待发布 → 已发布 → 已解除 → 已误报 流转。
        </p>
        <p class="status-legend">
          <span v-for="band in bands" :key="band.level" class="legend-item">
            <LevelBadge :level="band.level" /> ≥{{ warning.thresholds[band.key] }}mm
          </span>
        </p>
        <table class="data-table">
          <thead>
            <tr><th>待发布</th><th>已发布</th><th>已解除</th><th>本月误报数</th><th>待校准雨量</th><th>待转移预警</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{{ warning.stats.pendingPublish }}</td>
              <td>{{ warning.stats.published }}</td>
              <td>{{ warning.stats.released }}</td>
              <td>{{ warning.stats.falseAlarmsMonth }}</td>
              <td>{{ warning.stats.calibration }}</td>
              <td>{{ warning.pendingTransfers }}</td>
            </tr>
          </tbody>
        </table>
        <p class="page-desc" style="margin:8px 0 0">
          明细、本月误报数、避险搬迁「待转移预警」三处均由同一份预警记录统计，阈值调整后统一重判。
          <RouterLink class="link" to="/warning">去预警发布页 →</RouterLink>
        </p>
      </div>
      <div class="overview-panel">
        <h3>级别分布（重判后）</h3>
        <p class="status-legend" v-for="item in levelDistribution" :key="item.level">
          <LevelBadge :level="item.level" />：{{ item.count }} 条
        </p>
        <p v-if="!levelDistribution.length" class="page-desc">暂无预警</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadOverview, warningOverview, thresholdBands } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'
import LevelBadge from '@/components/LevelBadge.vue'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const warning = ref(warningOverview())
const bands = computed(() => thresholdBands(warning.value.thresholds))
const levelDistribution = computed(() =>
  ['红色预警', '橙色预警', '黄色预警', '蓝色预警', '待校准', '未达预警档']
    .map((level) => ({ level, count: warning.value.stats.levelCounts[level] ?? 0 }))
    .filter((item) => item.count > 0),
)

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  warning.value = warningOverview()
}

onMounted(refresh)
</script>
