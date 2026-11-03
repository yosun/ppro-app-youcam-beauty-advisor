"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImageUp, X } from "lucide-react";

// YouCam's JS Camera Kit (v2.5): a live, in-browser camera that tracks the
// face in real time, coaches the viewer on position, angle and lighting, and
// auto-captures a frame that meets YouCam's photo requirements. Analysis
// itself runs later, server-side, on that still. The SDK is loaded only when
// a viewer opens the camera, from Perfect Corp's CDN.
// Docs: https://docs.perfectcorp.com/reference/ai_skin_analysis (JS Camera Kit)
// Not affiliated with or endorsed by Perfect Corp.

const SDK_URL = "https://plugins-media.makeupar.com/v2.5-camera-kit/sdk.js";
const LOAD_TIMEOUT_MS = 25_000;

type CameraKitMode = "comprehensive" | "makeup" | "skincare" | "shadefinder";

type CameraKit = {
  init(options: Record<string, unknown>): void;
  openCameraKit(): void;
  close(): void;
  addEventListener(
    event: string,
    listener: (payload: unknown) => void,
  ): unknown;
  removeEventListener(id: unknown): void;
};

declare global {
  interface Window {
    YMK?: CameraKit;
  }
}

let loading: Promise<CameraKit> | null = null;

function loadCameraKit() {
  if (window.YMK) return Promise.resolve(window.YMK);
  loading ??= new Promise<CameraKit>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    const fail = (message: string) => {
      window.clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error(message));
    };
    const timer = window.setTimeout(
      () => fail("The live camera took too long to load."),
      LOAD_TIMEOUT_MS,
    );
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.YMK) resolve(window.YMK);
      else fail("The live camera did not start.");
    };
    script.onerror = () => fail("The live camera could not load.");
    document.head.appendChild(script);
  });
  return loading;
}

type Quality = {
  hasFace?: boolean;
  position?: string;
  frontal?: string;
  lighting?: string;
};

function coaching(quality: Quality | null) {
  if (!quality) return "Starting the camera…";
  if (!quality.hasFace)
    return "Look into the camera so YouCam can find your face.";
  if (quality.position === "toosmall") return "Move a little closer.";
  if (quality.position === "outofboundary")
    return "Move back a little so your whole face fits the oval.";
  if (quality.position && quality.position !== "good")
    return "Center your face in the oval.";
  if (quality.frontal !== "good")
    return "Face the camera straight on, chin level.";
  if (quality.lighting === "notgood")
    return "Find softer, brighter light on your face.";
  return "Hold still… capturing.";
}

// A fault inside the kit's WebAssembly ("memory access out of bounds") means
// nothing to a viewer and is not theirs to fix: say what they can do instead.
const KIT_FAULT =
  /out of bounds|memory access|WebAssembly|RuntimeError|unreachable/i;
function readable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (KIT_FAULT.test(message))
    return "YouCam’s live camera couldn’t start in this browser. Upload a photo instead.";
  return message || "The live camera didn’t start. Upload a photo instead.";
}
async function imageToBlob(image: unknown) {
  if (image instanceof Blob) return image;
  if (typeof image === "string" && image.startsWith("data:image/"))
    return (await fetch(image)).blob();
  throw new Error("The camera returned no photo.");
}

/**
 * A modal with YouCam's live camera. Calls onCapture with the captured JPEG,
 * or offers an upload when the camera cannot run on this device.
 */
