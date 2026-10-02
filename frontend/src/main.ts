import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bootstrapWarningData } from './api/local-service'
import './styles/global.css'

// 进入应用前先按现行阈值校正存量预警，并把预警结果回写避险搬迁清单。
bootstrapWarningData()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
