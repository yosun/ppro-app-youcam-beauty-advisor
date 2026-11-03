import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Camera, Send } from "lucide-react";
import type { BeautyAdvisorClient } from "../../client/index.ts";
import type { Message } from "../../protocol/types.ts";
import type { BeautySession } from "../apply-event.ts";
import { AppImage } from "../components/AppImage.tsx";
import { AskCard } from "../components/AskCard.tsx";

// The conversation. The advisor's tool results appear in it as cards, so the
// client sees what the advisor did even when they are on another screen.

type Card = Record<string, unknown>;

const record = (value: unknown): Card =>
  value && typeof value === "object" ? (value as Card) : {};

function ToolCard({
  message,
  client,
  onOpen,
}: {
  message: Message;
  client: BeautyAdvisorClient;
  onOpen: (screen: string) => void;
}) {
  const data = record(message.data);
  const tool = String(data.tool ?? "");
  if (message.kind === "notice")
    return <div className="chat-note">{message.body}</div>;

  if (message.kind === "try_on") {
    const tryOn = record(data.tryOn);
    const swatches = (Array.isArray(tryOn.swatches) ? tryOn.swatches : []) as {
      part: string;
      color: string;
    }[];
    return (
      <div className="card">
        <AppImage
          client={client}
          id={String(tryOn.imageId ?? "")}
          alt={`Try-on: ${String(tryOn.title ?? "makeup")}`}
          className="card-image"
          gone={<p>This image was deleted.</p>}
        />
        <div className="card-row">
          <h4>{String(tryOn.title ?? "Try-on")}</h4>
          {tryOn.simulated === true && (
            <span className="demo-tag">Demo preview</span>
          )}
        </div>
        {swatches.length > 0 && (
          <div className="card-swatches">
            {swatches.map((swatch) => (
              <span key={`${swatch.part}-${swatch.color}`}>
                <i style={{ background: swatch.color }} />
                {swatch.part}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (message.kind === "looks") {
    const looks = (Array.isArray(data.looks) ? data.looks : []) as {
      title: string;
    }[];
    return (
      <div className="card">
        <h4>Looks to try</h4>
        <div className="look-chips">
          {looks.map((look) => (
            <span key={look.title}>{look.title}</span>
          ))}
        </div>
      </div>
    );
  }

  if (message.kind === "analysis" && tool !== "recommend_products") {
    const report = record(data.report);
    const scores = (Array.isArray(report.scores) ? report.scores : []) as {
      label: string;
    }[];
    const attributes = (
      Array.isArray(report.attributes) ? report.attributes : []
    ) as {
      name: string;
      value: string;
    }[];
    const isSkin = tool === "analyze_skin";
    return (
      <div className="card">
        <div className="card-row">
          <h4>{String(data.title ?? message.body)}</h4>
          {report.simulated === true && (
            <span className="demo-tag">Demo preview</span>
          )}
        </div>
        <p>
          {isSkin
            ? `Needs the most care: ${scores
                .slice(0, 3)
                .map((s) => s.label)
                .join(", ")}`
            : attributes
                .slice(0, 3)
                .map((a) => `${a.name}: ${a.value}`)
                .join(" · ")}
        </p>
        <button
          type="button"
          className="card-link"
          onClick={() => onOpen(isSkin ? "skin" : "face")}
        >
          View
        </button>
      </div>
    );
  }

  if (message.kind === "picks")
    return (
      <div className="card">
        <div className="card-row">
          <h4>{message.body}</h4>
          <button
            type="button"
            className="card-link"
            onClick={() => onOpen("picks")}
          >
            View
          </button>
        </div>
      </div>
    );

  if (message.kind === "card")
    return (
      <div className="card">
        <div className="card-row">
          <h4>{message.body}</h4>
          <button
            type="button"
            className="card-link"
            onClick={() => onOpen("look")}
          >
            View
          </button>
        </div>
      </div>
    );

  return <div className="chat-note">{message.body}</div>;
}

export function ChatScreen({
  session,
  client,
  starters,
  photo,
  onSend,
  onOpen,
  onPhotoRequest,
}: {
  session: BeautySession;
  client: BeautyAdvisorClient;
  starters: readonly string[];
  photo: {
    busy: boolean;
    error: string | null;
    camera: () => void;
    upload: () => void;
    dismiss: (() => void) | null;
  };
  onSend: (text: string) => Promise<void>;
  onOpen: (screen: string) => void;
  /** Open the camera or picker without a prior card (the composer button). */
  onPhotoRequest: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const ended = session.phase === "ended";
  const name = session.advisor.name;
  const hasClientText = session.messages.some(
    (m) => m.role === "client" && m.kind === "text",
  );

  useEffect(() => {
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: "smooth",
    });
  }, [session.messages.length, session.presence, session.ui.mediaRequest]);

  async function send(text = draft) {
    const body = text.trim();
    if (!body || sending || ended) return;
    setSending(true);
    try {
      await onSend(body);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  }

  const showAsk =
    !ended && (session.ui.mediaRequest || session.photos.length === 0);
  return (
    <>
      <div
        className="chat-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        {session.messages.length === 0 && !showAsk && (
          <div className="chat-note">{name} will be with you shortly.</div>
        )}
        {session.messages.map((message) => {
          if (message.role === "tool" || message.role === "system")
            return (
              <ToolCard
                key={message.seq}
                message={message}
                client={client}
                onOpen={onOpen}
              />
            );
          if (message.kind === "photo") {
            const photoId = String(record(message.data).photoId ?? "");
            return (
              <div
                key={message.seq}
                className="bubble"
                data-from="client"
                data-photo=""
              >
                <AppImage
                  client={client}
                  id={photoId}
                  alt="Your photo"
                  className="bubble-photo"
                  gone={<span className="bubble-gone">Photo deleted</span>}
                />
              </div>
            );
          }
          return (
            <div key={message.seq} className="bubble" data-from={message.role}>
              {message.role === "agent" && (
                <span className="bubble-who">{name}</span>
              )}
              {message.body}
            </div>
          );
        })}
        {session.presence === "thinking" && (
          <div className="chat-typing" aria-label={`${name} is typing`}>
            <i />
            <i />
            <i />
          </div>
        )}
        {showAsk && (
          <AskCard
            session={session}
            client={client}
            busy={photo.busy}
            error={photo.error}
            onCamera={photo.camera}
            onUpload={photo.upload}
            onNotNow={session.ui.mediaRequest ? photo.dismiss : null}
          />
        )}
      </div>
      {!hasClientText && !ended && (
        <div className="chat-starters">
          {starters.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => void send(starter)}
            >
              {starter}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <button
          type="button"
          className="round-button"
          aria-label="Share a selfie"
          disabled={ended}
          onClick={onPhotoRequest}
        >
          <Camera size={18} aria-hidden="true" />
        </button>
        <textarea
          rows={1}
          value={draft}
          placeholder={
            ended ? "This consultation has ended" : `Message ${name}`
          }
          aria-label={`Message ${name}`}
          disabled={ended}
          maxLength={1000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="round-button"
          data-primary=""
          aria-label="Send"
          disabled={ended || sending || !draft.trim()}
          onClick={() => void send()}
        >
          <Send size={17} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
