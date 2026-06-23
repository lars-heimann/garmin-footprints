# Deployment

## Cloudflare

1. Create an R2 bucket named `garmin-footprints`.
2. Create a D1 database and replace `database_id` in `apps/worker/wrangler.jsonc`.
3. Apply `apps/worker/migrations/0001_init.sql`.
4. Add invite code hashes to D1:

   ```sql
   INSERT INTO invites (code_hash, max_uses, uses) VALUES ('HASH_FROM_WORKER_HELPER', 1, 0);
   ```

5. Configure wildcard DNS for `*.runs.example.com` and route it to the Worker.
6. Set Worker secrets:

   ```sh
   wrangler secret put INVITE_HASH_SECRET
   wrangler secret put UPLOAD_TOKEN_SECRET
   wrangler secret put PROCESSOR_TOKEN
   wrangler secret put GITHUB_TOKEN
   ```

7. Set Worker variables for `GITHUB_REPOSITORY`, `GITHUB_REF`, and `PUBLIC_HOST_SUFFIX`.
8. Add GitHub repository secrets `WORKER_API_BASE` and `PROCESSOR_TOKEN`.
9. Deploy from `apps/worker`.

The Worker stores raw uploads under `uploads/{jobId}/garmin-export.zip`, generated assets under `sites/{slug}/`, and removes raw uploads when the processor reports either `ready` or `failed`.
