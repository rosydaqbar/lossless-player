import { env } from "../config/env.js";
import { MediaService } from "../services/media-service.js";
import { RealtimeHub } from "../services/realtime-hub.js";

export class MediaJobRunner {
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly mediaService: MediaService, private readonly hub: RealtimeHub) {}

  start() {
    if (!env.ENABLE_MEDIA_JOBS || this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      this.tick().catch((error) => console.error("media job runner tick failed", error));
    }, env.MEDIA_JOB_POLL_MS);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick() {
    const jobs = await this.mediaService.listPendingJobs();
    const job = jobs[0];
    if (!job) {
      return;
    }

    await this.mediaService.claimJob(job.id);
    this.hub.emitUploadStatus(job.sessionId, {
      sessionId: job.sessionId,
      trackId: job.trackId,
      jobStatus: "processing",
      message:
        job.jobType === "normalize_to_flac"
          ? "Normalizing upload for browser playback"
          : "Packaging chunked lossless stream"
    });

    try {
      const result = await this.mediaService.processJob(job);
      this.hub.emitUploadStatus(job.sessionId, {
        sessionId: job.sessionId,
        trackId: job.trackId,
        jobStatus: "complete",
        message: result.message
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown media job error";
      await this.mediaService.failJob(job.id, job.assetId, message);
      this.hub.emitUploadStatus(job.sessionId, {
        sessionId: job.sessionId,
        trackId: job.trackId,
        jobStatus: "failed",
        message
      });
    }
  }
}
