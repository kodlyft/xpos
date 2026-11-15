import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import path from "path";

export default defineConfig({
	plugins: [vue()],
	resolve: {
		alias: {
			"@mobile": path.resolve(import.meta.dirname, "src"),
			"@": path.resolve(import.meta.dirname, "../frontend/src"),
		},
		dedupe: ["vue", "pinia", "radix-vue", "clsx", "tailwind-merge", "class-variance-authority"],
	},
	test: { environment: "node", include: ["tests/**/*.spec.ts"], testTimeout: 60_000 },
});
