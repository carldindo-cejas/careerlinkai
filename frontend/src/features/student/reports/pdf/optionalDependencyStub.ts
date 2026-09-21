/**
 * Stands in for jsPDF's optional dependencies — html2canvas, DOMPurify and canvg (aliased in
 * vite.config.ts).
 *
 * jsPDF `import()`s them for `doc.html()` and SVG input, neither of which the report PDF uses, so
 * left alone they would be bundled as ~380 KB of chunks nobody ever fetches. If a future caller
 * does reach for one of those features, this says so plainly instead of failing obscurely.
 */
export default function unavailable(): never {
  throw new Error(
    "jsPDF's html() / SVG support is not bundled: html2canvas, DOMPurify and canvg are stubbed in vite.config.ts.",
  );
}
