# Security policy

## Supported versions

Only the latest release of Inkwell receives security fixes.

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Include:

- the Inkwell version and whether it is the Windows app or `Inkwell.html`;
- what the problem allows (for example reading a file, running script, leaking data);
- steps to reproduce it, and a sample PDF if one is needed.

You should get a reply within a week. Once a fix is released, the report is credited in the
changelog unless you would rather it was not.

## What Inkwell is designed to prevent

PDFs come from untrusted sources, so the app assumes a malicious file might one day get script to run
inside its page, and limits what that script could do:

- The page cannot reach the network (Content-Security-Policy, and a session-level block in the Windows app).
- The page cannot read local files. In the Windows app it runs on its own `app://` address, and can
  only read or write files the person opened, through a checked bridge.
- The page has no access to Node.js, cannot open windows or navigate, and is refused every permission.
- JavaScript, launch actions and non-web links inside PDFs are ignored. Web links ask before opening.

A report showing a way around any of these is especially welcome.
