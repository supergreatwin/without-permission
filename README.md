# Without Permission editorial platform

The existing magazine stays on GitHub Pages. Supabase supplies the private editorial desk, verified editor and contributor accounts, PostgreSQL, private image storage and a small server-side integration. Beehiiv remains the subscriber system. Tally remains the public alternative for pitches.

## Current release

- The public homepage embeds a bilingual Beehiiv signup with email confirmation enabled. The Contribute page embeds the existing bilingual Tally form. Both have direct fallback links.
- The editorial platform source is prepared for staging. The CMS, account emails, analytics, managed publishing and subscriber reporting still need a configured hosting project and staging acceptance tests before switching the public site to the new publishing workflow.

## Why this setup

GitHub Pages serves accessible static HTML including each article's title and search metadata. A Git-based CMS could handle article revisions, but editorial roles, private contributor profiles and moderation would still need another system. Supabase handles those features in one system and supports database-side permissions. A separately built Cloudflare Worker would also work, with more identity and editorial infrastructure to maintain.

The workflow builds approved snapshots. It never serves draft rows or renders contributor-supplied executable HTML. Editing a published article starts a new draft while its prior approved version remains live. The two language editions are edited independently and published together as one article. The Arabic URL stays stable; published English editions have an additional indexable path and the existing language query switch still works. Existing raw archive routes and legacy redirects are retained.

## Local verification

Requires Node.js 24.

```sh
npm ci
npm test
npm run build -- --fixture
python3 -m http.server 8080 --directory dist
```

Open the rendered static site for a content and design check. In fixture mode the desk explains that its authentication is unconfigured. The fixture is a copy of public editorial material, not a simulated live database. For a true staging test use a hosted Supabase test project or Supabase CLI with Docker.

The test suite runs migrations in a local PostgreSQL runtime with stand-ins for the Supabase Auth and Storage schemas. It checks reader isolation, verification gates, editor and publisher permissions, comment visibility, optimistic revision checks, restoration, scheduling, unpublishing, audit entries, and deduplicated traffic. It checks the 31 archive URLs and two language editions, retained TikTok links, generated metadata, HTML sanitization and embedded form markup. It does not test real authentication emails, Storage network policies, production dispatch, Beehiiv delivery or production analytics.

## Launch the desk

1. Create or select the publication's Supabase project. For a staging rehearsal, use a separate project and a staging Pages repository or origin. Deploy the migrations and Edge Function.

   ```sh
   supabase link --project-ref PROJECT_REF
   supabase db push
   supabase functions deploy platform --no-verify-jwt
   ```

   The function handles three distinct entry points. The export endpoint uses a dedicated high-entropy token. Newsletter reporting verifies a Supabase user JWT and the database staff role. Traffic accepts only allowed site origins in browsers and applies a rate limit plus validation. Supabase Auth authentication and role checks still apply if a visitor calls the database API directly.

2. In Supabase Auth, enable email confirmation and configure custom SMTP for public verification and password reset. Set the Site URL to the actual desk URL and allow both language return URLs such as `https://supergreatwin.github.io/without-permission/desk/` and `https://supergreatwin.github.io/without-permission/desk/?lang=en`. Add the equivalent for your isolated staging origin. Set the password minimum to 12 and use the project's Auth rate limits. After verifying an external test signup and password reset, set the GitHub Actions variable `WP_PUBLIC_REGISTRATION` to `true` and rerun the workflow. Until then the sign-in page directs new contributors to the existing Tally form. If enabling Turnstile, configure its private secret in Supabase Auth and its public site key in the workflow. Limit allowed hostnames to the publication and staging hostnames.

3. Sign up and verify the account for the publication owner. In the Supabase SQL editor, bootstrap its administrator by the verified account UUID shown in Authentication > Users. Use only that account's UUID.

   ```sql
   update public.wp_profiles
   set role = 'admin'
   where id = 'REPLACE-WITH-VERIFIED-AUTH-USER-UUID'
     and exists (
       select 1 from auth.users
       where auth.users.id = public.wp_profiles.id
       and email_confirmed_at is not null
     );
   ```

4. Set these Edge Function secrets in the Supabase project.

   | Name | Value |
   | --- | --- |
   | `WP_SITE_ORIGIN` | Public origin, for example `https://supergreatwin.github.io`. Omit the path and trailing slash. |
   | `WP_SITE_URL` | Full public base URL such as `https://supergreatwin.github.io/without-permission/`. Include the trailing slash. |
   | `WP_EXPORT_TOKEN` | A unique random secret of at least 32 bytes, also added to GitHub Actions secrets. |
   | `WP_ANALYTICS_SECRET` | A different random secret of at least 32 bytes, used for temporary analytics identifiers. |
   | `BEEHIIV_API_KEY` | Existing Beehiiv read access for aggregate reporting. Use the narrowest available read access. |
   | `BEEHIIV_PUBLICATION_ID` | The existing publication ID, starting with `pub_`. |

   Supabase supplies its runtime URL, anon and service-role keys automatically. The browser uses the publishable key alone. Add the SMTP password, Beehiiv key and export token through the provider dashboards or secret stores. Keep them out of the repository and browser configuration.

