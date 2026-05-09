<template>
  <div class="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-100 px-4 py-8 dark:bg-slate-950">
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute -left-20 top-0 h-80 w-80 rounded-full bg-emerald-400/25 blur-3xl dark:bg-emerald-500/20" />
      <div class="absolute -right-20 bottom-0 h-80 w-80 rounded-full bg-cyan-300/25 blur-3xl dark:bg-cyan-400/20" />
    </div>
    <div class="absolute right-4 top-4 z-20">
      <UiThemeToggle />
    </div>
    <slot />
  </div>
</template>
