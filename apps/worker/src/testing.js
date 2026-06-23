export class MemoryStore {
  constructor() {
    this.invites = new Map();
    this.slugs = new Map();
    this.jobs = new Map();
  }

  addInvite(codeHash, maxUses = 1) {
    this.invites.set(codeHash, { codeHash, maxUses, uses: 0 });
  }

  async getInviteByHash(hash) {
    return this.invites.get(hash) || null;
  }

  async incrementInviteUse(hash) {
    const invite = this.invites.get(hash);
    if (!invite || invite.uses >= invite.maxUses) return false;
    invite.uses += 1;
    return true;
  }

  async decrementInviteUse(hash) {
    const invite = this.invites.get(hash);
    if (invite) {
      invite.uses = Math.max(0, invite.uses - 1);
    }
  }

  async reserveSlug(slug, jobId, createdAt) {
    if (this.slugs.has(slug)) return false;
    this.slugs.set(slug, { slug, jobId, createdAt });
    return true;
  }

  async releaseSlug(slug, jobId) {
    const existing = this.slugs.get(slug);
    if (existing?.jobId === jobId) {
      this.slugs.delete(slug);
    }
  }

  async createJob(job) {
    this.jobs.set(job.jobId, { ...job });
  }

  async getJob(jobId) {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  async updateJob(jobId, patch) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, patch);
  }

  async listReapableJobs({ reservedCutoff, queuedCutoff, processingCutoff }) {
    return Array.from(this.jobs.values())
      .filter((job) => {
        if (job.status === "reserved" && job.updatedAt < reservedCutoff) return true;
        if (job.status === "queued" && job.updatedAt < queuedCutoff) return true;
        if (job.status === "processing" && job.updatedAt < processingCutoff) return true;
        return Boolean(job.uploadKey && !job.rawUploadDeletedAt && ["ready", "failed", "expired"].includes(job.status));
      })
      .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)))
      .slice(0, 100)
      .map((job) => ({ ...job }));
  }
}

export class MemoryBucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options = {}) {
    const arrayBuffer = await new Response(value).arrayBuffer();
    this.objects.set(key, {
      body: new Uint8Array(arrayBuffer),
      httpMetadata: options.httpMetadata || {},
    });
  }

  async get(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      body: new Blob([entry.body]).stream(),
      async arrayBuffer() {
        return entry.body.buffer.slice(entry.body.byteOffset, entry.body.byteOffset + entry.body.byteLength);
      },
      writeHttpMetadata(headers) {
        if (entry.httpMetadata.contentType) {
          headers.set("Content-Type", entry.httpMetadata.contentType);
        }
      },
    };
  }

  async delete(keyOrKeys) {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    for (const key of keys) {
      this.objects.delete(key);
    }
  }

  has(key) {
    return this.objects.has(key);
  }

  async text(key) {
    const entry = this.objects.get(key);
    return entry ? new TextDecoder().decode(entry.body) : null;
  }

  async bytes(key) {
    const entry = this.objects.get(key);
    return entry ? entry.body : null;
  }
}
