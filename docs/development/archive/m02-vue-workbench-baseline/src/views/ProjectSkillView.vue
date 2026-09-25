<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import AppDialog from "../components/AppDialog.vue";
import { useSkillNavigation } from "../lib/useSkillNavigation";
import BlueprintView from "./BlueprintView.vue";
import ProjectResumeView from "./ProjectResumeView.vue";

const route = useRoute();
const { leaveDialogOpen, tabHref, onTabClick, keepEditing, discardAndContinue } = useSkillNavigation();

const tabs = [
  { key: "blueprint", label: "蓝图预览" },
  { key: "resume", label: "继续项目" }
];
const active = computed(() => (route.query.skill === "resume" ? "resume" : "blueprint"));
</script>

<template>
  <div class="skill-shell">
    <nav class="skill-tabs" aria-label="项目内页面">
      <a
        v-for="tab in tabs"
        :key="tab.key"
        class="skill-tab"
        :class="{ 'skill-tab--active': tab.key === active }"
        :href="tabHref(tab.key)"
        :aria-current="tab.key === active ? 'page' : undefined"
        @click="onTabClick($event, tab.key, active)"
      >
        {{ tab.label }}
      </a>
    </nav>
    <BlueprintView v-if="active === 'blueprint'" />
    <ProjectResumeView v-else />
  </div>

  <AppDialog v-model="leaveDialogOpen" title="保留未保存的修改" @close="keepEditing">
    <p>即将离开的页面还有未保存的修改。你可以继续编辑，或丢弃草稿后离开。</p>
    <div class="dialog-actions">
      <button class="secondary-button" type="button" @click="keepEditing">保留并继续编辑</button>
      <button class="danger-button" type="button" @click="discardAndContinue">丢弃草稿并离开</button>
    </div>
  </AppDialog>
</template>