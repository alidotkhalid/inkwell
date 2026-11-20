# Changelog

## 1.3.0 (14 November 2026)

Fixes from the pre-publish review.

### Fixed

- Text in other scripts (Cyrillic, Chinese, Arabic, emoji and so on) was saved as question marks. It is
  now saved as a sharp picture of the text.
- Phone photos with a camera rotation were saved sideways and squashed.
- Deleting a page left its form fields, and what was typed in them, in the saved file.
- SVG images could be chosen but never loaded. They can now be placed.
- Undoing every change now clears the unsaved-changes mark.
- Esc while typing ends typing and keeps the current tool. Press Esc again to return to Select.
- Saving a password-protected PDF left unused remains of the old lock in the file.
- The build failed when the project folder's path contained a space, and on Windows.

### Changed

- Links in a PDF show their address and ask before opening.
- Saving a password-protected PDF asks first, because the saved copy has no password.
- "Remember this signature" is a choice in the Sign window, with a Forget button. In the browser
  edition it is off by default.
- Remembered page positions are limited to the 50 most recent files.
- Recent files in the browser edition are told apart by the file itself, not by its name.
- Fonts a PDF names without carrying are drawn with the bundled stand-in when the computer does not
  have them.

### Security

- The Windows app's page now runs on its own address (`app://inkwell`) and no longer on `file://`,
  from which it could have read any file on the computer.
- A strict Content-Security-Policy: only the app's own scripts run, and no network connection is
  allowed. The Windows app also blocks network requests at the session level.
- All permission requests (camera, microphone, location, notifications and so on) are refused.
- Electron fuses are set: the program cannot be used as a general Node.js runtime, only loads its own
  packed code, and checks that code's integrity.
- Removed an unused handler that wrote data to a temporary file and opened it in a new window.
- Navigation and new-window rules now apply to every window.

### Project

- MIT `LICENSE`, `THIRD_PARTY_NOTICES.md` (also installed with the app and embedded in `Inkwell.html`),
  `README.md`, `SECURITY.md`, issue templates.
- Exact dependency versions and lockfiles for reproducible builds.
- An automated test suite and GitHub Actions workflows for building, testing and releasing.
- `npm run build` writes the desktop app's copy of the editor too, so a release cannot ship a stale one.

Settings and saved signatures from 1.2.1 and earlier are carried over on the first start.

## 1.2.1 (14 November 2026)

- Opening a PDF from Windows no longer flashes the start screen or the wrong theme: the window
  appears once the first page is drawn.

## 1.2.0 (13 November 2026)

- The app is renamed from **Blue Pencil** to **Inkwell**, with a new logo. The installer removes
  Blue Pencil, and Inkwell carries over its settings, saved signature and recent files.

## 1.1.0 (13 November 2026)

- Print preview with printer, copies, page range, paper, orientation, size, colour and two-sided options.

## 1.0.0 (13 November 2026)

- First release as a Windows app (under the name Blue Pencil): viewing, annotation, text editing,
  forms, signatures, page tools, and registration as a PDF handler.
