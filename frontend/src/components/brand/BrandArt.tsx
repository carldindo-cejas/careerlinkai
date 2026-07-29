import artPng from '@/assets/careerlinkai_art.png';
import artWebp from '@/assets/careerlinkai_art.webp';

/**
 * The official CareerLinkAI artwork plate, served WebP-first.
 *
 * One component for the same reason `Logo` is one: the two auth shells (staff and student)
 * render the same plate and must not drift. Only the alt text and the frame differ, so those
 * are the props.
 *
 * **WebP with a PNG fallback, not a bare `<img>`.** The plate is 66 kB as WebP and 410 kB as
 * PNG — the same picture, six times lighter for every browser of the last decade, with the PNG
 * still there for anything that cannot read WebP. `<picture>` is what makes that a fallback
 * rather than a bet.
 *
 * Both callers place this in a `hidden lg:flex` panel, which is *not* the same as not
 * downloading it: a `display:none` ancestor does not stop the image fetch in Chrome, so the
 * bytes were being paid on mobile — where they are never drawn — before this was optimized.
 * `loading="lazy"` is what actually spares them, since the plate is never the LCP element on a
 * viewport small enough to hide it.
 */
export function BrandArt({ alt, className }: { alt: string; className?: string }) {
  return (
    <picture>
      <source srcSet={artWebp} type="image/webp" />
      <img src={artPng} alt={alt} loading="lazy" decoding="async" className={className} />
    </picture>
  );
}
