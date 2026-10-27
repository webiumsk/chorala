# Managing changelog drafts

Open the project's **Changelog** page. Existing entries have an **Edit** action;
editing fills the title, original Markdown body, labels and audience and retains
the existing entry ID. **Save draft** updates that draft. **Publish** explicitly
makes it public and schedules the existing audience notifications and webhook event.
Saving an already published entry uses **Save changes** and preserves its status
and original publication date without scheduling publication again.
Moving a previously published entry to draft and publishing it again also retains
its first publication timestamp. A draft without any previous publication receives
its timestamp when it is first published. Republishing is not a way to correct a
historical date.

Use **Preview** to inspect supported Markdown headings, lists, code and links before
saving. Raw HTML is displayed as text, images are not loaded, and only absolute
HTTP(S) links without credentials are active. **New entry** or **Cancel** asks before
discarding unsaved work. Deletion requires confirmation. Errors keep the edited
values available for retry. The entries filter separates drafts and published items.

Admin, public portal and widget feeds show the newest entries first. Set the
optional **Changelog date** calendar field (`displayDate`) to retain a historical
day independently of the title, content and publication time. The same calendar
day controls ordering and display without a timezone shift. Ordinary entries
without an override use first publication time, falling back to creation time for
unpublished drafts. An explicit empty date clears the override and selects that
timestamp fallback. Ties are stable.

Migration `0012` restores the known imported Satflux history dates by their
project-bound import identities, including entries with edited titles. It leaves
content and existing publication/audit timestamps unchanged. The legacy dated-title
fallback applies only to older objects that do not have a `displayDate` property;
an explicit null is respected. Manually created or unrelated historical records
need an explicit calendar date rather than a guessed date from their titles.

Organization owners and admins may manage entries; members and moderators have a
read-only view. Server actions independently enforce session, role and project
authorization. The dashboard's validated update payload and the shared HTTP PATCH
schema preserve omitted status, labels and linked-post fields. Changing only the
date preserves publication state, relationships and audience without scheduling
publication again.

Concurrent updates lock the project-scoped entry while deciding the publication
transition. Multiple simultaneous publish attempts schedule delivery only for the
request that actually changes draft to published. The database commit and Redis
enqueue remain separate; this change does not add an outbox or promise atomic
cross-service delivery. A later explicit draft-to-published transition is a new
publication event under the existing delivery contract, so it still schedules
notifications/webhooks while retaining the first publication timestamp. This fix
does not add an exactly-once guarantee or change retry/delivery policy. Use the
calendar field for date corrections instead of toggling publication state.

Imported history remains a collection of drafts until explicitly published. Its
merge/source dates describe historical integration, not verified deployment dates.
This page does not bulk-publish historical drafts or silently suppress delivery.
The existing one-time import tools and signing keys are not part of this UI change.

The feature requires the updated dashboard and shared core source in the deployed
images. See [the updater runbook](UPDATING.md) for GitHub-built image deployment;
deploying source alone does not replace the running dashboard image.
