<script setup lang="ts">
import { useRouter } from "vue-router";
import SiteTop from "../components/SiteTop.vue";
import StateBox from "../components/StateBox.vue";
import { pickReport } from "../lib/open";

const router = useRouter();
</script>

<template>
  <div class="land">
    <SiteTop />
    <main class="w pg-body">
      <StateBox title="This link doesn’t hold a report">
        The address is cut short or was made by a newer loadsheet. Ask for the link again, or open
        the JSON file.
        <template #actions>
          <button type="button" data-slot="button" data-variant="solid" @click="pickReport(router)">
            Open a report file
          </button>
          <RouterLink data-slot="button" to="/">Go home</RouterLink>
        </template>
      </StateBox>
    </main>
  </div>
</template>
