import { describe, expect, it } from "vitest";
import {
  canManagePlayback,
  computeCurrentPositionMs,
  pickBestAsset,
  requiresNormalization
} from "../src/lib/playback.js";

describe("playback helpers", () => {
  it("computes current position while playing", () => {
    expect(
      computeCurrentPositionMs(
        { status: "playing", basePositionMs: 1000, effectiveAtMs: 5000 },
        6500
      )
    ).toBe(2500);
  });

  it("allows all session members to manage playback", () => {
    expect(canManagePlayback("owner")).toBe(true);
    expect(canManagePlayback("controller")).toBe(true);
    expect(canManagePlayback("listener")).toBe(true);
  });

  it("prefers direct FLAC when client supports it", () => {
    const selected = pickBestAsset({
      track: {
        extension: ".flac",
        mimeType: "audio/flac",
        codec: "flac"
      },
      assets: [
        { assetId: "1", kind: "original", mimeType: "audio/flac", status: "complete" },
        {
          assetId: "2",
          kind: "streaming_playback",
          mimeType: "application/json",
          container: "flac_chunks",
          codec: "flac",
          status: "complete"
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
    expect(selected).toEqual({
      mode: "direct_file",
      asset: expect.objectContaining({ assetId: "1" })
    });
  });

  it("marks DSD uploads for normalization", () => {
    expect(requiresNormalization({ extension: ".dsf", codec: "DSD", mimeType: "audio/dsd" })).toBe(true);
  });
});
