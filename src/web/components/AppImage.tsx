import type { BeautyAdvisorClient } from "../../client/index.ts";
import { useImage } from "../use-image.ts";

// A session image shown with the client token. While it loads it is a tinted
// box; if it was deleted (the client removed the photo) it says so.

export function AppImage({
  client,
  id,
  alt,
  className,
  gone,
}: {
  client: BeautyAdvisorClient;
  id: string | null | undefined;
  alt: string;
  className?: string;
  /** Shown instead of the image once it no longer exists. */
  gone?: React.ReactNode;
}) {
  const image = useImage(client, id);
  if (image.status === "gone") return <>{gone ?? null}</>;
  if (image.status === "loading")
    return <span className={className} role="img" aria-label={alt} />;
  return (
    <img
      className={className}
      src={image.url}
      alt={alt}
      decoding="async"
      draggable={false}
    />
  );
}
