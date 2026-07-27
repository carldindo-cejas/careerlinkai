import '@testing-library/jest-dom/vitest';

import { afterEach, beforeEach } from 'vitest';

/**
 * jsdom implements no part of the Geometry Interfaces spec, and pdf.js reaches for `DOMMatrix`
 * during document initialisation — before any rendering, so even pure text extraction (§33) dies
 * with "DOMMatrix is not defined" in a test while working perfectly in a real browser.
 *
 * This is the identity-and-multiply subset pdf.js's text path uses, not an implementation of the
 * spec. It lives in the shared setup rather than one test file because it is a statement about the
 * *environment* — jsdom is missing a browser API — and any future test that touches a PDF needs it
 * for the same reason. If a test ever needs real geometry, that test needs a real browser.
 */
if (!('DOMMatrix' in globalThis)) {
  class DOMMatrixPolyfill {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;

    constructor(init?: number[] | string) {
      if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init as [
          number,
          number,
          number,
          number,
          number,
          number,
        ];
      }
    }

    multiplySelf(other: DOMMatrixPolyfill): this {
      const { a, b, c, d, e, f } = this;

      this.a = a * other.a + c * other.b;
      this.b = b * other.a + d * other.b;
      this.c = a * other.c + c * other.d;
      this.d = b * other.c + d * other.d;
      this.e = a * other.e + c * other.f + e;
      this.f = b * other.e + d * other.f + f;

      return this;
    }

    translateSelf(x = 0, y = 0): this {
      this.e += this.a * x + this.c * y;
      this.f += this.b * x + this.d * y;

      return this;
    }

    scaleSelf(x = 1, y = x): this {
      this.a *= x;
      this.b *= x;
      this.c *= y;
      this.d *= y;

      return this;
    }
  }

  Object.defineProperty(globalThis, 'DOMMatrix', {
    value: DOMMatrixPolyfill,
    writable: true,
    configurable: true,
  });
}

/**
 * `Uint8Array.prototype.toHex` / `Uint8Array.fromHex` (the ES2025 base64-and-hex proposal).
 *
 * pdf.js v6 ships them unpolyfilled — every browser this app supports has them, and Node 24 does
 * not. Same category as the `DOMMatrix` shim above: a gap in the *runner*, filled so the suite can
 * exercise the same modern pdf.js build the app ships rather than being pushed onto the legacy
 * bundle, which would leave the shipped code path untested.
 */
if (typeof (Uint8Array.prototype as { toHex?: unknown }).toHex !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value(this: Uint8Array): string {
      return Array.from(this, (byte) => byte.toString(16).padStart(2, '0')).join('');
    },
    writable: true,
    configurable: true,
  });
}

if (typeof (Uint8Array as { fromHex?: unknown }).fromHex !== 'function') {
  Object.defineProperty(Uint8Array, 'fromHex', {
    value(hex: string): Uint8Array {
      const bytes = new Uint8Array(hex.length / 2);

      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }

      return bytes;
    },
    writable: true,
    configurable: true,
  });
}

import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';

// Auth state is global and persisted, so it must be reset between tests or a signed-in
// user leaks from one test into the next.
beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({ token: null, user: null });
  useStudentClassStore.setState({ classRoom: null, username: null });
});

afterEach(() => {
  window.localStorage.clear();
});
