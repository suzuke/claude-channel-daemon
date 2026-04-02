import { unlinkSync } from "node:fs";
import { transcribe } from "../stt.js";
import type { InboundMessage, ChannelAdapter } from "./types.js";

export interface AttachmentResult {
  text: string;
  extraMeta: Record<string, string>;
}

/**
 * Process attachments on an inbound message:
 * - Auto-download photos → extraMeta.image_path
 * - Transcribe voice/audio via Groq Whisper → prepend to text
 * - Pass other attachment types as file_id for manual download
 */
export async function processAttachments(
  msg: InboundMessage,
  adapter: ChannelAdapter,
  logger: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void },
  logPrefix?: string,
): Promise<AttachmentResult> {
  let text = msg.text;
  const extraMeta: Record<string, string> = {};

  // Auto-download photos so Claude can Read them directly
  const photoAttachment = msg.attachments?.find(a => a.kind === "photo");
  if (photoAttachment) {
    try {
      const localPath = await adapter.downloadAttachment(photoAttachment.fileId);
      extraMeta.image_path = localPath;
      text = `[📷 Image: ${localPath}]\n${text}`;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Photo download failed");
    }
  }

  // Transcribe voice/audio
  const voiceAttachment = msg.attachments?.find(a => a.kind === "voice" || a.kind === "audio");
  if (voiceAttachment) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const localPath = await adapter.downloadAttachment(voiceAttachment.fileId);
        const result = await transcribe(localPath, groqKey);
        try { unlinkSync(localPath); } catch { /* ignore */ }
        text = text ? `${text}\n\n[語音訊息] ${result.text}` : `[語音訊息] ${result.text}`;
        logger.info({ ...(logPrefix ? { context: logPrefix } : {}), transcription: result.text.slice(0, 80) }, "Voice transcribed");
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Voice transcription failed");
        text = text || "[語音訊息 — 轉錄失敗]";
      }
    } else {
      text = text || "[語音訊息 — 未設定 STT API key]";
    }
    extraMeta.attachment_file_id = voiceAttachment.fileId;
  }

  // Pass other attachment types as file_id for manual download
  const otherAttachment = msg.attachments?.find(a =>
    a.kind !== "photo" && a.kind !== "voice" && a.kind !== "audio",
  );
  if (otherAttachment) {
    extraMeta.attachment_file_id = otherAttachment.fileId;
  }

  return { text, extraMeta };
}
