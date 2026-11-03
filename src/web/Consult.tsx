import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Droplets,
  Download,
  Ellipsis,
  ListChecks,
  LogOut,
  MessageCircle,
  Palette,
  Radio,
  ScanFace,
  ShoppingBag,
  Sparkles,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { PproError } from "../client/index.ts";
import {
  screenOfTarget,
  SCREEN_TITLES,
  type Screen,
} from "../advisor/screens.ts";
import type { PproEvent } from "../protocol/types.ts";
import type { BeautySession } from "./apply-event.ts";
import YouCamCamera from "./components/YouCamCamera.tsx";
import { createBridge } from "./host-bridge.ts";
import { preparePhoto } from "./prepare-photo.ts";
import {
  FaceScreen,
  PicksScreen,
  SkinScreen,
} from "./screens/AnalysisScreens.tsx";
import { ChatScreen } from "./screens/ChatScreen.tsx";
import {
  LookScreen,
  ShadesScreen,
  StepsScreen,
} from "./screens/LookScreens.tsx";
import type { SessionHandle } from "./use-session.ts";

const TAB_ICONS: Record<Screen, typeof Sparkles> = {
  chat: MessageCircle,
  skin: Droplets,
  face: ScanFace,
  look: Sparkles,
  steps: ListChecks,
  shades: Palette,
  picks: ShoppingBag,
};

type Local = {
  screen?: string;
  target?: string | null;
  following?: boolean;
  compare?: number | null;
};

const ENDINGS = {
  expired: "The time for this consultation is up.",
  agent: "has ended the consultation.",
  client: "You ended the consultation.",
  host: "This consultation was closed.",
} as const;

