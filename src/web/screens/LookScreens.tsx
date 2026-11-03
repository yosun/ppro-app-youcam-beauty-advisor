import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, Copy, Download } from "lucide-react";
import type { BeautyAdvisorClient } from "../../client/index.ts";
import type { ShadeArea } from "../../advisor/types.ts";
import { parseTarget } from "../../advisor/screens.ts";
import type { BeautySession } from "../apply-event.ts";
import { AppImage } from "../components/AppImage.tsx";

// The Look, Steps and Shades screens: the presented look as a before-and-after,
// the steps to get it and the exact shades. Ported from the original YouCam
// Beauty professional app. Where that app followed a video's cues, these
// follow the advisor: whatever `ui.target` points at is highlighted.

const AREA_LABEL: Record<ShadeArea, string> = {
  lips: "Lips",
  cheeks: "Cheeks",
  eyes: "Eyes",
  face: "Face",
  brows: "Brows",
};

type ItemState = "next" | "active" | "done" | undefined;

function LipsIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 48 28" aria-hidden="true" className="pa-shade-lips">
      <path
        d="M2 14C8 6 14 2 19 3.5c2.2.6 3.6 2 5 2s2.8-1.4 5-2C34 2 40 6 46 14c-6 7-13 12-22 12S8 21 2 14Z"
        fill={color}
      />
      <path
        d="M4 14c6 1.6 13 2.4 20 2.4S38 15.6 44 14"
        stroke="#0003"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M14 7.5c3-.8 5.5-.2 8 .8"
        stroke="#fff6"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Where the advisor is pointing, as {section, index}, while the app follows. */
function pointer(session: BeautySession) {
  if (!session.ui.following)
    return { section: null, item: null as number | null };
  const parsed = parseTarget(session.ui.target);
  const item = parsed?.item;
  return {
    section: parsed?.section ?? null,
    item:
      item !== null && item !== undefined && /^\d+$/.test(item)
        ? Number(item)
        : null,
  };
}

function useCopy(onAction: (action: "copy" | "save", target: string) => void) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    copied,
    async write(text: string, key: string, target: string) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(key);
        onAction("copy", target);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(null), 1600);
      } catch {
        setCopied(null);
      }
    },
  };
}

export function LookScreen({
  session,
  client,
  compare,
  onCompare,
}: {
  session: BeautySession;
  client: BeautyAdvisorClient;
  /** Divider position from the left, 0 to 100, or null for the default. */
  compare: number | null;
  onCompare: (position: number) => void;
}) {
  const card = session.app.card;
  const { section } = pointer(session);
  if (!card?.image) return null;
  const sweeping =
    session.ui.following && section === "look" && compare === null;
  return (
    <>
      {card.question && <p className="pa-question">“{card.question}”</p>}
      <p className="pa-kicker">The look</p>
      <h3 className="pa-title">{card.title}</h3>
      <figure
        className="pa-compare"
        data-sweep={sweeping ? "on" : undefined}
        data-compare={card.before ? "true" : undefined}
        style={
          compare === null || sweeping
            ? undefined
            : ({ "--pa-split": `${compare}%` } as CSSProperties)
        }
      >
        {card.before && (
          <AppImage
            client={client}
            id={card.before.id}
            alt={card.before.alt}
            className="pa-compare-before"
          />
        )}
        <AppImage
          client={client}
          id={card.image.id}
          alt={card.image.alt}
          className="pa-compare-after"
        />
        {card.before && (
          <>
            <span className="pa-compare-tag pa-compare-tag-before">Before</span>
            <span className="pa-compare-tag pa-compare-tag-after">After</span>
            <span className="pa-compare-handle" aria-hidden="true" />
            <input
              className="pa-compare-range"
              type="range"
              min={0}
              max={100}
              value={compare ?? 50}
              aria-label="Drag to compare before and after the try-on"
              aria-valuetext={`${100 - (compare ?? 50)}% after`}
              onChange={(event) => onCompare(Number(event.target.value))}
            />
          </>
        )}
        <figcaption>{card.image.caption || "Try-on"}</figcaption>
      </figure>
      <p className="pa-note">
        {card.before ? "Drag the line to compare." : "The try-on result."}
      </p>
    </>
  );
}

