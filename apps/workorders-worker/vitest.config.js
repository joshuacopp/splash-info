// Matches apps/fleet-inquiry-worker's setup: tests run inside workerd via
// @cloudflare/vitest-pool-workers rather than plain Node.
//
// That matters here. The thing under test is WebCrypto HMAC, and the worker
// runs on workerd -- testing it against Node's crypto would verify a different
// implementation than the one that actually gates the route.
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
