<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useAttrs, watch } from 'vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    text: string
    /** Max lines before ellipsis (Tailwind line-clamp). */
    lines?: 1 | 2 | 3 | 4
    tag?: 'p' | 'span'
  }>(),
  {
    lines: 3,
    tag: 'p'
  }
)

const attrs = useAttrs()
const rootRef = ref<HTMLElement | null>(null)
const isTruncated = ref(false)

const lineClampClass = computed(() => {
  const map = { 1: 'line-clamp-1', 2: 'line-clamp-2', 3: 'line-clamp-3', 4: 'line-clamp-4' } as const
  return map[props.lines]
})

const rootClass = computed(() => [lineClampClass.value, 'min-w-0 break-words', attrs.class])

const checkTruncation = () => {
  const el = rootRef.value
  if (!el) {
    isTruncated.value = false
    return
  }
  isTruncated.value = el.scrollHeight > el.clientHeight + 1
}

let resizeObserver: ResizeObserver | undefined

onMounted(async () => {
  await nextTick()
  checkTruncation()
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    resizeObserver = new ResizeObserver(() => checkTruncation())
    resizeObserver.observe(rootRef.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

watch(
  () => props.text,
  async () => {
    await nextTick()
    checkTruncation()
  }
)
</script>

<template>
  <component
    :is="tag"
    ref="rootRef"
    :class="rootClass"
    :title="isTruncated ? text : undefined"
  >
    {{ text }}
  </component>
</template>
