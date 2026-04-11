import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultState = {
  sessionId: "",
  accessToken: "",
  sessionAccessCode: "",
  channelId: "",
  messageId: "",
  connectedAt: "",
  lastStateHash: ""
};

export class StateStore {
  constructor(filePath, legacyFilePath = "") {
    this.filePath = filePath;
    this.legacyFilePath = legacyFilePath;
    this.state = { ...defaultState };
  }

  async readState(filePath) {
    const raw = await readFile(filePath, "utf8");
    return { ...defaultState, ...JSON.parse(raw) };
  }

  async load() {
    try {
      this.state = await this.readState(this.filePath);
      if (
        !this.state.sessionId &&
        this.legacyFilePath &&
        this.legacyFilePath !== this.filePath
      ) {
        try {
          const legacy = await this.readState(this.legacyFilePath);
          if (legacy.sessionId) {
            this.state = legacy;
            await this.save();
          }
        } catch {
          // ignore missing legacy file
        }
      }
    } catch {
      try {
        if (!this.legacyFilePath || this.legacyFilePath === this.filePath) {
          throw new Error("No legacy state file");
        }

        this.state = await this.readState(this.legacyFilePath);
        await this.save();
      } catch {
        this.state = { ...defaultState };
        await this.save();
      }
    }

    return this.snapshot();
  }

  snapshot() {
    return { ...this.state };
  }

  async save() {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }

  async patch(patch) {
    this.state = { ...this.state, ...patch };
    await this.save();
    return this.snapshot();
  }

  async clear() {
    this.state = { ...defaultState };
    await this.save();
    return this.snapshot();
  }
}
