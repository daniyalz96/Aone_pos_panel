<script setup lang="ts">
import { computed } from 'vue'
import { useColorMode } from '#imports'

const colorMode = useColorMode()

const isDark = computed(() => colorMode.value === 'dark')

const toggleTheme = () => {
  colorMode.preference = isDark.value ? 'light' : 'dark'
}
</script>

<template>
  <UButton
    color="neutral"
    variant="soft"
    :icon="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
    @click="toggleTheme"
  >
    {{ isDark ? 'Light' : 'Dark' }}
  </UButton>
</template>