export function StepsScreen({
  session,
  onNext,
}: {
  session: BeautySession;
  /** Open the shades screen. */
  onNext: () => void;
}) {
  const card = session.app.card;
  const { section, item } = pointer(session);
  if (!card) return null;
  // Only a pointer at one step (step:N) highlights; "steps" shows the list.
  const pointed = session.ui.following && section === "step" && item !== null;
  const stateOf = (index: number): ItemState =>
    !pointed
      ? undefined
      : index < item
        ? "done"
        : index === item
          ? "active"
          : "next";
  return (
    <>
      <p className="pa-kicker">How to get it</p>
      <h3 className="pa-title">{card.title}</h3>
      <ol className="pa-steps">
        {card.steps.map((step, index) => {
          const state = stateOf(index);
          return (
            <li
              key={index}
              data-state={state}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="pa-step-number" aria-hidden="true">
                {state === "done" ? (
                  <Check size={13} strokeWidth={3} />
                ) : (
                  index + 1
                )}
              </span>
              <p>{step}</p>
            </li>
          );
        })}
      </ol>
      {card.shades.length > 0 && (
        <button type="button" className="pa-next" onClick={onNext}>
          <span className="pa-next-swatches" aria-hidden="true">
            {card.shades.map((shade) => (
              <span key={shade.hex} style={{ background: shade.hex }} />
            ))}
          </span>
          <span>
            <strong>The shades</strong>
            <small>{card.shades.map((shade) => shade.label).join(" · ")}</small>
          </span>
        </button>
      )}
    </>
  );
}

export function ShadesScreen({
  session,
  client,
  onAction,
}: {
  session: BeautySession;
  client: BeautyAdvisorClient;
  onAction: (action: "copy" | "save", target: string) => void;
}) {
  const card = session.app.card;
  const { section, item } = pointer(session);
  const { copied, write } = useCopy(onAction);
  if (!card) return null;
  const pointed = session.ui.following && section === "shade" && item !== null;
  const stateOf = (index: number): ItemState =>
    !pointed
      ? undefined
      : index < item
        ? "done"
        : index === item
          ? "active"
          : "next";
  const list = [
    `${card.title} (${session.advisor.name}, YouCam Beauty Advisor)`,
    ...card.shades.map(
      (shade) =>
        `${shade.label}${shade.area ? ` (${AREA_LABEL[shade.area].toLowerCase()})` : ""}: ${shade.hex}`,
    ),
  ].join("\n");
  return (
    <>
      <p className="pa-kicker">Shades in this look</p>
      <div
        className="pa-palette"
        aria-hidden="true"
        style={
          {
            "--pa-palette": `linear-gradient(90deg, ${card.shades
              .map(
                (shade, index) =>
                  `${shade.hex} ${(index / card.shades.length) * 100}% ${((index + 1) / card.shades.length) * 100}%`,
              )
              .join(", ")})`,
          } as CSSProperties
        }
      />
      <ul className="pa-shades">
        {card.shades.map((shade, index) => (
          <li
            key={`${shade.hex}-${shade.label}`}
            data-state={stateOf(index)}
            style={{ "--pa-index": index } as CSSProperties}
          >
            {shade.area === "lips" ? (
              <LipsIcon color={shade.hex} />
            ) : (
              <span
                className="pa-shade-dot"
                style={{ background: shade.hex }}
                aria-hidden="true"
              />
            )}
            <span className="pa-shade-text">
              <strong>{shade.label}</strong>
              <small>
                {shade.area ? `${AREA_LABEL[shade.area]} · ` : ""}
                {shade.hex}
              </small>
            </span>
            <button
              type="button"
              className="pa-copy"
              onClick={() => void write(shade.hex, shade.hex, `shade:${index}`)}
              aria-label={`Copy ${shade.label}, ${shade.hex}`}
            >
              {copied === shade.hex ? (
                <Check size={13} aria-hidden="true" />
              ) : (
                <Copy size={13} aria-hidden="true" />
              )}
              <span>{copied === shade.hex ? "Copied" : "Copy"}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="pa-keep">
        {card.image && <AppImage client={client} id={card.image.id} alt="" />}
        <span className="pa-keep-text">
          <strong>Keep this look</strong>
          <small>{card.title}</small>
        </span>
        <span className="pa-keep-actions">
          <button
            type="button"
            className="pa-copy"
            onClick={() => void write(list, "list", "shades")}
          >
            {copied === "list" ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
            <span>{copied === "list" ? "Copied" : "Copy shades"}</span>
          </button>
          {card.image && (
            <SaveImage
              client={client}
              imageId={card.image.id}
              name={card.title}
              onSaved={() => onAction("save", "look")}
            />
          )}
        </span>
      </div>
      <p className="pa-disclaimer">{card.disclaimer}</p>
    </>
  );
}

/** Downloads a session image. It cannot be a plain link: it needs the token. */
function SaveImage({
  client,
  imageId,
  name,
  onSaved,
}: {
  client: BeautyAdvisorClient;
  imageId: string;
  name: string;
  onSaved: () => void;
}) {
  async function save() {
    try {
      const blob = await client.image(imageId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name.replace(/[^\p{L}\p{N} -]/gu, "").trim() || "look"}.jpg`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      onSaved();
    } catch {
      // The image may have been deleted; nothing to save.
    }
  }
  return (
    <button type="button" className="pa-copy" onClick={() => void save()}>
      <Download size={13} aria-hidden="true" />
      <span>Save image</span>
    </button>
  );
}
