# Managing changelog drafts

Open the project's **Changelog** page. Existing entries have an **Edit** action;
editing fills the title, original Markdown body, labels and audience and retains
the existing entry ID. **Save draft** updates that draft. **Publish** explicitly
makes it public and schedules the existing audience notifications and webhook event.
Saving an already published entry uses **Save changes** and preserves its status
and original publication date without scheduling publication again.

Use **Preview** to inspect supported Markdown headings, lists, code and links before
saving. Raw HTML is displayed as text, images are not loaded, and only absolute
HTTP(S) links without credentials are active. **New entry** or **Cancel** asks before
discarding unsaved work. Deletion requires confirmation. Errors keep the edited
values available for retry. The entries filter separates drafts and published items.

Organization owners and admins may manage entries; members and moderators have a
read-only view. Server actions independently enforce session, role and project
authorization. The dashboard's validated update payload deliberately omits unchanged
status and linked-post fields, so edits preserve relationships. This is a dashboard
form fix, not a change to the existing HTTP API's partial-schema defaults.

Concurrent updates lock the project-scoped entry while deciding the publication
transition. Multiple simultaneous publish attempts schedule delivery only for the
request that actually changes draft to published. The database commit and Redis
enqueue remain separate; this change does not add an outbox or promise atomic
cross-service delivery. A later explicit draft-to-published transition is a new
publication under the existing service contract.

Imported history remains a collection of drafts until explicitly published. Its
merge/source dates describe historical integration, not verified deployment dates.
This page does not bulk-publish historical drafts or silently suppress delivery.
The existing one-time import tools and signing keys are not part of this UI change.

The feature requires the updated dashboard and shared core source in the deployed
images. See [the updater runbook](UPDATING.md) for GitHub-built image deployment;
deploying source alone does not replace the running dashboard image.
