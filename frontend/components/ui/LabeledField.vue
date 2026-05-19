<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    htmlFor?: string
    required?: boolean
    hint?: string
    class?: string
  }>(),
  { required: false }
)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5" :class="class">
    <label
      v-if="label"
      :for="htmlFor"
      class="block text-xs font-medium text-slate-600 dark:text-slate-300"
    >
      {{ label }}<span v-if="required" class="text-red-500"> *</span>
    </label>
    <p v-if="hint" class="text-xs text-slate-500 dark:text-slate-400">{{ hint }}</p>
    <slot />
  </div>
</template>
