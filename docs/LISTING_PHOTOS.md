# Listing photos

Services and seeker requests accept zero to three photos. The first photo is the cover. Public cards download only the cover thumbnail; Details renders the photo carousel and thumbnails. Existing listings need no photos.

The frontend adapts the user's supplied [21st.dev Trail Card](https://21st.dev/community/components/ravikatiyar162/trail-card) source with existing dependencies. The requested registry CLI was attempted, but its Windows launcher failed and direct registry installation required authentication. No registry installation is claimed.

`POST /api/upload/listing-photo` accepts a JPEG, PNG or WebP data URL, up to 5 MB. Authentication, verified email/residency and the shared upload rate limit apply. The backend checks the MIME signature, uploads a resized JPEG to Cloudinary, and registers ownership. The response contains only `{ id, url, width, height }`.

Create/update payloads use `photoIds`, never caller-supplied image URLs. The backend validates uniqueness, the three-photo cap, listing ownership and upload ownership. Ordered join rows use positions 0–2 with database constraints, preventing a fourth photo even if application validation is bypassed. Reposts may reuse the owner's uploaded assets.

`DELETE /api/upload/listing-photo/:id` removes an owner's unattached upload. An hourly bounded cleanup removes uploads abandoned for 48 hours and account-purge orphans. Saved photos are retained while any service/request references them. Owner deletion sets the asset owner to null so the Cloudinary identifier is preserved for cleanup, rather than leaking untracked media. Cloud deletion failures retain database records for a later retry.

The browser resizes and re-encodes uploads, offers preview/remove/cover selection, and prevents publishing during an upload. Individual failures preserve successful photos and release the form. Uploads canceled during navigation may be cleaned by the orphan job. Photos are public; the form explicitly asks users to leave out personal information.

Administrators can view current photos in the content inspector and use existing report/remove controls. Photos are not identity verification or automated visual moderation. Historical report snapshots retain existing text behavior; this feature does not add immutable photo evidence archives.

Migration: `20261013010000_listing_photos`. Rehearse with `SERVICEHUB_LISTING_PHOTOS_ONLY=1 npm run test:fresh-migrations`; it creates/removes a disposable schema, verifies all migrations and drift, and tests ownership, ordering, editing, maximum count, both marketplace reads, removal and cleanup. Cloudinary destruction is stubbed in the database integration test; it never destroys real uploads.
