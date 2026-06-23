export class MemoryStore {
  constructor() {
    this.invites = new Map();
    this.slugs = new Map();
    this.jobs = new Map();
  }

  addInvite(codeHash, maxUses = 1) {
    this.invites.set(codeHash, { codeHash, maxUses, uses: 0, reservedUses: 0 });
  }

  async getInviteByHash(hash) {
    return this.invites.get(hash) || null;
  }

  async reserveInviteUse(hash) {
    const invite = this.invites.get(hash);
    if (!invite || invite.uses + invite.reservedUses >= invite.maxUses) return false;
    invite.reservedUses += 1;
    return true;
  }

  async consumeInviteReservation(hash) {
    const invite = this.invites.get(hash);
    if (!invite || invite.reservedUses <= 0 || invite.uses >= invite.maxUses) return false;
    invite.reservedUses -= 1;
    invite.uses += 1;
    return true;
  }

  async releaseInviteReservation(hash) {
    const invite = this.invites.get(hash);
    if (invite) {
      invite.reservedUses = Math.max(0, invite.reservedUses - 1);
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

  async listReapableJobs({ reservedCutoff, uploadingCutoff, queuedCutoff, processingCutoff }) {
    return Array.from(this.jobs.values())
      .filter((job) => {
        if (job.status === "reserved" && job.updatedAt < reservedCutoff) return true;
        if (job.status === "uploading" && job.updatedAt < uploadingCutoff) return true;
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
    this.multipartUploads = new Map();
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

  async createMultipartUpload(key, options = {}) {
    const uploadId = crypto.randomUUID();
    this.multipartUploads.set(`${key}:${uploadId}`, {
      key,
      uploadId,
      httpMetadata: options.httpMetadata || {},
      parts: new Map(),
    });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key, uploadId) {
    const id = `${key}:${uploadId}`;
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, value) => {
        const upload = this.multipartUploads.get(id);
        if (!upload) throw new Error("No such multipart upload.");
        const arrayBuffer = await new Response(value).arrayBuffer();
        const body = new Uint8Array(arrayBuffer);
        const etag = `"${String(partNumber).padStart(32, "0")}"`;
        upload.parts.set(partNumber, { body, etag, partNumber });
        return { partNumber, etag };
      },
      complete: async (parts) => {
        const upload = this.multipartUploads.get(id);
        if (!upload) throw new Error("No such multipart upload.");
        const chunks = [];
        for (const part of parts) {
          const stored = upload.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) {
            throw new Error("Multipart part is missing or has a mismatched ETag.");
          }
          chunks.push(stored.body);
        }
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.objects.set(key, { body, httpMetadata: upload.httpMetadata });
        this.multipartUploads.delete(id);
        return { key, size, httpEtag: `"multipart-${parts.length}"` };
      },
      abort: async () => {
        this.multipartUploads.delete(id);
      },
    };
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
