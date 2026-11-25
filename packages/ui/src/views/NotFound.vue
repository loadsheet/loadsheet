<script setup lang="ts">
import SiteTop from "../components/SiteTop.vue";
import StateBox from "../components/StateBox.vue";
import { usePickReport } from "../lib/open";

const pickReport = usePickReport();
</script>

<template>
  <div class="land">
    <SiteTop />
    <main class="w pg-body">
      <StateBox title="This link doesn’t hold a report">
        The address is cut short or was made by a newer loadsheet. Ask for the link again, or open
        the JSON file.
        <template #actions>
          <button type="button" data-slot="button" data-variant="solid" @click="pickReport">
            Open a report file
          </button>
          <RouterLink data-slot="button" :to="{ name: 'home' }">Go home</RouterLink>
        </template>
      </StateBox>
    </main>
  </div>
</template>
