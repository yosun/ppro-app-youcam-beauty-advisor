import { useEffect, useState } from "react";
import { Camera, ImageUp, LoaderCircle } from "lucide-react";
import type { BeautyAdvisorClient } from "../../client/index.ts";
import type { BeautySession } from "../apply-event.ts";

// The card that asks the client for a selfie, either because the advisor asked
// (ui.mediaRequest) or to get started. Photo analysis needs two explicit
// confirmations; the moment both are ticked they are saved, so the camera and
// upload buttons are plain clicks (browsers can block a file picker opened
// after a network call).

export function AskCard({
  session,
  client,
  busy,
  error,
  onCamera,
  onUpload,
  onNotNow,
}: {
  session: BeautySession;
  client: BeautyAdvisorClient;
  busy: boolean;
  error: string | null;
  onCamera: () => void;
  onUpload: () => void;
  onNotNow: (() => void) | null;
}) {
  const request = session.ui.mediaRequest;
  const consented = session.consent.adult && session.consent.photoAnalysis;
  const [adult, setAdult] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!adult || !analysis || consented || saving) return;
    let live = true;
    // The two ticks are the client's confirmation; saving them is the effect.
    /* eslint-disable react-hooks/set-state-in-effect */
    setSaving(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    client
      .consent({ adult: true, photoAnalysis: true })
      .catch(() => live && setProblem("Could not save that. Try again."))
      .finally(() => live && setSaving(false));
    return () => {
      live = false;
    };
  }, [adult, analysis, consented, saving, client]);

  const name = session.advisor.name;
  const mode = request?.mode ?? "either";
  const ready = consented && !busy;
  return (
    <section className="ask" aria-label="Share a selfie">
      <h4>{request ? `${name} would like a selfie` : "Start with a selfie"}</h4>
      <p>
        {request?.reason ??
          "A clear, front-facing selfie in even light works best. It lets the analysis measure instead of guess."}
      </p>
      {!consented && (
        <>
          <label>
            <input
              type="checkbox"
              checked={adult}
              onChange={(event) => setAdult(event.target.checked)}
            />
            <span>I am 18 or older, and this is a photo of my own face.</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={analysis}
              onChange={(event) => setAnalysis(event.target.checked)}
            />
            <span>
              I agree to YouCam AI (Perfect Corp) analyzing my photo. It is kept
              in memory only and deleted when this consultation ends.
            </span>
          </label>
        </>
      )}
      <div className="ask-actions">
        {mode !== "upload" && (
          <button
            type="button"
            className="button"
            data-primary=""
            disabled={!ready}
            onClick={onCamera}
          >
            {busy || saving ? (
              <LoaderCircle size={15} aria-hidden="true" className="spin" />
            ) : (
              <Camera size={15} aria-hidden="true" />
            )}
            Live camera
          </button>
        )}
        {mode !== "camera" && (
          <button
            type="button"
            className="button"
            disabled={!ready}
            onClick={onUpload}
          >
            <ImageUp size={15} aria-hidden="true" />
            Upload a photo
          </button>
        )}
        {onNotNow && (
          <button type="button" className="button" onClick={onNotNow}>
            Not now
          </button>
        )}
      </div>
      {(error || problem) && (
        <p className="ask-error" role="alert">
          {error ?? problem}
        </p>
      )}
    </section>
  );
}
