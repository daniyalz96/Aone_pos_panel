<script setup lang="ts">
defineProps<{
  label: string
  value?: string | number | null
  class?: string
}>()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-0.5" :class="class">
    <span class="text-xs font-medium text-slate-500 dark:text-slate-400">{{ label }}</span>
    <span class="text-sm text-slate-900 dark:text-slate-100">
      <slot>{{ value ?? '—' }}</slot>
    </span>
  </div>
</template>
