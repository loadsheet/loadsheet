<script setup lang="ts">
import { StateBox } from "@loadsheet/ui";
import type { NuxtError } from "#app";

const props = defineProps<{ error: NuxtError }>();
const missing = computed(() => props.error.status === 404);
useHead({ title: missing.value ? "Not found · loadsheet" : "Error · loadsheet" });
</script>

<template>
  <NuxtLayout>
    <main class="w pg-body">
      <StateBox :title="missing ? 'loadsheet has no page here' : 'This page broke'">
        {{
          missing
            ? "The address may be mistyped, or the page has moved."
            : "Something went wrong while it rendered. Try again in a moment."
        }}
        <template #actions>
          <button
            type="button"
            data-slot="button"
            data-variant="solid"
            @click="clearError({ redirect: '/' })"
          >
            Go home
          </button>
        </template>
      </StateBox>
    </main>
  </NuxtLayout>
</template>
