# Email transport verification

The Nodemailer 10 transport retains the existing `getTransport()` / `sendEmail()`
contract. SMTP sends the configured sender plus the supplied recipient, subject,
plain text and HTML. Authentication is supplied only when `SMTP_USER` is configured.
Port 465 retains implicit TLS; other ports retain Nodemailer's normal SMTP/STARTTLS
behavior. Recipient rejection propagates to the caller instead of reporting success.

Disabled or unconfigured email uses the existing no-op transport. Its warning is
static: it contains no recipient address, subject, body or SMTP credential. Do not
add message contents or credentials to delivery diagnostics. Application callers
remain responsible for safe error reporting and queued delivery policies.

`packages/email/test/transport.test.ts` uses Node's built-in test runner and type
stripping, with no new test dependency. Every SMTP connection targets an ephemeral
loopback server that accepts synthetic messages into memory and never forwards
them. Runtime checks cover MIME/envelope preservation, real SMTP authentication,
recipient 550 rejection and disabled-mode privacy/no-network behavior. Credentials
are verified internally and are never printed.

Tests use synthetic environment configuration and fresh module instances, resetting
the existing configuration cache between cases. They neither connect to a database
nor use production mail servers. They do not establish external delivery, DNS,
provider reputation, TLS negotiation or queue/retry acceptance; those remain separate
staging checks before production email is enabled.