5. In GitHub Actions, set repository variables `WP_SITE_URL`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`. Set the `WP_EXPORT_TOKEN` repository secret. Add `TURNSTILE_SITE_KEY` as a variable only if CAPTCHA is enabled in Supabase Auth. Deploy the provided Pages workflow to staging first. Run `Publish Without Permission` and verify the build artifact. Once the staged site has passed the acceptance checks, switch production GitHub Pages to GitHub Actions, set the repository variable `WP_ENABLE_PAGES_DEPLOY` to `true`, and rerun the workflow. The scheduled workflow checks for eligible articles every 15 minutes. GitHub can queue or delay it, so an article should be considered publicly live once the deploy completes. The workflow also accepts a `without-permission-publish` repository dispatch if the team later sets up a push trigger.

6. Run the acceptance checks below. In Supabase Cron or the SQL editor with the pg_cron extension enabled, schedule `select public.wp_cleanup();` daily so temporary counters and traffic detail expire. The acceptance run should confirm this job is scheduled.

## Editor and contributor instructions

- A reader can verify an account, fill in a name or pen name, and send a private contributor application. An administrator approves the application or assigns an editorial role from **Accounts**. The Tally form on the public site remains available.
- A contributor opens **Articles**, creates a draft with a stable URL slug and edits either language. Use the toolbar for headings, emphasis, quotations and lists. Upload a cover or use one of your previous uploads. Add the public byline explicitly and preview both language editions. Saving creates a revision if the content changed. Drafts autosave after their URL has been entered.
- Submit for review. An editor opens the submission, reviews it and requests changes where needed. The contributor sees the new status and the feedback in the desk. Notes and account details stay private.
- An Editor-in-Chief or administrator approves a reviewed version, publishes it or selects a future local date and time. The dashboard stores the scheduled time as an absolute timestamp. The next successful site build publishes due articles. Only those roles can change homepage editor selections or unpublish. Earlier content appears in **Revision history** and restoring it creates a new revision.
- **Analytics** shows views, estimated unique daily browser sessions, 30-second engaged article reads, referrer categories, language mix, publication activity and editorial throughput over 7, 30 or 90 days. Beehiiv reports appear after connecting its API. A conversion estimate appears only when site attribution and a usable denominator are available. Tally submissions remain in Tally and are excluded from the desk's contributor counts.
- The existing Beehiiv Manage preferences and Unsubscribe links remain the subscriber controls. For language and interest choices, set up matching custom fields in the publication's Preference Center and create segments from the chosen values. The static build provides `feed-ar.xml` and `feed-en.xml` for optional new-article notifications. Beehiiv RSS ingestion or scheduling depends on the account's features. Configure and test an opt-in segment before activating any publication notifications.

## Staging acceptance

Use controlled test accounts you own for all email flows.

1. Register and verify one account for each role. Confirm forgotten-password email works, contributor application approval is visible, and an unrelated contributor cannot open or list someone else's draft, review note or image. Use isolated recipient mailboxes.
2. As a contributor, enter both editions and cover art, reload after autosave and submit. Request changes as an editor. Open the feedback as the contributor, revise and resubmit. As Editor-in-Chief, approve, schedule, wait for the workflow and check both public URLs and search previews. Restore an earlier revision and test unpublishing on the staging article. Review the audit entries.
3. From the public homepage, start a Beehiiv signup using a test inbox. Confirm the initial acknowledgement remains on-page, follow the email link, verify subscriber status in Beehiiv and then test Manage preferences and Unsubscribe. Verify the dashboard aggregate updates for that test. A production subscriber and Tally submission were not created during local checks.
4. On the staging site, browse in Arabic and English, load both forms, exercise dark mode, use the keyboard on the article and desk, and verify visits appear in the private dashboard. Test the original `#post-…` and `#lip-gloss` routes and sample archives. Check mobile layouts.
5. Verify GitHub Pages deployed the approved commit. Confirm `desk/config.js` contains only public settings. Confirm subscriber keys, private responses and contributor identities did not enter the Pages artifact.

## Backup and recovery

- Keep the original static source, archive images, migrations and frontend sources in Git. The import migration seeds 31 RAW by Vee items and the long-form feature, retaining their original URLs, page HTML and assets. Migrated entries use the import date internally because publication timestamps are unavailable in some original pages. The seed is safe to reapply without overwriting existing edits.
- Export the database to encrypted private storage regularly and copy private cover images separately. Supabase database dumps do not replace Storage backups. Verify recovery in an isolated project before using a backup for production.
- To reverse a Pages release, switch its publishing source back to the existing main-branch site or redeploy the last known-good artifact. Back up the database and image storage first. A Pages rollback does not rewind the private editorial data.
- Public traffic uses a tab-lifetime random identifier, hashed with a daily server secret derived from the configured secret, and honors Do Not Track and Global Privacy Control. No raw IP address or full referrer is stored in the site database. The hosting provider's own access logs follow its policies. Apply the included cleanup job for 95-day detail retention.

Supabase has a free tier with project limits. SMTP delivery needs an authorized provider and sending domain. Beehiiv API access and automatic newsletter features depend on the publication's plan. This implementation makes no purchase or plan change.

[Supabase SMTP requirements](https://supabase.com/docs/guides/auth/auth-smtp) · [GitHub Pages publishing workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) · [Beehiiv preferences](https://www.beehiiv.com/support/article/25861115929495-setting-up-a-subscriber-preferences-center)
