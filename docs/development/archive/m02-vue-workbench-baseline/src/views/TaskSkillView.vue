<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import AppDialog from "../components/AppDialog.vue";
import { useSkillNavigation } from "../lib/useSkillNavigation";
import TaskDefinitionView from "./TaskDefinitionView.vue";
import TaskDetailView from "./TaskDetailView.vue";
import VerificationPlanView from "./VerificationPlanView.vue";

/**
 * /tasks/:id 承载两类内容，不新增路由：
 *   - 无 skill 查询参数：任务详情（UI-10，含产物与完成页签）；
 *   - skill=definition｜verification：既有的 Skill 页签壳。
 * 只有 Skill 壳需要局部导航与它自己的草稿对话框；任务详情的草稿由产物编辑器自己的守卫处理，
 * 避免两个对话框叠加。
 */
const route = useRoute();
const skill = computed<"definition" | "verification" | null>(() => {
  if (route.query.skill === "verification") {
    return "verification";
  }
  if (route.query.skill === "definition") {
    return "definition";
  }
  return null;
});

const navigation = skill.value === null ? null : useSkillNavigation();
const leaveDialogOpen = computed({
  get: () => navigation?.leaveDialogOpen.value ?? false,
  set: (value: boolean) => {
    if (navigation !== null) {
      navigation.leaveDialogOpen.value = value;
    }
  }
});
const tabs = [
  { key: "definition", label: "完善定义" },
  { key: "verification", label: "验收方案" }
];
</script>

<template>
  <TaskDetailView v-if="skill === null" />

  <template v-else>
    <div class="skill-shell">
      <nav class="skill-tabs" aria-label="任务内页面">
        <a
          v-for="tab in tabs"
          :key="tab.key"
          class="skill-tab"
          :class="{ 'skill-tab--active': tab.key === skill }"
          :href="navigation?.tabHref(tab.key)"
          :aria-current="tab.key === skill ? 'page' : undefined"
          @click="navigation?.onTabClick($event, tab.key, skill)"
        >
          {{ tab.label }}
        </a>
      </nav>
      <TaskDefinitionView v-if="skill === 'definition'" />
      <VerificationPlanView v-else />
    </div>

    <AppDialog v-model="leaveDialogOpen" title="保留未保存的修改" @close="navigation?.keepEditing()">
      <p>即将离开的页面还有未保存的修改。你可以继续编辑，或丢弃草稿后离开。</p>
      <div class="dialog-actions">
        <button class="secondary-button" type="button" @click="navigation?.keepEditing()">保留并继续编辑</button>
        <button class="danger-button" type="button" @click="navigation?.discardAndContinue()">丢弃草稿并离开</button>
      </div>
    </AppDialog>
  </template>
</template>
