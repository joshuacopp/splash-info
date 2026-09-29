// Same setup as apps/workorders-worker and apps/fleet-inquiry-worker: tests run
// inside workerd via @cloudflare/vitest-pool-workers rather than plain Node.
//
// It matters more here than the pure-function suites suggest. What this worker
// most needs covered is its AUTHORITY rules, and those reach for WebCrypto,
// `fetch` and the Supabase bindings on the paths that are not pure. Running
// them under Node would verify a different runtime than the one that actually
// gates the routes, which is the class of mistake these tests exist to catch.
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.toml" },
			},
		},
	},
});
