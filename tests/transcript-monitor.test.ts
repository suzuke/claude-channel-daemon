import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { createLogger } from "../src/logger.js";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("TranscriptMonitor", () => {
  let tmpDir: string;
  let monitor: TranscriptMonitor;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-tm-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    monitor = new TranscriptMonitor(tmpDir, createLogger("silent"));
  });

  afterEach(() => {
    monitor.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits tool_use events from JSONL", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/foo" } }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const events: [string, unknown][] = [];
    monitor.on("tool_use", (name, input) => events.push([name, input]));

    await monitor.pollIncrement();
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe("Read");
  });

  it("reads only incremental content on second poll", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry1 = { message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry1) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const events: string[] = [];
    monitor.on("tool_use", (name) => events.push(name));

    await monitor.pollIncrement(); // reads entry1
    expect(events).toHaveLength(1);

    const entry2 = { message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }] } };
    appendFileSync(jsonlPath, JSON.stringify(entry2) + "\n");

    await monitor.pollIncrement(); // should only read entry2
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("Edit");
  });

  it("emits assistant_text for text blocks", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const texts: string[] = [];
    monitor.on("assistant_text", (text) => texts.push(text));

    await monitor.pollIncrement();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Hello world");
  });

  it("does not re-emit on poll with no new content", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "text", text: "once" }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const texts: string[] = [];
    monitor.on("assistant_text", (text) => texts.push(text));

    await monitor.pollIncrement();
    await monitor.pollIncrement(); // no new data
    expect(texts).toHaveLength(1);
  });

  it("skips concurrent pollIncrement calls (reentry guard)", async () => {
    const jsonlPath = join(tmpDir, "transcript.jsonl");
    const entry = { message: { role: "assistant", content: [{ type: "text", text: "once" }] } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");

    monitor.setTranscriptPath(jsonlPath);
    const texts: string[] = [];
    monitor.on("assistant_text", (text) => texts.push(text));

    // Fire two polls simultaneously; second should bail before reading
    // any bytes, so the entry is emitted exactly once.
    await Promise.all([monitor.pollIncrement(), monitor.pollIncrement()]);
    expect(texts).toHaveLength(1);
  });
});