export function Consult({
  handle,
  starters,
  onRestart,
}: {
  handle: SessionHandle;
  starters: readonly string[];
  /** Standalone only: begin another demo consultation. */
  onRestart: (() => void) | null;
}) {
  const { session, status, client, onEvent } = handle;
  const [local, setLocal] = useState<Local | null>(null);
  const [menu, setMenu] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const compareTimer = useRef<number | undefined>(undefined);

  // The server's UI state is the truth. A tap is shown at once and replaced by
  // the server's version when its ui.changed event arrives.
  useEffect(
    () =>
      onEvent((event: PproEvent) => {
        if (event.type === "ui.changed") setLocal(null);
      }),
    [onEvent],
  );

  const bridge = useMemo(
    () =>
      createBridge(session?.options.hostOrigin ?? null, (theme) =>
        setAccent(theme.accent),
      ),
    [session?.options.hostOrigin],
  );
  useEffect(() => {
    if (session) bridge.ready(session.id, session.rev);
    // Announce once per bridge, not on every revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, session?.id]);
  useEffect(() => onEvent((event) => bridge.event(event)), [onEvent, bridge]);
  useEffect(() => () => bridge.dispose(), [bridge]);

  useEffect(() => {
    if (session)
      document.title = `${session.advisor.name} · YouCam Beauty Advisor`;
  }, [session?.advisor.name, session]);

  const tell = useCallback(
    (event: Record<string, unknown>) => {
      client.uiEvent(event).catch(() => setLocal(null));
    },
    [client],
  );

  if (!session)
    return (
      <div className="pa-app">
        <div className="empty">
          {status === "error" ? handle.error : "Connecting…"}
        </div>
      </div>
    );

  const name = session.advisor.name;
  const base = session.ui;
  const ui = { ...base, ...(local ?? {}) };
  const available = base.available as Screen[];
  const screen = (
    available.includes(ui.screen as Screen) ? ui.screen : available[0]
  ) as Screen;
  const compare =
    local?.compare !== undefined ? local.compare : base.view.compare;
  const ended = session.phase === "ended";
  const view: BeautySession = {
    ...session,
    ui: { ...base, ...(local ?? {}), view: { compare } } as BeautySession["ui"],
  };

  // --- Client actions -----------------------------------------------------------

  const navigate = (next: string) => {
    setLocal({ screen: next, target: null, following: false });
    tell({ type: "navigate", screen: next });
  };
  const focus = (target: string) => {
    const next = screenOfTarget(target);
    setLocal({ ...(next ? { screen: next } : {}), target, following: false });
    tell({ type: "focus", target });
  };
  const follow = () => {
    setLocal({
      screen: base.focus?.screen,
      target: base.focus?.target ?? null,
      following: true,
    });
    tell({ type: "follow" });
  };
  const action = (kind: "copy" | "save", target: string) =>
    tell({ type: "action", action: kind, target });
  const setCompare = (position: number) => {
    setLocal((current) => ({
      ...(current ?? {}),
      compare: position,
      following: false,
    }));
    window.clearTimeout(compareTimer.current);
    compareTimer.current = window.setTimeout(
      () => tell({ type: "view", view: { compare: position } }),
      120,
    );
  };

  async function send(text: string) {
    try {
      await client.clientMessage(text);
    } catch (error) {
      if (error instanceof PproError && error.code === "rate_limited") return;
      throw error;
    }
  }

  // --- Photo --------------------------------------------------------------------

  const consented = session.consent.adult && session.consent.photoAnalysis;

  async function submitPhoto(blob: Blob) {
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const prepared = await preparePhoto(blob);
      await client.uploadPhoto(prepared, prepared.type || "image/jpeg");
      navigate("chat");
    } catch (error) {
      setPhotoError(
        error instanceof PproError
          ? error.message
          : "Could not send that photo. Try again.",
      );
    } finally {
      setPhotoBusy(false);
    }
  }

  function openCamera() {
    if (!consented) return navigate("chat");
    setPhotoError(null);
    setCameraOpen(true);
    tell({ type: "capture", open: true });
  }
  function closeCamera() {
    setCameraOpen(false);
    tell({ type: "capture", open: false });
  }
  function openPicker() {
    if (!consented) return navigate("chat");
    setPhotoError(null);
    fileInput.current?.click();
  }

  // --- Menu ---------------------------------------------------------------------

  async function downloadTranscript() {
    setMenu(false);
    try {
      const text = await client.transcript();
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "consultation.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      // The transcript is gone once the retention window passes.
    }
  }
  async function deletePhotos() {
    setMenu(false);
    if (
      !session ||
      !window.confirm("Delete your photos and everything made from them?")
    )
      return;
    for (const photo of session.photos)
      await client.deletePhoto(photo.id).catch(() => undefined);
  }
  async function endNow() {
    setMenu(false);
    if (!window.confirm("End this consultation? Your photos are deleted."))
      return;
    await client.end().catch(() => undefined);
  }

  // --- Header -------------------------------------------------------------------

  const focusTarget = base.focus;
  const away =
    !ui.following &&
    focusTarget &&
    (focusTarget.screen !== screen ||
      (focusTarget.target ?? null) !== (ui.target ?? null));
  const nudgeScreen = base.nudge ? screenOfTarget(base.nudge.target) : null;
  const status_ =
    ui.following && !ended ? (
      <span
        className="pa-live"
        data-speaking={session.presence === "speaking" ? "true" : undefined}
      >
        <Radio size={12} aria-hidden="true" /> With {name}
      </span>
    ) : away && !ended ? (
      <button type="button" className="pa-follow" onClick={follow}>
        <Radio size={12} aria-hidden="true" /> Follow {name}
      </button>
    ) : session.presence === "speaking" ? (
      <span className="pa-presence">
        <Radio size={12} aria-hidden="true" /> {name} is speaking
      </span>
    ) : null;

  const selectedSkin =
    screenOfTarget(ui.target) === "skin"
      ? (ui.target ?? "").replace("skin:", "")
      : null;
  const selectedFace = screenOfTarget(ui.target) === "face" ? ui.target : null;
  const selectedPick = screenOfTarget(ui.target) === "picks" ? ui.target : null;

  const content = (() => {
    switch (screen) {
      case "chat":
        return (
          <ChatScreen
            session={view}
            client={client}
            starters={starters}
            onSend={send}
            onOpen={navigate}
            onPhotoRequest={openCamera}
            photo={{
              busy: photoBusy,
              error: photoError,
              camera: openCamera,
              upload: openPicker,
              dismiss: () => tell({ type: "dismiss", what: "media_request" }),
            }}
          />
        );
      case "skin":
        return (
          <SkinScreen
            session={view}
            client={client}
            selected={
              selectedSkin && selectedSkin !== "skin" ? selectedSkin : null
            }
            onSelect={focus}
          />
        );
      case "face":
        return (
          <FaceScreen session={view} selected={selectedFace} onSelect={focus} />
        );
      case "look":
        return (
          <LookScreen
            session={view}
            client={client}
            compare={compare}
            onCompare={setCompare}
          />
        );
      case "steps":
        return <StepsScreen session={view} onNext={() => navigate("shades")} />;
      case "shades":
        return (
          <ShadesScreen session={view} client={client} onAction={action} />
        );
      case "picks":
        return (
          <PicksScreen
            session={view}
            selected={selectedPick}
            onSelect={focus}
          />
        );
    }
  })();

  return (
    <div
      className="pa-app pa-youcam"
      data-guided={ui.following ? "true" : undefined}
      style={
        accent
          ? ({ "--host-accent": accent } as React.CSSProperties)
          : undefined
      }
    >
      <header className="pa-bar">
        <span className="pa-mark" aria-hidden="true" />
        <span className="pa-bar-title">
          <strong>Beauty Advisor</strong>
          <small>{name}’s consultation</small>
        </span>
        <span className="pa-bar-actions">
          {status_}
          <button
            type="button"
            className="pa-icon-button"
            aria-label="Menu"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          >
            <Ellipsis size={18} aria-hidden="true" />
          </button>
        </span>
        {menu && (
          <div className="pa-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => void downloadTranscript()}
            >
              <Download size={15} aria-hidden="true" /> Download transcript
            </button>
            {!ended && session.photos.length > 0 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => void deletePhotos()}
              >
                <Trash2 size={15} aria-hidden="true" /> Delete my photos
              </button>
            )}
            {!ended && (
              <button
                type="button"
                role="menuitem"
                data-danger=""
                onClick={() => void endNow()}
              >
                <LogOut size={15} aria-hidden="true" /> End consultation
              </button>
            )}
          </div>
        )}
      </header>

      {status === "offline" && (
        <div className="pa-banner" data-tone="offline" role="status">
          <WifiOff size={15} aria-hidden="true" />
          <p>Reconnecting…</p>
        </div>
      )}
      {base.notice && !ended && (
        <div className="pa-banner" data-tone={base.notice.tone} role="status">
          <p>{base.notice.text}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setLocal(null);
              tell({ type: "dismiss", what: "notice" });
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="pa-screens">
        <section
          key={screen}
          id={`panel-${screen}`}
          role="tabpanel"
          aria-labelledby={`tab-${screen}`}
          className="pa-screen"
          data-screen={screen}
        >
          {content}
        </section>
      </div>

      <div
        className="pa-tabs"
        role="tablist"
        aria-label="Screens"
        onKeyDown={(event) => {
          const index = available.indexOf(screen);
          const step =
            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const next =
            available[(index + step + available.length) % available.length];
          navigate(next);
          document.getElementById(`tab-${next}`)?.focus();
        }}
      >
        {available.map((id) => {
          const Icon = TAB_ICONS[id];
          return (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              role="tab"
              aria-selected={screen === id}
              aria-controls={`panel-${id}`}
              tabIndex={screen === id ? 0 : -1}
              onClick={() => navigate(id)}
            >
              <Icon size={17} aria-hidden="true" />
              {SCREEN_TITLES[id]}
              {nudgeScreen === id && screen !== id && (
                <span className="pa-tab-dot" title={base.nudge?.label} />
              )}
            </button>
          );
        })}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void submitPhoto(file);
        }}
      />
      <YouCamCamera
        open={cameraOpen}
        title="Live camera"
        onCapture={(blob) => {
          closeCamera();
          void submitPhoto(blob);
        }}
        onUploadInstead={() => {
          closeCamera();
          openPicker();
        }}
        onClose={closeCamera}
      />

      {ended && (
        <div className="overlay" role="dialog" aria-label="Consultation ended">
          <div className="overlay-card">
            <h2>Consultation ended</h2>
            <p>
              {session.endReason === "agent"
                ? `${name} ${ENDINGS.agent}`
                : ENDINGS[session.endReason ?? "host"]}{" "}
              Your photos and the images made from them were deleted.
            </p>
            <div className="ask-actions" style={{ justifyContent: "center" }}>
              <button
                type="button"
                className="button"
                onClick={() => void downloadTranscript()}
              >
                <Download size={15} aria-hidden="true" /> Transcript
              </button>
              {onRestart && (
                <button
                  type="button"
                  className="button"
                  data-primary=""
                  onClick={onRestart}
                >
                  Start another
                </button>
              )}
            </div>
            <p className="pa-disclaimer">
              {session.app.card?.disclaimer ?? ""}
            </p>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {screen === "chat" ? "" : `${SCREEN_TITLES[screen]} screen`}
      </span>
    </div>
  );
}
