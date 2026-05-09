<script setup lang="ts">
defineProps<{
  title: string
  value: string
  delta: string
  icon: string
  positive?: boolean
  to?: string
}>()
</script>

<template>
  <NuxtLink
    v-if="to"
    :to="to"
    class="block h-full min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
  >
    <UCard class="h-full cursor-pointer transition hover:ring-2 hover:ring-primary/25">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-sm text-slate-500">{{ title }}</p>
          <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">{{ value }}</p>
          <p :class="positive ? 'text-emerald-600' : 'text-rose-600'" class="mt-2 text-sm font-medium">
            {{ delta }}
          </p>
        </div>
        <div class="rounded-xl bg-emerald-50 p-2 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400">
          <UIcon :name="icon" class="size-5" />
        </div>
      </div>
    </UCard>
  </NuxtLink>

  <UCard v-else class="h-full min-w-0">
    <div class="flex items-start justify-between gap-4">
      <div>
        <p class="text-sm text-slate-500">{{ title }}</p>
        <p class="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">{{ value }}</p>
        <p :class="positive ? 'text-emerald-600' : 'text-rose-600'" class="mt-2 text-sm font-medium">
          {{ delta }}
        </p>
      </div>
      <div class="rounded-xl bg-emerald-50 p-2 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400">
        <UIcon :name="icon" class="size-5" />
      </div>
    </div>
  </UCard>
</template>