export default function YouCamCamera({
  open,
  mode = "comprehensive",
  title = "Live camera",
  onCapture,
  onUploadInstead,
  onClose,
}: {
  open: boolean;
  mode?: CameraKitMode;
  title?: string;
  onCapture: (photo: Blob) => void;
  onUploadInstead?: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [quality, setQuality] = useState<Quality | null>(null);
  const [ready, setReady] = useState(false);
  const captured = useRef(false);
  const handlers = useRef({ onCapture, onClose });
  useEffect(() => {
    handlers.current = { onCapture, onClose };
  }, [onCapture, onClose]);

  const close = useCallback(() => {
    try {
      window.YMK?.close();
    } catch {
      // The kit may already be closed.
    }
    handlers.current.onClose();
  }, []);

  useEffect(() => {
    if (!open) {
      if (dialog.current?.open) dialog.current.close();
      return;
    }
    if (!dialog.current?.open) dialog.current?.showModal();
    captured.current = false;
    let cancelled = false;
    const listeners: unknown[] = [];
    void Promise.resolve()
      .then(() => {
        setError("");
        setQuality(null);
        setReady(false);
        return loadCameraKit();
      })
      .then((kit) => {
        if (cancelled) return;
        const on = (event: string, listener: (payload: unknown) => void) =>
          listeners.push(kit.addEventListener(event, listener));
        on("faceQualityChanged", (payload) => setQuality(payload as Quality));
        on("loaded", () => setReady(true));
        on("cameraFailed", (code) =>
          setError(
            String(code).includes("permission")
              ? "Camera access is blocked. Allow the camera for this site, or upload a photo instead."
              : "This device’s camera isn’t available here. Upload a photo instead.",
          ),
        );
        on("faceDetectionCaptured", (payload) => {
          if (captured.current) return;
          captured.current = true;
          const images = (payload as { images?: { image?: unknown }[] })
            ?.images;
          void imageToBlob(images?.[0]?.image)
            .then((blob) => {
              try {
                kit.close();
              } catch {
                // Already closed by the kit.
              }
              handlers.current.onCapture(blob);
            })
            .catch((caught: Error) => {
              captured.current = false;
              console.error("[youcam camera]", caught);
              setError(readable(caught));
            });
        });
        on("closed", () => {
          if (!captured.current) handlers.current.onClose();
        });
        const width = Math.max(300, Math.min(420, window.innerWidth - 40));
        kit.init({
          faceDetectionMode: mode,
          imageFormat: "base64",
          language: "enu",
          width,
          height: Math.round((width * 4) / 3),
          qualityLevel: "relaxed",
          disableCameraResolutionCheck: true,
          countingDuration: 1200,
        });
        kit.openCameraKit();
      })
      .catch((caught: Error) => {
        console.error("[youcam camera]", caught);
        if (!cancelled) setError(readable(caught));
      });
    return () => {
      cancelled = true;
      for (const id of listeners) {
        try {
          window.YMK?.removeEventListener(id);
        } catch {
          // Listener already gone.
        }
      }
      try {
        window.YMK?.close();
      } catch {
        // Already closed.
      }
    };
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    const fault = (reason: unknown) => {
      const message =
        reason instanceof Error ? reason.message : String(reason ?? "");
      if (!KIT_FAULT.test(message)) return;
      console.error("[youcam camera]", reason);
      setError(readable(reason));
      try {
        window.YMK?.close();
      } catch {
        // The kit may already be closed.
      }
    };
    const onError = (event: ErrorEvent) => fault(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => fault(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="youcam-camera"
      data-failed={error ? "true" : undefined}
      aria-labelledby="youcam-camera-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <span>
          <Camera size={15} aria-hidden="true" />
          <b id="youcam-camera-title">{title}</b>
        </span>
        <button type="button" aria-label="Close camera" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <p className="youcam-camera-coach" role="status" aria-live="polite">
        {error ? error : ready ? coaching(quality) : "Starting the camera…"}
      </p>
      {/* YouCam's Camera Kit renders into this fixed id, one per page. */}
      {open && <div id="YMK-module" className="youcam-camera-stage" />}
      <footer>
        {onUploadInstead && (
          <button
            type="button"
            className="youcam-camera-upload"
            onClick={onUploadInstead}
          >
            <ImageUp size={15} aria-hidden="true" /> Upload a photo instead
          </button>
        )}
        <small>
          Live face guidance by YouCam AI (Perfect Corp). The photo is taken
          automatically when your face is centered, straight on and well lit.
        </small>
      </footer>
    </dialog>
  );
}
