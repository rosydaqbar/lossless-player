import { describe, expect, it } from "vitest";
import { pickBestAsset, requiresSegmentedLosslessPlayback } from "./playback.js";
import { buildPlaybackManifest, parseDashSegmentTimeline } from "../services/media-service.js";

describe("requiresSegmentedLosslessPlayback", () => {
  it("returns false for mp3 uploads", () => {
    expect(
      requiresSegmentedLosslessPlayback({
        extension: ".mp3",
        mimeType: "audio/mpeg",
        codec: "mp3"
      })
    ).toBe(false);
  });

  it("returns true for lossless uploads", () => {
    expect(
      requiresSegmentedLosslessPlayback({
        extension: ".flac",
        mimeType: "audio/flac",
        codec: "flac"
      })
    ).toBe(true);
  });
});

describe("pickBestAsset", () => {
  it("prefers streaming playback for lossless tracks when segmented playback is supported", () => {
    const result = pickBestAsset({
      track: {
        extension: ".flac",
        mimeType: "audio/flac",
        codec: "flac"
      },
      assets: [
        {
          assetId: "stream-asset",
          kind: "streaming_playback",
          status: "complete",
          mimeType: "application/json",
          container: "flac_chunks",
          codec: "flac"
        }
      ],
      capabilities: {
        mimeTypes: [],
        supportsFlac: true,
        supportsMp3: true,
        supportsWav: true,
        supportsAiff: false,
        supportsMseFlacSegmented: true
      }
    });

    expect(result).toEqual({
      mode: "lossless_chunked",
      asset: expect.objectContaining({
        assetId: "stream-asset"
      })
    });
  });

  it("returns unsupported for lossless tracks when segmented playback is unavailable", () => {
    const result = pickBestAsset({
      track: {
        extension: ".flac",
        mimeType: "audio/flac",
        codec: "flac"
      },
      assets: [],
      capabilities: {
        mimeTypes: [],
        supportsFlac: false,
        supportsMp3: false,
        supportsWav: false,
        supportsAiff: false,
        supportsMseFlacSegmented: false
      }
    });

    expect(result).toEqual({
      mode: "unsupported",
      reason: "Chunked lossless playback requires Chromium or Edge on this device."
    });
  });

  it("keeps mp3 on the direct file path", () => {
    const result = pickBestAsset({
      track: {
        extension: ".mp3",
        mimeType: "audio/mpeg",
        codec: "mp3"
      },
      assets: [
        {
          assetId: "mp3-asset",
          kind: "original",
          status: "complete",
          mimeType: "audio/mpeg",
          container: "mpeg",
          codec: "mp3"
        }
      ],
      capabilities: {
        mimeTypes: [],
        supportsFlac: false,
        supportsMp3: true,
        supportsWav: true,
        supportsAiff: false,
        supportsMseFlacSegmented: true
      }
    });

    expect(result).toEqual({
      mode: "direct_file",
      asset: expect.objectContaining({
        assetId: "mp3-asset"
      })
    });
  });
});

describe("buildPlaybackManifest", () => {
  it("creates ordered segment timing from chunk filenames", () => {
    const manifest = buildPlaybackManifest({
      trackId: "11111111-1111-1111-1111-111111111111",
      assetId: "22222222-2222-2222-2222-222222222222",
      durationMs: 4500,
      segmentDurationMs: 2000,
      segmentNames: ["seg-00001.m4s", "seg-00002.m4s", "seg-00003.m4s"]
    });

    expect(manifest.segmentDurationMs).toBe(2000);
    expect(manifest.segments).toEqual([
      expect.objectContaining({ index: 0, startMs: 0, endMs: 2000 }),
      expect.objectContaining({ index: 1, startMs: 2000, endMs: 4000 }),
      expect.objectContaining({ index: 2, startMs: 4000, endMs: 4500 })
    ]);
  });

  it("uses the parsed DASH timeline when exact segment timing is available", () => {
    const manifest = buildPlaybackManifest({
      trackId: "11111111-1111-1111-1111-111111111111",
      assetId: "22222222-2222-2222-2222-222222222222",
      durationMs: 162100,
      segmentNames: ["seg-00001.m4s", "seg-00002.m4s", "seg-00003.m4s"],
      timedSegments: [
        { segmentName: "seg-00001.m4s", startMs: 0, endMs: 2090 },
        { segmentName: "seg-00002.m4s", startMs: 2090, endMs: 4180 },
        { segmentName: "seg-00003.m4s", startMs: 4180, endMs: 6270 }
      ]
    });

    expect(manifest.segments).toEqual([
      expect.objectContaining({ index: 0, startMs: 0, endMs: 2090 }),
      expect.objectContaining({ index: 1, startMs: 2090, endMs: 4180 }),
      expect.objectContaining({ index: 2, startMs: 4180, endMs: 6270 })
    ]);
  });
});

describe("parseDashSegmentTimeline", () => {
  it("extracts exact segment timing from the ffmpeg dash manifest", () => {
    const result = parseDashSegmentTimeline(
      `<?xml version="1.0" encoding="utf-8"?>
<MPD mediaPresentationDuration="PT2M42.1S">
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate timescale="44100" initialization="init.mp4" media="seg-$Number%05d$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="92160" r="2" />
            <S d="54212" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
      ["seg-00001.m4s", "seg-00002.m4s", "seg-00003.m4s", "seg-00004.m4s"]
    );

    expect(result.durationMs).toBe(162100);
    expect(result.segments).toEqual([
      { segmentName: "seg-00001.m4s", startMs: 0, endMs: 2090 },
      { segmentName: "seg-00002.m4s", startMs: 2090, endMs: 4180 },
      { segmentName: "seg-00003.m4s", startMs: 4180, endMs: 6269 },
      { segmentName: "seg-00004.m4s", startMs: 6269, endMs: 7499 }
    ]);
  });
});
