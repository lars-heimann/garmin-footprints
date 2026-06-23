const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const bucketName = required("R2_BUCKET_NAME");
const token = required("CLOUDFLARE_API_TOKEN");
const origin = required("WORKER_API_BASE");

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/cors`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rules: [
        {
          allowed: {
            origins: [origin],
            methods: ["PUT"],
            headers: ["Content-Type"],
          },
          exposeHeaders: ["ETag"],
          maxAgeSeconds: 3600,
        },
      ],
    }),
  }
);

const payload = await response.json().catch(() => ({}));
if (!response.ok || payload.success === false) {
  throw new Error(`R2 CORS configuration failed with ${response.status}: ${JSON.stringify(payload)}`);
}

console.log(`Configured R2 CORS for ${bucketName} from ${origin}`);
