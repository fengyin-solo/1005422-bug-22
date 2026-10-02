<template>
  <span class="level-badge" :class="badgeClass">{{ level }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { LEVEL_BELOW_BANDS, LEVEL_CALIBRATING } from '@/domain/warning'

const props = defineProps<{ level: string }>()

// 级别着色只认这一处：列表、详情、搬迁清单、工作台显示完全一致。
const badgeClass = computed(() => {
  switch (props.level) {
    case '红色预警':
      return 'lv-red'
    case '橙色预警':
      return 'lv-orange'
    case '黄色预警':
      return 'lv-yellow'
    case '蓝色预警':
      return 'lv-blue'
    case LEVEL_CALIBRATING:
      return 'lv-calibrate'
    case LEVEL_BELOW_BANDS:
      return 'lv-below'
    default:
      return ''
  }
})
</script>
