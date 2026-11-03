import type { BeautyAdvisorClient } from "../../client/index.ts";
import type { Attribute } from "../../advisor/types.ts";
import type { BeautySession } from "../apply-event.ts";
import { AppImage } from "../components/AppImage.tsx";

// Skin, Face and Picks: the analysis results and recommendations. Whatever the
// advisor points at (`ui.target`) is highlighted while the app follows it, and
// tapping an item tells the advisor what the client is looking at.

function scoreColor(score: number) {
  return score >= 70 ? "#26a965" : score >= 55 ? "#d9a21b" : "#d9534f";
}

export function SkinScreen({
  session,
  client,
  selected,
  onSelect,
}: {
  session: BeautySession;
  client: BeautyAdvisorClient;
  /** The concern key being looked at, or null. */
  selected: string | null;
  onSelect: (target: string) => void;
}) {
  const report = session.app.skin;
  if (!report) return null;
  return (
    <>
      <p className="pa-kicker">Your skin</p>
      <h3 className="pa-title">What needs the most care first</h3>
      {report.simulated && (
        <span className="demo-tag">Demo preview · not a real reading</span>
      )}
      <ul className="score-list">
        {report.scores.map((score) => {
          const active = selected === score.concern;
          return (
            <li key={score.concern}>
              <button
                type="button"
                className="score"
                style={
                  {
                    width: "100%",
                    "--score-color": scoreColor(score.score),
                  } as React.CSSProperties
                }
                data-active={active ? "true" : undefined}
                aria-expanded={active}
                onClick={() => onSelect(score.target)}
              >
                <span className="score-head">
                  <strong>{score.label}</strong>
                  <span>
                    {score.score}/100 · {score.rating}
                  </span>
                </span>
                <span className="score-bar" aria-hidden="true">
                  <i style={{ width: `${score.score}%` }} />
                </span>
                {active && score.imageId && (
                  <span className="score-detail">
                    <AppImage
                      client={client}
                      id={score.imageId}
                      alt={`Where ${score.label.toLowerCase()} was measured`}
                      gone={null}
                    />
                    <small>
                      Where {score.label.toLowerCase()} was measured on your
                      photo.
                    </small>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {report.skinType && (
        <p className="report-note">Skin type: {report.skinType}</p>
      )}
      <p className="pa-disclaimer">
        Skin analysis by YouCam AI (Perfect Corp). Scores are 0 to 100, higher
        is healthier, and are for reference only.
      </p>
    </>
  );
}

function AttributeList({
  title,
  attributes,
  selected,
  onSelect,
}: {
  title: string;
  attributes: Attribute[];
  selected: string | null;
  onSelect: (target: string) => void;
}) {
  return (
    <>
      <p className="pa-kicker">{title}</p>
      <ul className="attr-list">
        {attributes.map((attribute) => (
          <li key={attribute.target}>
            <button
              type="button"
              className="attr"
              style={{ width: "100%" }}
              data-active={selected === attribute.target ? "true" : undefined}
              onClick={() => onSelect(attribute.target)}
            >
              <strong>{attribute.name}</strong>
              <span>
                {attribute.color && (
                  <i
                    style={{ background: attribute.color }}
                    aria-hidden="true"
                  />
                )}
                {attribute.color && attribute.value !== attribute.color
                  ? `${attribute.value} · ${attribute.color}`
                  : attribute.value}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function FaceScreen({
  session,
  selected,
  onSelect,
}: {
  session: BeautySession;
  selected: string | null;
  onSelect: (target: string) => void;
}) {
  const { face, tone } = session.app;
  if (!face && !tone) return null;
  const simulated = Boolean(face?.simulated || tone?.simulated);
  return (
    <>
      <h3 className="pa-title">Your face and colors</h3>
      {simulated && (
        <span className="demo-tag">Demo preview · not a real reading</span>
      )}
      {face && (
        <AttributeList
          title="Face shape & features"
          attributes={face.attributes}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      {tone && (
        <AttributeList
          title="Skin tone & colors"
          attributes={tone.attributes}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      <p className="pa-disclaimer">
        Analysis by YouCam AI (Perfect Corp), for reference only. Colors can
        shift with the light in your photo.
      </p>
    </>
  );
}

export function PicksScreen({
  session,
  selected,
  onSelect,
}: {
  session: BeautySession;
  selected: string | null;
  onSelect: (target: string) => void;
}) {
  const { picks } = session.app;
  if (!picks.length) return null;
  return (
    <>
      <p className="pa-kicker">Picked for you</p>
      <h3 className="pa-title">Products to look at</h3>
      {picks.map((pick) => (
        <div
          key={pick.target}
          className="pick"
          data-active={selected === pick.target ? "true" : undefined}
          onClick={() => onSelect(pick.target)}
        >
          <span className="pick-tags">
            <span>{pick.category}</span>
            <span>{pick.tier}</span>
          </span>
          <strong>
            {pick.brand} {pick.name}
          </strong>
          {pick.shade && <p>Shade: {pick.shade}</p>}
          <p>{pick.why}</p>
          {pick.url && (
            <a
              href={pick.url}
              target="_blank"
              rel="sponsored noopener noreferrer"
            >
              Find it
            </a>
          )}
        </div>
      ))}
      <p className="pa-disclaimer">
        Product suggestions are general guidance. Check ingredients and shades
        before you buy.
      </p>
    </>
  );
}
